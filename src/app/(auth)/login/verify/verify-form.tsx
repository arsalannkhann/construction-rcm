'use client';

import Link from 'next/link';
import { useState, useTransition } from 'react';
import { Button } from '@/components/ui/button';
import { Field, FormError, Input } from '@/components/ui/form';
import { verifyLoginAction } from '../../actions';

/** A 6-digit code, or a recovery code (ten letters and digits, with or without the dash). */
const looksValid = (value: string) => /^\d{6}$/.test(value.replace(/\s/g, '')) || value.toLowerCase().replace(/[^a-z0-9]/g, '').length === 10;

export function VerifyForm({ attemptsLeft: initialAttempts }: { attemptsLeft: number }) {
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [restart, setRestart] = useState<string | null>(null);
  const [inviteGone, setInviteGone] = useState(false);
  const [attemptsLeft, setAttemptsLeft] = useState(initialAttempts);
  const [pending, start] = useTransition();

  if (inviteGone) {
    return (
      <div className="space-y-4">
        <FormError message="You are signed in, but the invitation stopped being valid before you finished (it was revoked, expired or already used), so you did not join that organisation. Ask whoever invited you for a new invitation." />
        <Link href="/overview" className="block text-[13px] font-medium text-accent hover:underline">
          Continue
        </Link>
      </div>
    );
  }

  if (restart) {
    return (
      <div className="space-y-4">
        <FormError message={restart} />
        <Link href="/login" className="block text-[13px] font-medium text-accent hover:underline">
          Go to sign in
        </Link>
      </div>
    );
  }

  return (
    <form
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        if (!looksValid(code) || pending) return;
        setError(null);
        start(async () => {
          const result = await verifyLoginAction(code);
          if (!result.ok) return setError(result.error);
          const outcome = result.data;
          if (outcome.status === 'signed_in') {
            if (outcome.invitationNoLongerValid) return setInviteGone(true);
            window.location.assign(outcome.recoveryCodesLeft !== null && outcome.recoveryCodesLeft <= 3 ? '/settings/profile#two-step' : '/overview');
          } else if (outcome.status === 'wrong_code') {
            setAttemptsLeft(outcome.attemptsLeft);
            setCode('');
            setError(`That code is not right. ${outcome.attemptsLeft === 1 ? 'One more try' : `${outcome.attemptsLeft} more tries`} before you have to sign in again.`);
          } else {
            setRestart(outcome.message);
          }
        });
      }}
    >
      <FormError message={error} />
      <Field label="Code" hint={error ? undefined : attemptsLeft < 5 ? `${attemptsLeft} tries left.` : 'Codes change every 30 seconds.'}>
        <Input
          name="one-time-code"
          autoComplete="one-time-code"
          inputMode="text"
          autoFocus
          required
          maxLength={20}
          value={code}
          onChange={(e) => setCode(e.target.value)}
          placeholder="123456"
          className="num h-9 tracking-widest"
        />
      </Field>
      <Button type="submit" variant="primary" size="lg" loading={pending} disabled={!looksValid(code)} className="w-full">
        Verify and sign in
      </Button>
    </form>
  );
}
