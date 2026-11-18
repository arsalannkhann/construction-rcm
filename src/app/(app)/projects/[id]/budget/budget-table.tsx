'use client';

import { MoreHorizontal, Pencil } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Money } from '@/components/ui/data';
import { Checkbox, Field, Input, MoneyInput, Select, Textarea } from '@/components/ui/form';
import { Dialog, Menu, MenuItem } from '@/components/ui/overlay';
import { formatMoney } from '@/lib/money';
import { useAction } from '@/lib/use-action';
import { cn, formatDateTime, pluralize } from '@/lib/utils';
import { FORECAST_METHOD_HINT, FORECAST_METHOD_LABEL, FORECAST_METHODS, type ForecastMethod } from '@/server/services/budget-calc';
import { assignBudgetLinesAction, deleteBudgetLineAction, saveBudgetLineAction, setBudgetForecastAction } from './actions';

export type Figures = {
  original: number;
  changes: number;
  budget: number;
  committed: number;
  pending: number;
  projected: number;
  billed: number;
  stillToCommit: number;
  atCompletion: number;
  toComplete: number;
  variance: number;
};

export type BudgetLineView = Figures & {
  id: string;
  costCode: string;
  description: string;
  contractIds: string[];
  forecastMethod: ForecastMethod;
  forecastAmount: number | null;
  forecastNote: string | null;
  forecastBy: string | null;
  forecastAt: string | null;
};

export type BudgetContractView = { id: string; number: string; title: string; subcontractorName: string; status: string; budgetLineId: string | null; suggestedLineId: string | null; contractSum: number };

type Props = {
  projectId: string;
  lines: BudgetLineView[];
  unassigned: (Figures & { contractIds: string[] }) | null;
  totals: Figures;
  contracts: BudgetContractView[];
  suggestions: Array<{ code: string; description: string }>;
  locked: boolean;
  canWrite: boolean;
};

/** Over/under: a saving reads plainly, an overrun in red with what it is. */
function Variance({ cents, className }: { cents: number; className?: string }) {
  if (cents === 0) return <span className={cn('num text-ink-3', className)}>On budget</span>;
  return (
    <span className={cn('num whitespace-nowrap', cents < 0 ? 'font-medium text-block' : 'text-pass', className)}>
      {formatMoney(Math.abs(cents))} {cents < 0 ? 'over' : 'under'}
    </span>
  );
}

const FIGURE_CELL = 'border-b border-line px-3 py-2.5 text-right align-top num';
const FORECAST_CELL = cn(FIGURE_CELL, 'bg-canvas/50');

/**
 * The budget by cost code. Figures from records on the left, the forecast on
 * the right, so it is always plain which numbers are a forecast.
 */
