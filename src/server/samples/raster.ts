/**
 * A very small rasteriser for the evaluation corpus: paints text into a bitmap
 * with a 5×7 pixel font and encodes it as a PNG. It exists to manufacture
 * pages that are a picture of a document with no text layer ("scans"), and
 * ink-like marks drawn over a printed page.
 *
 * It is deliberately crude. The point is not a faithful scan; it is a file
 * that a text-layer reader cannot read, whose content is nevertheless known.
 * No dependency beyond node:zlib.
 */
import { deflateSync } from 'node:zlib';

export type Bitmap = { width: number; height: number; channels: 1 | 4; data: Uint8Array };

export function createBitmap(width: number, height: number, channels: 1 | 4, fill: number[]): Bitmap {
  const data = new Uint8Array(width * height * channels);
  for (let i = 0; i < width * height; i++) for (let c = 0; c < channels; c++) data[i * channels + c] = fill[c] ?? fill[0] ?? 0;
  return { width, height, channels, data };
}

function setPixel(bmp: Bitmap, x: number, y: number, ink: number[]) {
  if (x < 0 || y < 0 || x >= bmp.width || y >= bmp.height) return;
  const i = (y * bmp.width + x) * bmp.channels;
  for (let c = 0; c < bmp.channels; c++) bmp.data[i + c] = ink[c] ?? ink[0] ?? 0;
}

// The classic public-domain 5×7 column font, ASCII 0x20–0x7E. Five bytes per
// glyph, one per column; bit 0 is the top row.
const FONT_HEX =
  '0000000000' + '00005F0000' + '0007000700' + '147F147F14' + '242A7F2A12' + '2313086462' + '3649552250' + '0005030000' +
  '001C224100' + '0041221C00' + '082A1C2A08' + '08083E0808' + '0050300000' + '0808080808' + '0060600000' + '2010080402' +
  '3E5149453E' + '00427F4000' + '4261514946' + '2141454B31' + '1814127F10' + '2745454539' + '3C4A494930' + '0171090503' +
  '3649494936' + '064949291E' + '0036360000' + '0056360000' + '0008142241' + '1414141414' + '4122140800' + '0201510906' +
  '324979413E' + '7E1111117E' + '7F49494936' + '3E41414122' + '7F4141221C' + '7F49494941' + '7F09090101' + '3E41415132' +
  '7F0808087F' + '00417F4100' + '2040413F01' + '7F08142241' + '7F40404040' + '7F0204027F' + '7F0408107F' + '3E4141413E' +
  '7F09090906' + '3E4151215E' + '7F09192946' + '4649494931' + '01017F0101' + '3F4040403F' + '1F2040201F' + '7F2018207F' +
  '6314081463' + '0304780403' + '6151494543' + '00007F4141' + '0204081020' + '41417F0000' + '0402010204' + '4040404040' +
  '0001020400' + '2054545478' + '7F48444438' + '3844444420' + '384444487F' + '3854545418' + '087E090102' + '081454543C' +
  '7F08040478' + '00447D4000' + '2040443D00' + '007F102844' + '00417F4000' + '7C04180478' + '7C08040478' + '3844444438' +
  '7C14141408' + '081414187C' + '7C08040408' + '4854545420' + '043F444020' + '3C4040207C' + '1C2040201C' + '3C4030403C' +
  '4428102844' + '0C5050503C' + '4464544C44' + '0008364100' + '00007F0000' + '0041360800' + '0804081008';

const FOLD: Record<string, string> = { '’': "'", '‘': "'", '“': '"', '”': '"', '·': '.', '–': '-', '—': '-', '−': '-', '±': '+', '×': 'x' };

function glyph(ch: string): number[] {
  const c = (FOLD[ch] ?? ch).charCodeAt(0);
  const idx = c >= 0x20 && c <= 0x7e ? c - 0x20 : '?'.charCodeAt(0) - 0x20;
  const cols: number[] = [];
  for (let i = 0; i < 5; i++) cols.push(parseInt(FONT_HEX.slice(idx * 10 + i * 2, idx * 10 + i * 2 + 2), 16));
  return cols;
}

/**
 * Paint `text` into the box (x, y, w, h), all in pixels; y is the top. The
 * glyphs are stretched to fill the box, so a phrase keeps the footprint it had
 * on the page it was copied from. `shear` leans the glyphs like handwriting.
 */
export function drawText(bmp: Bitmap, text: string, x: number, y: number, w: number, h: number, ink: number[], shear = 0): void {
  const chars = [...text];
  if (chars.length === 0 || w <= 0 || h <= 0) return;
  const advance = w / chars.length;
  const glyphW = (advance * 5) / 6;
  chars.forEach((ch, n) => {
    const cols = glyph(ch);
    const gx = x + n * advance;
    for (let py = 0; py < Math.ceil(h); py++) {
      const row = Math.min(6, Math.floor((py / h) * 7));
      const lean = shear * (h - py);
      for (let px = 0; px < Math.ceil(glyphW); px++) {
        const col = Math.min(4, Math.floor((px / glyphW) * 5));
        if ((cols[col]! >> row) & 1) setPixel(bmp, Math.round(gx + px + lean), Math.round(y + py), ink);
      }
    }
  });
}

