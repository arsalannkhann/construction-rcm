'use client';

import { Pencil } from 'lucide-react';
import { useState } from 'react';
import { bpsToPercentText, PercentInput, retainageError } from '@/components/records/percent-input';
import { Button } from '@/components/ui/button';
import { Checkbox, Field, Input, MoneyInput, Select } from '@/components/ui/form';
import { Dialog } from '@/components/ui/overlay';
import { parsePercentToBps } from '@/lib/money';
import { describeRetainageTerms } from '@/lib/retainage';
import type { RetainageTerms } from '@/server/types';
import { useAction } from '@/lib/use-action';
import { updateContractAction } from '../actions';

type Terms = { id: string; number: string; title: string; originalAmount: number; retainageWorkBps: number; retainageStoredBps: number; retainageTerms: RetainageTerms | null; executedOn: string | null; status: string };
type Values = {
  number: string;
  title: string;
  originalAmount: number | null;
  retainageWork: string;
  retainageStored: string;
  /** Stepped retainage: the rate changes once the work is this far along. */
  reduces: boolean;
  reduceAt: string;
  reduceTo: string;
  appliesTo: 'future_work' | 'all_work';
  executedOn: string;
  status: 'active' | 'closed';
};

const valuesOf = (c: Terms): Values => ({
  number: c.number,
  title: c.title,
  originalAmount: c.originalAmount,
  retainageWork: bpsToPercentText(c.retainageWorkBps),
  retainageStored: bpsToPercentText(c.retainageStoredBps),
  reduces: !!c.retainageTerms?.reduction,
  reduceAt: c.retainageTerms?.reduction ? bpsToPercentText(c.retainageTerms.reduction.atPercentBps) : '50',
  reduceTo: c.retainageTerms?.reduction ? bpsToPercentText(c.retainageTerms.reduction.toBps) : '5',
  appliesTo: c.retainageTerms?.reduction?.appliesTo ?? 'future_work',
  executedOn: c.executedOn ?? '',
  status: c.status === 'closed' ? 'closed' : 'active',
});

