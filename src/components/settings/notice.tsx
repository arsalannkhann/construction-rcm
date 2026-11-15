import * as React from 'react';
import { cn } from '@/lib/utils';

type Tone = 'neutral' | 'pass' | 'warn' | 'block';

const TONE: Record<Tone, string> = {
  neutral: 'border-line bg-canvas text-ink-2',
  pass: 'border-pass-line bg-pass-soft text-pass',
  warn: 'border-warn-line bg-warn-soft text-warn',
  block: 'border-block-line bg-block-soft text-block',
};

/** A one- or two-line statement of fact about the page: an outcome, a status, or why something is read-only. */
export function Notice({ tone = 'neutral', icon, children, className }: { tone?: Tone; icon?: React.ReactNode; children: React.ReactNode; className?: string }) {
  return (
    <div role={tone === 'block' ? 'alert' : undefined} className={cn('flex items-start gap-2 rounded-md border px-3 py-2 text-[13px]', TONE[tone], className)}>
      {icon ? <span className="mt-0.5 flex shrink-0 [&>svg]:size-4">{icon}</span> : null}
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}
