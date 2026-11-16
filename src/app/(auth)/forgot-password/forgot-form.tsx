'use client';

import { MailCheck } from 'lucide-react';
import { useState, useTransition } from 'react';
import { Notice } from '@/components/settings/notice';
import { Button } from '@/components/ui/button';
import { Field, FormError, Input } from '@/components/ui/form';
import { requestResetAction } from '../actions';

export function ForgotForm() {
  const [email, setEmail] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const [pending, start] = useTransition();

  if (unavailable) {
    return <Notice tone="warn">Reset emails cannot be sent from this deployment. Ask an owner or admin of your organisation to create a reset link for you under Settings → Team.</Notice>;
  }

  if (sentTo) {
    // The same words whether or not the address has an account, so this page cannot be used to find out who does.
    return (
      <div className="space-y-4">
        <Notice tone="neutral" icon={<MailCheck strokeWidth={1.9} />}>
          If {sentTo} has an account, a link to set a new password is on its way. Check your inbox, and your spam folder, in the next few minutes.
        </Notice>
        <p className="text-xs text-ink-3">Nothing arrived? Your organisation may use a different address for you, or the email may be held by your mail filter. An owner or admin of your organisation can also create a reset link for you.</p>
        <Button variant="ghost" onClick={() => setSentTo(null)}>
          Use a different address
        </Button>
      </div>
    );
  }

  return (
    <form
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        const to = email.trim();
        if (!to || pending) return;
        setError(null);
        start(async () => {
          const result = await requestResetAction(to);
          if (!result.ok) setError(result.error);
          else if (result.data === 'unavailable') setUnavailable(true);
          else setSentTo(to);
        });
      }}
    >
      <FormError message={error} />
      <Field label="Work email">
        <Input type="email" name="email" autoComplete="email" required autoFocus value={email} onChange={(e) => setEmail(e.target.value)} className="h-10 text-[14px]" />
      </Field>
      <Button type="submit" variant="primary" size="lg" loading={pending} className="w-full">
        Email me a reset link
      </Button>
    </form>
  );
}
