'use client';

import { Check } from 'lucide-react';
import { useState, useTransition } from 'react';
import { Button } from '@/components/ui/button';
import { Field, FormError, Input } from '@/components/ui/form';
import { PasswordInput } from '@/components/ui/password-input';
import { PASSWORD_HINT, passwordProblem } from '@/server/auth/password-rules';
import { signupAction } from '../actions';

export function SignupForm() {
  const [form, setForm] = useState({ orgName: '', name: '', email: '', password: '' });
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const [done, setDone] = useState(false);
  const set = (key: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) => setForm((f) => ({ ...f, [key]: e.target.value }));
  // The same rule the server applies, checked as the password is typed so nobody finds out only after pressing the button.
  const problem = form.password ? passwordProblem(form.password, { email: form.email, name: form.name }) : null;

  return (
    <form
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        if (problem) return setError(problem);
        setError(null);
        start(async () => {
          const result = await signupAction(form);
          if (!result.ok) setError(result.error);
          else {
            setDone(true);
            // Straight to the welcome step; a full page load so the app starts clean with this session.
            window.location.assign('/start');
          }
        });
      }}
    >
      <FormError message={error} />
      <Field label="Company name" hint="Your general contracting company. You can invite colleagues afterwards.">
        <Input name="organization" autoComplete="organization" required autoFocus value={form.orgName} onChange={set('orgName')} className="h-10 text-[14px]" />
      </Field>
      <Field label="Your name">
        <Input name="name" autoComplete="name" required value={form.name} onChange={set('name')} className="h-10 text-[14px]" />
      </Field>
      <Field label="Work email">
        <Input type="email" name="email" autoComplete="email" required value={form.email} onChange={set('email')} className="h-10 text-[14px]" />
      </Field>
      <Field
        label="Password"
        hint={
          !form.password ? (
            PASSWORD_HINT
          ) : problem ? (
            <span className="text-warn">{problem}</span>
          ) : (
            <span className="inline-flex items-center gap-1 text-pass">
              <Check className="size-3.5" strokeWidth={2.5} /> That password works.
            </span>
          )
        }
      >
        <PasswordInput name="new-password" autoComplete="new-password" required minLength={10} value={form.password} onChange={set('password')} aria-invalid={!!problem} className="h-10 text-[14px]" />
      </Field>
      <Button type="submit" variant="primary" size="lg" loading={pending || done} className="w-full">
        {done ? 'Opening Zephric…' : 'Create my organisation'}
      </Button>
      <p className="text-center text-xs leading-[1.5] text-ink-3">Next: two quick questions, then explore a ready-made example or set up your first project.</p>
    </form>
  );
}
