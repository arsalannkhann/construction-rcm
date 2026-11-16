'use client';

import { RotateCcw, Save } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Money, PanelHeader } from '@/components/ui/data';
import { Input, MoneyInput } from '@/components/ui/form';
import { Tooltip } from '@/components/ui/overlay';
import { formatMoney, sum } from '@/lib/money';
import { useAction } from '@/lib/use-action';
import { cn, pluralize } from '@/lib/utils';
import type { OwnerLine } from '@/server/types';
import { PRIME_LINE_BASIS_LABEL } from '@/server/types';
import { saveOwnerEntriesAction } from '../actions';

type Edit = { thisPeriod: number | null; stored: number | null; note: string };

/** What the line comes to without anything typed over it. */
const workedOut = (l: OwnerLine) => ({ thisPeriod: l.suggested?.thisPeriod ?? 0, stored: l.suggested?.stored ?? 0 });

/**
 * The G703 continuation sheet. On a draft, people who keep the records can
 * type over this period's work (E) and stored materials (F) on any line; the
 * rest of the sheet follows. Saving sends only the lines that changed.
 */
export function ContinuationSheet({ appId, version, lines, editable }: { appId: string; version: number; lines: OwnerLine[]; editable: boolean }) {
  const [edits, setEdits] = useState<Record<string, Edit>>({});
  const { pending, run } = useAction();

  const current = (l: OwnerLine): Edit => edits[l.primeLineId] ?? { thisPeriod: l.thisPeriod, stored: l.stored, note: l.entered?.note ?? '' };
  const dirty = Object.keys(edits);
  const set = (l: OwnerLine, patch: Partial<Edit>) => setEdits((e) => ({ ...e, [l.primeLineId]: { ...current(l), ...patch } }));

  // While editing, show the effect on each line's totals right away (the server works out the rest on save).
  const shown = useMemo(
    () =>
      lines.map((l) => {
        const e = edits[l.primeLineId];
        if (!e) return l;
        const thisPeriod = e.thisPeriod ?? 0;
        const stored = e.stored ?? 0;
        const total = l.previous + thisPeriod + stored;
        return { ...l, thisPeriod, stored, total, balance: l.scheduledValue - total, percent: l.scheduledValue ? Math.round((total / l.scheduledValue) * 1000) / 10 : null };
      }),
    [lines, edits],
  );

  const save = () => {
    const changes = dirty.map((id) => {
      const l = lines.find((x) => x.primeLineId === id)!;
      const e = edits[id]!;
      const w = workedOut(l);
      const same = (e.thisPeriod ?? 0) === w.thisPeriod && (e.stored ?? 0) === w.stored;
      // Typing the worked-out figures back in is the same as going back to them.
      return same ? { primeLineId: id, thisPeriod: null, stored: null } : { primeLineId: id, thisPeriod: e.thisPeriod ?? 0, stored: e.stored ?? 0, note: e.note };
    });
    run(() => saveOwnerEntriesAction(appId, version, changes), { success: `${pluralize(changes.length, 'line')} saved`, onSuccess: () => setEdits({}), onError: (conflict) => conflict && setEdits({}) });
  };
  const reset = (l: OwnerLine) => run(() => saveOwnerEntriesAction(appId, version, [{ primeLineId: l.primeLineId, thisPeriod: null, stored: null }]), { success: `Line ${l.itemNo} follows the worked-out figures again` });

  const total = (k: 'scheduledValue' | 'previous' | 'thisPeriod' | 'stored' | 'total' | 'balance' | 'retainage') => sum(shown.map((l) => l[k]));
  const grand = total('scheduledValue');

  return (
    <>
      <PanelHeader
        title="Continuation sheet"
        description={editable ? 'Columns E and F can be typed over on any line. Lines that follow subcontracts start at the approved progress; the fee follows the rest.' : 'As submitted.'}
        actions={
          editable && dirty.length > 0 ? (
            <div className="flex gap-2">
              <Button size="sm" variant="ghost" disabled={pending} onClick={() => setEdits({})}>
                Discard
              </Button>
              <Button size="sm" variant="primary" loading={pending} onClick={save}>
                <Save className="size-3.5" />
                Save {pluralize(dirty.length, 'line')}
              </Button>
            </div>
          ) : null
        }
      />
      <div className="overflow-x-auto">
        <table className="w-full min-w-[1080px] border-collapse text-[13px]">
          <thead>
            <tr className="border-b border-line text-[11px] uppercase tracking-wide text-ink-3">
              <th className="py-2 pl-4 pr-2 text-left font-medium">Item</th>
              <th className="px-2 py-2 text-left font-medium">Description</th>
              <th className="px-2 py-2 text-right font-medium">
                <span className="block text-ink-4">C</span>Scheduled
              </th>
              <th className="px-2 py-2 text-right font-medium">
                <span className="block text-ink-4">D</span>Previous
              </th>
              <th className="w-32 px-2 py-2 text-right font-medium">
                <span className="block text-ink-4">E</span>This period
              </th>
              <th className="w-32 px-2 py-2 text-right font-medium">
                <span className="block text-ink-4">F</span>Stored now
              </th>
              <th className="px-2 py-2 text-right font-medium">
                <span className="block text-ink-4">G</span>Completed &amp; stored
              </th>
              <th className="px-2 py-2 text-right font-medium">G ÷ C</th>
              <th className="px-2 py-2 text-right font-medium">
                <span className="block text-ink-4">H</span>Balance
              </th>
              <th className="py-2 pl-2 pr-4 text-right font-medium">
                <span className="block text-ink-4">I</span>Retainage
              </th>
            </tr>
          </thead>
          <tbody>
            {shown.map((l, i) => {
              const original = lines[i]!;
              const e = edits[l.primeLineId];
              const typedOver = !!e || !!original.entered;
              const over = l.scheduledValue >= 0 && l.total > l.scheduledValue;
              return (
                <tr key={l.primeLineId} className={cn('border-b border-line align-top', typedOver && 'bg-warn-soft/40')}>
                  <td className="py-2 pl-4 pr-2 font-medium">{l.itemNo}</td>
                  <td className="min-w-56 px-2 py-2">
                    <div>{l.description}</div>
                    <div className="text-xs text-ink-3">
                      {l.basis === 'manual' ? PRIME_LINE_BASIS_LABEL.manual : l.basisNote}
                      {l.changeOrderNumber ? ' · change order' : ''}
                    </div>
                    {original.entered && !e ? (
                      <div className="mt-0.5 flex flex-wrap items-center gap-x-2 text-xs text-warn">
                        <span>
                          Typed over by {original.entered.by}
                          {original.entered.note ? `: ${original.entered.note}` : ''}
                        </span>
                        {editable && original.suggested ? (
                          <button type="button" className="inline-flex items-center gap-1 underline-offset-2 hover:underline" disabled={pending} onClick={() => reset(original)}>
                            <RotateCcw className="size-3" />
                            Use {formatMoney(original.suggested.thisPeriod)} worked out
                          </button>
                        ) : null}
                      </div>
                    ) : null}
                    {e ? <Input aria-label={`Note for line ${l.itemNo}`} className="mt-1.5 h-7 text-xs" placeholder="Why it differs (kept with the record)" value={e.note} onChange={(ev) => set(original, { note: ev.target.value })} /> : null}
                  </td>
                  <td className="px-2 py-2 text-right">
                    <Money cents={l.scheduledValue} />
                  </td>
                  <td className="px-2 py-2 text-right text-ink-2">
                    <Money cents={l.previous} />
                  </td>
                  <td className="px-2 py-1.5 text-right">
                    {editable ? (
                      <MoneyInput aria-label={`This period, line ${l.itemNo}`} allowBlank value={current(original).thisPeriod} onChange={(c) => set(original, { thisPeriod: c })} />
                    ) : (
                      <Money cents={l.thisPeriod} />
                    )}
                    {original.suggested && (original.entered || e) ? <div className="mt-0.5 text-[11px] text-ink-3">worked out {formatMoney(original.suggested.thisPeriod)}</div> : null}
                  </td>
                  <td className="px-2 py-1.5 text-right">
                    {editable ? <MoneyInput aria-label={`Stored now, line ${l.itemNo}`} allowBlank value={current(original).stored} onChange={(c) => set(original, { stored: c })} /> : <Money cents={l.stored} />}
                  </td>
                  <td className={cn('px-2 py-2 text-right font-medium', over && 'text-block')}>
                    {over ? (
                      <Tooltip content="More than the line’s scheduled value">
                        <span>
                          <Money cents={l.total} />
                        </span>
                      </Tooltip>
                    ) : (
                      <Money cents={l.total} />
                    )}
                  </td>
                  <td className="num px-2 py-2 text-right text-ink-2">{l.percent === null ? '—' : `${l.percent}%`}</td>
                  <td className="px-2 py-2 text-right text-ink-2">
                    <Money cents={l.balance} />
                  </td>
                  <td className="py-2 pl-2 pr-4 text-right text-ink-2">
                    <Money cents={e ? null : l.retainage} blank="…" />
                  </td>
                </tr>
              );
            })}
          </tbody>
          <tfoot>
            <tr className="bg-canvas/60 font-medium">
              <td className="py-2.5 pl-4 pr-2" />
              <td className="px-2 py-2.5">Grand total</td>
              <td className="px-2 py-2.5 text-right">
                <Money cents={grand} />
              </td>
              <td className="px-2 py-2.5 text-right">
                <Money cents={total('previous')} />
              </td>
              <td className="px-2 py-2.5 text-right">
                <Money cents={total('thisPeriod')} />
              </td>
              <td className="px-2 py-2.5 text-right">
                <Money cents={total('stored')} />
              </td>
              <td className="px-2 py-2.5 text-right">
                <Money cents={total('total')} />
              </td>
              <td className="num px-2 py-2.5 text-right">{grand ? `${Math.round((total('total') / grand) * 1000) / 10}%` : '—'}</td>
              <td className="px-2 py-2.5 text-right">
                <Money cents={total('balance')} />
              </td>
              <td className="py-2.5 pl-2 pr-4 text-right">
                <Money cents={dirty.length ? null : total('retainage')} blank="…" />
              </td>
            </tr>
          </tfoot>
        </table>
      </div>
    </>
  );
}
