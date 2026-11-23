'use client';

import { useState, useTransition } from 'react';
import { Button } from '@/components/ui/button';
import { Field, FormError, Input } from '@/components/ui/form';
import { signOut } from '@/lib/sign-out';
import { createOrgAction } from '../(auth)/actions';

export function WelcomeForm() {
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  return (
    <form
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        setError(null);
        start(async () => {
          const result = await createOrgAction(name);
          if (!result.ok) setError(result.error);
          else window.location.assign('/start');
        });
      }}
    >
      <FormError message={error} />
      <Field label="Company name">
        <Input required autoFocus value={name} onChange={(e) => setName(e.target.value)} className="h-10 text-[14px]" />
      </Field>
      <div className="flex items-center gap-2">
        <Button type="submit" variant="primary" size="lg" loading={pending} className="flex-1">
          Create organisation
        </Button>
        <Button type="button" variant="ghost" size="lg" onClick={() => signOut()}>
          Sign out
        </Button>
      </div>
    </form>
  );
}
