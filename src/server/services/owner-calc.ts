/**
 * The arithmetic of an owner application: from the owner's schedule of
 * values, the approved subcontractor progress and the previous application,
 * to the G703 lines, the G702 summary and the checks. Pure functions, no
 * database, so every rule can be tested on its own.
 *
 * How each line is worked out
 * - Column D (previous) is the work to date on the previous application.
 * - A line that follows subcontracts is billed at their percent complete: its
 *   scheduled value times the linked subcontracts' approved work to date over
 *   their contract sum to date, and the same for stored materials. When the
 *   line's value equals the subcontract's, that is the approved amount itself.
 * - A line that follows the rest of the contract (fee, insurance, bonds) is
 *   billed at the percent of work completed on every other line.
 * - A line entered each period starts at nothing this period.
 * - Figures someone typed over win, and are checked against the suggestion.
 */
import { applyBps, formatMoney, percentOf, sum } from '@/lib/money';
import { formatMonth } from '@/lib/utils';
import type { OwnerCheck, OwnerEntry, OwnerHeader, OwnerLine, OwnerSource, PrimeLineBasis } from '@/server/types';

/** value × num ÷ den, rounded half away from zero. Exact for any amounts in cents. */
export function scale(value: number, num: number, den: number): number {
  if (den === 0) return 0;
  const p = BigInt(value) * BigInt(num);
  const d = BigInt(den);
  const negative = p < 0n !== d < 0n;
  const ap = p < 0n ? -p : p;
  const ad = d < 0n ? -d : d;
  const q = (ap * 2n + ad) / (2n * ad);
  return Number(negative ? -q : q);
}

export type PrimeLineInput = {
  id: string;
  itemNo: string;
  description: string;
  scheduledValue: number;
  basis: PrimeLineBasis;
  contractIds: string[];
  changeOrderNumber: string | null;
};

export type OwnerCalcInput = {
  lines: PrimeLineInput[];
  sources: OwnerSource[];
  /** Work to date per prime line on the previous application (its D + E). */
  previous: Record<string, number>;
  entries: Record<string, OwnerEntry>;
  retainageWorkBps: number;
  retainageStoredBps: number;
};

const pct = (part: number, whole: number) => {
  const p = percentOf(part, whole);
  return p === null ? '0%' : `${p}%`;
};

function finish(line: Omit<OwnerLine, 'total' | 'percent' | 'balance' | 'retainage'>, workBps: number, storedBps: number): OwnerLine {
  const total = line.previous + line.thisPeriod + line.stored;
  return {
    ...line,
    total,
    percent: percentOf(total, line.scheduledValue),
    balance: line.scheduledValue - total,
    retainage: applyBps(line.previous + line.thisPeriod, workBps) + applyBps(line.stored, storedBps),
  };
}

