'use client';

import { ArrowRight, Check, FileText, Lock, OctagonAlert, ScanLine, TriangleAlert } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useState, useSyncExternalStore } from 'react';
import { cn } from '@/lib/utils';

/**
 * The hero's product preview: the sample billing package going from a PDF to
 * a decision. The figures and findings are not written for this page. They
 * are the product's own output for the sample package (`/sample`), passed in
 * by the page, so the preview cannot show a result the product would not
 * produce. The left side is a drawing of the form, not the PDF itself; the
 * real pages are one click away.
 *
 * Stops on hover or focus, and shows the checked state without motion for
 * people who ask for reduced motion.
 */

export type HeroSample = {
  subcontractor: string;
  project: string;
  period: string;
  applicationNumber: number;
  pages: string[];
  /** The application summary as printed: line number, label, formatted amount, and whether the checks agree with it. */
  lines: Array<{ n: string; label: string; value: string; agrees: boolean }>;
  figuresRead: number;
  requested: string;
  verified: string;
  difference: string;
  passed: number;
  findings: Array<{ severity: 'blocking' | 'warning'; title: string; detail: string }>;
};

const STAGES = ['Arrives', 'Read', 'Checked', 'Decided'] as const;

function subscribeReducedMotion(cb: () => void) {
  const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
  mq.addEventListener('change', cb);
  return () => mq.removeEventListener('change', cb);
}

function useReducedMotion() {
  return useSyncExternalStore(
    subscribeReducedMotion,
    () => window.matchMedia('(prefers-reduced-motion: reduce)').matches,
    () => false,
  );
}

