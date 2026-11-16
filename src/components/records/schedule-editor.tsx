'use client';

import { ClipboardPaste, Plus, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { parseScheduleAction } from '@/app/(app)/contracts/actions';
import { Button } from '@/components/ui/button';
import { Money, Table, Td, Th } from '@/components/ui/data';
import { Checkbox, Input, MoneyInput, Textarea } from '@/components/ui/form';
import { Dialog } from '@/components/ui/overlay';
import { formatMoney } from '@/lib/money';
import { useAction } from '@/lib/use-action';
import { pluralize } from '@/lib/utils';
import { Note } from './figures';

/** One editable row. `id` is set for a line that already exists on the contract, so saving updates it in place. */
export type ScheduleRow = { key: string; id?: string; itemNo: string; description: string; scheduledValue: number | null };
/** What is sent to the server for each row. */
export type ScheduleLine = { id?: string; itemNo: string; description: string; scheduledValue: number };
type ParsedLine = { itemNo: string; description: string; scheduledValue: number };

let nextKey = 0;
export function scheduleRow(init: { id?: string; itemNo?: string; description?: string; scheduledValue?: number | null } = {}): ScheduleRow {
  return { key: `row-${++nextKey}`, id: init.id, itemNo: init.itemNo ?? '', description: init.description ?? '', scheduledValue: init.scheduledValue ?? null };
}

/** A new row nobody has typed a description or value into. Such rows are ignored, never sent. */
const isBlank = (row: ScheduleRow) => !row.id && !row.description.trim() && row.scheduledValue === null;

export function filledRows(rows: ScheduleRow[]): ScheduleRow[] {
  return rows.filter((r) => !isBlank(r));
}

export function scheduleRowsTotal(rows: ScheduleRow[]): number {
  return rows.reduce((total, r) => total + (r.scheduledValue ?? 0), 0);
}

/** The rows as lines ready to save, or the first thing that stops them being saved. */
export function scheduleLinesFrom(rows: ScheduleRow[]): { ok: true; lines: ScheduleLine[] } | { ok: false; error: string } {
  const lines: ScheduleLine[] = [];
  for (const [index, row] of filledRows(rows).entries()) {
    if (row.scheduledValue === null) return { ok: false, error: `Line ${row.itemNo.trim() || index + 1}: enter a scheduled value.` };
    lines.push({ id: row.id, itemNo: row.itemNo, description: row.description, scheduledValue: row.scheduledValue });
  }
  return { ok: true, lines };
}

/** The next item number when the schedule is numbered 1, 2, 3…; blank when it uses any other scheme. */
function nextItemNo(rows: ScheduleRow[]): string {
  const used = rows.map((r) => r.itemNo.trim()).filter(Boolean);
  if (!used.every((n) => /^\d{1,6}$/.test(n))) return '';
  return String(used.reduce((max, n) => Math.max(max, Number(n)), 0) + 1);
}

export function ScheduleEditor({ rows, onChange, disabled }: { rows: ScheduleRow[]; onChange: (rows: ScheduleRow[]) => void; disabled?: boolean }) {
  const [focusKey, setFocusKey] = useState<string | null>(null);
  const [pasting, setPasting] = useState(false);
  const filled = filledRows(rows);

  const update = (key: string, patch: Partial<ScheduleRow>) => onChange(rows.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  const add = () => {
    const row = scheduleRow({ itemNo: nextItemNo(rows) });
    setFocusKey(row.key);
    onChange([...rows, row]);
  };

  const load = (lines: ParsedLine[], replace: boolean) => {
    if (!replace) {
      onChange([...filled, ...lines.map((l) => scheduleRow(l))]);
      return;
    }
    // A pasted line that reuses an existing item number stays the same line, so its billing history stays attached.
    const ids = new Map(filled.filter((r) => r.id).map((r) => [r.itemNo.trim().toLowerCase(), r.id]));
    onChange(lines.map((l) => scheduleRow({ ...l, id: ids.get(l.itemNo.trim().toLowerCase()) })));
  };

  return (
    <div>
      <div
        className="overflow-hidden rounded-lg border border-line"
        onKeyDown={(e) => {
          // Enter moves on to a new line; it must not submit a surrounding form.
          if (e.key !== 'Enter' || !(e.target instanceof HTMLInputElement)) return;
          e.preventDefault();
          const last = rows[rows.length - 1];
          if (!disabled && last && !isBlank(last) && e.target.closest('tr')?.dataset.last === 'true') add();
        }}
      >
        <Table className="table-fixed">
          <thead>
            <tr className="bg-canvas/60">
              <Th className="w-28 pl-3">Item no.</Th>
              <Th>Description of work</Th>
              <Th align="right" className="w-44 pr-[17px]">
                Scheduled value
              </Th>
              <Th className="w-10" />
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <Td colSpan={4} className="py-6 text-center text-ink-3">
                  No lines. Add a line, or paste the schedule from a spreadsheet.
                </Td>
              </tr>
            ) : (
              rows.map((row, index) => (
                <tr key={row.key} data-last={index === rows.length - 1 ? 'true' : undefined}>
                  <Td className="py-1.5 pl-3 pr-1.5">
                    <Input aria-label={`Line ${index + 1} item number`} value={row.itemNo} disabled={disabled} autoFocus={row.key === focusKey && !row.itemNo} onChange={(e) => update(row.key, { itemNo: e.target.value })} />
                  </Td>
                  <Td className="px-1.5 py-1.5">
                    <Input aria-label={`Line ${index + 1} description`} value={row.description} disabled={disabled} autoFocus={row.key === focusKey && !!row.itemNo} onChange={(e) => update(row.key, { description: e.target.value })} />
                  </Td>
                  <Td className="px-1.5 py-1.5">
                    <MoneyInput aria-label={`Line ${index + 1} scheduled value`} value={row.scheduledValue} disabled={disabled} onChange={(cents) => update(row.key, { scheduledValue: cents })} />
                  </Td>
                  <Td className="py-1.5 pl-0 pr-2 text-right">
                    <Button variant="ghost" size="sm" className="px-1.5" aria-label={`Remove line ${row.itemNo.trim() || index + 1}`} disabled={disabled} onClick={() => onChange(rows.filter((r) => r.key !== row.key))}>
                      <X className="size-3.5" />
                    </Button>
                  </Td>
                </tr>
              ))
            )}
          </tbody>
          <tfoot>
            <tr className="bg-canvas/60">
              <Td colSpan={2} className="border-b-0 pl-3 text-ink-2">
                Schedule total
                <span className="ml-2 text-xs text-ink-3">{pluralize(filled.length, 'line')}</span>
              </Td>
              <Td align="right" className="border-b-0 pr-[17px] font-semibold">
                <Money cents={scheduleRowsTotal(rows)} />
              </Td>
              <Td className="border-b-0" />
            </tr>
          </tfoot>
        </Table>
      </div>
      <div className="mt-2.5 flex items-center gap-2">
        <Button size="sm" disabled={disabled} onClick={add}>
          <Plus className="size-3.5" />
          Add line
        </Button>
        <Button size="sm" variant="ghost" disabled={disabled} onClick={() => setPasting(true)}>
          <ClipboardPaste className="size-3.5" />
          Paste from spreadsheet
        </Button>
      </div>
      {pasting ? <PasteDialog existing={filled.length} onClose={() => setPasting(false)} onLoad={load} /> : null}
    </div>
  );
}

