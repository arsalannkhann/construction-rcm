'use client';

import { useState, useTransition } from 'react';
import { Button } from '@/components/ui/button';
import { Field, FormError, Input } from '@/components/ui/form';
import { PASSWORD_HINT } from '@/server/auth/password-rules';
import { signupAction } from '../actions';

export function SignupForm() {
  const [form, setForm] = useState({ orgName: '', name: '', email: '', password: '' });
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const set = (key: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) => setForm((f) => ({ ...f, [key]: e.target.value }));

  return (
    <form
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        setError(null);
        start(async () => {
          const result = await signupAction(form);
          if (!result.ok) setError(result.error);
          else window.location.assign('/overview');
        });
      }}
    >
      <FormError message={error} />
      <Field label="Company name" hint="Your general contracting company. You can invite colleagues next.">
        <Input name="organization" autoComplete="organization" required autoFocus value={form.orgName} onChange={set('orgName')} className="h-10 text-[14px]" />
      </Field>
      <Field label="Your name">
        <Input name="name" autoComplete="name" required value={form.name} onChange={set('name')} className="h-10 text-[14px]" />
      </Field>
      <Field label="Work email">
        <Input type="email" name="email" autoComplete="email" required value={form.email} onChange={set('email')} className="h-10 text-[14px]" />
      </Field>
      <Field label="Password" hint={PASSWORD_HINT}>
        <Input type="password" name="new-password" autoComplete="new-password" required minLength={10} value={form.password} onChange={set('password')} className="h-10 text-[14px]" />
      </Field>
      <Button type="submit" variant="primary" size="lg" loading={pending} className="w-full">
        Create organisation
      </Button>
    </form>
  );
}
