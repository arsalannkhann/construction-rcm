'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Field, Select } from '@/components/ui/form';
import { useAction } from '@/lib/use-action';
import { selectCompanyAction } from './actions';

/** Shown when the Procore login that connected can see more than one company. */
export function CompanyPicker({ companies }: { companies: Array<{ id: string; name: string }> }) {
  const [companyId, setCompanyId] = useState('');
  const { pending, run } = useAction();
  const chosen = companies.find((c) => c.id === companyId);

  return (
    <form
      className="flex items-end gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        if (!chosen || pending) return;
        run(() => selectCompanyAction(chosen.id), { success: `Procore company set to ${chosen.name}` });
      }}
    >
      <Field label="Procore company" className="w-80 max-w-full">
        <Select value={companyId} onChange={(e) => setCompanyId(e.target.value)} required>
          <option value="" disabled>
            Choose a company…
          </option>
          {companies.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </Select>
      </Field>
      <Button type="submit" variant="primary" loading={pending} disabled={!chosen}>
        Use this company
      </Button>
    </form>
  );
}