/** The G703 lines for one period. */
export function ownerLines(input: OwnerCalcInput): OwnerLine[] {
  const byContract = new Map(input.sources.map((s) => [s.contractId, s]));
  const first: OwnerLine[] = input.lines.map((l) => {
    const previous = input.previous[l.id] ?? 0;
    const entered = input.entries[l.id] ?? null;
    let suggested: OwnerLine['suggested'] = null;
    let basisNote: string | null = null;
    if (l.basis === 'subcontracts') {
      const linked = l.contractIds.map((id) => byContract.get(id)).filter((s): s is OwnerSource => s !== undefined);
      if (linked.length === 0) {
        basisNote = 'No subcontracts linked yet';
      } else {
        const contractSum = sum(linked.map((s) => s.contractSum));
        const work = sum(linked.map((s) => s.workToDate));
        const stored = sum(linked.map((s) => s.stored));
        const workToDate = scale(l.scheduledValue, work, contractSum);
        let storedNow = scale(l.scheduledValue, stored, contractSum);
        // Rounding each figure separately can overshoot the line by a cent.
        if (l.scheduledValue >= 0 && workToDate + storedNow > l.scheduledValue) storedNow = Math.max(0, l.scheduledValue - workToDate);
        suggested = { workToDate, thisPeriod: workToDate - previous, stored: storedNow };
        const who = linked.length === 1 ? linked[0]!.contractNumber : `${linked.length} subcontracts`;
        basisNote = `${who} ${pct(work, contractSum)} complete${stored ? `, ${pct(stored, contractSum)} stored` : ''}, as approved`;
      }
    }
    return finish(
      {
        primeLineId: l.id,
        itemNo: l.itemNo,
        description: l.description,
        changeOrderNumber: l.changeOrderNumber,
        basis: l.basis,
        scheduledValue: l.scheduledValue,
        previous,
        thisPeriod: entered ? entered.thisPeriod : suggested ? suggested.thisPeriod : 0,
        stored: entered ? entered.stored : suggested ? suggested.stored : 0,
        suggested,
        basisNote,
        entered,
      },
      input.retainageWorkBps,
      input.retainageStoredBps,
    );
  });

  // Lines that follow the rest of the contract go at the percent of work completed on all the others.
  const others = first.filter((l) => l.basis !== 'overall');
  const othersValue = sum(others.map((l) => l.scheduledValue));
  const othersWork = sum(others.map((l) => l.previous + l.thisPeriod));
  return first.map((l) => {
    if (l.basis !== 'overall') return l;
    const workToDate = scale(l.scheduledValue, othersWork, othersValue);
    const suggested = { workToDate, thisPeriod: workToDate - l.previous, stored: 0 };
    return finish(
      {
        ...l,
        thisPeriod: l.entered ? l.entered.thisPeriod : suggested.thisPeriod,
        stored: l.entered ? l.entered.stored : 0,
        suggested,
        basisNote: othersValue ? `Rest of the contract ${pct(othersWork, othersValue)} complete` : 'Nothing else on the schedule yet',
      },
      input.retainageWorkBps,
      input.retainageStoredBps,
    );
  });
}

/** G702 lines 1 to 9. `previousCertificates` is what the owner certified (or was asked for) on earlier applications. */
export function ownerHeader(input: { originalAmount: number; approvedChangeOrders: number; lines: OwnerLine[]; retainageWorkBps: number; retainageStoredBps: number; previousCertificates: number }): OwnerHeader {
  const contractSumToDate = input.originalAmount + input.approvedChangeOrders;
  const totalCompletedStored = sum(input.lines.map((l) => l.total));
  const retainageWork = sum(input.lines.map((l) => applyBps(l.previous + l.thisPeriod, input.retainageWorkBps)));
  const retainageStored = sum(input.lines.map((l) => applyBps(l.stored, input.retainageStoredBps)));
  const retainageTotal = retainageWork + retainageStored;
  const totalEarnedLessRetainage = totalCompletedStored - retainageTotal;
  return {
    originalContractSum: input.originalAmount,
    netChangeOrders: input.approvedChangeOrders,
    contractSumToDate,
    totalCompletedStored,
    retainageWork,
    retainageStored,
    retainageTotal,
    totalEarnedLessRetainage,
    lessPreviousCertificates: input.previousCertificates,
    currentPaymentDue: totalEarnedLessRetainage - input.previousCertificates,
    balanceToFinish: contractSumToDate - totalEarnedLessRetainage,
  };
}

export type OwnerCheckInput = {
  month: string;
  header: OwnerHeader;
  lines: OwnerLine[];
  sources: OwnerSource[];
  pendingChangeOrders: number;
};

const label = (l: OwnerLine) => `Line ${l.itemNo} “${l.description}”`;

/**
 * What stands out on the application. Blocking checks stop it being submitted;
 * warnings and notes go with it, so whoever submits sees them first.
 */
