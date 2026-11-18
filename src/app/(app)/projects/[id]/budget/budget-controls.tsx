'use client';

import { ArrowRight, Lock, LockOpen, Plus, Wand2 } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/data';
import { Field, Input, MoneyInput, Select } from '@/components/ui/form';
import { Dialog } from '@/components/ui/overlay';
import { formatMoney } from '@/lib/money';
import { useAction } from '@/lib/use-action';
import { cn, formatDateTime } from '@/lib/utils';
import { lockBudgetAction, recordBudgetChangeAction, startBudgetFromSubcontractsAction, unlockBudgetAction, voidBudgetChangeAction } from './actions';
import { LineDialog, type BudgetContractView, type BudgetLineView } from './budget-table';

type LineRef = Pick<BudgetLineView, 'id' | 'costCode' | 'description' | 'budget'>;

/** "Add line": the dialog, opened from a button. */
export function AddLineButton({
  projectId,
  contracts,
  lines,
  suggestions,
  locked,
  singleBudget,
  variant = 'secondary',
}: {
  projectId: string;
  contracts: BudgetContractView[];
  lines: Array<Pick<BudgetLineView, 'id' | 'costCode' | 'description'>>;
  suggestions: Array<{ code: string; description: string }>;
  locked: boolean;
  singleBudget: number | null;
  variant?: 'primary' | 'secondary';
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button variant={variant} onClick={() => setOpen(true)}>
        <Plus className="size-3.5" />
        Add line
      </Button>
      {open ? <LineDialog projectId={projectId} line={null} contracts={contracts} lines={lines} suggestions={suggestions} locked={locked} singleBudget={lines.length === 0 ? singleBudget : null} onClose={() => setOpen(false)} /> : null}
    </>
  );
}

/** One line per trade from the subcontracts already on the project. */
export function StartFromSubcontractsButton({ projectId, count, singleBudget }: { projectId: string; count: number; singleBudget: number | null }) {
  const [open, setOpen] = useState(false);
  const { pending, run } = useAction();
  return (
    <>
      <Button variant="primary" onClick={() => setOpen(true)}>
        <Wand2 className="size-3.5" />
        Start from the subcontracts
      </Button>
      <Dialog
        open={open}
        onOpenChange={setOpen}
        size="sm"
        title="Start from the subcontracts?"
        description={
          singleBudget === null
            ? `One budget line per trade, each starting at what is committed on it, with its subcontracts assigned. ${count === 1 ? 'There is 1 subcontract' : `There are ${count} subcontracts`} on the project. Check each line’s budget against your estimate afterwards.`
            : `One budget line per trade, with its subcontracts assigned. Each line starts at what is committed on it and the rest of the project’s ${formatMoney(singleBudget)} budget goes to contingency. If that budget is less than what is committed, the lines share it in proportion, so the project stays over by the same amount.`
        }
        footer={
          <>
            <Button variant="ghost" onClick={() => setOpen(false)} disabled={pending}>
              Cancel
            </Button>
            <Button variant="primary" loading={pending} onClick={() => run(() => startBudgetFromSubcontractsAction(projectId), { success: (r) => `${r.lines} budget lines made`, onSuccess: () => setOpen(false) })}>
              Make the lines
            </Button>
          </>
        }
      />
    </>
  );
}

export function LockButton({ projectId, locked, canUnlock }: { projectId: string; locked: boolean; canUnlock: boolean }) {
  const [open, setOpen] = useState(false);
  const { pending, run } = useAction();
  if (locked && !canUnlock) return null;
  return (
    <>
      <Button onClick={() => setOpen(true)}>
        {locked ? <LockOpen className="size-3.5" /> : <Lock className="size-3.5" />}
        {locked ? 'Unlock' : 'Lock budget'}
      </Button>
      <Dialog
        open={open}
        onOpenChange={setOpen}
        size="sm"
        title={locked ? 'Unlock the budget?' : 'Lock the budget?'}
        description={
          locked
            ? 'The original budget of each line can be changed again. Every change is in the activity log. Lock it again once the change is made.'
            : 'The original budget of each line is frozen, so it stays a fixed baseline. From then on, money moves between lines by budget changes, each with a reason. Unlocking takes an approver.'
        }
        footer={
          <>
            <Button variant="ghost" onClick={() => setOpen(false)} disabled={pending}>
              Cancel
            </Button>
            <Button variant={locked ? 'danger' : 'primary'} loading={pending} onClick={() => run(() => (locked ? unlockBudgetAction(projectId) : lockBudgetAction(projectId)), { success: locked ? 'Budget unlocked' : 'Budget locked', onSuccess: () => setOpen(false) })}>
              {locked ? 'Unlock' : 'Lock'}
            </Button>
          </>
        }
      />
    </>
  );
}

export type BudgetChangeView = {
  id: string;
  from: { costCode: string; description: string } | null;
  to: { costCode: string; description: string } | null;
  amount: number;
  reason: string;
  status: string;
  createdAt: string;
  createdBy: string | null;
  voidedAt: string | null;
  voidedBy: string | null;
};

const OUTSIDE = '';

