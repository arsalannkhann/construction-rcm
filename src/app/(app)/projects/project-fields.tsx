'use client';

import { Field, Input, Select } from '@/components/ui/form';
import { US_STATES } from '@/lib/utils';

export type ProjectValues = { name: string; number: string; address: string; city: string; state: string; ownerName: string };
export const EMPTY_PROJECT: ProjectValues = { name: '', number: '', address: '', city: '', state: '', ownerName: '' };

/** The fields shared by "New project" and "Edit project". Lay them out in a two-column grid. */
export function ProjectFields({ value, onChange, stateHint }: { value: ProjectValues; onChange: (next: ProjectValues) => void; stateHint?: string }) {
  const set = (key: keyof ProjectValues) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => onChange({ ...value, [key]: e.target.value });
  return (
    <>
      <Field label="Project name" className="col-span-2">
        <Input autoFocus required value={value.name} onChange={set('name')} placeholder="Riverside Medical Office Building" />
      </Field>
      <Field label="Project number" optional hint="As it appears on pay applications; used to match incoming packages.">
        <Input value={value.number} onChange={set('number')} placeholder="2301" />
      </Field>
      <Field label="Owner" optional>
        <Input value={value.ownerName} onChange={set('ownerName')} placeholder="Riverside Health Partners" />
      </Field>
      <Field label="Address" optional className="col-span-2">
        <Input value={value.address} onChange={set('address')} placeholder="880 Riverside Dr" />
      </Field>
      <Field label="City" optional>
        <Input value={value.city} onChange={set('city')} />
      </Field>
      <Field
        label="State"
        optional
        hint={stateHint ?? 'Determines which statutory lien-waiver form is expected on this project’s applications. Texas, California and Florida forms are recognised.'}
      >
        <Select value={value.state} onChange={set('state')}>
          <option value="">Not set</option>
          {US_STATES.map(([code, name]) => (
            <option key={code} value={code}>
              {name}
            </option>
          ))}
        </Select>
      </Field>
    </>
  );
}
