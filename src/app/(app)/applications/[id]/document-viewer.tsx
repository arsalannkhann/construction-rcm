'use client';

import { Download, FileWarning, Minus, Plus, Trash2 } from 'lucide-react';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/data';
import { Dialog, Tooltip } from '@/components/ui/overlay';
import { useAction } from '@/lib/use-action';
import { cn } from '@/lib/utils';
import { removeDocumentAction } from '../actions';
import type { BBox, DocumentSegment } from '@/server/types';
import { DOC_TYPE_LABEL } from '@/server/types';

export type ViewerDocument = {
  id: string;
  filename: string;
  mimeType: string;
  pageCount: number | null;
  status: string;
  statusDetail: string | null;
  segments: DocumentSegment[];
};

/** Where to look. `nonce` changes on every request so asking for the same spot twice still scrolls and flashes. */
export type ViewerTarget = { documentId: string; page: number; bbox?: BBox | null; nonce: number };

// pdf.js is served from /public and imported at runtime, so the bundler never touches it.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type PdfJs = any;
let pdfjsPromise: Promise<PdfJs> | null = null;
function loadPdfJs(): Promise<PdfJs> {
  if (!pdfjsPromise) {
    const runtimeImport = new Function('url', 'return import(url)') as (url: string) => Promise<PdfJs>;
    pdfjsPromise = runtimeImport('/pdfjs/pdf.min.mjs').then((lib) => {
      lib.GlobalWorkerOptions.workerSrc = '/pdfjs/pdf.worker.min.mjs';
      return lib;
    });
    pdfjsPromise.catch(() => {
      pdfjsPromise = null;
    });
  }
  return pdfjsPromise;
}

const SEGMENT_SHORT: Record<string, string> = {
  pay_application: 'Pay application',
  continuation_sheet: 'Schedule of values',
  lien_waiver: 'Lien waiver',
  invoice: 'Invoice',
  change_order: 'Change order',
  contract: 'Contract',
  insurance: 'Insurance',
  other: 'Other',
};

