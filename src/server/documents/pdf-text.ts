/**
 * Reads the text layer of a PDF with positions, so extracted values can be
 * traced back to an exact place on a page.
 *
 * Coordinates are converted to a top-left origin in PDF points.
 */
import type { BBox } from '@/server/types';

export type Cell = { text: string; x: number; y: number; w: number; h: number };
export type TextLine = { y: number; cells: Cell[]; text: string };
export type PageText = { page: number; width: number; height: number; lines: TextLine[]; text: string };
export type PdfText = { pageCount: number; pages: PageText[]; hasTextLayer: boolean };

type RawItem = { str: string; transform: number[]; width: number; height: number };

export async function readPdfText(bytes: Uint8Array): Promise<PdfText> {
  // The legacy build is the one pdf.js supports under Node. Pinned to 4.x: later
  // majors need Node 22 built-ins (Promise.withResolvers, Iterator helpers).
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  // pdf.js takes ownership of the buffer it is given, so hand it a copy.
  const pdf = await pdfjs.getDocument({ data: new Uint8Array(bytes), useSystemFonts: true, isEvalSupported: false, verbosity: 0 }).promise;
  const pages: PageText[] = [];
  let chars = 0;
  try {
    for (let n = 1; n <= pdf.numPages; n++) {
      const page = await pdf.getPage(n);
      const viewport = page.getViewport({ scale: 1 });
      const content = await page.getTextContent();
      const items: Cell[] = [];
      for (const raw of content.items as unknown as RawItem[]) {
        if (!raw.str || !raw.str.trim()) continue;
        const h = Math.abs(raw.transform[3]!) || raw.height || 8;
        items.push({
          text: raw.str,
          x: raw.transform[4]!,
          // transform[5] is the baseline measured from the bottom of the page.
          y: viewport.height - raw.transform[5]! - h,
          w: raw.width,
          h,
        });
        chars += raw.str.trim().length;
      }
      const lines = toLines(items);
      pages.push({ page: n, width: viewport.width, height: viewport.height, lines, text: lines.map((l) => l.text).join('\n') });
    }
  } finally {
    await pdf.destroy();
  }
  // A scan with a stray watermark still has "a text layer"; require real content.
  return { pageCount: pages.length, pages, hasTextLayer: chars >= 40 * Math.max(1, pages.length) || chars >= 200 };
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
        } else {
          cells.push({ ...item });
        }
      }
      for (const c of cells) c.text = c.text.replace(/\s+/g, ' ').trim();
      const y = Math.min(...cells.map((c) => c.y));
      return { y, cells, text: cells.map((c) => c.text).join('  ') };
    })
    .sort((a, b) => a.y - b.y);
}

export function bboxOf(page: PageText, cell: Cell, pad = 1.5): BBox {
  return [
    Math.max(0, (cell.x - pad) / page.width),
    Math.max(0, (cell.y - pad) / page.height),
    Math.min(1, (cell.w + pad * 2) / page.width),
    Math.min(1, (cell.h + pad * 2) / page.height),
  ];
}

export function bboxOfLine(page: PageText, line: TextLine): BBox {
  const x1 = Math.min(...line.cells.map((c) => c.x));
  const x2 = Math.max(...line.cells.map((c) => c.x + c.w));
  const y1 = Math.min(...line.cells.map((c) => c.y));
  const y2 = Math.max(...line.cells.map((c) => c.y + c.h));
  return [Math.max(0, (x1 - 2) / page.width), Math.max(0, (y1 - 2) / page.height), Math.min(1, (x2 - x1 + 4) / page.width), Math.min(1, (y2 - y1 + 4) / page.height)];
}