export function HeroPreview({ sample: s }: { sample: HeroSample }) {
  const reduced = useReducedMotion();
  const [stage, setStage] = useState(0);
  const [paused, setPaused] = useState(false);
  const shown = reduced ? 2 : stage;

  useEffect(() => {
    if (reduced || paused) return;
    const id = window.setTimeout(() => setStage((v) => (v + 1) % STAGES.length), stage >= 2 ? 4600 : 2400);
    return () => window.clearTimeout(id);
  }, [stage, paused, reduced]);

  const read = shown >= 1;
  const checked = shown >= 2;
  const decided = shown >= 3;
  const blocking = s.findings.filter((f) => f.severity === 'blocking').length;

  return (
    <div onMouseEnter={() => setPaused(true)} onMouseLeave={() => setPaused(false)} onFocus={() => setPaused(true)} onBlur={() => setPaused(false)}>
      <figure className="relative overflow-hidden rounded-2xl border border-line bg-surface shadow-float" aria-label="Sample pay application being reviewed in Zephric">
        <div className="brand-gradient h-[3px]" />
        <header className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-line px-4 py-3 sm:px-5">
          <div className="min-w-0">
            <p className="truncate text-[13px] font-semibold text-ink">
              Pay application #{s.applicationNumber} · {s.subcontractor}
            </p>
            <p className="truncate text-[12px] text-ink-3">
              {s.project} · period to {s.period}
            </p>
          </div>
          <span className="ml-auto rounded-full border border-warn-line bg-warn-soft px-2 py-0.5 text-[10px] font-medium uppercase tracking-[0.1em] text-warn">Sample data</span>
        </header>

        <div role="tablist" aria-label="Stage of the review" className="grid grid-cols-4 border-b border-line bg-canvas/60">
          {STAGES.map((label, i) => (
            <button
              key={label}
              type="button"
              role="tab"
              aria-selected={shown === i}
              onClick={() => setStage(i)}
              className={cn('focus-ring relative flex items-center justify-center gap-1.5 py-2.5 text-[12px] font-medium transition-colors', shown === i ? 'text-ink' : shown > i ? 'text-ink-2' : 'text-ink-4 hover:text-ink-3')}
            >
              <span className={cn('flex size-4 items-center justify-center rounded-full text-[9px] transition-colors', shown > i ? 'bg-aqua text-white' : shown === i ? 'bg-ink text-white' : 'border border-line-strong')}>
                {shown > i ? <Check className="size-2.5" strokeWidth={3} /> : i + 1}
              </span>
              <span className="hidden min-[400px]:inline">{label}</span>
              {shown === i && <span className="absolute inset-x-3 -bottom-px h-[2px] rounded-full bg-ink" />}
            </button>
          ))}
        </div>

        <div className="grid md:grid-cols-[minmax(0,1.08fr)_minmax(0,1fr)]">
          {/* The document: the application summary as it is printed on the form. */}
          <div className="relative border-b border-line bg-sunken/40 p-3 sm:p-4 md:border-b-0 md:border-r">
            <div className="relative rounded-md bg-surface px-3.5 pb-3 pt-3 shadow-[0_0_0_1px_var(--color-line),0_2px_8px_rgb(11_18_32/0.06)]">
              <p className="flex items-center gap-1.5 text-[9.5px] font-semibold uppercase tracking-[0.08em] text-ink-2">
                <FileText className="size-3 text-ink-4" />
                Application and certificate for payment
              </p>
              <p className="mt-0.5 text-[9.5px] text-ink-4">
                Page 1 of {s.pages.length} · {s.pages.join(' · ')}
              </p>
              <dl className="num mt-2.5 text-[11px] leading-[1.25] sm:text-[11.5px]">
                {s.lines.map((l) => {
                  const flagged = checked && !l.agrees;
                  return (
                    <div key={l.n} className={cn('-mx-1.5 flex items-center gap-2 rounded px-1.5 py-[3.5px] transition-colors duration-500', flagged && 'bg-block-soft ring-1 ring-block-line')}>
                      <dt className="flex min-w-0 flex-1 items-center gap-2 text-ink-2">
                        <span className="w-4 shrink-0 text-[9.5px] text-ink-4">{l.n}</span>
                        <span className="truncate">{l.label}</span>
                      </dt>
                      <dd className={cn('shrink-0 transition-colors duration-500', flagged ? 'font-semibold text-block' : read ? 'text-ink' : 'text-ink-3')}>{l.value}</dd>
                    </div>
                  );
                })}
              </dl>
              {shown === 1 && !reduced ? <div aria-hidden className="absolute inset-x-3 top-12 h-px bg-accent/60 shadow-[0_0_12px_2px_rgb(31_79_209/0.35)] [animation:scan_2.2s_ease-in-out_infinite]" /> : null}
            </div>
          </div>

          {/* What Zephric makes of it. */}
          <div className="flex min-h-[272px] flex-col p-3.5 sm:p-4">
            {!read ? (
              <div className="animate-in">
                <p className="text-[11px] font-medium uppercase tracking-[0.1em] text-ink-3">Received</p>
                <ul className="mt-2 space-y-1.5">
                  {s.pages.map((p, i) => (
                    <li key={p} className="flex items-center gap-2.5 rounded-lg border border-line px-2.5 py-2 text-[12.5px] text-ink">
                      <FileText className="size-3.5 text-ink-3" />
                      {p}
                      <span className="ml-auto text-[11px] text-ink-4">page {i + 1}</span>
                    </li>
                  ))}
                </ul>
                <p className="mt-3 text-[12px] leading-[1.5] text-ink-3">One PDF, sent the way subcontractors already send them.</p>
              </div>
            ) : !checked ? (
              <div className="animate-in">
                <p className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-[0.1em] text-aqua-ink">
                  <ScanLine className="size-3" /> Read from the document
                </p>
                <p className="num mt-2 text-[26px] font-semibold leading-none tracking-[-0.02em] text-ink">{s.figuresRead}</p>
                <p className="mt-1 text-[12.5px] text-ink-2">figures read, each tied to where it is printed.</p>
                <div className="mt-3 space-y-1.5">
                  {[76, 58, 88, 64].map((w, i) => (
                    <div key={i} className="flex items-center gap-2">
                      <span className="h-1.5 animate-shimmer rounded-full bg-sunken" style={{ width: `${w}%`, animationDelay: `${i * 120}ms` }} />
                      <span className="ml-auto h-1.5 w-10 animate-shimmer rounded-full bg-sunken" style={{ animationDelay: `${i * 120}ms` }} />
                    </div>
                  ))}
                </div>
                <p className="mt-3 text-[12px] leading-[1.5] text-ink-3">Next: every one is recomputed from the project’s records.</p>
              </div>
            ) : (
              <div className="flex flex-1 animate-in flex-col">
                <dl className="num overflow-hidden rounded-lg border border-line text-[12px]">
                  <div className="flex items-center justify-between gap-3 px-2.5 py-1.5">
                    <dt className="text-ink-3">Requested</dt>
                    <dd className="font-medium text-ink">{s.requested}</dd>
                  </div>
                  <div className="flex items-center justify-between gap-3 border-t border-line px-2.5 py-1.5">
                    <dt className="text-ink-3">Verified</dt>
                    <dd className="font-semibold text-ink">{s.verified}</dd>
                  </div>
                  <div className="flex items-center justify-between gap-3 border-t border-block-line bg-block-soft/60 px-2.5 py-1.5">
                    <dt className="font-medium text-block">Difference</dt>
                    <dd className="font-semibold text-block">{s.difference}</dd>
                  </div>
                </dl>
                <ul className="mt-2 space-y-1.5">
                  {s.findings.slice(0, 1).map((f) => (
                    <li key={f.title} className={cn('flex items-start gap-2 rounded-lg border px-2.5 py-2', f.severity === 'blocking' ? 'border-block-line bg-block-soft/60' : 'border-warn-line bg-warn-soft/60')}>
                      {f.severity === 'blocking' ? <OctagonAlert className="mt-0.5 size-3.5 shrink-0 text-block" /> : <TriangleAlert className="mt-0.5 size-3.5 shrink-0 text-warn" />}
                      <span className="min-w-0">
                        <span className="block text-[12px] font-medium leading-snug text-ink">{f.title}</span>
                        <span className="num mt-0.5 block text-[11px] leading-[1.4] text-ink-2">{f.detail}</span>
                      </span>
                    </li>
                  ))}
                </ul>
                <p className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11.5px]">
                  {s.findings.length > 1 ? <span className="text-ink-3">+ {s.findings.length - 1} more to look at</span> : null}
                  <span className="inline-flex items-center gap-1.5 text-pass">
                    <Check className="size-3" strokeWidth={3} /> {s.passed} checks passed
                  </span>
                </p>
                <div className={cn('mt-auto rounded-lg border border-line bg-canvas p-2.5 transition-opacity duration-500', decided ? 'opacity-100' : 'opacity-45')}>
                  <p className="flex items-center gap-1.5 text-[12px] font-medium text-ink">
                    <Lock className="size-3 text-ink-3" />
                    Approval locked by {blocking} blocking finding{blocking === 1 ? '' : 's'}
                  </p>
                  <p className="mt-0.5 text-[11px] leading-[1.45] text-ink-3">A person asks for a correction, or approves the verified amount with a written reason.</p>
                </div>
              </div>
            )}
          </div>
        </div>
      </figure>
      <p className="mt-3 flex flex-wrap items-center justify-between gap-x-4 gap-y-1 px-1 text-[12.5px] text-ink-3">
        <span>Fictitious companies. The findings are the product’s own output for this document.</span>
        <Link href="/sample" className="focus-ring group inline-flex items-center gap-1 rounded font-medium text-ink hover:underline">
          Open this sample
          <ArrowRight className="size-3.5 transition-transform group-hover:translate-x-0.5" />
        </Link>
      </p>
    </div>
  );
}
