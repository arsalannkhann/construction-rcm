'use client';

import { Check, FileText, OctagonAlert, ScanLine } from 'lucide-react';
import { useEffect, useState, useSyncExternalStore } from 'react';
import { cn } from '@/lib/utils';

/**
 * The hero's product preview: one pay application moving through capture,
 * extraction, reconciliation and review. The figures are illustrative and
 * internally consistent; the one finding (too little retainage withheld) is
 * a blocking check in the real engine, so approval is refused until it is
 * corrected or overridden with a written reason. Stops on hover or focus, and shows the
 * finished state without motion for people who ask for reduced motion.
 */

const STAGES = ['Capture', 'Extract', 'Reconcile', 'Review'] as const;

const LINES: Array<{ n: string; label: string; value: string; flag?: boolean; strong?: boolean }> = [
  { n: '1', label: 'Original contract sum', value: '500,000.00' },
  { n: '2', label: 'Net change by change orders', value: '25,000.00' },
  { n: '3', label: 'Contract sum to date', value: '525,000.00' },
  { n: '4', label: 'Completed & stored to date', value: '350,000.00' },
  { n: '5', label: 'Retainage (10%)', value: '30,000.00', flag: true },
  { n: '6', label: 'Earned less retainage', value: '320,000.00' },
  { n: '7', label: 'Less previous certificates', value: '250,000.00' },
  { n: '8', label: 'Current payment due', value: '70,000.00', strong: true },
];

const CHECKS: Array<{ label: string; detail: string; ok: boolean }> = [
  { label: 'Contract sum', detail: 'Matches contract + CO-003', ok: true },
  { label: 'Previous certificates', detail: 'Matches pay application No. 006', ok: true },
  { label: 'Schedule of values', detail: '14 lines sum to $350,000.00', ok: true },
  { label: 'Too little retainage withheld', detail: '$5,000.00 short of 10% ($35,000.00)', ok: false },
];

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

