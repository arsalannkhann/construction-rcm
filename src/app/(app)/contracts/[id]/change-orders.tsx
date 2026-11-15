'use client';

import { Check, FileDiff, Pencil, Plus } from 'lucide-react';
import { useState } from 'react';
import { ChangeOrderStatusBadge } from '@/components/records/figures';
import { Button } from '@/components/ui/button';
import { EmptyState, Money, Panel, PanelHeader, Table, Td, Th } from '@/components/ui/data';
import { Field, Input, MoneyInput, Select } from '@/components/ui/form';
import { Dialog } from '@/components/ui/overlay';
import { useAction } from '@/lib/use-action';
import { formatDate } from '@/lib/utils';
import { createChangeOrderAction, updateChangeOrderAction } from '../actions';

type Status = 'pending' | 'approved' | 'rejected' | 'void';
type ChangeOrder = { id: string; number: string; title: string; amount: number; status: string; approvedOn: string | null };
type Values = { number: string; title: string; amount: number | null; status: Status; approvedOn: string };

const EMPTY: Values = { number: '', title: '', amount: null, status: 'pending', approvedOn: '' };
const STATUSES: Array<[Status, string]> = [
  ['pending', 'Pending'],
  ['approved', 'Approved'],
  ['rejected', 'Rejected'],
  ['void', 'Void'],
];
const STATUS_EFFECT: Record<Status, string> = {
  pending: 'Not part of the contract sum yet. If the subcontractor bills it, the application shows a finding until it is approved here.',
  approved: 'Added to the contract sum, with a line of its own on the schedule of values.',
  rejected: 'Not part of the contract sum. Billing against it shows up as a finding.',
  void: 'Not part of the contract sum. Billing against it shows up as a finding.',
};
const asStatus = (s: string): Status => (STATUSES.some(([value]) => value === s) ? (s as Status) : 'pending');