export function drawLine(bmp: Bitmap, x1: number, y1: number, x2: number, y2: number, thickness: number, ink: number[]): void {
  const steps = Math.max(1, Math.ceil(Math.hypot(x2 - x1, y2 - y1)));
  for (let s = 0; s <= steps; s++) {
    const cx = x1 + ((x2 - x1) * s) / steps;
    const cy = y1 + ((y2 - y1) * s) / steps;
    for (let dy = 0; dy < thickness; dy++) for (let dx = 0; dx < thickness; dx++) setPixel(bmp, Math.round(cx + dx), Math.round(cy + dy), ink);
  }
}

/** A small deterministic generator, so the corpus is the same on every run. */
export function prng(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

/** Scanner dirt: speckles, and optionally grain over the whole page. Greyscale bitmaps only. */
export function addNoise(bmp: Bitmap, seed: number, opts: { speckles: number; grain: number }): void {
  const rand = prng(seed);
  const pixels = bmp.width * bmp.height;
  if (opts.grain > 0) {
    for (let i = 0; i < pixels; i++) {
      if (rand() < 0.35) bmp.data[i] = Math.max(0, Math.min(255, bmp.data[i]! + Math.round((rand() - 0.5) * 2 * opts.grain)));
    }
  }
  for (let n = 0; n < Math.round(pixels * opts.speckles); n++) {
    const x = Math.floor(rand() * bmp.width);
    const y = Math.floor(rand() * bmp.height);
    const dark = Math.floor(rand() * 120);
    setPixel(bmp, x, y, [dark]);
    if (rand() < 0.3) setPixel(bmp, x + 1, y, [dark]);
  }
}

// ── PNG ─────────────────────────────────────────────────────────────────────

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

export function encodePng(bmp: Bitmap): Uint8Array {
  const header = new Uint8Array(13);
  const hv = new DataView(header.buffer);
  hv.setUint32(0, bmp.width);
  hv.setUint32(4, bmp.height);
  header[8] = 8; // bit depth
  header[9] = bmp.channels === 1 ? 0 : 6; // greyscale, or RGBA
  const stride = bmp.width * bmp.channels;
  const raw = new Uint8Array((stride + 1) * bmp.height);
  for (let y = 0; y < bmp.height; y++) raw.set(bmp.data.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
  const parts = [Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', header), chunk('IDAT', deflateSync(raw, { level: 6 })), chunk('IEND', new Uint8Array(0))];
  const out = new Uint8Array(parts.reduce((a, p) => a + p.length, 0));
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

// ── Ready-made pictures ─────────────────────────────────────────────────────

export type PlacedText = { text: string; x: number; y: number; w: number; h: number };

/** A greyscale picture of a page: each phrase painted where it sits on the page. Coordinates are PDF points, top-left origin. */
export function pagePicture(page: { width: number; height: number; items: PlacedText[] }, opts: { dpi: number; seed: number; speckles?: number; grain?: number }): Bitmap {
  const scale = opts.dpi / 72;
  const bmp = createBitmap(Math.round(page.width * scale), Math.round(page.height * scale), 1, [246]);
  for (const it of page.items) {
    // The cap height of a typical face is about 0.72 of the font size, sitting on the baseline at the bottom of the box.
    const capH = it.h * 0.72 * scale;
    drawText(bmp, it.text, it.x * scale, (it.y + it.h) * scale - capH, it.w * scale, capH, [28]);
  }
  addNoise(bmp, opts.seed, { speckles: opts.speckles ?? 0.0004, grain: opts.grain ?? 0 });
  return bmp;
}

/**
 * A hand-corrected figure: a strike through the printed amount and the new
 * amount written above it in blue ink. Transparent elsewhere. The picture is
 * `width` × `height` points; the strike runs along the bottom third.
 */
export function inkCorrection(text: string, width: number, height: number, dpi = 200): Bitmap {
  const scale = dpi / 72;
  const bmp = createBitmap(Math.round(width * scale), Math.round(height * scale), 4, [0, 0, 0, 0]);
  const ink = [24, 44, 160, 255];
  const strikeY = bmp.height * 0.8;
  drawLine(bmp, 0, strikeY + 2, bmp.width - 1, strikeY - 3, Math.max(2, Math.round(scale)), ink);
  const figH = bmp.height * 0.5;
  drawText(bmp, text, bmp.width * 0.06, bmp.height * 0.04, bmp.width * 0.86, figH, ink, 0.22);
  return bmp;
}

/** A scribble that reads as a handwritten signature. Transparent background. */
export function inkSignature(width: number, height: number, seed: number, dpi = 200): Bitmap {
  const scale = dpi / 72;
  const bmp = createBitmap(Math.round(width * scale), Math.round(height * scale), 4, [0, 0, 0, 0]);
  const ink = [20, 30, 120, 255];
  const rand = prng(seed);
  let x = bmp.width * 0.04;
  let y = bmp.height * 0.6;
  while (x < bmp.width * 0.94) {
    const nx = x + bmp.width * (0.02 + rand() * 0.05);
    const ny = bmp.height * (0.15 + rand() * 0.7);
    drawLine(bmp, x, y, nx, ny, Math.max(2, Math.round(scale * 0.8)), ink);
    x = nx;
    y = ny;
  }
  return bmp;
}
