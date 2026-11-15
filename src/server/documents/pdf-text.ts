/**
 * Reads the text layer of a PDF with positions, so extracted values can be
 * traced back to an exact place on a page.
 *
 * Coordinates are in PDF points with a top-left origin, in the frame the text
 * reads in: a page whose content is turned sideways (a landscape table printed
 * on a portrait page, a scan fed in the wrong way) is turned back so its lines
 * run left to right. `bboxOf` maps positions back to the page as a viewer shows
 * it, so highlights land where the value is printed.
 *
 * Alongside the text it records where images are drawn, because text under an
 * image (a handwritten correction pasted over a figure, a stamp) or an image
 * with no text at all (a scanned page) cannot be trusted or read from the text
 * layer, and the readers have to say so.
 */
import type { BBox } from '@/server/types';

/** A phrase or table cell. `parts` are the text runs it was merged from, as the PDF drew them. */
export type Cell = { text: string; x: number; y: number; w: number; h: number; parts?: Cell[] };
export type TextLine = { y: number; cells: Cell[]; text: string };
export type Rect = { x: number; y: number; w: number; h: number };
export type Rotation = 0 | 90 | 180 | 270;
export type PageText = {
  page: number;
  /** Size of the frame the text reads in (points). */
  width: number;
  height: number;
  lines: TextLine[];
  text: string;
  /** How far the content is turned relative to the page as displayed (clockwise, degrees). 0 when it reads upright. */
  rotation?: Rotation;
  /** Size of the page as displayed (points). Equal to width/height when rotation is 0 or 180. */
  viewWidth?: number;
  viewHeight?: number;
  /** Where images are drawn, in the same frame as the text. */
  images?: Rect[];
  /** Non-blank characters in the text layer. */
  chars?: number;
};
export type PdfText = { pageCount: number; pages: PageText[]; hasTextLayer: boolean };

type RawItem = { str: string; transform: number[]; width: number; height: number };
type Matrix = [number, number, number, number, number, number];

const multiply = (m: Matrix, n: Matrix): Matrix => [
  m[0] * n[0] + m[2] * n[1],
  m[1] * n[0] + m[3] * n[1],
  m[0] * n[2] + m[2] * n[3],
  m[1] * n[2] + m[3] * n[3],
  m[0] * n[4] + m[2] * n[5] + m[4],
  m[1] * n[4] + m[3] * n[5] + m[5],
];
const apply = (m: Matrix, x: number, y: number): [number, number] => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];

/** The direction text runs in, on the displayed page (y down), to the nearest quarter turn. */
function directionOf(m: Matrix): Rotation {
  const angle = (Math.atan2(m[1], m[0]) * 180) / Math.PI;
  const q = (((Math.round(angle / 90) % 4) + 4) % 4) as 0 | 1 | 2 | 3;
  return ([0, 90, 180, 270] as const)[q];
}

/** Map a point on the displayed page (W × H) into the frame where text turned by `r` reads left to right. */
function toFrame(r: Rotation, W: number, H: number, x: number, y: number): [number, number] {
  switch (r) {
    case 0:
      return [x, y];
    case 90:
      return [y, W - x];
    case 180:
      return [W - x, H - y];
    case 270:
      return [H - y, x];
  }
}

/**
 * pdf.js, with its worker already in hand.
 *
 * Under Node, pdf.js runs its worker in-process, and unless it is given one it
 * loads it with import() of a path computed at run time. A build cannot trace
 * that, so hosts that deploy only traced files (Vercel) leave the worker out and
 * no PDF opens. Importing it here makes the build include it, and pdf.js uses
 * the module it finds on `globalThis.pdfjsWorker` instead of importing one.
 */
async function loadPdfjs() {
  // The legacy build is the one pdf.js supports under Node. Pinned to 4.x: later
  // majors need Node 22 built-ins (Promise.withResolvers, Iterator helpers).
  const [pdfjs, worker] = await Promise.all([import('pdfjs-dist/legacy/build/pdf.mjs'), import('pdfjs-dist/legacy/build/pdf.worker.mjs')]);
  const g = globalThis as { pdfjsWorker?: { WorkerMessageHandler?: unknown } };
  if (!g.pdfjsWorker?.WorkerMessageHandler) g.pdfjsWorker = worker;
  return pdfjs;
}

