'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Field, Input } from '@/components/ui/form';
import { useAction } from '@/lib/use-action';
import { PASSWORD_HINT, passwordProblem } from '@/server/auth/password-rules';
import { changePasswordAction, updateProfileAction } from './actions';

export function NameForm({ name }: { name: string }) {
  const [value, setValue] = useState(name);
  const { pending, run } = useAction();
  const clean = value.trim();
  const changed = clean !== name;
  const valid = clean.length >= 2 && clean.length <= 120;

  return (
    <form
      className="flex max-w-md items-start gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        if (!changed || !valid || pending) return;
        run(() => updateProfileAction({ name: clean }), { success: 'Name updated' });
      }}
    >
      <Field
        label="Your name"
        className="min-w-0 flex-1"
        error={changed && !valid ? 'Enter your name (2 to 120 characters).' : null}
        hint="Shown to your team and recorded in Activity next to what you do. Earlier entries keep the name they were recorded with."
      >
        <Input value={value} onChange={(e) => setValue(e.target.value)} maxLength={120} autoComplete="name" aria-invalid={changed && !valid} />
      </Field>
      {/* Offset by the label's height so the button lines up with the input. */}
      <Button type="submit" variant="primary" loading={pending} disabled={!changed || !valid} className="mt-5">
        Save
      </Button>
    </form>
  );
}

export function PasswordForm({ email, name }: { email: string; name: string }) {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const { pending, run } = useAction();

  // The same rule the server applies, shown as you type.
  const problem = next.length > 0 ? passwordProblem(next, { email, name }) : null;
  const mismatch = confirm.length > 0 && confirm !== next;
  const ready = current.length > 0 && next.length > 0 && !problem && confirm === next;

  return (
    <form
      className="max-w-sm space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        if (!ready || pending) return;
        run(() => changePasswordAction({ current, next }), {
          success: 'Password changed. Your other sessions were signed out.',
          onSuccess: () => {
            setCurrent('');
            setNext('');
            setConfirm('');
          },
        });
      }}
    >
      {/* Lets a password manager file the new password under the right account. */}
      <input type="text" name="username" autoComplete="username" value={email} readOnly hidden />
      <Field label="Current password">
        <Input type="password" name="current-password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} />
      </Field>
      <Field label="New password" error={problem} hint={PASSWORD_HINT}>
        <Input type="password" name="new-password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} aria-invalid={!!problem} />
      </Field>
      <Field label="Confirm new password" error={mismatch ? 'This does not match the new password.' : null}>
        <Input type="password" name="confirm-password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} aria-invalid={mismatch} />
      </Field>
      <div className="flex items-center gap-3">
        <Button type="submit" variant="primary" loading={pending} disabled={!ready}>
          Change password
        </Button>
        <span className="text-xs text-ink-3">You stay signed in here. Every other session is signed out.</span>
      </div>
    </form>
  );
}
