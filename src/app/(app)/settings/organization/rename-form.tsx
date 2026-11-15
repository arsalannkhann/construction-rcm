'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Field, Input } from '@/components/ui/form';
import { useAction } from '@/lib/use-action';
import { renameOrganizationAction } from './actions';

export function RenameForm({ name }: { name: string }) {
  const [value, setValue] = useState(name);
  const { pending, run } = useAction();
  const clean = value.trim();
  const changed = clean !== name;
  const valid = clean.length >= 2 && clean.length <= 120;

  return (
    <form
      className="flex max-w-xl items-start gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        if (!changed || !valid || pending) return;
        run(() => renameOrganizationAction(clean), { success: `Organisation renamed to ${clean}` });
      }}
    >
      <Field
        label="Organisation name"
        className="min-w-0 flex-1"
        error={changed && !valid ? 'Enter your company name (2 to 120 characters).' : null}
        hint="Renaming is recorded in Activity."
      >
        <Input value={value} onChange={(e) => setValue(e.target.value)} maxLength={120} autoComplete="organization" aria-invalid={changed && !valid} />
      </Field>
      {/* Offset by the label's height so the button lines up with the input. */}
      <Button type="submit" variant="primary" loading={pending} disabled={!changed || !valid} className="mt-5">
        Save
      </Button>
    </form>
  );
}
