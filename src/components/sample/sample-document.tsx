'use client';

import { ExternalLink, FileText } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { SampleBox, SampleSnapshot } from '@/content/sample-types';
import { cn } from '@/lib/utils';

/**
 * The sample package itself: the real PDF, drawn in the browser with the same
 * pdf.js the review workspace uses, and a highlight over the figure being
 * talked about. One page at a time, chosen by the tabs or by whatever the
 * visitor last pointed at.
 */

// pdf.js is served from /public and imported at runtime, so the bundler never touches it.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type PdfJs = any;
let pdfjs: Promise<PdfJs> | null = null;
function loadPdfJs(): Promise<PdfJs> {
  if (!pdfjs) {
    const runtimeImport = new Function('url', 'return import(url)') as (url: string) => Promise<PdfJs>;
    pdfjs = runtimeImport('/pdfjs/pdf.min.mjs').then((lib) => {
      lib.GlobalWorkerOptions.workerSrc = '/pdfjs/pdf.worker.min.mjs';
      return lib;
    });
    pdfjs.catch(() => {
      pdfjs = null;
    });
  }
  return pdfjs;
}

export type SampleTarget = { page: number; bbox: SampleBox | null; nonce: number };

export function SampleDocument({ document: doc, page, onPage, target, className }: { document: SampleSnapshot['document']; page: number; onPage: (page: number) => void; target: SampleTarget | null; className?: string }) {
  const holder = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const mark = useRef<HTMLDivElement>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [pdf, setPdf] = useState<any>(null);
  const [failed, setFailed] = useState(false);
  const [width, setWidth] = useState(0);
  const meta = doc.pages.find((p) => p.page === page) ?? doc.pages[0]!;
  const ratio = meta.height / meta.width;

  useEffect(() => {
    let cancelled = false;
    loadPdfJs()
      .then((lib) => lib.getDocument({ url: doc.url }).promise)
      .then((loaded) => {
        if (!cancelled) setPdf(loaded);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [doc.url]);

  useEffect(() => {
    const el = holder.current;
    if (!el) return;
    const measure = () => setWidth(Math.floor(el.clientWidth));
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!pdf || !width || !canvas.current) return;
    let cancelled = false;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let task: any = null;
    (async () => {
      const p = await pdf.getPage(page);
      if (cancelled || !canvas.current) return;
      const scale = (width / p.getViewport({ scale: 1 }).width) * Math.min(window.devicePixelRatio || 1, 2);
      const viewport = p.getViewport({ scale });
      const el = canvas.current;
      el.width = Math.floor(viewport.width);
      el.height = Math.floor(viewport.height);
      task = p.render({ canvasContext: el.getContext('2d')!, viewport });
      try {
        await task.promise;
      } catch {
        // A newer render replaced this one.
      }
    })();
    return () => {
      cancelled = true;
      task?.cancel?.();
    };
  }, [pdf, page, width]);

  // Bring the highlighted figure into view inside the pane (never scroll the whole page for it).
  useEffect(() => {
    if (!target?.bbox || target.page !== page) return;
    const frame = requestAnimationFrame(() => mark.current?.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' }));
    return () => cancelAnimationFrame(frame);
  }, [target, page]);

  const box = target && target.page === page ? target.bbox : null;

  return (
    <div className={cn('flex min-h-0 flex-col', className)}>
      <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-2 border-b border-line bg-surface px-3 py-2">
        <span className="hidden min-w-0 items-center gap-1.5 text-[12px] text-ink-3 sm:flex">
          <FileText className="size-3.5 shrink-0" />
          <span className="truncate font-medium text-ink-2">{doc.filename}</span>
        </span>
        <div className="flex min-w-0 max-w-full items-center gap-1 overflow-x-auto sm:ml-auto" role="tablist" aria-label="Pages of the sample package">
          {doc.pages.map((p) => (
            <button
              key={p.page}
              type="button"
              role="tab"
              aria-selected={p.page === page}
              onClick={() => onPage(p.page)}
              className={cn('focus-ring shrink-0 whitespace-nowrap rounded-full border px-2.5 py-1 text-[11.5px] transition-colors', p.page === page ? 'border-ink bg-ink font-medium text-white' : 'border-line text-ink-2 hover:border-line-strong hover:text-ink')}
            >
              {p.label}
              <span className={cn('ml-1.5', p.page === page ? 'text-white/60' : 'text-ink-4')}>p{p.page}</span>
            </button>
          ))}
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-auto bg-sunken/60 p-3 sm:p-4">
        <div ref={holder} className="mx-auto w-full max-w-[860px]">
          <div className="relative overflow-hidden rounded-sm bg-surface shadow-[0_0_0_1px_var(--color-line),0_2px_10px_rgb(11_18_32/0.07)]" style={{ aspectRatio: `${meta.width} / ${meta.height}`, minHeight: width ? Math.round(width * ratio) : undefined }}>
            {failed ? (
              <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 p-6 text-center text-[13px] text-ink-2">
                <p>The document could not be drawn in this browser.</p>
                <a href={doc.url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1.5 font-medium text-accent hover:underline">
                  Open the PDF <ExternalLink className="size-3.5" />
                </a>
              </div>
            ) : (
              <canvas ref={canvas} className={cn('block h-full w-full transition-opacity duration-300', pdf ? 'opacity-100' : 'opacity-0')} role="img" aria-label={`${meta.label}, page ${page} of ${doc.pageCount} of the sample billing package`} />
            )}
            {!pdf && !failed ? (
              <div className="absolute inset-0 space-y-3 p-8" aria-hidden>
                {Array.from({ length: 12 }, (_, i) => (
                  <div key={i} className="h-2 animate-shimmer rounded-full bg-sunken" style={{ width: `${42 + ((i * 23) % 50)}%` }} />
                ))}
              </div>
            ) : null}
            {box ? (
              <div
                key={target!.nonce}
                ref={mark}
                className="pointer-events-none absolute scroll-m-16 rounded-[3px] bg-accent/15 ring-2 ring-accent"
                style={{ left: `${box[0] * 100}%`, top: `${box[1] * 100}%`, width: `${box[2] * 100}%`, height: `${box[3] * 100}%`, animation: 'sample-mark 900ms ease-out 1' }}
              />
            ) : null}
            <style>{`@keyframes sample-mark { 0% { box-shadow: 0 0 0 12px rgb(31 79 209 / 0.28); } 100% { box-shadow: 0 0 0 0 rgb(31 79 209 / 0); } }`}</style>
          </div>
        </div>
      </div>
    </div>
  );
}