export function TermsDialogButton({ contract }: { contract: Terms }) {
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState<Values>(() => valuesOf(contract));
  const { pending, run } = useAction();
  const set = <K extends keyof Values>(key: K, value: Values[K]) => setForm((f) => ({ ...f, [key]: value }));

  const workError = retainageError(form.retainageWork);
  const storedError = retainageError(form.retainageStored);
  const workBps = parsePercentToBps(form.retainageWork);
  const atBps = parsePercentToBps(form.reduceAt);
  const toBps = parsePercentToBps(form.reduceTo);
  const reduction: RetainageTerms['reduction'] = form.reduces && atBps !== null && toBps !== null ? { atPercentBps: atBps, toBps, appliesTo: form.appliesTo } : null;
  const atError = !form.reduces ? null : atBps === null ? 'Enter a percentage such as 50.' : atBps < 100 || atBps > 9900 ? 'Between 1% and 99%.' : null;
  const toError = !form.reduces ? null : toBps === null ? 'Enter a percentage; 0 if none is withheld after that.' : workBps !== null && toBps >= workBps ? 'Lower than the starting rate.' : null;
  const complete = !!form.number.trim() && !!form.title.trim() && form.originalAmount !== null && !workError && !storedError && !atError && !toError;

  const submit = () => {
    const originalAmount = form.originalAmount;
    const retainageWorkBps = workBps;
    const retainageStoredBps = parsePercentToBps(form.retainageStored);
    if (!complete || originalAmount === null || retainageWorkBps === null || retainageStoredBps === null) return;
    run(
      () =>
        updateContractAction(contract.id, {
          number: form.number,
          title: form.title,
          originalAmount,
          retainageWorkBps,
          retainageStoredBps,
          retainageReduction: reduction,
          executedOn: form.executedOn || null,
          status: form.status,
        }),
      {
        success: 'Contract terms saved',
        onSuccess: () => setOpen(false),
      },
    );
  };

  return (
    <>
      <Button
        size="sm"
        onClick={() => {
          setForm(valuesOf(contract));
          setOpen(true);
        }}
      >
        <Pencil className="size-3.5" />
        Edit terms
      </Button>
      <Dialog
        open={open}
        onOpenChange={setOpen}
        title="Edit contract terms"
        description="Changing these terms re-checks every undecided application on this contract, so its findings always reflect the terms on file."
        footer={
          <>
            <Button variant="ghost" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button variant="primary" loading={pending} disabled={!complete} onClick={submit}>
              Save terms
            </Button>
          </>
        }
      >
        <form
          className="grid grid-cols-2 gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          <Field label="Contract number">
            <Input autoFocus required value={form.number} onChange={(e) => set('number', e.target.value)} />
          </Field>
          <Field label="Contract date" optional>
            <Input type="date" value={form.executedOn} onChange={(e) => set('executedOn', e.target.value)} />
          </Field>
          <Field label="Scope / title" className="col-span-2">
            <Input required value={form.title} onChange={(e) => set('title', e.target.value)} />
          </Field>
          <Field label="Original contract amount" className="col-span-2" hint="Before change orders. Change orders are recorded separately and added to the contract sum when approved.">
            <MoneyInput required allowBlank={false} value={form.originalAmount} onChange={(cents) => set('originalAmount', cents)} />
          </Field>
          <Field label="Retainage on completed work" error={workError}>
            <PercentInput value={form.retainageWork} onChange={(e) => set('retainageWork', e.target.value)} aria-invalid={!!workError} />
          </Field>
          <Field label="Retainage on stored materials" error={storedError}>
            <PercentInput value={form.retainageStored} onChange={(e) => set('retainageStored', e.target.value)} aria-invalid={!!storedError} />
          </Field>
          <div className="col-span-2 space-y-3 rounded-lg border border-line px-3.5 py-3">
            <Checkbox
              checked={form.reduces}
              onChange={(e) => set('reduces', e.target.checked)}
              label="Retainage on completed work reduces part-way through the contract"
              description="For example 10% until the work is 50% complete, then 5%. Check the subcontract for the exact wording."
            />
            {form.reduces ? (
              <div className="grid grid-cols-3 gap-3">
                <Field label="Once the work is" error={atError} hint={atError ? undefined : 'complete, of the contract sum'}>
                  <PercentInput value={form.reduceAt} onChange={(e) => set('reduceAt', e.target.value)} aria-invalid={!!atError} />
                </Field>
                <Field label="Retainage becomes" error={toError}>
                  <PercentInput value={form.reduceTo} onChange={(e) => set('reduceTo', e.target.value)} aria-invalid={!!toError} />
                </Field>
                <Field label="Applied to">
                  <Select value={form.appliesTo} onChange={(e) => set('appliesTo', e.target.value === 'all_work' ? 'all_work' : 'future_work')}>
                    <option value="future_work">Further work only</option>
                    <option value="all_work">All work to date</option>
                  </Select>
                </Field>
                <p className="col-span-3 text-xs text-ink-2">
                  {workBps !== null && !atError && !toError ? `Applications will be checked against: ${describeRetainageTerms(workBps, { reduction })}.` : ' '}
                  {form.appliesTo === 'all_work' ? ' The retainage already held above the new rate becomes due to the subcontractor when the threshold is reached.' : ''}
                </p>
              </div>
            ) : null}
          </div>
          <Field label="Status" className="col-span-2" hint="A closed contract keeps its history but is no longer matched to incoming billing packages.">
            <Select value={form.status} onChange={(e) => set('status', e.target.value === 'closed' ? 'closed' : 'active')}>
              <option value="active">Active</option>
              <option value="closed">Closed</option>
            </Select>
          </Field>
          <button type="submit" hidden />
        </form>
      </Dialog>
    </>
  );
}
