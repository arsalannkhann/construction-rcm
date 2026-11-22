'use client';

import { useState, useTransition } from 'react';
import { Button } from '@/components/ui/button';
import { Field, FormError, Input } from '@/components/ui/form';
import { PASSWORD_HINT } from '@/server/auth/password-rules';
import { acceptInviteAction } from '../../actions';
import { PasswordInput } from '@/components/ui/password-input';

export function InviteForm({ token, email, hasAccount }: { token: string; email: string; hasAccount: boolean }) {
  const [name, setName] = useState('');
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
          const result = await acceptInviteAction(token, { name, password });
          if (!result.ok) setError(result.error);
          // An existing account with two-step verification still owes its code.
          else window.location.assign(result.data === 'verify' ? '/login/verify' : '/overview');
        });
      }}
    >
      <FormError message={error} />
      <Field label="Email">
        <Input value={email} disabled className="h-10 text-[14px]" />
      </Field>
      {hasAccount ? null : (
        <Field label="Your name">
          <Input name="name" autoComplete="name" required autoFocus value={name} onChange={(e) => setName(e.target.value)} className="h-10 text-[14px]" />
        </Field>
      )}
      <Field label={hasAccount ? 'Your password' : 'Choose a password'} hint={hasAccount ? 'You already have an account with this email. Enter its password to join.' : PASSWORD_HINT}>
        <PasswordInput name="password" autoComplete={hasAccount ? 'current-password' : 'new-password'} required value={password} onChange={(e) => setPassword(e.target.value)} className="h-10 text-[14px]" />
      </Field>
      <Button type="submit" variant="primary" size="lg" loading={pending} className="w-full">
        Join team
      </Button>
    </form>
  );
}
