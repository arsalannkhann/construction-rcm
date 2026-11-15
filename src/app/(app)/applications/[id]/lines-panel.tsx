'use client';

import { CircleHelp, Ellipsis, Link2, LocateFixed, Plus, Trash2 } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Badge, EmptyState } from '@/components/ui/data';
import { Field, Input, MoneyInput, Select } from '@/components/ui/form';
import { Dialog, Menu, MenuItem, Tooltip } from '@/components/ui/overlay';
import { formatMoney, percentOf } from '@/lib/money';
import { useAction } from '@/lib/use-action';
import { cn } from '@/lib/utils';
import type { ReviewData } from '@/server/services/queries';
import type { LineAmountField } from '@/server/types';
import { addLineAction, deleteLineAction, setLineMatchAction, updateLineAction } from '../actions';
import { EditableAmount } from './edit-amount';
import { useWorkspace } from './workspace';

type Line = ReviewData['lines'][number];
type Verified = ReviewData['verifiedLines'][number];

const m = (cents: number | null | undefined) => formatMoney(cents, { symbol: false });

export function LinesPanel() {
  const ws = useWorkspace();
  const { data, editable } = ws;
  const [adding, setAdding] = useState(false);
  const decided = data.app.status === 'approved';

  const bySov = new Map<string, Verified>();
  for (const v of data.verifiedLines) if (v.sovLineId) bySov.set(v.sovLineId, v);
  const used = new Set(data.lines.map((l) => l.sovLineId).filter(Boolean));
  const missing = data.verifiedLines.filter((v) => v.sovLineId && !used.has(v.sovLineId));
  const freeSov = data.sov.filter((s) => !used.has(s.id));

  const sum = (pick: (l: Line) => number | null) => data.lines.reduce((a, l) => a + (pick(l) ?? 0), 0);
  const vsum = (pick: (v: Verified) => number) => data.verifiedLines.reduce((a, v) => a + pick(v), 0);

  if (data.lines.length === 0 && missing.length === 0) {
    return (
      <>
      <AddLineDialog open={adding} onOpenChange={setAdding} />
      <EmptyState
        className="py-16"
        title="No line items were read"
        description="The package has no schedule of values that could be read automatically. Key the lines from the document, or add the continuation sheet to the package."
        action={
          editable ? (
            <Button variant="primary" onClick={() => setAdding(true)}>
              <Plus className="size-3.5" /> Add a line
            </Button>
          ) : null
        }
      />
      </>
    );
  }

  return (
    <div className="px-5 py-4">
      <div className="mb-2 flex items-center justify-between gap-4">
        <p className="text-xs text-ink-3">
          {editable ? 'Click a figure to correct a misread or adjust what will be approved. ' : ''}
          Smaller figures under a cell show where your records differ from the submission.
        </p>
        {editable ? (
          <Button size="sm" onClick={() => setAdding(true)}>
            <Plus className="size-3.5" /> Add line
          </Button>
        ) : null}
      </div>

      <div className="overflow-x-auto rounded-lg border border-line">
        <table className="w-full min-w-[720px] border-collapse text-xs">
          <thead>
            <tr className="bg-canvas/70 text-[10.5px] font-medium uppercase tracking-wide text-ink-3">
              <th className="w-12 py-1.5 pl-3 text-left">Item</th>
              <th className="py-1.5 text-left">Description</th>
              <th className="py-1.5 pr-2.5 text-right">Scheduled</th>
              <th className="py-1.5 pr-2.5 text-right">Previous</th>
              <th className="py-1.5 pr-2.5 text-right">This period</th>
              <th className="py-1.5 pr-2.5 text-right">Stored</th>
              <th className="py-1.5 pr-2.5 text-right">Total</th>
              <th className="w-12 py-1.5 pr-2.5 text-right">%</th>
              <th className="w-8" />
            </tr>
          </thead>
          <tbody>
            {data.lines.map((line) => (
              <LineRow key={line.id} line={line} verified={line.sovLineId ? bySov.get(line.sovLineId) : undefined} freeSov={freeSov} />
            ))}
            {missing.map((v) => (
              <tr key={v.sovLineId} className="border-t border-line bg-canvas/40 text-ink-3">
                <td className="num py-2 pl-3 align-top">{v.itemNo}</td>
                <td className="py-2 align-top">
                  {v.description}
                  <span className="mt-0.5 block text-[11px] text-warn">On the contract, not on the submitted schedule</span>
                </td>
                <td className="num py-2 pr-2.5 text-right align-top">{m(v.scheduledValue)}</td>
                <td className="num py-2 pr-2.5 text-right align-top">{m(v.previous)}</td>
                <td className="num py-2 pr-2.5 text-right align-top">—</td>
                <td className="num py-2 pr-2.5 text-right align-top">—</td>
                <td className="num py-2 pr-2.5 text-right align-top">{m(v.total)}</td>
                <td className="num py-2 pr-2.5 text-right align-top">{percentOf(v.total, v.scheduledValue)?.toFixed(0) ?? '—'}</td>
                <td />
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="border-t-2 border-line-strong bg-canvas/60 font-medium">
              <td />
              <td className="py-2 text-ink-2">As submitted</td>
              <td className="num py-2 pr-2.5 text-right">{m(sum((l) => l.scheduledValue))}</td>
              <td className="num py-2 pr-2.5 text-right">{m(sum((l) => l.previous))}</td>
              <td className="num py-2 pr-2.5 text-right">{m(sum((l) => l.thisPeriod))}</td>
              <td className="num py-2 pr-2.5 text-right">{m(sum((l) => l.stored))}</td>
              <td className="num py-2 pr-2.5 text-right">{m(sum((l) => l.total ?? (l.previous ?? 0) + (l.thisPeriod ?? 0) + (l.stored ?? 0)))}</td>
              <td colSpan={2} />
            </tr>
            {data.verifiedLines.length > 0 ? (
              <tr className="border-t border-line bg-canvas/60 font-semibold">
                <td />
                <td className="py-2">{decided ? 'Approved' : 'Verified'}</td>
                <td className="num py-2 pr-2.5 text-right">{m(vsum((v) => v.scheduledValue))}</td>
                <td className="num py-2 pr-2.5 text-right">{m(vsum((v) => v.previous))}</td>
                <td className="num py-2 pr-2.5 text-right">{m(vsum((v) => v.thisPeriod))}</td>
                <td className="num py-2 pr-2.5 text-right">{m(vsum((v) => v.stored))}</td>
                <td className="num py-2 pr-2.5 text-right">{m(vsum((v) => v.total))}</td>
                <td className="num py-2 pr-2.5 text-right">{percentOf(vsum((v) => v.total), vsum((v) => v.scheduledValue))?.toFixed(0) ?? '—'}</td>
                <td />
              </tr>
            ) : null}
          </tfoot>
        </table>
      </div>

      <AddLineDialog open={adding} onOpenChange={setAdding} />
    </div>
  );
}

function LineRow({ line, verified, freeSov }: { line: Line; verified?: Verified; freeSov: ReviewData['sov'] }) {
  const ws = useWorkspace();
  const { data, editable } = ws;
  const { pending, run } = useAction();
  const ref = useRef<HTMLTableRowElement>(null);
  const [matching, setMatching] = useState(false);
  const [removing, setRemoving] = useState(false);
  const focused = ws.focusedLine?.id === line.id ? ws.focusedLine.nonce : null;

  useEffect(() => {
    if (focused) ref.current?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }, [focused]);

  const spot = ws.spotForLine(line.id);
  const unmatched = !line.sovLineId;
  const total = line.total ?? (line.previous ?? 0) + (line.thisPeriod ?? 0) + (line.stored ?? 0);
  const over = verified ? verified.total > verified.scheduledValue : false;
  const shaky = line.extracted && line.extracted.confidence < 0.75 && !line.editKind;
  const issues = new Set(data.findings.filter((f) => f.status === 'open' && f.refs?.lineId === line.id).map((f) => f.code));

  const save = (field: LineAmountField) => (edit: { value: number | null; kind: 'correction' | 'adjustment'; note: string | null }, close: () => void) =>
    run(() => updateLineAction(line.id, { [field]: edit.value }, edit.kind, edit.note), { success: edit.kind === 'adjustment' ? 'Adjusted' : 'Corrected', onSuccess: close });

  const cell = (field: LineAmountField, label: string, askKind: boolean, ours?: number | null, oursLabel?: string) => {
    const value = line[field];
    const differs = ours !== undefined && ours !== null && value !== null && value !== ours;
    return (
      <td className="py-2 pr-2.5 text-right align-top">
        <EditableAmount value={value} extracted={line.extracted ? line.extracted[field] : undefined} editable={editable} askKind={askKind} label={`${line.itemNo ?? ''} ${line.description ?? ''} · ${label}`.trim()} pending={pending} onSave={save(field)}>
          <span className={cn('num', value === null && 'text-ink-4', differs && 'font-medium text-block')}>{value === null ? (editable ? 'Enter' : '—') : m(value)}</span>
        </EditableAmount>
        {differs ? (
          <span className="num mt-0.5 block text-[10.5px] leading-3 text-ink-3">
            {oursLabel} {m(ours)}
          </span>
        ) : null}
      </td>
    );
  };

  return (
    <tr
      ref={ref}
      key={focused ?? 'row'}
      className={cn('group border-t border-line', (unmatched || issues.size > 0) && 'bg-block-soft/35')}
      style={focused ? { animation: 'row-flash 1400ms ease-out 1' } : undefined}
    >
      <td className="num py-2 pl-3 align-top text-ink-2">{line.itemNo ?? '—'}</td>
      <td className="max-w-[220px] py-2 pr-2 align-top">
        <span className="flex items-start gap-1.5">
          <span className="min-w-0 break-words text-ink">{line.description ?? <span className="text-ink-4">No description</span>}</span>
          {shaky ? (
            <Tooltip content="Read with low confidence. Check the row against the page.">
              <CircleHelp className="mt-0.5 size-3 shrink-0 text-warn" />
            </Tooltip>
          ) : null}
        </span>
        <span className="mt-0.5 flex flex-wrap items-center gap-1">
          {unmatched ? <Badge tone="block">Not on the contract</Badge> : null}
          {over ? <Badge tone="block">Over scheduled value</Badge> : null}
          {line.editKind ? (
            <Tooltip content={`${line.editNote ?? (line.editKind === 'adjustment' ? 'Adjusted' : 'Corrected from the document')}${line.editedBy ? ` — ${data.people[line.editedBy] ?? 'reviewer'}` : ''}`}>
              <span>
                <Badge tone={line.editKind === 'adjustment' ? 'accent' : 'neutral'}>{line.editKind === 'adjustment' ? 'Adjusted' : 'Corrected'}</Badge>
              </span>
            </Tooltip>
          ) : null}
        </span>
      </td>
      {cell('scheduledValue', 'Scheduled value', false, verified?.scheduledValue, 'contract')}
      {cell('previous', 'Previous', false, verified?.previous, 'approved')}
      {cell('thisPeriod', 'This period', true)}
      {cell('stored', 'Stored materials', true)}
      {cell('total', 'Total', false, verified?.total, 'verified')}
      <td className={cn('num py-2 pr-2.5 text-right align-top', over ? 'font-medium text-block' : 'text-ink-2')}>{percentOf(verified?.total ?? total, verified?.scheduledValue ?? line.scheduledValue ?? 0)?.toFixed(0) ?? '—'}</td>
      <td className="py-1.5 pr-1.5 text-right align-top">
        <Menu
          trigger={
            <button className="focus-ring rounded p-1 text-ink-4 hover:bg-sunken hover:text-ink" aria-label={`Actions for line ${line.itemNo ?? ''}`}>
              <Ellipsis className="size-3.5" />
            </button>
          }
        >
          <MenuItem icon={<LocateFixed />} disabled={!spot} onSelect={() => ws.show(spot)}>
            Show in document
          </MenuItem>
          {editable ? (
            <>
              <MenuItem icon={<Link2 />} onSelect={() => setMatching(true)}>
                {unmatched ? 'Match to a contract line…' : 'Change contract line…'}
              </MenuItem>
              <MenuItem icon={<Trash2 />} danger onSelect={() => setRemoving(true)}>
                Remove line…
              </MenuItem>
            </>
          ) : null}
        </Menu>
        <MatchDialog open={matching} onOpenChange={setMatching} line={line} freeSov={freeSov} />
        <Dialog
          open={removing}
          onOpenChange={setRemoving}
          size="sm"
          title="Remove this line?"
          description={`${line.itemNo ?? ''} ${line.description ?? ''} will be removed from the application’s figures. The original document is not changed, and the removal is recorded.`}
          footer={
            <>
              <Button variant="ghost" onClick={() => setRemoving(false)}>
                Cancel
              </Button>
              <Button variant="danger" loading={pending} onClick={() => run(() => deleteLineAction(line.id), { success: 'Line removed', onSuccess: () => setRemoving(false) })}>
                Remove line
              </Button>
            </>
          }
        />
        <style>{`@keyframes row-flash { 0%, 35% { background-color: var(--color-accent-soft); } 100% { background-color: transparent; } }`}</style>
      </td>
    </tr>
  );
}

function MatchDialog({ open, onOpenChange, line, freeSov }: { open: boolean; onOpenChange: (o: boolean) => void; line: Line; freeSov: ReviewData['sov'] }) {
  const { data } = useWorkspace();
  const current = data.sov.find((s) => s.id === line.sovLineId);
  const options = current ? [current, ...freeSov] : freeSov;
  const [choice, setChoice] = useState(line.sovLineId ?? '');
  const { pending, run } = useAction();
  useEffect(() => {
    if (open) setChoice(line.sovLineId ?? '');
  }, [open, line.sovLineId]);
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Which contract line is this?"
      description={`Submitted as “${line.itemNo ?? ''} ${line.description ?? ''}” with a scheduled value of ${formatMoney(line.scheduledValue)}.`}
      footer={
        <>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button variant="primary" loading={pending} disabled={(choice || null) === line.sovLineId} onClick={() => run(() => setLineMatchAction(line.id, choice || null), { success: 'Match updated', onSuccess: () => onOpenChange(false) })}>
            Save
          </Button>
        </>
      }
    >
      <Field label="Contract schedule line" hint="Only lines not already matched to another row are listed. A line that is not on the contract is excluded from the verified amount.">
        <Select value={choice} onChange={(e) => setChoice(e.target.value)}>
          <option value="">Not on the contract</option>
          {options.map((s) => (
            <option key={s.id} value={s.id}>
              {s.itemNo} · {s.description} · {formatMoney(s.scheduledValue)}
            </option>
          ))}
        </Select>
      </Field>
    </Dialog>
  );
}

function AddLineDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const { data } = useWorkspace();
  const { pending, run } = useAction();
  const empty = { itemNo: '', description: '', scheduledValue: null as number | null, thisPeriod: null as number | null, stored: null as number | null, previous: null as number | null };
  const [form, setForm] = useState(empty);
  useEffect(() => {
    if (open) setForm(empty);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Add a line from the document"
      description="For rows that were not read automatically. Enter the figures as they appear on the schedule of values."
      footer={
        <>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            variant="primary"
            loading={pending}
            disabled={!form.description.trim() && !form.itemNo.trim()}
            onClick={() => run(() => addLineAction(data.app.id, { ...form, itemNo: form.itemNo || null, description: form.description || null }), { success: 'Line added', onSuccess: () => onOpenChange(false) })}
          >
            Add line
          </Button>
        </>
      }
    >
      <div className="grid grid-cols-3 gap-3">
        <Field label="Item no.">
          <Input autoFocus value={form.itemNo} onChange={(e) => setForm((f) => ({ ...f, itemNo: e.target.value }))} />
        </Field>
        <Field label="Description" className="col-span-2">
          <Input value={form.description} onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))} />
        </Field>
        <Field label="Scheduled value">
          <MoneyInput value={form.scheduledValue} onChange={(v) => setForm((f) => ({ ...f, scheduledValue: v }))} />
        </Field>
        <Field label="Previous">
          <MoneyInput value={form.previous} onChange={(v) => setForm((f) => ({ ...f, previous: v }))} />
        </Field>
        <Field label="This period">
          <MoneyInput value={form.thisPeriod} onChange={(v) => setForm((f) => ({ ...f, thisPeriod: v }))} />
        </Field>
        <Field label="Stored materials">
          <MoneyInput value={form.stored} onChange={(v) => setForm((f) => ({ ...f, stored: v }))} />
        </Field>
      </div>
    </Dialog>
  );
}
