import { ArrowRight, Check, Lock } from 'lucide-react';
import Link from '@/components/ui/link';
import { buttonClass } from '@/components/ui/button';
import type { SetupFollowUp, SetupStep, SetupSummary } from '@/lib/setup-guide';
import { cn } from '@/lib/utils';

/** How far setup has got, as a thin bar and a count. */
export function SetupMeter({ summary, className }: { summary: SetupSummary; className?: string }) {
  const pct = Math.round((summary.done / summary.total) * 100);
  return (
    <div className={cn('flex items-center gap-3', className)}>
      <div className="h-1.5 min-w-[80px] flex-1 overflow-hidden rounded-full bg-sunken" role="progressbar" aria-valuemin={0} aria-valuemax={summary.total} aria-valuenow={summary.done} aria-label="Setup progress">
        <div className="brand-gradient h-full rounded-full transition-[width] duration-500" style={{ width: `${Math.max(pct, 4)}%` }} />
      </div>
      <span className="num shrink-0 text-xs text-ink-3">
        {summary.done} of {summary.total} done
      </span>
    </div>
  );
}

/**
 * Every setup step in order. The next one is opened up with its action; the
 * rest stay one line each, so the list reads as a path and not as a form.
 * A step this member's role cannot do says who can, and offers no button.
 */
export function SetupSteps({ steps }: { steps: SetupStep[] }) {
  return (
    <ol className="relative">
      {steps.map((s, i) => (
        <li key={s.id} className={cn('relative flex gap-4 px-5 py-4', i > 0 && 'border-t border-line', s.next && 'bg-accent-soft/35')} aria-current={s.next ? 'step' : undefined}>
          <span
            className={cn(
              'mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full text-[11px] font-semibold',
              s.done ? 'bg-pass-soft text-pass' : s.next ? 'bg-ink text-white' : 'border border-line-strong text-ink-3',
            )}
          >
            {s.done ? <Check className="size-3.5" strokeWidth={2.5} aria-label="Done" /> : i + 1}
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
              <h3 className={cn('text-sm font-medium', s.done ? 'text-ink-2' : 'text-ink')}>{s.title}</h3>
              {s.done ? <span className="text-xs text-pass">Done</span> : s.next ? <span className="text-xs font-medium text-accent-ink">Next</span> : null}
            </div>
            {s.next || !s.done ? <p className="mt-1 max-w-[62ch] text-[13px] leading-[1.55] text-ink-2">{s.body}</p> : null}
            {s.next && s.hint ? <p className="mt-2 max-w-[62ch] text-[12.5px] leading-[1.55] text-ink-3">{s.hint}</p> : null}
            {s.next ? (
              <div className="mt-3">
                {s.allowed ? (
                  <Link href={s.href} className={buttonClass({ variant: 'primary', size: 'lg' })}>
                    {s.cta}
                    <ArrowRight className="size-4" />
                  </Link>
                ) : (
                  <p className="inline-flex items-center gap-2 rounded-md bg-surface px-3 py-2 text-[13px] text-ink-2 ring-1 ring-line">
                    <Lock className="size-3.5 text-ink-3" />
                    {s.who} Your role cannot do this step.
                  </p>
                )}
              </div>
            ) : null}
          </div>
          {!s.next && !s.done && s.allowed ? (
            <Link href={s.href} className="mt-0.5 shrink-0 self-start text-xs font-medium text-ink-3 hover:text-ink hover:underline">
              {s.cta}
            </Link>
          ) : null}
          {s.done && s.id !== 'organisation' ? (
            <Link href={s.href} className="mt-0.5 shrink-0 self-start text-xs text-ink-3 hover:text-ink hover:underline">
              Open
            </Link>
          ) : null}
        </li>
      ))}
    </ol>
  );
}

export function SetupFollowUps({ items }: { items: SetupFollowUp[] }) {
  return (
    <ul className="divide-y divide-line">
      {items.map((f) => (
        <li key={f.id} className="flex items-start gap-4 px-5 py-3.5">
          <span className={cn('mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full', f.done ? 'bg-pass-soft text-pass' : 'border border-dashed border-line-strong')}>{f.done ? <Check className="size-3" strokeWidth={2.5} aria-label="Done" /> : null}</span>
          <div className="min-w-0 flex-1">
            <h3 className={cn('text-[13px] font-medium', f.done && 'text-ink-2')}>{f.title}</h3>
            <p className="mt-0.5 text-xs leading-[1.5] text-ink-3">{f.body}</p>
          </div>
          {f.done ? (
            <span className="mt-0.5 text-xs text-pass">Done</span>
          ) : f.allowed ? (
            <Link href={f.href} className={buttonClass({ size: 'sm' })}>
              {f.cta}
            </Link>
          ) : (
            <span className="mt-0.5 max-w-[150px] text-right text-xs text-ink-3">An owner or admin does this</span>
          )}
        </li>
      ))}
    </ul>
  );
}