export async function readPdfText(bytes: Uint8Array): Promise<PdfText> {
  const pdfjs = await loadPdfjs();
  // pdf.js takes ownership of the buffer it is given, so hand it a copy.
  const pdf = await pdfjs.getDocument({ data: new Uint8Array(bytes), useSystemFonts: true, isEvalSupported: false, isOffscreenCanvasSupported: false, verbosity: 0 }).promise;
  const OPS = pdfjs.OPS as Record<string, number>;
  const pages: PageText[] = [];
  let chars = 0;
  try {
    for (let n = 1; n <= pdf.numPages; n++) {
      const page = await pdf.getPage(n);
      const viewport = page.getViewport({ scale: 1 });
      const vt = viewport.transform as Matrix;
      const W = viewport.width;
      const H = viewport.height;
      const content = await page.getTextContent();

      // Each item positioned on the displayed page, with the direction it reads in.
      type Placed = { str: string; m: Matrix; width: number; dir: Rotation };
      const placed: Placed[] = [];
      const weight: Record<Rotation, number> = { 0: 0, 90: 0, 180: 0, 270: 0 };
      for (const raw of content.items as unknown as RawItem[]) {
        if (!raw.str || !raw.str.trim()) continue;
        const m = multiply(vt, raw.transform as Matrix);
        const dir = directionOf(m);
        placed.push({ str: raw.str, m, width: raw.width, dir });
        weight[dir] += raw.str.trim().length;
      }
      const rotation = ([0, 90, 180, 270] as const).reduce((best, r) => (weight[r] > weight[best] ? r : best), 0 as Rotation);
      const [fw, fh] = rotation === 90 || rotation === 270 ? [H, W] : [W, H];

      const items: Cell[] = [];
      let pageChars = 0;
      for (const p of placed) {
        // Text running across the main direction (a stamp, a vertical label) cannot be placed on a line.
        if (p.dir !== rotation) continue;
        const size = Math.hypot(p.m[2], p.m[3]) || 8;
        const [x, baseline] = toFrame(rotation, W, H, p.m[4], p.m[5]);
        items.push({ text: p.str, x, y: baseline - size, w: p.width, h: size });
        pageChars += p.str.trim().length;
      }
      chars += pageChars;

      const images = await imageRects(page, OPS, vt).catch(() => [] as Array<[number, number, number, number]>);
      const rects: Rect[] = images.map(([x0, y0, x1, y1]) => {
        const a = toFrame(rotation, W, H, x0, y0);
        const b = toFrame(rotation, W, H, x1, y1);
        return { x: Math.min(a[0], b[0]), y: Math.min(a[1], b[1]), w: Math.abs(a[0] - b[0]), h: Math.abs(a[1] - b[1]) };
      });

      const lines = toLines(items);
      pages.push({ page: n, width: fw, height: fh, lines, text: lines.map((l) => l.text).join('\n'), rotation, viewWidth: W, viewHeight: H, images: rects, chars: pageChars });
    }
  } finally {
    await pdf.destroy();
  }
  // A scan with a stray watermark still has "a text layer"; require real content.
  return { pageCount: pages.length, pages, hasTextLayer: chars >= 40 * Math.max(1, pages.length) || chars >= 200 };
}

/** Rectangles (displayed page, y down: x0, y0, x1, y1) where the page paints an image. */
async function imageRects(page: { getOperatorList: () => Promise<{ fnArray: number[]; argsArray: unknown[] }> }, OPS: Record<string, number>, vt: Matrix): Promise<Array<[number, number, number, number]>> {
  const list = await page.getOperatorList();
  const paints = new Set([OPS.paintImageXObject, OPS.paintInlineImageXObject, OPS.paintImageMaskXObject, OPS.paintImageXObjectRepeat].filter((v) => v !== undefined));
  let ctm: Matrix = [1, 0, 0, 1, 0, 0];
  const stack: Matrix[] = [];
  const out: Array<[number, number, number, number]> = [];
  for (let i = 0; i < list.fnArray.length; i++) {
    const fn = list.fnArray[i]!;
    const args = list.argsArray[i] as unknown[] | null;
    if (fn === OPS.save) stack.push(ctm);
    else if (fn === OPS.restore) ctm = stack.pop() ?? ctm;
    else if (fn === OPS.transform && args) ctm = multiply(ctm, args as Matrix);
    else if (fn === OPS.paintFormXObjectBegin) {
      stack.push(ctm);
      const m = args?.[0];
      if (Array.isArray(m) && m.length === 6) ctm = multiply(ctm, m as Matrix);
    } else if (fn === OPS.paintFormXObjectEnd) ctm = stack.pop() ?? ctm;
    else if (paints.has(fn)) {
      // An image fills the unit square of the current transformation.
      const m = multiply(vt, ctm);
      const corners = [apply(m, 0, 0), apply(m, 1, 0), apply(m, 0, 1), apply(m, 1, 1)];
      const xs = corners.map((c) => c[0]);
      const ys = corners.map((c) => c[1]);
      out.push([Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)]);
    }
  }
  return out;
}

