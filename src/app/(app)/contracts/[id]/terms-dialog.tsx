'use client';

import { Pencil } from 'lucide-react';
import { useState } from 'react';
import { bpsToPercentText, PercentInput, retainageError } from '@/components/records/percent-input';
import { Button } from '@/components/ui/button';
import { Field, Input, MoneyInput, Select } from '@/components/ui/form';
import { Dialog } from '@/components/ui/overlay';
import { parsePercentToBps } from '@/lib/money';
import { useAction } from '@/lib/use-action';
import { updateContractAction } from '../actions';

type Terms = { id: string; number: string; title: string; originalAmount: number; retainageWorkBps: number; retainageStoredBps: number; executedOn: string | null; status: string };
type Values = { number: string; title: string; originalAmount: number | null; retainageWork: string; retainageStored: string; executedOn: string; status: 'active' | 'closed' };

const valuesOf = (c: Terms): Values => ({
  number: c.number,
  title: c.title,
  originalAmount: c.originalAmount,
  retainageWork: bpsToPercentText(c.retainageWorkBps),
  retainageStored: bpsToPercentText(c.retainageStoredBps),
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
  const complete = !!form.number.trim() && !!form.title.trim() && form.originalAmount !== null && !workError && !storedError;

  const submit = () => {
    const originalAmount = form.originalAmount;
    const retainageWorkBps = parsePercentToBps(form.retainageWork);
    const retainageStoredBps = parsePercentToBps(form.retainageStored);
    if (!complete || originalAmount === null || retainageWorkBps === null || retainageStoredBps === null) return;
    run(() => updateContractAction(contract.id, { number: form.number, title: form.title, originalAmount, retainageWorkBps, retainageStoredBps, executedOn: form.executedOn || null, status: form.status }), {
      success: 'Contract terms saved',
      onSuccess: () => setOpen(false),
    });
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
