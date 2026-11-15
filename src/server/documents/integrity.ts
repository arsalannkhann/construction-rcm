/**
 * Checks on what a reader saw that do not depend on which reader saw it: gaps
 * in printed page numbering, and whether schedule rows add up to the printed
 * grand total. Pure, deterministic, integer cents. Shared by reconciliation
 * and by the extraction evaluation so both apply the same rule.
 */
import type { LineAmountField, PrintedPageNumber } from '@/server/types';

export type NumberingGap = {
  /** The printed total ("of y"); null when only "page x" is printed. */
  of: number | null;
  /** Printed page numbers that should be there and are not. */
  missing: number[];
  /** File pages the sequence was seen on. */
  pages: number[];
};

/**
 * Walk the printed page numbers in file order and report the numbers missing
 * from each run. A run continues while the printed total stays the same and
 * the numbers go up; it restarts when they fall back (a new document in the
 * same file) or the total changes.
 */
export function printedPageGaps(numbering: PrintedPageNumber[]): NumberingGap[] {
  const runs: Array<{ of: number | null; numbers: number[]; pages: number[] }> = [];
  for (const p of [...numbering].sort((a, b) => a.page - b.page)) {
    const run = runs[runs.length - 1];
    const last = run?.numbers[run.numbers.length - 1];
    if (run && run.of === p.of && last !== undefined && p.number > last) {
      run.numbers.push(p.number);
      run.pages.push(p.page);
    } else {
      runs.push({ of: p.of, numbers: [p.number], pages: [p.page] });
    }
  }
  const out: NumberingGap[] = [];
  for (const run of runs) {
    const seen = new Set(run.numbers);
    // With a printed total every number up to it is expected; without one, only the numbers between those seen.
    const from = run.of !== null ? 1 : Math.min(...run.numbers);
    const to = run.of !== null ? run.of : Math.max(...run.numbers);
    if (to - from > 500) continue; // not a page count
    const missing: number[] = [];
    for (let n = from; n <= to; n++) if (!seen.has(n)) missing.push(n);
    if (missing.length > 0) out.push({ of: run.of, missing, pages: run.pages });
  }
  return out;
}

/** Sum one column over schedule rows. A blank cell counts as zero; `blanks` says how many there were. */
export function sumColumn(lines: Array<Partial<Record<LineAmountField, number | null>>>, field: LineAmountField): { sum: number; blanks: number } {
  let sum = 0;
  let blanks = 0;
  for (const l of lines) {
    const v = l[field];
    if (v === null || v === undefined) blanks++;
    else sum += v;
  }
  return { sum, blanks };
}
