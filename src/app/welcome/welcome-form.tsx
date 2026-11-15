'use client';

import { useState, useTransition } from 'react';
import { Button } from '@/components/ui/button';
import { Field, FormError, Input } from '@/components/ui/form';
import { createOrgAction, logoutAction } from '../(auth)/actions';

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
          else window.location.assign('/overview');
        });
      }}
    >
      <FormError message={error} />
      <Field label="Company name">
        <Input required autoFocus value={name} onChange={(e) => setName(e.target.value)} className="h-9" />
      </Field>
      <div className="flex items-center gap-2">
        <Button type="submit" variant="primary" size="lg" loading={pending} className="flex-1">
          Create organisation
        </Button>
        <Button type="button" variant="ghost" size="lg" onClick={() => logoutAction()}>
          Sign out
        </Button>
      </div>
    </form>
  );
}
