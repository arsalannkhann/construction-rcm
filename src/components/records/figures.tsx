import * as React from 'react';
import { Badge, Money } from '@/components/ui/data';
import { formatMoney } from '@/lib/money';
import { cn } from '@/lib/utils';

/** A row of headline figures. Give it grid columns that divide the number of figures evenly. */
export function Figures({ children, className }: { children: React.ReactNode; className?: string }) {
  return <dl className={cn('grid gap-px overflow-hidden rounded-xl border border-line bg-line shadow-card', className)}>{children}</dl>;
}

export function Figure({ label, cents, note }: { label: React.ReactNode; cents: number; note?: React.ReactNode }) {
  return (
    <div className="min-w-0 bg-surface px-4 py-3">
      <dt className="text-[11px] font-medium uppercase tracking-wide text-ink-3">{label}</dt>
      <dd className="mt-1">
        <Money cents={cents} className="text-[17px] font-semibold leading-6" />
        {note ? <div className="mt-0.5 text-xs text-ink-3">{note}</div> : null}
      </dd>
    </div>
  );
}

/** Thin bar for percent complete. Anything past 100% is drawn full, in the warning colour. */
export function ProgressBar({ percent, className }: { percent: number | null; className?: string }) {
  const value = Math.max(0, Math.min(100, percent ?? 0));
  return (
    <div
      className={cn('h-1 w-full overflow-hidden rounded-full bg-sunken', className)}
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={value}
      aria-label="Percent complete"
    >
      <div className={cn('h-full rounded-full', percent !== null && percent > 100 ? 'bg-warn' : 'bg-ink-2')} style={{ width: `${value}%` }} />
    </div>
  );
}

/** A short in-page note. `warn` means the record needs attention; `neutral` is explanation. */
export function Note({ tone = 'neutral', children, className }: { tone?: 'warn' | 'neutral'; children: React.ReactNode; className?: string }) {
  return (
    <div className={cn('rounded-md border px-3 py-2 text-[13px]', tone === 'warn' ? 'border-warn-line bg-warn-soft text-warn' : 'border-line bg-canvas text-ink-2', className)}>
      {children}
    </div>
  );
}

export function RecordStatusBadge({ status }: { status: string }) {
  return status === 'closed' ? <Badge tone="muted">Closed</Badge> : <Badge tone="neutral">Active</Badge>;
}

const CHANGE_ORDER_STATUS: Record<string, { label: string; tone: 'warn' | 'pass' | 'block' | 'muted' }> = {
  pending: { label: 'Pending', tone: 'warn' },
  approved: { label: 'Approved', tone: 'pass' },
  rejected: { label: 'Rejected', tone: 'block' },
  void: { label: 'Void', tone: 'muted' },
};

export function ChangeOrderStatusBadge({ status }: { status: string }) {
  const s = CHANGE_ORDER_STATUS[status];
  return (
    <Badge tone={s?.tone ?? 'neutral'} dot>
      {s?.label ?? status}
    </Badge>
  );
}

/**
 * Says whether a schedule of values adds up to the contract. `saving` is the
 * wording used while editing, before the change has been made.
 */
export function ScheduleDifference({
  scheduleTotal,
  contractAmount,
  amountLabel = 'contract amount',
  saving = false,
  className,
}: {
  scheduleTotal: number;
  contractAmount: number;
  amountLabel?: string;
  saving?: boolean;
  className?: string;
}) {
  if (scheduleTotal === contractAmount) return null;
  return (
    <Note tone="warn" className={className}>
      The schedule totals <span className="num font-medium">{formatMoney(scheduleTotal)}</span>; the {amountLabel} is <span className="num font-medium">{formatMoney(contractAmount)}</span> — a difference of{' '}
      <span className="num font-medium">{formatMoney(Math.abs(scheduleTotal - contractAmount))}</span>. {saving ? 'You can save, but applications will be flagged until they agree.' : 'Applications are flagged until they agree.'}
    </Note>
  );
}
