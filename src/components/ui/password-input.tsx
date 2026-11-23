'use client';

import { Eye, EyeOff } from 'lucide-react';
import { useState } from 'react';
import { cn } from '@/lib/utils';
import { Input } from './form';

/**
 * A password field with a show/hide control and a caps-lock warning. Showing
 * the password is the person's own choice on their own screen, and it goes
 * back to hidden when the form is submitted and the page moves on; nothing
 * about how the password is sent or stored changes.
 */
export function PasswordInput({ className, onKeyUp, onBlur, ...rest }: Omit<React.ComponentProps<typeof Input>, 'type'>) {
  const [shown, setShown] = useState(false);
  const [caps, setCaps] = useState(false);
  return (
    <span className="block">
      <span className="relative block">
        <Input
          {...rest}
          type={shown ? 'text' : 'password'}
          className={cn('pr-10', className)}
          onKeyUp={(e) => {
            setCaps(e.getModifierState?.('CapsLock') ?? false);
            onKeyUp?.(e);
          }}
          onBlur={(e) => {
            setCaps(false);
            onBlur?.(e);
          }}
        />
        <button
          type="button"
          onClick={() => setShown((v) => !v)}
          className="focus-ring absolute inset-y-0 right-0 flex w-10 items-center justify-center rounded-r-md text-ink-3 hover:text-ink"
          aria-label={shown ? 'Hide password' : 'Show password'}
          aria-pressed={shown}
        >
          {shown ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
        </button>
      </span>
      {caps ? (
        <span role="status" className="mt-1 block text-xs font-medium text-warn">
          Caps Lock is on.
        </span>
      ) : null}
    </span>
  );
}
