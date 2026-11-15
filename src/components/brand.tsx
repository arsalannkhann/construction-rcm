import { cn } from '@/lib/utils';

/** The mark: a ledger rule and a plumb line — figures that are level and true. */
export function BrandMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={cn('size-6', className)} aria-hidden>
      <rect width="24" height="24" rx="6" fill="#1a1a18" />
      <path d="M6.5 8h11M6.5 12h7M6.5 16h4" stroke="#fff" strokeWidth="1.7" strokeLinecap="round" />
      <path d="M17.5 11.2v5.6" stroke="#7ea0ff" strokeWidth="1.7" strokeLinecap="round" />
      <circle cx="17.5" cy="17.2" r="1.25" fill="#7ea0ff" />
    </svg>
  );
}

export function Brand({ className }: { className?: string }) {
  return (
    <span className={cn('inline-flex items-center gap-2', className)}>
      <BrandMark />
      <span className="text-sm font-semibold tracking-tight text-ink">Construction RCM</span>
    </span>
  );
}
