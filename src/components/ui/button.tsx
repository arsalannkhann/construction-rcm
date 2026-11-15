import { Loader2 } from 'lucide-react';
import * as React from 'react';
import { cn } from '@/lib/utils';

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'danger-outline' | 'accent';
type Size = 'sm' | 'md' | 'lg';

const VARIANT: Record<Variant, string> = {
  primary: 'bg-ink text-white hover:bg-ink/88 active:bg-ink',
  accent: 'bg-accent text-white hover:bg-accent-ink',
  secondary: 'bg-surface text-ink border border-line-strong hover:bg-sunken/70 active:bg-sunken',
  ghost: 'text-ink-2 hover:bg-sunken hover:text-ink',
  danger: 'bg-block text-white hover:bg-block/90',
  'danger-outline': 'bg-surface text-block border border-block-line hover:bg-block-soft',
};
const SIZE: Record<Size, string> = {
  sm: 'h-7 px-2.5 text-xs gap-1.5 rounded-md',
  md: 'h-8 px-3 text-[13px] gap-1.5 rounded-md',
  lg: 'h-10 px-4 text-sm gap-2 rounded-lg',
};

/** Class string for things that should look like a button but are not one (links). */
export function buttonClass(opts: { variant?: Variant; size?: Size; className?: string } = {}): string {
  return cn(
    'focus-ring inline-flex shrink-0 select-none items-center justify-center whitespace-nowrap font-medium transition-colors disabled:pointer-events-none disabled:opacity-50',
    VARIANT[opts.variant ?? 'secondary'],
    SIZE[opts.size ?? 'md'],
    opts.className,
  );
}

export type ButtonProps = React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: Size; loading?: boolean };

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant, size, loading, className, children, disabled, type, ...rest },
  ref,
) {
  return (
    <button ref={ref} type={type ?? 'button'} disabled={disabled || loading} className={buttonClass({ variant, size, className })} {...rest}>
      {loading ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : null}
      {children}
    </button>
  );
});