export function ownerChecks(input: OwnerCheckInput): OwnerCheck[] {
  const out: OwnerCheck[] = [];
  const { header, lines } = input;
  const scheduleTotal = sum(lines.map((l) => l.scheduledValue));
  if (lines.length === 0) {
    out.push({ code: 'schedule.empty', severity: 'blocking', title: 'The owner schedule of values has no lines', detail: 'Add the lines the owner is billed against before preparing an application.' });
  } else if (scheduleTotal !== header.contractSumToDate) {
    out.push({
      code: 'schedule.total',
      severity: 'blocking',
      title: 'The schedule of values does not add up to the contract sum',
      detail: `The lines add up to ${formatMoney(scheduleTotal)}; the contract sum to date is ${formatMoney(header.contractSumToDate)}, ${formatMoney(Math.abs(scheduleTotal - header.contractSumToDate))} apart. Correct the schedule or record the owner change order.`,
    });
  }

  for (const l of lines) {
    const work = l.previous + l.thisPeriod;
    if (l.stored < 0 || (l.scheduledValue >= 0 && work < 0)) {
      out.push({ code: 'line.negative', severity: 'blocking', title: `${label(l)} is below zero`, detail: `Work to date ${formatMoney(work)}, stored ${formatMoney(l.stored)}. Neither can be negative.`, primeLineId: l.primeLineId });
    } else if (l.scheduledValue >= 0 && l.total > l.scheduledValue) {
      out.push({
        code: 'line.over',
        severity: 'blocking',
        title: `${label(l)} is billed beyond its scheduled value`,
        detail: `Completed and stored ${formatMoney(l.total)} against a scheduled value of ${formatMoney(l.scheduledValue)}, ${formatMoney(l.total - l.scheduledValue)} over.`,
        primeLineId: l.primeLineId,
      });
    }
    if (l.entered && l.suggested) {
      const ahead = work + l.stored - (l.suggested.workToDate + l.suggested.stored);
      if (ahead > 0) {
        out.push({
          code: 'line.ahead',
          severity: 'warning',
          title: `${label(l)} is billed ahead of the approved progress`,
          detail: `${formatMoney(ahead)} more than the ${l.basis === 'overall' ? 'rest of the contract' : 'approved subcontractor billing'} supports (${l.basisNote ?? ''}).${l.entered.note ? ` Note: ${l.entered.note}` : ''}`,
          primeLineId: l.primeLineId,
        });
      }
    }
    if (l.basis === 'subcontracts' && !l.suggested) {
      out.push({ code: 'line.unlinked', severity: 'warning', title: `${label(l)} follows no subcontract`, detail: 'Link the subcontracts it covers, or change it to a line entered each period.', primeLineId: l.primeLineId });
    }
    if (l.thisPeriod < 0) {
      out.push({ code: 'line.reduced', severity: 'info', title: `${label(l)} takes back work billed earlier`, detail: `This period is ${formatMoney(l.thisPeriod)}: less work to date than the previous application claimed.`, primeLineId: l.primeLineId });
    }
  }

  for (const s of input.sources) {
    if (s.primeLineIds.length === 0) {
      if (s.workToDate + s.stored > 0 || s.status === 'active') {
        out.push({
          code: 'source.unlinked',
          severity: 'warning',
          title: `${s.contractNumber} (${s.subcontractorName}) is not on the owner schedule`,
          detail: `Its approved billing${s.workToDate + s.stored > 0 ? ` (${formatMoney(s.workToDate + s.stored)} completed and stored)` : ''} does not reach the owner. Link it to the line that covers its work.`,
        });
      }
      continue;
    }
    if (s.openThisPeriod > 0) {
      out.push({
        code: 'source.open',
        severity: 'warning',
        title: `${s.subcontractorName} has an application for ${formatMonth(input.month)} still in review`,
        detail: `${s.contractNumber}: only approved billing is counted, so this period's work on it is not included yet.`,
      });
    } else if (s.status === 'active' && s.workToDate + s.stored < s.contractSum && (!s.asOf || s.asOf.periodTo.slice(0, 7) < input.month) && (s.asOf || s.workToDate > 0)) {
      out.push({
        code: 'source.stale',
        severity: 'info',
        title: `No approved application from ${s.subcontractorName} for ${formatMonth(input.month)}`,
        detail: `${s.contractNumber} is counted as of ${s.asOf ? `its application #${s.asOf.applicationNumber}, period to ${s.asOf.periodTo}` : 'its opening balance'}.`,
      });
    }
  }

  if (input.pendingChangeOrders > 0) {
    out.push({
      code: 'changes.pending',
      severity: 'info',
      title: `${input.pendingChangeOrders} owner change order${input.pendingChangeOrders === 1 ? ' is' : 's are'} pending`,
      detail: 'A change order is billed once the owner approves it and it is recorded as approved.',
    });
  }
  const rank = { blocking: 0, warning: 1, info: 2 } as const;
  return out.sort((a, b) => rank[a.severity] - rank[b.severity]);
}
