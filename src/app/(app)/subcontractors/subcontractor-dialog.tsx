'use client';

import { Pencil, Plus } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Field, Input } from '@/components/ui/form';
import { Dialog } from '@/components/ui/overlay';
import { useAction } from '@/lib/use-action';
import { createSubcontractorAction, updateSubcontractorAction } from './actions';

type Values = { name: string; trade: string | null; contactName: string | null; contactEmail: string | null; phone: string | null; address: string | null };
const EMPTY: Values = { name: '', trade: null, contactName: null, contactEmail: null, phone: null, address: null };

export function SubcontractorDialogButton(props: { mode: 'create'; variant?: 'primary' | 'secondary' } | { mode: 'edit'; subcontractor: Values & { id: string }; label?: string }) {
  const [open, setOpen] = useState(false);
  const initial = props.mode === 'edit' ? props.subcontractor : EMPTY;
  const [form, setForm] = useState<Values>(initial);
  const { pending, run } = useAction();
  const set = (key: keyof Values) => (e: React.ChangeEvent<HTMLInputElement>) => setForm((f) => ({ ...f, [key]: e.target.value }));

  const submit = () => {
    if (props.mode === 'create') {
      run(() => createSubcontractorAction(form), { success: `${form.name} added`, onSuccess: () => setOpen(false) });
    } else {
      run(() => updateSubcontractorAction(props.subcontractor.id, form), { success: 'Subcontractor updated', onSuccess: () => setOpen(false) });
    }
  };

  return (
    <>
      {props.mode === 'create' ? (
        <Button
          variant={props.variant ?? 'secondary'}
          onClick={() => {
            setForm(EMPTY);
            setOpen(true);
          }}
        >
          <Plus className="size-3.5" />
          Add subcontractor
        </Button>
      ) : props.label ? (
        <Button
          size="sm"
          onClick={() => {
            setForm(initial);
            setOpen(true);
          }}
        >
          <Pencil className="size-3.5" />
          {props.label}
        </Button>
      ) : (
        <Button
          variant="ghost"
          size="sm"
          className="opacity-0 focus-visible:opacity-100 group-hover:opacity-100"
          aria-label={`Edit ${props.subcontractor.name}`}
          onClick={() => {
            setForm(initial);
            setOpen(true);
          }}
        >
          <Pencil className="size-3.5" />
        </Button>
      )}
      <Dialog
        open={open}
        onOpenChange={setOpen}
        title={props.mode === 'create' ? 'Add subcontractor' : 'Edit subcontractor'}
        description="The name is used to match incoming billing packages, so enter it the way it appears on their pay applications."
        footer={
          <>
            <Button variant="ghost" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button variant="primary" loading={pending} onClick={submit} disabled={!form.name.trim()}>
              {props.mode === 'create' ? 'Add subcontractor' : 'Save changes'}
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
          <Field label="Company name" className="col-span-2">
            <Input autoFocus required value={form.name} onChange={set('name')} placeholder="Lone Star Electric, LLC" />
          </Field>
          <Field label="Trade" optional>
            <Input value={form.trade ?? ''} onChange={set('trade')} placeholder="Electrical" />
          </Field>
          <Field label="Phone" optional>
            <Input value={form.phone ?? ''} onChange={set('phone')} />
          </Field>
          <Field label="Billing contact" optional>
            <Input value={form.contactName ?? ''} onChange={set('contactName')} />
          </Field>
          <Field label="Contact email" optional hint="Used when you request corrections.">
            <Input type="email" value={form.contactEmail ?? ''} onChange={set('contactEmail')} />
          </Field>
          <Field label="Address" optional className="col-span-2">
            <Input value={form.address ?? ''} onChange={set('address')} />
          </Field>
          <button type="submit" hidden />
        </form>
      </Dialog>
    </>
  );
}
