import { describe, expect, it, vi } from 'vitest';

// Under Node, pdf.js runs its worker in-process and, unless it is handed one,
// loads it with import() of a path it computes at run time ("./pdf.worker.mjs"
// beside pdf.mjs). Hosts that deploy only the files a build can trace (Vercel)
// leave that file out, and then no PDF opens at all: every upload failed this
// way on the first live deployment.
//
// This reproduces that layout: pdf.js is loaded from a copy of pdf.mjs with no
// worker beside it. The reader has to load the worker itself and hand it over.
const alone = await vi.hoisted(async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const { createRequire } = await import('node:module');
  const real = createRequire(import.meta.url).resolve('pdfjs-dist/legacy/build/pdf.mjs');
  // Under a node_modules directory, so the test runner loads it with Node itself, as production does.
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'rcm-pdfjs-')), 'node_modules', 'pdfjs-dist', 'legacy', 'build');
  fs.mkdirSync(dir, { recursive: true });
  fs.copyFileSync(real, path.join(dir, 'pdf.mjs'));
  return path.join(dir, 'pdf.mjs');
});

vi.mock('pdfjs-dist/legacy/build/pdf.mjs', () => import(/* @vite-ignore */ alone));

describe('pdf.js worker', () => {
  it('opens a PDF when pdf.js is deployed without its worker file beside it', async () => {
    delete (globalThis as { pdfjsWorker?: unknown }).pdfjsWorker;
    const { readPdfText } = await import('@/server/documents/pdf-text');
    const { renderPackage } = await import('@/server/samples/pdf');
    const { samplePackage } = await import('./helpers/sample');

    const text = await readPdfText(await renderPackage(samplePackage()));

    expect(text.pageCount).toBe(3);
    expect(text.hasTextLayer).toBe(true);
  });
});