export function BudgetTable({ projectId, lines, unassigned, totals, contracts, suggestions, locked, canWrite }: Props) {
  const [editing, setEditing] = useState<BudgetLineView | 'new' | null>(null);
  const [forecasting, setForecasting] = useState<BudgetLineView | null>(null);
  const [assigning, setAssigning] = useState(false);
  const [removing, setRemoving] = useState<BudgetLineView | null>(null);
  const { pending, run } = useAction();
  const numbers = (ids: string[]) => ids.map((id) => contracts.find((c) => c.id === id)?.number).filter(Boolean) as string[];

  return (
    <>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[1080px] border-collapse text-left text-[13px]">
          <thead>
            <tr className="text-[11px] font-medium uppercase tracking-wide text-ink-3">
              <th className="sticky left-0 z-10 bg-surface px-3 pb-1 pt-2 pl-4" />
              <th colSpan={4} className="border-b border-line px-3 pb-1 pt-2 text-right font-medium normal-case tracking-normal text-ink-2">
                From records
              </th>
              <th colSpan={4} className="border-b border-line bg-canvas/50 px-3 pb-1 pt-2 text-right font-medium normal-case tracking-normal text-ink-2">
                Forecast
              </th>
              {canWrite ? <th /> : null}
            </tr>
            <tr className="text-[11px] font-medium uppercase tracking-wide text-ink-3">
              <th className="sticky left-0 z-10 whitespace-nowrap border-b border-line bg-surface px-3 py-2 pl-4">Cost code</th>
              <th className="whitespace-nowrap border-b border-line px-3 py-2 text-right">Budget</th>
              <th className="whitespace-nowrap border-b border-line px-3 py-2 text-right">Committed</th>
              <th className="whitespace-nowrap border-b border-line px-3 py-2 text-right">Pending</th>
              <th className="whitespace-nowrap border-b border-line px-3 py-2 text-right">Billed to date</th>
              <th className="whitespace-nowrap border-b border-line bg-canvas/50 px-3 py-2 text-right">Still to commit</th>
              <th className="whitespace-nowrap border-b border-line bg-canvas/50 px-3 py-2 text-right">At completion</th>
              <th className="whitespace-nowrap border-b border-line bg-canvas/50 px-3 py-2 text-right">To complete</th>
              <th className="whitespace-nowrap border-b border-line bg-canvas/50 px-3 py-2 text-right">Over / under</th>
              {canWrite ? <th className="w-10 border-b border-line" /> : null}
            </tr>
          </thead>
          <tbody>
            {lines.map((l) => {
              const subs = numbers(l.contractIds);
              return (
                <tr key={l.id} className="group hover:bg-canvas/60">
                  <td className="sticky left-0 z-10 max-w-[260px] border-b border-line bg-surface px-3 py-2.5 pl-4 align-top group-hover:bg-canvas">
                    {canWrite ? (
                      <button type="button" onClick={() => setEditing(l)} className="text-left font-medium hover:underline">
                        <span className="num">{l.costCode}</span> {l.description}
                      </button>
                    ) : (
                      <span className="font-medium">
                        <span className="num">{l.costCode}</span> {l.description}
                      </span>
                    )}
                    <div className="mt-0.5 truncate text-xs text-ink-3" title={subs.join(', ')}>
                      {subs.length ? subs.join(', ') : 'No subcontracts'}
                    </div>
                  </td>
                  <td className={FIGURE_CELL}>
                    <Money cents={l.budget} />
                    {l.changes !== 0 ? <div className="text-xs text-ink-3">{`${formatMoney(l.original)} ${l.changes > 0 ? '+' : '−'} ${formatMoney(Math.abs(l.changes))}`}</div> : null}
                  </td>
                  <td className={FIGURE_CELL}>
                    <Money cents={l.committed} />
                  </td>
                  <td className={cn(FIGURE_CELL, l.pending !== 0 && 'text-warn')}>{l.pending === 0 ? <span className="text-ink-4">—</span> : formatMoney(l.pending)}</td>
                  <td className={FIGURE_CELL}>
                    <Money cents={l.billed} />
                  </td>
                  <td className={FORECAST_CELL}>
                    {canWrite ? (
                      <button type="button" onClick={() => setForecasting(l)} className="group/f inline-flex items-center gap-1.5 hover:underline" aria-label={`Change the forecast for ${l.costCode}`}>
                        <Pencil className="size-3 text-ink-4 opacity-0 transition group-hover:opacity-100" />
                        {formatMoney(l.stillToCommit)}
                      </button>
                    ) : (
                      formatMoney(l.stillToCommit)
                    )}
                    <div className="text-xs text-ink-3" title={l.forecastNote ?? undefined}>
                      {l.forecastMethod === 'entered' ? 'entered' : l.forecastMethod === 'none' ? 'nothing more' : 'rest of budget'}
                    </div>
                  </td>
                  <td className={FORECAST_CELL}>
                    <Money cents={l.atCompletion} />
                  </td>
                  <td className={FORECAST_CELL}>
                    <Money cents={l.toComplete} />
                  </td>
                  <td className={FORECAST_CELL}>
                    <Variance cents={l.variance} />
                  </td>
                  {canWrite ? (
                    <td className="border-b border-line px-2 py-2 align-top">
                      <Menu
                        trigger={
                          <button type="button" className="focus-ring rounded-md p-1 text-ink-3 hover:bg-sunken hover:text-ink" aria-label={`Actions for ${l.costCode}`}>
                            <MoreHorizontal className="size-4" />
                          </button>
                        }
                      >
                        <MenuItem onSelect={() => setEditing(l)}>Edit line and subcontracts…</MenuItem>
                        <MenuItem onSelect={() => setForecasting(l)}>Change the forecast…</MenuItem>
                        <MenuItem danger onSelect={() => setRemoving(l)}>
                          Remove line
                        </MenuItem>
                      </Menu>
                    </td>
                  ) : null}
                </tr>
              );
            })}
            {unassigned ? (
              <tr className="bg-warn-soft/40">
                <td className="sticky left-0 z-10 border-b border-line bg-warn-soft px-3 py-2.5 pl-4 align-top">
                  <span className="font-medium text-warn">Not on a budget line</span>
                  <div className="mt-0.5 text-xs text-ink-2">{numbers(unassigned.contractIds).join(', ')}</div>
                  {canWrite ? (
                    <button type="button" onClick={() => setAssigning(true)} className="mt-1 text-xs font-medium text-accent-ink hover:underline">
                      Assign to lines…
                    </button>
                  ) : null}
                </td>
                <td className={FIGURE_CELL}>
                  <span className="text-ink-4">—</span>
                </td>
                <td className={FIGURE_CELL}>
                  <Money cents={unassigned.committed} />
                </td>
                <td className={cn(FIGURE_CELL, unassigned.pending !== 0 && 'text-warn')}>{unassigned.pending === 0 ? <span className="text-ink-4">—</span> : formatMoney(unassigned.pending)}</td>
                <td className={FIGURE_CELL}>
                  <Money cents={unassigned.billed} />
                </td>
                <td className={FORECAST_CELL}>
                  <span className="text-ink-4">—</span>
                </td>
                <td className={FORECAST_CELL}>
                  <Money cents={unassigned.atCompletion} />
                </td>
                <td className={FORECAST_CELL}>
                  <Money cents={unassigned.toComplete} />
                </td>
                <td className={FORECAST_CELL}>
                  <span className="text-xs text-warn">No budget</span>
                </td>
                {canWrite ? <td className="border-b border-line" /> : null}
              </tr>
            ) : null}
          </tbody>
          <tfoot>
            <tr className="font-semibold">
              <td className="sticky left-0 z-10 bg-surface px-3 py-3 pl-4">Total</td>
              <td className="num px-3 py-3 text-right">
                <Money cents={totals.budget} />
              </td>
              <td className="num px-3 py-3 text-right">
                <Money cents={totals.committed} />
              </td>
              <td className="num px-3 py-3 text-right">{formatMoney(totals.pending)}</td>
              <td className="num px-3 py-3 text-right">
                <Money cents={totals.billed} />
              </td>
              <td className="num bg-canvas/50 px-3 py-3 text-right">{formatMoney(totals.stillToCommit)}</td>
              <td className="num bg-canvas/50 px-3 py-3 text-right">
                <Money cents={totals.atCompletion} />
              </td>
              <td className="num bg-canvas/50 px-3 py-3 text-right">
                <Money cents={totals.toComplete} />
              </td>
              <td className="num bg-canvas/50 px-3 py-3 text-right">
                <Variance cents={totals.variance} />
              </td>
              {canWrite ? <td /> : null}
            </tr>
          </tfoot>
        </table>
      </div>

      {editing ? (
        <LineDialog
          key={editing === 'new' ? 'new' : editing.id}
          projectId={projectId}
          line={editing === 'new' ? null : editing}
          contracts={contracts}
          lines={lines}
          suggestions={suggestions}
          locked={locked}
          onClose={() => setEditing(null)}
        />
      ) : null}
      {forecasting ? <ForecastDialog key={forecasting.id} line={forecasting} onClose={() => setForecasting(null)} /> : null}
      {assigning && unassigned ? <AssignDialog projectId={projectId} contracts={contracts.filter((c) => unassigned.contractIds.includes(c.id))} lines={lines} onClose={() => setAssigning(false)} /> : null}
      <Dialog
        open={removing !== null}
        onOpenChange={(o) => !o && setRemoving(null)}
        size="sm"
        title={removing ? `Remove ${removing.costCode} ${removing.description}?` : 'Remove this line?'}
        description={removing ? removeText(removing, locked, totals.budget, numbers(removing.contractIds)) : undefined}
        footer={
          removing && removeBlocked(removing, locked) ? (
            <Button variant="ghost" onClick={() => setRemoving(null)}>
              Close
            </Button>
          ) : (
            <>
              <Button variant="ghost" onClick={() => setRemoving(null)} disabled={pending}>
                Cancel
              </Button>
              <Button variant="danger" loading={pending} onClick={() => removing && run(() => deleteBudgetLineAction(removing.id), { success: `Removed ${removing.costCode}`, onSuccess: () => setRemoving(null) })}>
                Remove line
              </Button>
            </>
          )
        }
      />
    </>
  );
}

