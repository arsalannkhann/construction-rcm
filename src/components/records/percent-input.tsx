'use client';

import * as React from 'react';
import { Input } from '@/components/ui/form';
import { formatBps, parsePercentToBps } from '@/lib/money';
import { cn } from '@/lib/utils';

/** 1000 → "10", 750 → "7.5": the text a rate is edited as. */
export function bpsToPercentText(bps: number): string {
  return formatBps(bps).replace('%', '');
}

/** The message to show under a retainage field, or null when the text is a usable rate. */
export function retainageError(text: string): string | null {
  if (!text.trim()) return 'Enter a percentage; 0 if none is withheld.';
  const bps = parsePercentToBps(text);
  if (bps === null) return 'Enter a percentage such as 10 or 7.5.';
  return null;
}

/** A rate typed as a percentage. Holds the text as typed; parse it with parsePercentToBps. */
export function PercentInput({ className, ...rest }: Omit<React.InputHTMLAttributes<HTMLInputElement>, 'type'>) {
  return (
    <div className="relative">
      <Input inputMode="decimal" autoComplete="off" className={cn('num pr-7 text-right', className)} {...rest} />
      <span className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-ink-3">%</span>
    </div>
  );
}