export function DocumentViewer({
  documents,
  target,
  onNavigate,
  canRemove = false,
}: {
  documents: ViewerDocument[];
  target: ViewerTarget | null;
  onNavigate: (t: Omit<ViewerTarget, 'nonce'>) => void;
  /** The reviewer may take a file out of the package (an open application, more than one file). */
  canRemove?: boolean;
}) {
  const [activeId, setActiveId] = useState(target?.documentId ?? documents[0]?.id ?? null);
  const [zoom, setZoom] = useState(1);
  const [removing, setRemoving] = useState(false);
  const { pending, run } = useAction();
  useEffect(() => {
    if (target && documents.some((d) => d.id === target.documentId)) setActiveId(target.documentId);
  }, [target, documents]);
  const active = documents.find((d) => d.id === activeId) ?? documents[0];

  if (!active) {
    return <div className="flex h-full items-center justify-center text-[13px] text-ink-3">No documents in this package.</div>;
  }
  const isPdf = active.mimeType === 'application/pdf';
  const isImage = active.mimeType.startsWith('image/');
  const url = `/api/documents/${active.id}/file`;

  return (
    <div className="flex h-full min-h-0 flex-col bg-sunken/60">
      <div className="flex shrink-0 items-center gap-2 border-b border-line bg-surface px-3 py-1.5">
        <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
          {documents.map((d) => (
            <button
              key={d.id}
              onClick={() => setActiveId(d.id)}
              className={cn(
                'focus-ring flex h-7 max-w-[220px] shrink-0 items-center gap-1.5 rounded-md px-2 text-xs',
                d.id === active.id ? 'bg-ink/[0.07] font-medium text-ink' : 'text-ink-2 hover:bg-ink/[0.045]',
              )}
              title={d.filename}
            >
              {d.status === 'unreadable' || d.status === 'failed' ? <FileWarning className="size-3.5 shrink-0 text-block" /> : null}
              <span className="truncate">{d.filename}</span>
              {d.pageCount ? <span className="shrink-0 text-ink-4">{d.pageCount}p</span> : null}
            </button>
          ))}
        </div>
        {isPdf ? (
          <div className="flex shrink-0 items-center gap-0.5">
            <Tooltip content="Zoom out">
              <button className="focus-ring rounded p-1 text-ink-3 hover:bg-sunken hover:text-ink disabled:opacity-40" onClick={() => setZoom((z) => Math.max(0.6, Math.round((z - 0.2) * 10) / 10))} disabled={zoom <= 0.6} aria-label="Zoom out">
                <Minus className="size-3.5" />
              </button>
            </Tooltip>
            <button className="focus-ring num w-11 rounded py-0.5 text-center text-[11px] text-ink-2 hover:bg-sunken" onClick={() => setZoom(1)} aria-label="Reset zoom">
              {Math.round(zoom * 100)}%
            </button>
            <Tooltip content="Zoom in">
              <button className="focus-ring rounded p-1 text-ink-3 hover:bg-sunken hover:text-ink disabled:opacity-40" onClick={() => setZoom((z) => Math.min(2.4, Math.round((z + 0.2) * 10) / 10))} disabled={zoom >= 2.4} aria-label="Zoom in">
                <Plus className="size-3.5" />
              </button>
            </Tooltip>
          </div>
        ) : null}
        <Tooltip content="Download the original file">
          <a href={url} download={active.filename} className="focus-ring shrink-0 rounded p-1 text-ink-3 hover:bg-sunken hover:text-ink" aria-label="Download the original file">
            <Download className="size-3.5" />
          </a>
        </Tooltip>
        {canRemove && documents.length > 1 ? (
          <Tooltip content="Remove from this package">
            <button className="focus-ring shrink-0 rounded p-1 text-ink-3 hover:bg-sunken hover:text-block" onClick={() => setRemoving(true)} aria-label="Remove from this package">
              <Trash2 className="size-3.5" />
            </button>
          </Tooltip>
        ) : null}
      </div>
      <Dialog
        open={removing}
        onOpenChange={setRemoving}
        size="sm"
        title={`Remove “${active.filename}” from this package?`}
        description="The package is read again without it. The original file stays stored, and the removal is recorded in the activity log."
        footer={
          <>
            <Button onClick={() => setRemoving(false)}>Cancel</Button>
            <Button variant="danger" loading={pending} onClick={() => run(() => removeDocumentAction(active.id), { success: 'Removed. The package is being read again.', onSuccess: () => setRemoving(false) })}>
              Remove and read again
            </Button>
          </>
        }
      />

      {active.segments.length > 0 ? (
        <div className="flex shrink-0 items-center gap-1.5 overflow-x-auto border-b border-line bg-surface px-3 py-1.5">
          <span className="shrink-0 text-[11px] text-ink-3">Contains</span>
          {active.segments.map((s, i) => (
            <button
              key={i}
              onClick={() => onNavigate({ documentId: active.id, page: s.pageStart })}
              className="focus-ring shrink-0 rounded-full border border-line bg-surface px-2 py-0.5 text-[11px] text-ink-2 hover:border-line-strong hover:text-ink"
              title={DOC_TYPE_LABEL[s.type]}
            >
              {SEGMENT_SHORT[s.type] ?? s.type}
              <span className="ml-1 text-ink-4">p{s.pageStart}{s.pageEnd !== s.pageStart ? `–${s.pageEnd}` : ''}</span>
            </button>
          ))}
        </div>
      ) : null}

      {active.status === 'unreadable' || active.status === 'failed' ? (
        <div className="shrink-0 border-b border-block-line bg-block-soft px-3 py-2 text-xs text-block">
          <span className="font-medium">Not read automatically.</span> {active.statusDetail ?? 'Key the values from this document by hand.'}
        </div>
      ) : null}

      <div className="min-h-0 flex-1">
        {isPdf ? (
          <PdfView key={active.id} url={url} zoom={zoom} target={target && target.documentId === active.id ? target : null} />
        ) : isImage ? (
          <div className="h-full overflow-auto p-4">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={url} alt={active.filename} className="mx-auto max-w-full rounded border border-line bg-surface shadow-card" style={{ width: `${zoom * 100}%` }} />
          </div>
        ) : (
          <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
            <Badge tone="neutral">{active.mimeType || 'Unknown type'}</Badge>
            <p className="max-w-xs text-[13px] text-ink-2">This file type cannot be previewed here. The original is stored unchanged.</p>
            <a href={url} download={active.filename} className="text-[13px] font-medium text-accent hover:underline">
              Download {active.filename}
            </a>
          </div>
        )}
      </div>
    </div>
  );
}