/** Mounted only while open, so it starts empty every time. */
function PasteDialog({ existing, onClose, onLoad }: { existing: number; onClose: () => void; onLoad: (lines: ParsedLine[], replace: boolean) => void }) {
  const [text, setText] = useState('');
  const [replace, setReplace] = useState(false);
  const [result, setResult] = useState<{ lines: ParsedLine[]; problems: string[] } | null>(null);
  const { pending, run } = useAction();
  // If the dialog is closed while the text is being read, the result is dropped.
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const read = () =>
    run(() => parseScheduleAction(text), {
      refresh: false,
      onSuccess: (parsed) => {
        if (!mounted.current) return;
        // A clean read goes straight into the editor; anything else is shown first.
        if (parsed.lines.length > 0 && parsed.problems.length === 0) {
          onLoad(parsed.lines, replace);
          onClose();
        } else setResult(parsed);
      },
    });

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      size="lg"
      title="Paste from spreadsheet"
      description="Copy the rows from your spreadsheet and paste them here, with columns in this order: item number, description, scheduled value. Header, total and subtotal rows are left out."
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          {result && result.lines.length > 0 ? (
            <Button
              variant="primary"
              onClick={() => {
                onLoad(result.lines, replace);
                onClose();
              }}
            >
              Load {pluralize(result.lines.length, 'line')}
            </Button>
          ) : (
            <Button variant="primary" loading={pending} disabled={!text.trim()} onClick={read}>
              Read rows
            </Button>
          )}
        </>
      }
    >
      <div className="space-y-3">
        <Textarea
          autoFocus
          aria-label="Schedule rows"
          rows={10}
          spellCheck={false}
          className="font-mono text-xs"
          placeholder={'1\tMobilization\t50,000.00\n2\tRough-in, levels 1-3\t300,000.00\n3\tFixtures and trim\t150,000.00'}
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            setResult(null);
          }}
        />
        {existing > 0 ? (
          <Checkbox
            checked={replace}
            onChange={(e) => setReplace(e.target.checked)}
            label={`Replace the ${pluralize(existing, 'line')} already entered`}
            description="Leave unticked to add the pasted rows after them."
          />
        ) : null}
        {result && result.problems.length > 0 ? (
          <Note tone="warn">
            <p className="font-medium">{result.problems.length === 1 ? '1 row could not be read' : `${result.problems.length} rows could not be read`}</p>
            <ul className="mt-1 list-disc space-y-0.5 pl-4">
              {result.problems.map((problem, i) => (
                <li key={i}>{problem}</li>
              ))}
            </ul>
            <p className="mt-1.5">
              {result.lines.length > 0
                ? `The other ${pluralize(result.lines.length, 'row')} totalling ${formatMoney(result.lines.reduce((total, l) => total + l.scheduledValue, 0))} can be loaded as they are. Or correct the text and read it again.`
                : 'Nothing else was read. Correct the text and read it again.'}
            </p>
          </Note>
        ) : null}
        {result && result.problems.length === 0 && result.lines.length === 0 ? <Note>No rows were found. Each row needs at least a description and an amount.</Note> : null}
      </div>
    </Dialog>
  );
}
