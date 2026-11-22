'use client';

import { CircleCheck } from 'lucide-react';
import Link from '@/components/ui/link';
import { useState, useTransition } from 'react';
import { Button } from '@/components/ui/button';
import { Field, FormError, Input } from '@/components/ui/form';
import { loginAction } from '../actions';
import { PasswordInput } from '@/components/ui/password-input';

/** `next` is a page on this site to open after signing in (already checked by the page). */
export function LoginForm({ next = null }: { next?: string | null }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const [done, setDone] = useState<null | 'app' | 'verify'>(null);

  return (
    <form
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        setError(null);
        start(async () => {
          const result = await loginAction({ email, password });
          if (!result.ok) {
            setError(result.error);
            return;
          }
          // Into the app (which sends anyone who still has something to set up to the right page), or to the second step.
          // A full page load, replacing the sign-in page in history, so the app starts clean with this session.
          setDone(result.data === 'verify' ? 'verify' : 'app');
          window.location.replace(result.data === 'verify' ? (next ? `/login/verify?next=${encodeURIComponent(next)}` : '/login/verify') : (next ?? '/overview'));
        });
      }}
    >
      <FormError message={error} />
      <Field label="Work email">
        <Input type="email" name="email" autoComplete="email" required autoFocus value={email} onChange={(e) => setEmail(e.target.value)} className="h-10 text-[14px]" />
      </Field>
      <div>
        <Field label="Password">
          <PasswordInput name="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} className="h-10 text-[14px]" />
        </Field>
        <div className="mt-1.5 text-right">
          <Link href="/forgot-password" className="text-xs font-medium text-accent hover:underline">
            Forgot password?
          </Link>
        </div>
      </div>
      <Button type="submit" variant="primary" size="lg" loading={pending || done !== null} className="w-full">
        {done === 'app' ? 'Opening Zephric…' : done === 'verify' ? 'One more step…' : 'Sign in'}
      </Button>
      <p role="status" aria-live="polite" className="min-h-5 text-center text-[13px] text-pass">
        {done === 'app' ? (
          <span className="inline-flex animate-in items-center gap-1.5">
            <CircleCheck className="size-4" /> Signed in
          </span>
        ) : null}
      </p>
    </form>
  );
}
