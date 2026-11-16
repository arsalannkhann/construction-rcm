'use client';

import Link from '@/components/ui/link';
import { useState, useTransition } from 'react';
import { Button } from '@/components/ui/button';
import { Field, FormError, Input } from '@/components/ui/form';
import { loginAction } from '../actions';

/** `next` is a page on this site to open after signing in (already checked by the page). */
export function LoginForm({ next = null }: { next?: string | null }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  return (
    <form
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        setError(null);
        start(async () => {
          const result = await loginAction({ email, password });
          if (!result.ok) setError(result.error);
          // Into the app (which sends anyone who still has something to set up to the right page), or to the second step.
          else window.location.assign(result.data === 'verify' ? (next ? `/login/verify?next=${encodeURIComponent(next)}` : '/login/verify') : (next ?? '/overview'));
        });
      }}
    >
      <FormError message={error} />
      <Field label="Work email">
        <Input type="email" name="email" autoComplete="email" required autoFocus value={email} onChange={(e) => setEmail(e.target.value)} className="h-9" />
      </Field>
      <div>
        <Field label="Password">
          <Input type="password" name="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} className="h-9" />
        </Field>
        <div className="mt-1.5 text-right">
          <Link href="/forgot-password" className="text-xs font-medium text-accent hover:underline">
            Forgot password?
          </Link>
        </div>
      </div>
      <Button type="submit" variant="primary" size="lg" loading={pending} className="w-full">
        Sign in
      </Button>
    </form>
  );
}
