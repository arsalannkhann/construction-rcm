'use client';

import { useState, useTransition } from 'react';
import { Button } from '@/components/ui/button';
import { Field, FormError, Input } from '@/components/ui/form';
import { loginAction } from '../actions';

export function LoginForm() {
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
          else window.location.assign('/');
        });
      }}
    >
      <FormError message={error} />
      <Field label="Work email">
        <Input type="email" name="email" autoComplete="email" required autoFocus value={email} onChange={(e) => setEmail(e.target.value)} className="h-9" />
      </Field>
      <Field label="Password">
        <Input type="password" name="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} className="h-9" />
      </Field>
      <Button type="submit" variant="primary" size="lg" loading={pending} className="w-full">
        Sign in
      </Button>
    </form>
  );
}
