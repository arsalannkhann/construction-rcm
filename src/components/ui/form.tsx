'use client';

import * as React from 'react';
import { formatMoney, parseMoney } from '@/lib/money';
import { cn } from '@/lib/utils';

const CONTROL =
  'w-full rounded-md border border-line-strong bg-surface px-2.5 text-[13px] text-ink placeholder:text-ink-4 transition-shadow ' +
  'focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/20 disabled:bg-sunken disabled:text-ink-3 aria-[invalid=true]:border-block';

export const Input = React.forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(function Input({ className, ...rest }, ref) {
  return <input ref={ref} className={cn(CONTROL, 'h-8', className)} {...rest} />;
});

export const Textarea = React.forwardRef<HTMLTextAreaElement, React.TextareaHTMLAttributes<HTMLTextAreaElement>>(function Textarea({ className, ...rest }, ref) {
  return <textarea ref={ref} className={cn(CONTROL, 'min-h-20 py-1.5 leading-5', className)} {...rest} />;
});

export const Select = React.forwardRef<HTMLSelectElement, React.SelectHTMLAttributes<HTMLSelectElement>>(function Select({ className, children, ...rest }, ref) {
  return (
    <select
      ref={ref}
      className={cn(
        CONTROL,
        'h-8 appearance-none bg-[length:14px] bg-[right_8px_center] bg-no-repeat pr-7',
        "bg-[url('data:image/svg+xml;utf8,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20viewBox%3D%220%200%2024%2024%22%20fill%3D%22none%22%20stroke%3D%22%2385847d%22%20stroke-width%3D%222%22%20stroke-linecap%3D%22round%22%20stroke-linejoin%3D%22round%22%3E%3Cpath%20d%3D%22m6%209%206%206%206-6%22%2F%3E%3C%2Fsvg%3E')]",
        className,
      )}
      {...rest}
    >
      {children}
    </select>
  );
});

export function Checkbox({ className, label, description, ...rest }: React.InputHTMLAttributes<HTMLInputElement> & { label: React.ReactNode; description?: React.ReactNode }) {
  return (
    <label className={cn('flex cursor-pointer items-start gap-2.5', rest.disabled && 'cursor-not-allowed opacity-60', className)}>
      <input type="checkbox" className="mt-0.5 size-3.5 shrink-0 rounded border-line-strong accent-ink" {...rest} />
      <span className="min-w-0">
        <span className="block text-[13px] text-ink">{label}</span>
        {description ? <span className="block text-xs text-ink-3">{description}</span> : null}
      </span>
    </label>
  );
}

export function Field({
  label,
  hint,
  error,
  optional,
  className,
  children,
}: {
  label: React.ReactNode;
  hint?: React.ReactNode;
  error?: string | null;
  optional?: boolean;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <label className={cn('block', className)}>
      <span className="mb-1 flex items-baseline justify-between gap-2">
        <span className="text-xs font-medium text-ink-2">{label}</span>
        {optional ? <span className="text-[11px] text-ink-4">Optional</span> : null}
      </span>
      {children}
      {error ? <span className="mt-1 block text-xs text-block">{error}</span> : hint ? <span className="mt-1 block text-xs text-ink-3">{hint}</span> : null}
    </label>
  );
}

/**
 * Amount entry. Works in cents; shows a formatted value when not focused and
 * refuses to hand back anything that is not a clean amount.
 */
export function MoneyInput({
  value,
  onChange,
  allowBlank = true,
  className,
  ...rest
}: Omit<React.InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange'> & { value: number | null; onChange: (cents: number | null) => void; allowBlank?: boolean }) {
  const show = (v: number | null) => (v === null ? '' : formatMoney(v, { symbol: false }));
  const [text, setText] = React.useState(show(value));
  const [focused, setFocused] = React.useState(false);
  const [bad, setBad] = React.useState(false);
  React.useEffect(() => {
    if (!focused) setText(show(value));
  }, [value, focused]);

  return (
    <div className="relative">
      <span className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-ink-3">$</span>
      <input
        inputMode="decimal"
        className={cn(CONTROL, 'num h-8 pl-5 text-right', className)}
        aria-invalid={bad}
        value={text}
        onFocus={(e) => {
          setFocused(true);
          e.currentTarget.select();
        }}
        onChange={(e) => {
          setText(e.target.value);
          const t = e.target.value.trim();
          if (t === '') {
            setBad(!allowBlank);
            if (allowBlank) onChange(null);
            return;
          }
          const cents = parseMoney(t);
          setBad(cents === null);
          if (cents !== null) onChange(cents);
        }}
        onBlur={() => {
          setFocused(false);
          setBad(false);
        }}
        {...rest}
      />
    </div>
  );
}

/** Inline error shown at the top of a form. */
export function FormError({ message }: { message?: string | null }) {
  if (!message) return null;
  return (
    <div role="alert" className="rounded-md border border-block-line bg-block-soft px-3 py-2 text-[13px] text-block">
      {message}
    </div>
  );
}