function PdfView({ url, zoom, target }: { url: string; zoom: number; target: ViewerTarget | null }) {
  const scroller = useRef<HTMLDivElement>(null);
  const [pdf, setPdf] = useState<PdfJs | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [width, setWidth] = useState(0);
  const [ratio, setRatio] = useState(792 / 612);

  useEffect(() => {
    let cancelled = false;
    let task: PdfJs = null;
    setPdf(null);
    setError(null);
    loadPdfJs()
      .then((lib) => {
        if (cancelled) return null;
        task = lib.getDocument({ url, withCredentials: true });
        return task.promise;
      })
      .then(async (doc: PdfJs) => {
        if (cancelled || !doc) return;
        const first = await doc.getPage(1);
        const vp = first.getViewport({ scale: 1 });
        if (cancelled) return;
        setRatio(vp.height / vp.width);
        setPdf(doc);
      })
      .catch(() => {
        if (!cancelled) setError('The document could not be displayed. You can still download the original.');
      });
    return () => {
      cancelled = true;
      task?.destroy?.();
    };
  }, [url]);

  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const measure = () => setWidth(Math.max(200, el.clientWidth - 32));
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  if (error) return <div className="flex h-full items-center justify-center px-6 text-center text-[13px] text-ink-2">{error}</div>;

  const pageWidth = Math.round(width * zoom);
  return (
    <div ref={scroller} className="h-full overflow-auto px-4 py-4">
      {!pdf || width === 0 ? (
        <div className="mx-auto animate-pulse rounded border border-line bg-surface" style={{ width: pageWidth || '100%', aspectRatio: `1 / ${ratio}` }} />
      ) : (
        <div className="mx-auto flex flex-col gap-4" style={{ width: pageWidth }}>
          {Array.from({ length: pdf.numPages }, (_, i) => (
            <PdfPage key={i + 1} pdf={pdf} number={i + 1} width={pageWidth} fallbackRatio={ratio} scroller={scroller} target={target && target.page === i + 1 ? target : null} total={pdf.numPages} />
          ))}
        </div>
      )}
    </div>
  );
}

function PdfPage({ pdf, number, width, fallbackRatio, scroller, target, total }: { pdf: PdfJs; number: number; width: number; fallbackRatio: number; scroller: React.RefObject<HTMLDivElement | null>; target: ViewerTarget | null; total: number }) {
  const holder = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const mark = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(number <= 2);
  const [ratio, setRatio] = useState(fallbackRatio);

  // Render pages only when they are near the viewport.
  useEffect(() => {
    const el = holder.current;
    if (!el || visible) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) setVisible(true);
      },
      { root: scroller.current, rootMargin: '800px 0px' },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [visible, scroller]);

  // A request to look at this page counts as "near the viewport".
  useEffect(() => {
    if (target) setVisible(true);
  }, [target]);

  useEffect(() => {
    if (!visible || !canvas.current || width === 0) return;
    let cancelled = false;
    let task: PdfJs = null;
    (async () => {
      const page = await pdf.getPage(number);
      if (cancelled || !canvas.current) return;
      const base = page.getViewport({ scale: 1 });
      setRatio(base.height / base.width);
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const viewport = page.getViewport({ scale: (width / base.width) * dpr });
      const el = canvas.current;
      el.width = Math.floor(viewport.width);
      el.height = Math.floor(viewport.height);
      const ctx = el.getContext('2d');
      if (!ctx) return;
      task = page.render({ canvasContext: ctx, viewport });
      try {
        await task.promise;
      } catch {
        /* cancelled by a newer render */
      }
    })();
    return () => {
      cancelled = true;
      task?.cancel?.();
    };
  }, [pdf, number, width, visible]);

  // Bring the requested spot into view.
  useEffect(() => {
    if (!target) return;
    const el = (target.bbox ? mark.current : null) ?? holder.current;
    const frame = requestAnimationFrame(() => el?.scrollIntoView({ block: target.bbox ? 'center' : 'start', behavior: 'smooth' }));
    return () => cancelAnimationFrame(frame);
  }, [target]);

  const box = target?.bbox;
  return (
    <div ref={holder} className={cn('relative rounded-sm bg-surface shadow-[0_0_0_1px_var(--color-line),0_2px_8px_rgb(26_26_24/0.06)]', target && !box && 'ring-2 ring-accent/60')} style={{ width, height: Math.round(width * ratio) }}>
      <canvas ref={canvas} className="block h-full w-full" aria-label={`Page ${number} of ${total}`} />
      {box ? (
        <div
          key={target.nonce}
          ref={mark}
          className="pointer-events-none absolute rounded-[3px] bg-accent/15 ring-2 ring-accent"
          style={{
            left: `${box[0] * 100}%`,
            top: `${box[1] * 100}%`,
            width: `${box[2] * 100}%`,
            height: `${box[3] * 100}%`,
            animation: 'viewer-mark 900ms ease-out 1',
          }}
        />
      ) : null}
      <span className="num pointer-events-none absolute bottom-1.5 right-2 rounded bg-surface/85 px-1 text-[10px] text-ink-3">
        {number} / {total}
      </span>
      <style>{`@keyframes viewer-mark { 0% { box-shadow: 0 0 0 10px rgb(31 79 209 / 0.28); } 100% { box-shadow: 0 0 0 0 rgb(31 79 209 / 0); } }`}</style>
    </div>
  );
}
