'use client';

import { Field, Input, MoneyInput, Select } from '@/components/ui/form';
import { formatMoney } from '@/lib/money';
import { US_STATES } from '@/lib/utils';

export type ProjectValues = { name: string; number: string; address: string; city: string; state: string; ownerName: string; budget: number | null };
export const EMPTY_PROJECT: ProjectValues = { name: '', number: '', address: '', city: '', state: '', ownerName: '', budget: null };

/** The fields shared by "New project" and "Edit project". Lay them out in a two-column grid. */
export function ProjectFields({
  value,
  onChange,
  stateHint,
  budgetLines = null,
}: {
  value: ProjectValues;
  onChange: (next: ProjectValues) => void;
  stateHint?: string;
  /** Set when the project's budget is the total of its budget lines, which are changed on the budget page. */
  budgetLines?: { count: number; total: number } | null;
}) {
  const set = (key: Exclude<keyof ProjectValues, 'budget'>) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => onChange({ ...value, [key]: e.target.value });
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
      {budgetLines ? (
        <div className="col-span-2">
          <p className="mb-1 text-xs font-medium text-ink-2">Budget for subcontracted work</p>
          <p className="text-[13px] text-ink-2">
            <span className="num font-medium text-ink">{formatMoney(budgetLines.total)}</span>, the total of {budgetLines.count} budget line{budgetLines.count === 1 ? '' : 's'}. Change it on the budget page.
          </p>
        </div>
      ) : (
        <Field label="Budget for subcontracted work" optional className="col-span-2" hint="What you have set aside for this project’s subcontracts. Committed value and pending change orders are compared with it. For a budget by cost code, use the budget page.">
          <MoneyInput value={value.budget} onChange={(budget) => onChange({ ...value, budget })} placeholder="0.00" className="max-w-[220px]" />
        </Field>
      )}
    </>
  );
}