export function HeroPreview() {
  const reduced = useReducedMotion();
  const [stage, setStage] = useState(0);
  const [paused, setPaused] = useState(false);
  const shown = reduced ? 3 : stage;

  useEffect(() => {
    if (reduced || paused) return;
    const id = window.setTimeout(() => setStage((s) => (s + 1) % STAGES.length), stage === 3 ? 4200 : 2400);
    return () => window.clearTimeout(id);
  }, [stage, paused, reduced]);

  const extracted = shown >= 1;
  const reconciled = shown >= 2;
  const reviewing = shown >= 3;

  return (
    <div
      className="relative"
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      onFocus={() => setPaused(true)}
      onBlur={() => setPaused(false)}
    >
      {/* The source document, peeking out behind the workspace. */}
      <div aria-hidden className="absolute -right-3 -top-5 hidden h-[78%] w-[46%] rotate-[3deg] rounded-xl border border-line bg-surface p-5 shadow-pop sm:block">
        <div className="flex items-center gap-2 text-[10px] font-medium uppercase tracking-[0.12em] text-ink-4">
          <FileText className="size-3" /> G702 · page 1 of 3
        </div>
        <div className="mt-4 space-y-2.5">
          {Array.from({ length: 9 }, (_, i) => (
            <div key={i} className="flex items-center gap-3">
              <div className="h-1.5 rounded-full bg-sunken" style={{ width: `${38 + ((i * 17) % 30)}%` }} />
              <div className="ml-auto h-1.5 w-12 rounded-full bg-sunken" />
            </div>
          ))}
        </div>
        {shown === 0 && !reduced && <div className="absolute inset-x-4 top-10 h-px bg-accent/60 shadow-[0_0_12px_2px_rgb(31_79_209/0.35)] [animation:scan_2.2s_ease-in-out_infinite]" />}
      </div>

      <figure
        className="relative overflow-hidden rounded-2xl border border-line bg-surface shadow-float"
        aria-label="Illustrative pay application review in Zephric"
      >
        <div className="brand-gradient h-[3px]" />
        <header className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-line px-5 py-3.5">
          <div className="min-w-0">
            <p className="text-[13px] font-semibold text-ink">Pay application No. 007</p>
            <p className="text-[12px] text-ink-3">Apex Concrete, Inc. · Riverside Medical, Phase 2 · Oct 31</p>
          </div>
          <span className="ml-auto rounded-full border border-line bg-sunken px-2 py-0.5 text-[10px] font-medium uppercase tracking-[0.1em] text-ink-3">Illustrative</span>
        </header>

        {/* Stage selector */}
        <div role="tablist" aria-label="Workflow stage" className="grid grid-cols-4 border-b border-line bg-canvas/60">
          {STAGES.map((s, i) => (
            <button
              key={s}
              type="button"
              role="tab"
              aria-selected={shown === i}
              onClick={() => setStage(i)}
              className={cn(
                'focus-ring relative flex items-center justify-center gap-1.5 py-2.5 text-[12px] font-medium transition-colors',
                shown === i ? 'text-ink' : shown > i ? 'text-ink-2' : 'text-ink-4 hover:text-ink-3',
              )}
            >
              <span
                className={cn(
                  'flex size-4 items-center justify-center rounded-full text-[9px] transition-colors',
                  shown > i ? 'bg-aqua text-white' : shown === i ? 'bg-ink text-white' : 'border border-line-strong',
                )}
              >
                {shown > i ? <Check className="size-2.5" strokeWidth={3} /> : i + 1}
              </span>
              <span className="hidden min-[420px]:inline">{s}</span>
              {shown === i && <span className="absolute inset-x-3 -bottom-px h-[2px] rounded-full bg-ink" />}
            </button>
          ))}
        </div>

        <div className="grid md:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)]">
          {/* Extracted G702 summary */}
          <div className="border-b border-line p-4 md:border-b-0 md:border-r">
            <div className="mb-2 flex items-center justify-between">
              <p className="text-[11px] font-medium uppercase tracking-[0.1em] text-ink-3">Application summary</p>
              <p className={cn('flex items-center gap-1 text-[11px] transition-opacity', extracted ? 'text-aqua-ink opacity-100' : 'opacity-0')}>
                <ScanLine className="size-3" /> Read from document
              </p>
            </div>
            <dl className="num text-[12.5px]">
              {LINES.map((l, i) => (
                <div
                  key={l.n}
                  className={cn(
                    'flex items-center gap-2 rounded-md px-2 py-[5px] transition-colors duration-500',
                    l.flag && reviewing && 'bg-block-soft',
                    l.strong && 'mt-1 border-t border-line pt-2',
                  )}
                >
                  <dt className={cn('flex min-w-0 flex-1 items-center gap-2', l.strong ? 'font-medium text-ink' : 'text-ink-2')}>
                    <span className="w-3 shrink-0 text-[10px] text-ink-4">{l.n}</span>
                    <span className="truncate">{l.label}</span>
                  </dt>
                  <dd className="relative h-4 w-[92px] shrink-0 text-right">
                    <span
                      className={cn('absolute inset-0 transition-all duration-500', extracted ? 'opacity-100' : 'translate-y-1 opacity-0', l.strong ? 'font-semibold text-ink' : 'text-ink', l.flag && reviewing && 'text-block')}
                      style={{ transitionDelay: extracted && !reduced ? `${i * 70}ms` : '0ms' }}
                    >
                      ${l.value}
                    </span>
                    <span className={cn('absolute right-0 top-1 h-2 w-16 rounded-full bg-sunken transition-opacity', extracted ? 'opacity-0' : 'animate-shimmer opacity-100')} />
                  </dd>
                </div>
              ))}
            </dl>
          </div>

          {/* Checks and review */}
          <div className="flex flex-col p-4">
            <p className="mb-2 text-[11px] font-medium uppercase tracking-[0.1em] text-ink-3">Checks</p>
            <ul className="relative space-y-1.5">
              {!reconciled && (
                <li aria-hidden className="absolute inset-0 space-y-1.5">
                  {CHECKS.map((c) => (
                    <div key={c.label} className="flex h-[50px] items-center gap-2.5 rounded-lg border border-dashed border-line px-2.5">
                      <span className="size-4 rounded-full bg-sunken" />
                      <span className="h-2 w-24 animate-shimmer rounded-full bg-sunken" />
                    </div>
                  ))}
                </li>
              )}
              {CHECKS.map((c, i) => (
                <li
                  key={c.label}
                  className={cn(
                    'flex items-start gap-2.5 rounded-lg border px-2.5 py-2 transition-all duration-500',
                    reconciled ? 'translate-y-0 opacity-100' : 'translate-y-1 opacity-0',
                    !c.ok && reviewing ? 'border-block-line bg-block-soft/70' : 'border-line',
                  )}
                  style={{ transitionDelay: reconciled && !reduced ? `${i * 110}ms` : '0ms' }}
                >
                  <span className={cn('mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full', c.ok ? 'bg-pass-soft text-pass' : 'bg-block-soft text-block')}>
                    {c.ok ? <Check className="size-2.5" strokeWidth={3} /> : <OctagonAlert className="size-2.5" strokeWidth={2.5} />}
                  </span>
                  <span className="min-w-0">
                    <span className="block text-[12px] font-medium text-ink">{c.label}</span>
                    <span className="num block text-[11.5px] text-ink-3">{c.detail}</span>
                  </span>
                </li>
              ))}
            </ul>

            <div className={cn('mt-3 rounded-lg border border-line bg-canvas p-3 transition-all duration-500', reviewing ? 'opacity-100' : 'opacity-40')}>
              <p className="text-[12px] font-medium text-ink">{reviewing ? 'Approval blocked by 1 finding' : 'Review'}</p>
              <p className="mt-0.5 text-[11.5px] text-ink-3">{reviewing ? 'Request a correction, or override it with a written reason kept on the approval record.' : 'Opens once every check has run.'}</p>
              <div className="mt-2.5 flex gap-2">
                <span className="inline-flex h-7 items-center whitespace-nowrap rounded-md bg-ink px-2.5 text-[11.5px] font-medium text-white">Request correction</span>
                <span className="inline-flex h-7 items-center whitespace-nowrap rounded-md border border-line px-2.5 text-[11.5px] font-medium text-ink-4">Approve</span>
              </div>
            </div>
          </div>
        </div>
      </figure>
    </div>
  );
}
