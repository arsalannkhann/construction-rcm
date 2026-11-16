'use client';

import { Calculator, FileText, Link2 } from 'lucide-react';
import { useState } from 'react';
import { cn } from '@/lib/utils';

/**
 * Document intelligence, shown rather than described: every figure Zephric
 * reads stays linked to the cell it came from. Point at (or tab to) a field
 * on the right to see its source on the continuation sheet. Illustrative data.
 */

const COLS = ['Item', 'Description', 'Scheduled', 'Previous', 'This period', 'Stored', 'Completed', '%'] as const;
const ROWS: string[][] = [
  ['03-100', 'Foundations', '120,000', '120,000', '0', '0', '120,000', '100'],
  ['03-200', 'Slab on grade', '95,000', '60,000', '25,000', '0', '85,000', '89'],
  ['03-300', 'Elevated decks', '180,000', '45,000', '40,000', '10,000', '95,000', '53'],
  ['03-400', 'Site concrete', '60,000', '25,000', '10,000', '0', '35,000', '58'],
  ['CO-003', 'Added footings', '25,000', '0', '10,000', '0', '10,000', '40'],
];

type Field = { id: string; label: string; value: string; cell: [number, number]; note: string; computed?: boolean };
const FIELDS: Field[] = [
  { id: 'slab', label: 'Slab on grade · this period', value: '$25,000.00', cell: [1, 4], note: 'Read from page 2, row 2' },
  { id: 'stored', label: 'Elevated decks · stored materials', value: '$10,000.00', cell: [2, 5], note: 'Read from page 2, row 3' },
  { id: 'co', label: 'CO-003 · scheduled value', value: '$25,000.00', cell: [4, 2], note: 'Matches approved change order CO-003' },
  { id: 'pct', label: 'Elevated decks · % complete', value: '53%', cell: [2, 7], note: 'Recomputed: 95,000 ÷ 180,000 = 52.8%', computed: true },
];

export function TraceDemo() {
  const [active, setActive] = useState<string>('slab');
  const field = FIELDS.find((f) => f.id === active)!;

  return (
    <div className="grid gap-4 xl:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)]">
      <div className="overflow-hidden rounded-2xl border border-line bg-surface shadow-card">
        <div className="flex items-center gap-2 border-b border-line px-4 py-3 text-[12px] text-ink-3">
          <FileText className="size-3.5" />
          <span className="font-medium text-ink-2">G703 continuation sheet</span>
          <span>· page 2 · excerpt</span>
          <span className="ml-auto rounded-full border border-line bg-sunken px-2 py-0.5 text-[10px] font-medium uppercase tracking-[0.1em]">Illustrative</span>
        </div>
        <div className="overflow-x-auto">
          <table className="num w-full min-w-[560px] text-[12px]">
            <thead>
              <tr className="border-b border-line bg-canvas/70 text-left text-[10.5px] uppercase tracking-[0.08em] text-ink-3">
                {COLS.map((c, i) => (
                  <th key={c} scope="col" className={cn('whitespace-nowrap px-3 py-2 font-medium', i >= 2 && 'text-right')}>
                    {c}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {ROWS.map((row, r) => (
                <tr key={row[0]} className={cn('border-b border-line/70 last:border-0 transition-colors duration-300', field.cell[0] === r && 'bg-accent-soft/40')}>
                  {row.map((cell, c) => {
                    const hit = field.cell[0] === r && field.cell[1] === c;
                    return (
                      <td key={c} className={cn('relative px-3 py-2.5 whitespace-nowrap', c >= 2 && 'text-right', c === 1 ? 'text-ink' : 'text-ink-2', c === 0 && 'font-mono text-[11px] text-ink-3')}>
                        <span
                          className={cn(
                            'relative rounded px-1 py-0.5 transition-all duration-300',
                            hit && 'bg-surface text-accent-ink ring-2 ring-accent shadow-[0_0_0_6px_rgb(31_79_209/0.08)]',
                          )}
                        >
                          {cell}
                          {c === 7 && '%'}
                        </span>
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="grid content-start gap-2 md:grid-cols-2 xl:grid-cols-1" role="listbox" aria-label="Extracted fields">
        {FIELDS.map((f) => {
          const on = f.id === active;
          return (
            <button
              key={f.id}
              type="button"
              role="option"
              aria-selected={on}
              onMouseEnter={() => setActive(f.id)}
              onFocus={() => setActive(f.id)}
              onClick={() => setActive(f.id)}
              className={cn(
                'focus-ring group flex items-start gap-3 rounded-xl border px-4 py-3 text-left transition-all duration-200',
                on ? 'border-accent-line bg-surface shadow-pop' : 'border-line bg-surface/60 hover:bg-surface',
              )}
            >
              <span className={cn('mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-md transition-colors', on ? 'bg-accent text-white' : 'bg-sunken text-ink-3')}>
                {f.computed ? <Calculator className="size-3.5" /> : <Link2 className="size-3.5" />}
              </span>
              <span className="min-w-0 flex-1">
                <span className="flex items-baseline justify-between gap-3">
                  <span className="truncate text-[13px] text-ink-2">{f.label}</span>
                  <span className="num shrink-0 text-[14px] font-semibold text-ink">{f.value}</span>
                </span>
                <span className={cn('mt-0.5 block text-[12px] transition-colors', on ? 'text-accent-ink' : 'text-ink-3')}>{f.note}</span>
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
