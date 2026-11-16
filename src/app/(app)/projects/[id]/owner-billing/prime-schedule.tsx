'use client';

import { ChevronDown, ListPlus, Pencil, Plus, X } from 'lucide-react';
import { useState } from 'react';
import { ScheduleDifference } from '@/components/records/figures';
import { Badge, EmptyState, Money, Panel, PanelHeader, Table, Td, Th } from '@/components/ui/data';
import { Button } from '@/components/ui/button';
import { Checkbox, Input, MoneyInput, Select } from '@/components/ui/form';
import { Dialog, Popover } from '@/components/ui/overlay';
import { formatMoney } from '@/lib/money';
import { useAction } from '@/lib/use-action';
import { cn, pluralize } from '@/lib/utils';
import { PRIME_LINE_BASES, PRIME_LINE_BASIS_LABEL, type PrimeLineBasis } from '@/server/types';
import { savePrimeScheduleAction } from './actions';

export type PrimeLineView = { id: string; itemNo: string; description: string; scheduledValue: number; basis: PrimeLineBasis; contractIds: string[]; changeOrderNumber: string | null };
export type SubcontractOption = { id: string; number: string; title: string; subcontractorName: string; contractSum: number; status: string };

type Row = { key: string; id?: string; itemNo: string; description: string; scheduledValue: number | null; basis: PrimeLineBasis; contractIds: string[]; changeOrderNumber: string | null };

let nextKey = 0;
const rowOf = (l: Partial<Row> = {}): Row => ({ key: `pl-${++nextKey}`, itemNo: '', description: '', scheduledValue: null, basis: 'manual', contractIds: [], changeOrderNumber: null, ...l });
const blank = (r: Row) => !r.id && !r.description.trim() && r.scheduledValue === null;

function nextItemNo(rows: Row[]): string {
  const used = rows.map((r) => r.itemNo.trim()).filter((n) => /^\d{1,6}$/.test(n));
  return String(used.reduce((max, n) => Math.max(max, Number(n)), 0) + 1);
}

const BASIS_HINT: Record<PrimeLineBasis, string> = {
  subcontracts: 'Billed at the percent complete of the linked subcontracts, from their approved applications.',
  overall: 'Billed at the percent complete of everything else: for fee, insurance and bonds.',
  manual: 'You enter the amount each period: self-performed work, general conditions.',
};

function SubcontractPicker({ value, onChange, subcontracts, disabled }: { value: string[]; onChange: (ids: string[]) => void; subcontracts: SubcontractOption[]; disabled?: boolean }) {
  const chosen = subcontracts.filter((s) => value.includes(s.id));
  return (
    <Popover
      trigger={
        <button type="button" disabled={disabled} className={cn('focus-ring flex h-8 w-full items-center justify-between gap-2 rounded-md border border-line bg-surface px-2.5 text-left text-[13px]', chosen.length === 0 && 'text-warn')}>
          <span className="truncate">{chosen.length === 0 ? 'Choose subcontracts' : chosen.map((c) => c.number).join(', ')}</span>
          <ChevronDown className="size-3.5 shrink-0 text-ink-3" />
        </button>
      }
    >
      <div className="max-h-72 w-72 space-y-2 overflow-y-auto p-1">
        {subcontracts.length === 0 ? <p className="text-[13px] text-ink-3">No subcontracts on this project yet.</p> : null}
        {subcontracts.map((s) => (
          <Checkbox
            key={s.id}
            checked={value.includes(s.id)}
            onChange={(e) => onChange(e.target.checked ? [...value, s.id] : value.filter((id) => id !== s.id))}
            label={`${s.number} · ${s.subcontractorName}`}
            description={`${s.title}, ${formatMoney(s.contractSum)}`}
          />
        ))}
      </div>
    </Popover>
  );
}