export function ChangeOrdersPanel({ contractId, changeOrders, canWrite }: { contractId: string; changeOrders: ChangeOrder[]; canWrite: boolean }) {
  // 'new', the change order being edited, or null when the dialog is closed.
  const [target, setTarget] = useState<ChangeOrder | 'new' | null>(null);
  const [form, setForm] = useState<Values>(EMPTY);
  const [approvingId, setApprovingId] = useState<string | null>(null);
  const { pending, run } = useAction();
  const set = <K extends keyof Values>(key: K, value: Values[K]) => setForm((f) => ({ ...f, [key]: value }));
  const complete = !!form.number.trim() && !!form.title.trim() && form.amount !== null;
  const alreadyApproved = target !== null && target !== 'new' && target.status === 'approved' && !!target.approvedOn;

  const openNew = () => {
    setForm(EMPTY);
    setTarget('new');
  };
  const openEdit = (co: ChangeOrder) => {
    setForm({ number: co.number, title: co.title, amount: co.amount, status: asStatus(co.status), approvedOn: co.approvedOn ?? '' });
    setTarget(co);
  };

  const submit = () => {
    const amount = form.amount;
    if (!target || !complete || amount === null) return;
    const input = { number: form.number, title: form.title, amount, status: form.status, approvedOn: form.status === 'approved' ? form.approvedOn || null : null };
    setApprovingId(null);
    if (target === 'new') {
      run(() => createChangeOrderAction(contractId, input), { success: `Change order ${form.number.trim()} added`, onSuccess: () => setTarget(null) });
    } else {
      run(() => updateChangeOrderAction(target.id, input), { success: `Change order ${form.number.trim()} saved`, onSuccess: () => setTarget(null) });
    }
  };

  const approve = (co: ChangeOrder) => {
    setApprovingId(co.id);
    run(() => updateChangeOrderAction(co.id, { number: co.number, title: co.title, amount: co.amount, status: 'approved' }), {
      success: `Change order ${co.number} approved and added to the schedule`,
    });
  };

  const addButton = (variant: 'primary' | 'secondary') => (
    <Button size={variant === 'primary' ? 'md' : 'sm'} variant={variant} onClick={openNew}>
      <Plus className="size-3.5" />
      Add change order
    </Button>
  );

  return (
    <Panel className="overflow-hidden">
      <PanelHeader
        title="Change orders"
        description="Approving a change order adds a line to the schedule of values and re-checks open applications. A pending change order that the subcontractor bills shows up as a finding on the application."
        actions={canWrite && changeOrders.length > 0 ? addButton('secondary') : null}
      />
      {changeOrders.length === 0 ? (
        <EmptyState
          icon={<FileDiff />}
          title="No change orders"
          description="Record a change order when the contract value changes. Once approved, it is added to the contract sum and to the schedule of values."
          action={canWrite ? addButton('primary') : null}
        />
      ) : (
        <Table>
          <thead>
            <tr>
              <Th className="pl-4">Number</Th>
              <Th>Description</Th>
              <Th align="right">Amount</Th>
              <Th>Status</Th>
              <Th>Approved on</Th>
              <Th className="pr-4" />
            </tr>
          </thead>
          <tbody className="[&_tr:last-child>td]:border-b-0">
            {changeOrders.map((co) => (
              <tr key={co.id} className="group hover:bg-canvas/60">
                <Td className="whitespace-nowrap pl-4 font-medium">{co.number}</Td>
                <Td>{co.title}</Td>
                <Td align="right">
                  <Money cents={co.amount} />
                </Td>
                <Td>
                  <ChangeOrderStatusBadge status={co.status} />
                </Td>
                <Td className="whitespace-nowrap text-ink-2">{co.status === 'approved' ? formatDate(co.approvedOn) : <span className="text-ink-4">—</span>}</Td>
                <Td className="pr-3">
                  {canWrite ? (
                    <div className="flex items-center justify-end gap-1">
                      {co.status === 'pending' ? (
                        <Button size="sm" loading={pending && approvingId === co.id} disabled={pending} onClick={() => approve(co)}>
                          {pending && approvingId === co.id ? null : <Check className="size-3.5" />}
                          Approve
                        </Button>
                      ) : null}
                      <Button variant="ghost" size="sm" className="opacity-0 focus-visible:opacity-100 group-hover:opacity-100" aria-label={`Edit change order ${co.number}`} onClick={() => openEdit(co)}>
                        <Pencil className="size-3.5" />
                      </Button>
                    </div>
                  ) : null}
                </Td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}

      <Dialog
        open={target !== null}
        onOpenChange={(open) => {
          if (!open) setTarget(null);
        }}
        title={target === 'new' || target === null ? 'Add change order' : `Edit change order ${target.number}`}
        description="Saving re-checks every undecided application on this contract."
        footer={
          <>
            <Button variant="ghost" onClick={() => setTarget(null)}>
              Cancel
            </Button>
            <Button variant="primary" loading={pending && approvingId === null} disabled={!complete} onClick={submit}>
              {target === 'new' || target === null ? 'Add change order' : 'Save changes'}
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
          <Field label="Number">
            <Input autoFocus required value={form.number} onChange={(e) => set('number', e.target.value)} placeholder="CO-1" />
          </Field>
          <Field label="Amount" hint="Enter a deduct as a negative amount.">
            <MoneyInput required value={form.amount} onChange={(cents) => set('amount', cents)} />
          </Field>
          <Field label="Description" className="col-span-2">
            <Input required value={form.title} onChange={(e) => set('title', e.target.value)} placeholder="Added receptacles, level 2" />
          </Field>
          <Field label="Status" className={form.status === 'approved' ? undefined : 'col-span-2'} hint={form.status === 'approved' ? undefined : STATUS_EFFECT[form.status]}>
            <Select value={form.status} onChange={(e) => set('status', asStatus(e.target.value))}>
              {STATUSES.map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </Select>
          </Field>
          {form.status === 'approved' ? (
            <>
              <Field label="Approved on" optional>
                <Input type="date" value={form.approvedOn} onChange={(e) => set('approvedOn', e.target.value)} />
              </Field>
              <p className="col-span-2 -mt-2 text-xs text-ink-3">
                {STATUS_EFFECT.approved} {alreadyApproved ? 'Leave the date blank to keep the one on record.' : 'Leave the date blank to use today’s date.'}
              </p>
            </>
          ) : null}
          <button type="submit" hidden />
        </form>
      </Dialog>
    </Panel>
  );
}