/** A line stays once the budget is locked with an original budget on it, or once money has moved in or out of it (the service checks every change, void ones too). */
const removeBlocked = (l: BudgetLineView, locked: boolean) => (locked && l.original !== 0) || l.changes !== 0;

function removeText(l: BudgetLineView, locked: boolean, total: number, subs: string[]): string {
  const instead = 'Move its subcontracts to another line and set its forecast to “Nothing more” instead.';
  if (locked && l.original !== 0) return `The budget is locked and ${l.costCode} has an original budget, so it stays on the budget. ${instead}`;
  if (l.changes !== 0) return `${l.costCode} has budget changes on record, so it stays on the budget. ${instead}`;
  return [
    l.budget ? `The budget goes down by its ${formatMoney(l.budget)}, to ${formatMoney(total - l.budget)}.` : 'The budget total stays the same.',
    subs.length ? `${pluralize(subs.length, 'subcontract')} on it (${subs.join(', ')}) will be on no line until you assign them again.` : '',
    'The removal is in the activity log.',
  ]
    .filter(Boolean)
    .join(' ');
}

/** Add a line, or change one: its code, description, original budget and subcontracts. */
export function LineDialog({
  projectId,
  line,
  contracts,
  lines,
  suggestions,
  locked,
  singleBudget = null,
  onClose,
}: {
  projectId: string;
  line: BudgetLineView | null;
  contracts: BudgetContractView[];
  lines: Array<Pick<BudgetLineView, 'id' | 'costCode' | 'description'>>;
  suggestions: Array<{ code: string; description: string }>;
  locked: boolean;
  /** The project's single budget figure, when this is its first line. */
  singleBudget?: number | null;
  onClose: () => void;
}) {
  const [costCode, setCostCode] = useState(line?.costCode ?? '');
  const [description, setDescription] = useState(line?.description ?? '');
  const [original, setOriginal] = useState<number | null>(line ? line.original : locked ? 0 : null);
  const [chosen, setChosen] = useState<string[]>(line?.contractIds ?? []);
  const { pending, run } = useAction();
  const lineOf = (id: string | null) => lines.find((l) => l.id === id);
  const fixed = locked && line !== null;
  const ready = costCode.trim() !== '' && description.trim() !== '' && original !== null && original >= 0;

  const pickCode = (code: string) => {
    setCostCode(code);
    const hit = suggestions.find((s) => s.code.toLowerCase() === code.trim().toLowerCase());
    if (hit && !description.trim()) setDescription(hit.description);
  };

  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      size="lg"
      title={line ? `Budget line ${line.costCode}` : 'Add a budget line'}
      description={
        singleBudget !== null && singleBudget !== undefined
          ? `This project has one budget of ${formatMoney(singleBudget)}. Budget lines take its place: whatever this line does not use goes to a contingency line, so the total stays ${formatMoney(singleBudget)}.`
          : 'A part of the subcontracted work, by cost code. Assign the subcontracts whose cost counts against it.'
      }
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={pending}>
            Cancel
          </Button>
          <Button
            variant="primary"
            loading={pending}
            disabled={!ready}
            onClick={() =>
              original !== null &&
              run(() => saveBudgetLineAction(projectId, { id: line?.id, costCode, description, originalAmount: original, contractIds: chosen }), { success: line ? 'Budget line saved' : 'Budget line added', onSuccess: onClose })
            }
          >
            {line ? 'Save' : 'Add line'}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-[10rem_1fr]">
          <Field label="Cost code">
            <Input value={costCode} onChange={(e) => pickCode(e.target.value)} list="budget-cost-codes" placeholder="26 00 00" autoFocus={!line} />
            <datalist id="budget-cost-codes">
              {suggestions.map((s) => (
                <option key={s.code} value={s.code}>
                  {s.description}
                </option>
              ))}
            </datalist>
          </Field>
          <Field label="Description">
            <Input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Electrical" />
          </Field>
        </div>
        <Field
          label="Original budget"
          className="max-w-xs"
          hint={fixed ? 'The budget is locked, so this stays as it is. Record a budget change to move money.' : locked ? 'The budget is locked, so a new line starts at $0. Give it a budget with a budget change.' : 'What was set aside for this line when the budget was agreed.'}
        >
          <MoneyInput value={original} onChange={setOriginal} disabled={locked} allowBlank={false} />
        </Field>
        <div>
          <p className="mb-1.5 text-xs font-medium text-ink-2">Subcontracts on this line</p>
          {contracts.length === 0 ? (
            <p className="text-[13px] text-ink-3">This project has no subcontracts yet.</p>
          ) : (
            <ul className="divide-y divide-line rounded-lg border border-line">
              {contracts.map((c) => {
                const elsewhere = c.budgetLineId && c.budgetLineId !== line?.id ? lineOf(c.budgetLineId) : undefined;
                return (
                  <li key={c.id} className="px-3 py-2">
                    <Checkbox
                      checked={chosen.includes(c.id)}
                      onChange={(e) => setChosen((xs) => (e.target.checked ? [...xs, c.id] : xs.filter((x) => x !== c.id)))}
                      label={
                        <span className="flex flex-wrap items-baseline justify-between gap-x-3">
                          <span>
                            {c.subcontractorName} <span className="text-ink-3">· {c.number}</span>
                          </span>
                          <span className="num text-ink-2">{formatMoney(c.contractSum)}</span>
                        </span>
                      }
                      description={elsewhere ? (chosen.includes(c.id) ? `Moves here from ${elsewhere.costCode} ${elsewhere.description}` : `On ${elsewhere.costCode} ${elsewhere.description}`) : c.title}
                    />
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </div>
    </Dialog>
  );
}

/** How the cost still to be committed on a line is forecast. */
function ForecastDialog({ line, onClose }: { line: BudgetLineView; onClose: () => void }) {
  const [method, setMethod] = useState<ForecastMethod>(line.forecastMethod);
  const [amount, setAmount] = useState<number | null>(line.forecastAmount);
  const [note, setNote] = useState(line.forecastNote ?? '');
  const { pending, run } = useAction();
  const preview = method === 'none' ? 0 : method === 'entered' ? Math.max(amount ?? 0, 0) : Math.max(line.budget - line.projected, 0);
  const atCompletion = line.projected + preview;

  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={`Forecast for ${line.costCode} ${line.description}`}
      description={`Committed and pending come to ${formatMoney(line.projected)} against a budget of ${formatMoney(line.budget)}. How much more do you expect to commit on this line?`}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={pending}>
            Cancel
          </Button>
          <Button
            variant="primary"
            loading={pending}
            disabled={method === 'entered' && amount === null}
            onClick={() => run(() => setBudgetForecastAction(line.id, { method, amount: method === 'entered' ? amount : null, note }), { success: 'Forecast saved', onSuccess: onClose })}
          >
            Save
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <fieldset className="space-y-2">
          <legend className="sr-only">Forecast method</legend>
          {FORECAST_METHODS.map((m) => (
            <label key={m} className={cn('flex cursor-pointer gap-3 rounded-lg border px-3 py-2.5', method === m ? 'border-accent-line bg-accent-soft/40' : 'border-line hover:bg-canvas')}>
              <input type="radio" name="forecast-method" className="mt-0.5" checked={method === m} onChange={() => setMethod(m)} />
              <span>
                <span className="block text-[13px] font-medium text-ink">{FORECAST_METHOD_LABEL[m]}</span>
                <span className="block text-xs text-ink-3">{FORECAST_METHOD_HINT[m]}</span>
              </span>
            </label>
          ))}
        </fieldset>
        {method === 'entered' ? (
          <Field label="Still to commit" className="max-w-xs">
            <MoneyInput value={amount} onChange={setAmount} allowBlank={false} />
          </Field>
        ) : null}
        <Field label="Note" optional hint="What the forecast rests on, for whoever reads it next.">
          <Textarea value={note} onChange={(e) => setNote(e.target.value)} rows={2} placeholder="Lighting controls not bought out yet" />
        </Field>
        <dl className="grid grid-cols-2 gap-3 rounded-lg bg-canvas px-3 py-2.5 text-[13px]">
          <div>
            <dt className="text-xs text-ink-3">Estimate at completion</dt>
            <dd className="num font-medium">{formatMoney(atCompletion)}</dd>
          </div>
          <div>
            <dt className="text-xs text-ink-3">Over / under</dt>
            <dd>
              <Variance cents={line.budget - atCompletion} />
            </dd>
          </div>
        </dl>
        {line.forecastBy ? (
          <p className="text-xs text-ink-3">
            Last set by {line.forecastBy}
            {line.forecastAt ? `, ${formatDateTime(line.forecastAt)}` : ''}.
          </p>
        ) : null}
      </div>
    </Dialog>
  );
}

/** Put the subcontracts that are on no line onto lines. */
function AssignDialog({ projectId, contracts, lines, onClose }: { projectId: string; contracts: BudgetContractView[]; lines: BudgetLineView[]; onClose: () => void }) {
  // Each subcontract starts on the line whose cost code matches its trade, if there is one.
  const [choice, setChoice] = useState<Record<string, string>>(() => Object.fromEntries(contracts.flatMap((c) => (c.suggestedLineId && lines.some((l) => l.id === c.suggestedLineId) ? [[c.id, c.suggestedLineId]] : []))));
  const { pending, run } = useAction();
  const picked = Object.entries(choice).filter(([, lineId]) => lineId);

  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title="Assign subcontracts to budget lines"
      description={`${pluralize(contracts.length, 'subcontract')} on this project ${contracts.length === 1 ? 'is' : 'are'} on no budget line, so ${contracts.length === 1 ? 'its' : 'their'} cost counts against the total without a line to check it against.`}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={pending}>
            Cancel
          </Button>
          <Button
            variant="primary"
            loading={pending}
            disabled={picked.length === 0}
            onClick={() => run(() => assignBudgetLinesAction(projectId, picked.map(([contractId, lineId]) => ({ contractId, lineId }))), { success: 'Subcontracts assigned', onSuccess: onClose })}
          >
            Assign
          </Button>
        </>
      }
    >
      <ul className="space-y-3">
        {contracts.map((c) => (
          <li key={c.id} className="grid gap-1.5 sm:grid-cols-[1fr_16rem] sm:items-center">
            <div className="text-[13px]">
              <span className="font-medium">{c.subcontractorName}</span> <span className="text-ink-3">· {c.number}</span>
              <div className="text-xs text-ink-3">
                {c.title} · {formatMoney(c.contractSum)}
              </div>
            </div>
            <Select value={choice[c.id] ?? ''} onChange={(e) => setChoice((x) => ({ ...x, [c.id]: e.target.value }))} aria-label={`Budget line for ${c.number}`}>
              <option value="">Leave on no line</option>
              {lines.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.costCode} {l.description}
                </option>
              ))}
            </Select>
          </li>
        ))}
      </ul>
    </Dialog>
  );
}
