'use client';

import { Pencil, Plus } from 'lucide-react';
import { useState } from 'react';
import { bpsToPercentText, PercentInput, retainageError } from '@/components/records/percent-input';
import { Button } from '@/components/ui/button';
import { Field, Input, MoneyInput } from '@/components/ui/form';
import { Dialog } from '@/components/ui/overlay';
import { parsePercentToBps } from '@/lib/money';
import { useAction } from '@/lib/use-action';
import { savePrimeContractAction } from './actions';

export type PrimeTerms = { number: string | null; architectName: string | null; originalAmount: number; retainageWorkBps: number; retainageStoredBps: number; executedOn: string | null };
type Values = { number: string; architectName: string; originalAmount: number | null; retainageWork: string; retainageStored: string; executedOn: string };

const valuesOf = (t: PrimeTerms | null, suggestedAmount: number | null): Values => ({
  number: t?.number ?? '',
  architectName: t?.architectName ?? '',
  originalAmount: t?.originalAmount ?? suggestedAmount,
  retainageWork: bpsToPercentText(t?.retainageWorkBps ?? 1000),
  retainageStored: bpsToPercentText(t?.retainageStoredBps ?? 1000),
  executedOn: t?.executedOn ?? '',
});

/** Set up, or edit the terms of, the project's contract with the owner. */
export function PrimeContractDialogButton({ projectId, ownerName, terms, suggestedAmount = null, variant = 'secondary' }: { projectId: string; ownerName: string | null; terms: PrimeTerms | null; suggestedAmount?: number | null; variant?: 'primary' | 'secondary' }) {
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState<Values>(() => valuesOf(terms, suggestedAmount));
  const { pending, run } = useAction();
  const set = <K extends keyof Values>(key: K, value: Values[K]) => setForm((f) => ({ ...f, [key]: value }));
  const workError = retainageError(form.retainageWork);
  const storedError = retainageError(form.retainageStored);
  const complete = form.originalAmount !== null && form.originalAmount > 0 && !workError && !storedError;

  const submit = () => {
    const originalAmount = form.originalAmount;
    const retainageWorkBps = parsePercentToBps(form.retainageWork);
    const retainageStoredBps = parsePercentToBps(form.retainageStored);
    if (!complete || originalAmount === null || retainageWorkBps === null || retainageStoredBps === null) return;
    run(() => savePrimeContractAction(projectId, { number: form.number, architectName: form.architectName, originalAmount, retainageWorkBps, retainageStoredBps, executedOn: form.executedOn || null }), {
      success: terms ? 'Owner contract saved' : 'Owner contract set up',
      onSuccess: () => setOpen(false),
    });
  };

  return (
    <>
      <Button
        variant={variant}
        size={variant === 'primary' ? 'md' : 'sm'}
        onClick={() => {
          setForm(valuesOf(terms, suggestedAmount));
          setOpen(true);
        }}
      >
        {terms ? <Pencil className="size-3.5" /> : <Plus className="size-3.5" />}
        {terms ? 'Edit terms' : 'Set up the owner contract'}
      </Button>
      <Dialog
        open={open}
        onOpenChange={setOpen}
        title={terms ? 'Edit the owner contract' : 'Set up the owner contract'}
        description={`Your contract with ${ownerName ?? 'the owner'}: what you bill against each period. The owner’s name comes from the project.`}
        footer={
          <>
            <Button variant="ghost" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button variant="primary" loading={pending} disabled={!complete} onClick={submit}>
              {terms ? 'Save terms' : 'Set up contract'}
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
          <Field label="Original contract sum" className="col-span-2" hint={terms ? undefined : suggestedAmount ? 'Filled in from the project budget; change it to the sum in your contract.' : undefined}>
            <MoneyInput autoFocus required value={form.originalAmount} onChange={(cents) => set('originalAmount', cents)} />
          </Field>
          <Field label="Contract number" optional>
            <Input value={form.number} onChange={(e) => set('number', e.target.value)} placeholder="OC-2301" />
          </Field>
          <Field label="Contract date" optional>
            <Input type="date" value={form.executedOn} onChange={(e) => set('executedOn', e.target.value)} />
          </Field>
          <Field label="Architect" optional className="col-span-2" hint="Shown on the application, for the certification.">
            <Input value={form.architectName} onChange={(e) => set('architectName', e.target.value)} placeholder="Hollis Architects" />
          </Field>
          <Field label="Retainage on completed work" error={workError}>
            <PercentInput value={form.retainageWork} onChange={(e) => set('retainageWork', e.target.value)} />
          </Field>
          <Field label="Retainage on stored materials" error={storedError}>
            <PercentInput value={form.retainageStored} onChange={(e) => set('retainageStored', e.target.value)} />
          </Field>
          <button type="submit" hidden />
        </form>
      </Dialog>
    </>
  );
}
