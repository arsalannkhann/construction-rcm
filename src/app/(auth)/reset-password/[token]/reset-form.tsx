'use client';

import { CircleCheck } from 'lucide-react';
import Link from 'next/link';
import { useState, useTransition } from 'react';
import { Notice } from '@/components/settings/notice';
import { Button } from '@/components/ui/button';
import { Field, FormError, Input } from '@/components/ui/form';
import { PASSWORD_HINT, passwordProblem } from '@/server/auth/password-rules';
import { completeResetAction } from '../../actions';

export function ResetForm({ token, email }: { token: string; email: string }) {
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [pending, start] = useTransition();

  // The same rule the server applies, shown before submitting.
  const problem = password.length > 0 ? passwordProblem(password, { email }) : null;
  const mismatch = confirm.length > 0 && confirm !== password;
  const ready = password.length > 0 && !problem && confirm === password;

  if (done) {
    return (
      <div className="space-y-4">
        <Notice tone="pass" icon={<CircleCheck strokeWidth={1.9} />}>
          Your new password is set, and the account was signed out everywhere.
        </Notice>
        <Link href="/login" className="block text-[13px] font-medium text-accent hover:underline">
          Sign in with your new password
        </Link>
      </div>
    );
  }

  return (
    <form
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        if (!ready || pending) return;
        setError(null);
        start(async () => {
          const result = await completeResetAction(token, password);
          if (!result.ok) setError(result.error);
          else setDone(true);
        });
      }}
    >
      <FormError message={error} />
      {/* Lets a password manager file the new password under the right account. */}
      <input type="text" name="username" autoComplete="username" value={email} readOnly hidden />
      <Field label="New password" error={problem} hint={PASSWORD_HINT}>
        <Input type="password" name="new-password" autoComplete="new-password" required autoFocus value={password} onChange={(e) => setPassword(e.target.value)} aria-invalid={!!problem} className="h-9" />
      </Field>
      <Field label="Confirm new password" error={mismatch ? 'This does not match the new password.' : null}>
        <Input type="password" name="confirm-password" autoComplete="new-password" required value={confirm} onChange={(e) => setConfirm(e.target.value)} aria-invalid={mismatch} className="h-9" />
      </Field>
      <Button type="submit" variant="primary" size="lg" loading={pending} disabled={!ready} className="w-full">
        Set new password
      </Button>
    </form>
  );
}