/** Group items into visual lines, and neighbouring items on a line into cells (phrases / table cells). */
function toLines(items: Cell[]): TextLine[] {
  const sorted = [...items].sort((a, b) => a.y + a.h - (b.y + b.h) || a.x - b.x);
  const rows: Cell[][] = [];
  for (const item of sorted) {
    const baseline = item.y + item.h;
    const row = rows.find((r) => Math.abs(r[0]!.y + r[0]!.h - baseline) <= Math.max(2, Math.min(item.h, r[0]!.h) * 0.4));
    if (row) row.push(item);
    else rows.push([item]);
  }
  return rows
    .map((row) => {
      row.sort((a, b) => a.x - b.x);
      const cells: Cell[] = [];
      for (const item of row) {
        const last = cells[cells.length - 1];
        const gap = last ? item.x - (last.x + last.w) : Infinity;
        if (last && gap <= Math.max(3, last.h * 0.6)) {
          // Same phrase: merge, inserting a space only where there visibly is one.
          const joiner = gap > last.h * 0.15 && !last.text.endsWith(' ') && !item.text.startsWith(' ') ? ' ' : '';
          const top = Math.min(last.y, item.y);
          const bottom = Math.max(last.y + last.h, item.y + item.h);
          last.text = last.text + joiner + item.text;
          last.w = item.x + item.w - last.x;
          last.y = top;
          last.h = bottom - top;
          last.parts!.push({ ...item });
        } else {
          cells.push({ ...item, parts: [{ ...item }] });
        }
      }
      for (const c of cells) {
        c.text = c.text.replace(/\s+/g, ' ').trim();
        for (const p of c.parts!) p.text = p.text.replace(/\s+/g, ' ').trim();
        c.parts = c.parts!.filter((p) => p.text);
      }
      const y = Math.min(...cells.map((c) => c.y));
      return { y, cells, text: cells.map((c) => c.text).join('  ') };
    })
    .sort((a, b) => a.y - b.y);
}

/** A rectangle in the text's frame as a fraction of the page as displayed. */
export function bboxOfRect(page: PageText, r: Rect): BBox {
  const rotation = page.rotation ?? 0;
  const W = page.viewWidth ?? page.width;
  const H = page.viewHeight ?? page.height;
  let x: number, y: number, w: number, h: number;
  switch (rotation) {
    case 0:
      [x, y, w, h] = [r.x, r.y, r.w, r.h];
      break;
    case 90:
      [x, y, w, h] = [W - r.y - r.h, r.x, r.h, r.w];
      break;
    case 180:
      [x, y, w, h] = [W - r.x - r.w, H - r.y - r.h, r.w, r.h];
      break;
    case 270:
      [x, y, w, h] = [r.y, H - r.x - r.w, r.h, r.w];
      break;
  }
  const x0 = Math.max(0, x / W);
  const y0 = Math.max(0, y / H);
  return [x0, y0, Math.min(1 - x0, w / W), Math.min(1 - y0, h / H)];
}

export function bboxOf(page: PageText, cell: Cell, pad = 1.5): BBox {
  return bboxOfRect(page, { x: cell.x - pad, y: cell.y - pad, w: cell.w + pad * 2, h: cell.h + pad * 2 });
}

export function bboxOfLine(page: PageText, line: TextLine): BBox {
  const x1 = Math.min(...line.cells.map((c) => c.x));
  const x2 = Math.max(...line.cells.map((c) => c.x + c.w));
  const y1 = Math.min(...line.cells.map((c) => c.y));
  const y2 = Math.max(...line.cells.map((c) => c.y + c.h));
  return bboxOfRect(page, { x: x1 - 2, y: y1 - 2, w: x2 - x1 + 4, h: y2 - y1 + 4 });
}

/** Share of the page an image covers (largest single image; overlapping images are not summed). */
export function imageCoverage(page: PageText): number {
  const area = page.width * page.height;
  if (!area) return 0;
  return Math.min(1, Math.max(0, ...(page.images ?? []).map((r) => (r.w * r.h) / area)));
}

/** Images drawn over part of a cell (not page-sized backgrounds). */
export function imagesOver(page: PageText, cell: Rect): Rect[] {
  const area = page.width * page.height;
  return (page.images ?? []).filter(
    (r) => r.w * r.h < area * 0.6 && r.x < cell.x + cell.w && cell.x < r.x + r.w && r.y < cell.y + cell.h && cell.y < r.y + r.h,
  );
}