/** Record a budget change: between two lines, into one from outside the budget, or out of one. */
export function BudgetChangeButton({ projectId, lines }: { projectId: string; lines: LineRef[] }) {
  const [open, setOpen] = useState(false);
  const [from, setFrom] = useState(OUTSIDE);
  const [to, setTo] = useState(OUTSIDE);
  const [amount, setAmount] = useState<number | null>(null);
  const [reason, setReason] = useState('');
  const { pending, run } = useAction();
  const fromLine = lines.find((l) => l.id === from);
  const toLine = lines.find((l) => l.id === to);
  const over = fromLine && amount !== null && amount > fromLine.budget;
  const ready = (from || to) && from !== to && amount !== null && amount > 0 && reason.trim() !== '' && !over;
  const reset = () => {
    setFrom(OUTSIDE);
    setTo(OUTSIDE);
    setAmount(null);
    setReason('');
  };
  const option = (l: LineRef) => (
    <option key={l.id} value={l.id}>
      {l.costCode} {l.description} ({formatMoney(l.budget)})
    </option>
  );

  return (
    <>
      <Button size="sm" onClick={() => setOpen(true)}>
        <Plus className="size-3.5" />
        Record a budget change
      </Button>
      <Dialog
        open={open}
        onOpenChange={(o) => {
          setOpen(o);
          if (!o) reset();
        }}
        title="Record a budget change"
        description="Move budget from one line to another, or add to or take from the budget as a whole (an owner change order, say). The original budgets stay as they were."
        footer={
          <>
            <Button variant="ghost" onClick={() => setOpen(false)} disabled={pending}>
              Cancel
            </Button>
            <Button
              variant="primary"
              loading={pending}
              disabled={!ready}
              onClick={() =>
                amount !== null &&
                run(() => recordBudgetChangeAction(projectId, { fromLineId: from || null, toLineId: to || null, amount, reason }), {
                  success: 'Budget change recorded',
                  onSuccess: () => {
                    setOpen(false);
                    reset();
                  },
                })
              }
            >
              Record
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          <div className="grid items-end gap-3 sm:grid-cols-[1fr_auto_1fr]">
            <Field label="From">
              <Select value={from} onChange={(e) => setFrom(e.target.value)}>
                <option value={OUTSIDE}>Outside the budget (adds to it)</option>
                {lines.map(option)}
              </Select>
            </Field>
            <ArrowRight className="mb-2 hidden size-4 text-ink-3 sm:block" />
            <Field label="To">
              <Select value={to} onChange={(e) => setTo(e.target.value)}>
                <option value={OUTSIDE}>Outside the budget (takes from it)</option>
                {lines.map(option)}
              </Select>
            </Field>
          </div>
          <Field label="Amount" className="max-w-xs" error={over ? `${fromLine!.costCode} has ${formatMoney(fromLine!.budget)} of budget.` : from && from === to ? 'Choose two different lines.' : undefined}>
            <MoneyInput value={amount} onChange={setAmount} />
          </Field>
          <Field label="Reason" hint="Why the money moves, for whoever reads the budget next.">
            <Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Generator feed, change order CO-7" maxLength={300} />
          </Field>
          {(fromLine || toLine) && !over ? (
            <p className="text-xs text-ink-3">
              {fromLine && amount ? `${fromLine.costCode} goes to ${formatMoney(fromLine.budget - amount)}. ` : ''}
              {toLine && amount ? `${toLine.costCode} goes to ${formatMoney(toLine.budget + amount)}.` : ''}
            </p>
          ) : null}
        </div>
      </Dialog>
    </>
  );
}

const lineName = (l: { costCode: string; description: string }) => `${l.costCode} ${l.description}`;
const movement = (c: BudgetChangeView) => (c.from && c.to ? `from ${lineName(c.from)} to ${lineName(c.to)}` : c.to ? `added to ${lineName(c.to)}` : c.from ? `taken out of ${lineName(c.from)}` : '');

export function BudgetChangesList({ changes, canWrite }: { changes: BudgetChangeView[]; canWrite: boolean }) {
  const [voiding, setVoiding] = useState<BudgetChangeView | null>(null);
  const { pending, run } = useAction();
  return (
    <>
      <ul className="divide-y divide-line">
        {changes.map((c) => (
          <li key={c.id} className={cn('flex flex-wrap items-start justify-between gap-x-4 gap-y-1 px-4 py-2.5', c.status === 'void' && 'opacity-60')}>
            <div className="min-w-0 text-[13px]">
              <p className={cn('text-ink', c.status === 'void' && 'line-through')}>
                <span className="num font-medium">{formatMoney(c.amount)}</span> {movement(c)}
              </p>
              <p className="text-xs text-ink-2">{c.reason}</p>
              <p className="text-xs text-ink-3">
                {formatDateTime(c.createdAt)}
                {c.createdBy ? ` · ${c.createdBy}` : ''}
                {c.status === 'void' ? ` · voided${c.voidedBy ? ` by ${c.voidedBy}` : ''}${c.voidedAt ? `, ${formatDateTime(c.voidedAt)}` : ''}` : ''}
              </p>
            </div>
            {c.status === 'void' ? (
              <Badge tone="muted">Void</Badge>
            ) : canWrite ? (
              <Button size="sm" variant="ghost" onClick={() => setVoiding(c)} disabled={pending}>
                Void
              </Button>
            ) : null}
          </li>
        ))}
      </ul>
      <Dialog
        open={voiding !== null}
        onOpenChange={(o) => !o && setVoiding(null)}
        size="sm"
        title="Void this budget change?"
        description="It stays on record, marked void, and stops counting in the budget."
        footer={
          <>
            <Button variant="ghost" onClick={() => setVoiding(null)} disabled={pending}>
              Cancel
            </Button>
            <Button variant="danger" loading={pending} onClick={() => voiding && run(() => voidBudgetChangeAction(voiding.id), { success: 'Budget change voided', onSuccess: () => setVoiding(null) })}>
              Void
            </Button>
          </>
        }
      />
    </>
  );
}