export function PrimeSchedulePanel({ projectId, lines, subcontracts, contractSumToDate, canWrite }: { projectId: string; lines: PrimeLineView[]; subcontracts: SubcontractOption[]; contractSumToDate: number; canWrite: boolean }) {
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState<Row[]>([]);
  const [error, setError] = useState<string | null>(null);
  const { pending, run } = useAction();
  const total = lines.reduce((a, l) => a + l.scheduledValue, 0);
  const byId = new Map(subcontracts.map((s) => [s.id, s]));
  const linked = new Set(lines.flatMap((l) => (l.basis === 'subcontracts' ? l.contractIds : [])));
  const unlinked = subcontracts.filter((s) => !linked.has(s.id));

  const edit = (seed?: Row[]) => {
    setRows(seed ?? [...lines.map((l) => rowOf({ ...l })), rowOf({ itemNo: nextItemNo(lines.map((l) => rowOf(l))) })]);
    setError(null);
    setOpen(true);
  };
  const fromSubcontracts = (current: Row[]): Row[] => {
    const have = new Set(current.flatMap((r) => (r.basis === 'subcontracts' ? r.contractIds : [])));
    const kept = current.filter((r) => !blank(r));
    const added: Row[] = [];
    for (const s of subcontracts.filter((x) => !have.has(x.id))) {
      added.push(rowOf({ itemNo: nextItemNo([...kept, ...added]), description: `${s.title} (${s.subcontractorName})`, scheduledValue: s.contractSum, basis: 'subcontracts', contractIds: [s.id] }));
    }
    return [...kept, ...added];
  };
  const update = (key: string, patch: Partial<Row>) => setRows((rs) => rs.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  const filled = rows.filter((r) => !blank(r));
  const draftTotal = filled.reduce((a, r) => a + (r.scheduledValue ?? 0), 0);

  const save = () => {
    for (const [i, r] of filled.entries()) {
      if (r.scheduledValue === null) return setError(`Line ${r.itemNo || i + 1}: enter a scheduled value.`);
      if (r.basis === 'subcontracts' && r.contractIds.length === 0) return setError(`Line ${r.itemNo || i + 1}: choose the subcontracts it follows, or bill it another way.`);
    }
    setError(null);
    run(() => savePrimeScheduleAction(projectId, filled.map((r) => ({ id: r.id, itemNo: r.itemNo, description: r.description, scheduledValue: r.scheduledValue!, basis: r.basis, contractIds: r.contractIds }))), {
      success: 'Owner schedule of values saved',
      onSuccess: () => setOpen(false),
    });
  };

  return (
    <Panel className="overflow-hidden">
      <PanelHeader
        title="Owner schedule of values"
        description="The lines you bill the owner against. Each line says how it is billed every period."
        actions={
          canWrite && lines.length > 0 ? (
            <Button size="sm" onClick={() => edit()}>
              <Pencil className="size-3.5" />
              Edit schedule
            </Button>
          ) : null
        }
      />
      {lines.length === 0 ? (
        <EmptyState
          icon={<ListPlus />}
          title="No lines yet"
          description={subcontracts.length > 0 ? `Start with one line per subcontract (${pluralize(subcontracts.length, 'subcontract')} on this project), then add general conditions, your fee and anything you perform yourself.` : 'Add the lines of the schedule in your contract with the owner.'}
          action={
            canWrite ? (
              <div className="flex flex-wrap justify-center gap-2">
                {subcontracts.length > 0 ? (
                  <Button variant="primary" onClick={() => edit([...fromSubcontracts([]), rowOf({ itemNo: String(subcontracts.length + 1) })])}>
                    <ListPlus className="size-3.5" />
                    Start from subcontracts
                  </Button>
                ) : null}
                <Button onClick={() => edit([rowOf({ itemNo: '1' })])}>
                  <Plus className="size-3.5" />
                  Add lines
                </Button>
              </div>
            ) : null
          }
        />
      ) : (
        <>
          <Table>
            <thead>
              <tr>
                <Th className="w-16 pl-4">Item</Th>
                <Th>Description</Th>
                <Th align="right">Scheduled value</Th>
                <Th className="pr-4">Billed</Th>
              </tr>
            </thead>
            <tbody className="[&_tr:last-child>td]:border-b-0">
              {lines.map((l) => (
                <tr key={l.id}>
                  <Td className="pl-4 font-medium">{l.itemNo}</Td>
                  <Td>
                    {l.description}
                    {l.changeOrderNumber ? (
                      <Badge tone="muted" className="ml-2">
                        Change order
                      </Badge>
                    ) : null}
                  </Td>
                  <Td align="right">
                    <Money cents={l.scheduledValue} />
                  </Td>
                  <Td className="pr-4 text-ink-2">
                    {PRIME_LINE_BASIS_LABEL[l.basis]}
                    {l.basis === 'subcontracts' ? (
                      <div className={cn('text-xs', l.contractIds.length ? 'text-ink-3' : 'text-warn')}>
                        {l.contractIds.length ? l.contractIds.map((id) => byId.get(id)?.number ?? 'Removed').join(', ') : 'No subcontracts linked'}
                      </div>
                    ) : null}
                  </Td>
                </tr>
              ))}
              <tr className="bg-canvas/60">
                <Td className="pl-4" />
                <Td className="font-medium">Total</Td>
                <Td align="right" className="font-medium">
                  <Money cents={total} />
                </Td>
                <Td className="pr-4" />
              </tr>
            </tbody>
          </Table>
          <div className="space-y-2 p-4 empty:hidden">
            <ScheduleDifference scheduleTotal={total} contractAmount={contractSumToDate} amountLabel="contract sum to date" />
            {unlinked.length > 0 ? (
              <p className="text-[13px] text-warn">
                Not on the owner schedule: {unlinked.map((s) => `${s.number} (${s.subcontractorName})`).join(', ')}. Their approved billing does not reach the owner until a line follows them.
              </p>
            ) : null}
          </div>
        </>
      )}

      <Dialog
        open={open}
        onOpenChange={setOpen}
        size="xl"
        title="Owner schedule of values"
        description="Lines from approved owner change orders keep their figures; change those on the change order. A line already billed to the owner cannot be removed."
        footer={
          <>
            <span className="mr-auto text-[13px] text-ink-2">
              Total <span className="num font-medium text-ink">{formatMoney(draftTotal)}</span> of <span className="num">{formatMoney(contractSumToDate)}</span>
            </span>
            <Button variant="ghost" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button variant="primary" loading={pending} onClick={save}>
              Save schedule
            </Button>
          </>
        }
      >
        <div className="space-y-3">
          <div className="overflow-x-auto rounded-lg border border-line">
            <table className="w-full min-w-[760px] text-[13px]">
              <thead className="bg-canvas/60 text-[11px] uppercase tracking-wide text-ink-3">
                <tr>
                  <th className="w-20 px-2 py-2 text-left font-medium">Item</th>
                  <th className="px-2 py-2 text-left font-medium">Description</th>
                  <th className="w-36 px-2 py-2 text-right font-medium">Value</th>
                  <th className="w-56 px-2 py-2 text-left font-medium">Billed</th>
                  <th className="w-8" />
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const fixed = r.changeOrderNumber !== null;
                  return (
                    <tr key={r.key} className="border-t border-line align-top">
                      <td className="px-2 py-1.5">
                        <Input aria-label="Item number" value={r.itemNo} disabled={fixed} onChange={(e) => update(r.key, { itemNo: e.target.value })} />
                      </td>
                      <td className="px-2 py-1.5">
                        <Input aria-label="Description" value={r.description} disabled={fixed} onChange={(e) => update(r.key, { description: e.target.value })} placeholder="General conditions" />
                      </td>
                      <td className="px-2 py-1.5">
                        <MoneyInput aria-label="Scheduled value" value={r.scheduledValue} disabled={fixed} onChange={(cents) => update(r.key, { scheduledValue: cents })} />
                      </td>
                      <td className="space-y-1.5 px-2 py-1.5">
                        <Select aria-label="How this line is billed" value={r.basis} onChange={(e) => update(r.key, { basis: e.target.value as PrimeLineBasis })} title={BASIS_HINT[r.basis]}>
                          {PRIME_LINE_BASES.map((b) => (
                            <option key={b} value={b}>
                              {PRIME_LINE_BASIS_LABEL[b]}
                            </option>
                          ))}
                        </Select>
                        {r.basis === 'subcontracts' ? <SubcontractPicker value={r.contractIds} onChange={(ids) => update(r.key, { contractIds: ids })} subcontracts={subcontracts} /> : null}
                      </td>
                      <td className="py-1.5 pr-2">
                        {fixed ? null : (
                          <button type="button" className="focus-ring mt-1 rounded p-1 text-ink-3 hover:bg-sunken hover:text-ink" aria-label={`Remove line ${r.itemNo}`} onClick={() => setRows((rs) => rs.filter((x) => x.key !== r.key))}>
                            <X className="size-3.5" />
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" onClick={() => setRows((rs) => [...rs, rowOf({ itemNo: nextItemNo(rs) })])}>
              <Plus className="size-3.5" />
              Add line
            </Button>
            {subcontracts.some((s) => !rows.some((r) => r.basis === 'subcontracts' && r.contractIds.includes(s.id))) ? (
              <Button size="sm" variant="ghost" onClick={() => setRows((rs) => fromSubcontracts(rs))}>
                <ListPlus className="size-3.5" />
                Add a line for each subcontract not on it
              </Button>
            ) : null}
          </div>
          <ul className="space-y-1 text-xs text-ink-3">
            {PRIME_LINE_BASES.map((b) => (
              <li key={b}>
                <span className="font-medium text-ink-2">{PRIME_LINE_BASIS_LABEL[b]}:</span> {BASIS_HINT[b]}
              </li>
            ))}
          </ul>
          <ScheduleDifference scheduleTotal={draftTotal} contractAmount={contractSumToDate} amountLabel="contract sum to date" saving />
          {error ? <p className="text-[13px] text-block">{error}</p> : null}
        </div>
      </Dialog>
    </Panel>
  );
}
