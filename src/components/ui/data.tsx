import * as React from 'react';
import { formatMoney } from '@/lib/money';
import { cn, initials } from '@/lib/utils';
import type { AppStatus } from '@/server/types';
import { APP_STATUS_LABEL } from '@/server/types';

// ── Layout ──────────────────────────────────────────────────────────────────

export function Page({ children, className, width = 'default' }: { children: React.ReactNode; className?: string; width?: 'default' | 'narrow' | 'wide' }) {
  const max = { default: 'max-w-[1180px]', narrow: 'max-w-[760px]', wide: 'max-w-[1400px]' }[width];
  return <div className={cn('mx-auto w-full px-4 pb-16 pt-7 sm:px-8', max, className)}>{children}</div>;
}

export function PageHeader({ title, description, actions, back }: { title: React.ReactNode; description?: React.ReactNode; actions?: React.ReactNode; back?: React.ReactNode }) {
  return (
    <header className="mb-6">
      {back ? <div className="mb-2 text-xs text-ink-3">{back}</div> : null}
      <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-3">
        <div className="min-w-0">
          <h1 className="text-[22px] font-semibold leading-7 text-ink">{title}</h1>
          {description ? <p className="mt-1 max-w-2xl text-[13px] text-ink-2">{description}</p> : null}
        </div>
        {actions ? <div className="flex max-w-full shrink-0 flex-wrap items-center gap-2">{actions}</div> : null}
      </div>
    </header>
  );
}

export function Panel({ children, className, ...rest }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div className={cn('rounded-xl border border-line bg-surface shadow-card', className)} {...rest}>
      {children}
    </div>
  );
}

export function PanelHeader({ title, description, actions, className }: { title: React.ReactNode; description?: React.ReactNode; actions?: React.ReactNode; className?: string }) {
  return (
    <div className={cn('flex flex-wrap items-start justify-between gap-x-4 gap-y-2 border-b border-line px-4 py-3', className)}>
      {/* At least 12rem for the title and description; the actions wrap below them on a narrow screen. */}
      <div className="min-w-0 flex-1 basis-48">
        <h2 className="text-[13px] font-semibold text-ink">{title}</h2>
        {description ? <p className="mt-0.5 text-xs text-ink-3">{description}</p> : null}
      </div>
      {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
    </div>
  );
}

export function EmptyState({ icon, title, description, action, className }: { icon?: React.ReactNode; title: React.ReactNode; description?: React.ReactNode; action?: React.ReactNode; className?: string }) {
  return (
    <div className={cn('flex flex-col items-center justify-center px-6 py-12 text-center', className)}>
      {icon ? <div className="mb-3 flex size-10 items-center justify-center rounded-full bg-sunken text-ink-3 [&>svg]:size-5">{icon}</div> : null}
      <h3 className="text-sm font-medium text-ink">{title}</h3>
      {description ? <p className="mt-1 max-w-sm text-[13px] text-ink-3">{description}</p> : null}
      {action ? <div className="mt-4 flex items-center gap-2">{action}</div> : null}
    </div>
  );
}

// ── Tables ──────────────────────────────────────────────────────────────────

/** A table that scrolls sideways when it is wider than its panel, rather than being cut off. */
export function Table({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <div className="overflow-x-auto">
      <table className={cn('w-full border-collapse text-left text-[13px]', className)}>{children}</table>
    </div>
  );
}
export function Th({ children, className, align }: { children?: React.ReactNode; className?: string; align?: 'right' | 'left' | 'center' }) {
  return <th className={cn('whitespace-nowrap border-b border-line px-3 py-2 text-[11px] font-medium uppercase tracking-wide text-ink-3', align === 'right' && 'text-right', align === 'center' && 'text-center', className)}>{children}</th>;
}
export function Td({ children, className, align, ...rest }: React.TdHTMLAttributes<HTMLTableCellElement> & { align?: 'right' | 'left' | 'center' }) {
  return (
    <td className={cn('border-b border-line px-3 py-2.5 align-middle', align === 'right' && 'num text-right', align === 'center' && 'text-center', className)} {...rest}>
      {children}
    </td>
  );
}

// ── Small pieces ────────────────────────────────────────────────────────────

export function Money({ cents, className, blank }: { cents: number | null | undefined; className?: string; blank?: string }) {
  return <span className={cn('num whitespace-nowrap', cents != null && cents < 0 && 'text-block', className)}>{formatMoney(cents, { blank })}</span>;
}

type Tone = 'neutral' | 'pass' | 'warn' | 'block' | 'accent' | 'muted';
const TONE: Record<Tone, string> = {
  neutral: 'bg-sunken text-ink-2 border-line',
  muted: 'bg-transparent text-ink-3 border-line',
  pass: 'bg-pass-soft text-pass border-pass-line',
  warn: 'bg-warn-soft text-warn border-warn-line',
  block: 'bg-block-soft text-block border-block-line',
  accent: 'bg-accent-soft text-accent-ink border-accent-line',
};

export function Badge({ children, tone = 'neutral', className, dot }: { children: React.ReactNode; tone?: Tone; className?: string; dot?: boolean }) {
  return (
    <span className={cn('inline-flex h-5 items-center gap-1 whitespace-nowrap rounded-full border px-2 text-[11px] font-medium leading-none', TONE[tone], className)}>
      {dot ? <span className="size-1.5 rounded-full bg-current" /> : null}
      {children}
    </span>
  );
}

const STATUS_TONE: Record<AppStatus, Tone> = {
  processing: 'accent',
  needs_matching: 'warn',
  needs_review: 'warn',
  pending_approval: 'accent',
  on_hold: 'neutral',
  approved: 'pass',
  rejected: 'block',
  void: 'muted',
};

export function StatusBadge({ status, className }: { status: string; className?: string }) {
  const s = status as AppStatus;
  return (
    <Badge tone={STATUS_TONE[s] ?? 'neutral'} dot className={className}>
      {APP_STATUS_LABEL[s] ?? status}
    </Badge>
  );
}

export function Avatar({ name, size = 'md', className }: { name: string; size?: 'sm' | 'md'; className?: string }) {
  return (
    <span
      className={cn('inline-flex shrink-0 select-none items-center justify-center rounded-full bg-ink/8 font-medium text-ink-2', size === 'sm' ? 'size-5 text-[9px]' : 'size-6 text-[10px]', className)}
      title={name}
      aria-hidden
    >
      {initials(name)}
    </span>
  );
}

export function Kbd({ children }: { children: React.ReactNode }) {
  return <kbd className="rounded border border-line bg-sunken px-1 font-mono text-[10px] text-ink-2">{children}</kbd>;
}

/** A labelled value in a definition-style grid. */
export function Stat({ label, children, className }: { label: React.ReactNode; children: React.ReactNode; className?: string }) {
  return (
    <div className={className}>
      <dt className="text-[11px] font-medium uppercase tracking-wide text-ink-3">{label}</dt>
      <dd className="mt-0.5 text-[13px] text-ink">{children}</dd>
    </div>
  );
}
