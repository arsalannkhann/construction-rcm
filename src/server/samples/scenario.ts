/**
 * Builds the numbers for a subcontractor's billing package the way a
 * subcontractor's own billing software would: from the contract, what was
 * billed before and this period's progress. Then, optionally, gets them wrong
 * in the specific ways real submissions do.
 *
 * Used by the demo workspace, the downloadable samples and the tests. This is
 * deliberately independent of the reconciliation engine — it is the "other
 * side" whose work the engine checks.
 */
import { applyBps } from '@/lib/money';
import type { SampleLine, SamplePackage, SampleWaiver } from './pdf';

export type Parties = Pick<SamplePackage, 'gc' | 'owner' | 'project' | 'sub'>;

export type BillingContract = {
  number: string;
  date: string;
  description: string;
  originalAmount: number;
  retainageWorkBps: number;
  retainageStoredBps: number;
  sov: Array<{ itemNo: string; description: string; scheduledValue: number }>;
  /** Change orders the subcontractor treats as part of the contract (approved or not). */
  changeOrders: Array<{ number: string; title: string; amount: number }>;
};

/** What has been billed and certified so far, keyed by item number. */
export type BillingState = {
  applicationNumber: number;
  workToDate: Record<string, number>;
  totalEarnedLessRetainage: number;
};

export type PeriodInput = {
  applicationNumber: number;
  periodTo: string;
  applicationDate: string;
  /** Work and stored material billed this period, by item number. */
  progress: Record<string, { work?: number; stored?: number }>;
  waiver?: Partial<SampleWaiver> | null;
  signed?: boolean;
  notarized?: boolean;
};

export function buildPackage(parties: Parties, contract: BillingContract, prior: BillingState | null, period: PeriodInput): SamplePackage {
  const schedule = [
    ...contract.sov,
    ...contract.changeOrders.map((c) => ({ itemNo: c.number, description: c.title, scheduledValue: c.amount })),
  ];
  const lines: SampleLine[] = schedule.map((s) => {
    const previous = prior?.workToDate[s.itemNo] ?? 0;
    const thisPeriod = period.progress[s.itemNo]?.work ?? 0;
    const stored = period.progress[s.itemNo]?.stored ?? 0;
    const total = previous + thisPeriod + stored;
    return {
      itemNo: s.itemNo,
      description: s.description,
      scheduledValue: s.scheduledValue,
      previous,
      thisPeriod,
      stored,
      total,
      balance: s.scheduledValue - total,
      retainage: applyBps(previous + thisPeriod, contract.retainageWorkBps) + applyBps(stored, contract.retainageStoredBps),
    };
  });
  const pkg: SamplePackage = {
    ...parties,
    contract: { number: contract.number, date: contract.date, description: contract.description },
    applicationNumber: period.applicationNumber,
    applicationDate: period.applicationDate,
    periodTo: period.periodTo,
    retainageWorkBps: contract.retainageWorkBps,
    retainageStoredBps: contract.retainageStoredBps,
    header: {
      originalContractSum: contract.originalAmount,
      netChangeOrders: contract.changeOrders.reduce((a, c) => a + c.amount, 0),
      contractSumToDate: 0,
      totalCompletedStored: 0,
      retainageWork: 0,
      retainageStored: 0,
      retainageTotal: 0,
      totalEarnedLessRetainage: 0,
      lessPreviousCertificates: prior?.totalEarnedLessRetainage ?? 0,
      currentPaymentDue: 0,
      balanceToFinish: 0,
    },
    lines,
    signed: period.signed ?? true,
    notarized: period.notarized ?? true,
    waiver: null,
  };
  recompute(pkg);
  if (period.waiver !== null) {
    pkg.waiver = {
      form: (['TX', 'CA', 'FL'].includes(parties.project.state) ? parties.project.state : 'generic') as SampleWaiver['form'],
      type: 'conditional_progress',
      amount: pkg.header.currentPaymentDue,
      throughDate: period.periodTo,
      claimant: parties.sub.name,
      signed: true,
      ...period.waiver,
    };
  }
  return pkg;
}

/** Re-derive the summary from the line items, as billing software does. */
export function recompute(pkg: SamplePackage, opts: { keepWaiver?: boolean } = {}): void {
  const h = pkg.header;
  const work = pkg.lines.reduce((a, l) => a + l.previous + l.thisPeriod, 0);
  const stored = pkg.lines.reduce((a, l) => a + l.stored, 0);
  h.contractSumToDate = (h.originalContractSum ?? 0) + (h.netChangeOrders ?? 0);
  h.totalCompletedStored = pkg.lines.reduce((a, l) => a + l.total, 0);
  h.retainageWork = applyBps(work, pkg.retainageWorkBps);
  h.retainageStored = applyBps(stored, pkg.retainageStoredBps);
  h.retainageTotal = h.retainageWork + h.retainageStored;
  h.totalEarnedLessRetainage = h.totalCompletedStored - h.retainageTotal;
  h.currentPaymentDue = h.totalEarnedLessRetainage - (h.lessPreviousCertificates ?? 0);
  h.balanceToFinish = h.contractSumToDate - h.totalEarnedLessRetainage;
  if (pkg.waiver && !opts.keepWaiver) pkg.waiver.amount = h.currentPaymentDue;
}

/** The billing state after this package is certified as submitted. */
export function stateAfter(pkg: SamplePackage): BillingState {
  const workToDate: Record<string, number> = {};
  for (const l of pkg.lines) workToDate[l.itemNo] = l.previous + l.thisPeriod;
  return { applicationNumber: pkg.applicationNumber, workToDate, totalEarnedLessRetainage: pkg.header.totalEarnedLessRetainage ?? 0 };
}

// ── The ways real submissions go wrong ──────────────────────────────────────

export const defects = {
  /** Line 7 deducts less than was certified, so the difference is billed twice. */
  understatePreviousCertificates(pkg: SamplePackage, by: number) {
    pkg.header.lessPreviousCertificates = (pkg.header.lessPreviousCertificates ?? 0) - by;
    recompute(pkg);
  },

  /** Retainage is withheld at a lower rate than the contract requires. */
  retainAt(pkg: SamplePackage, bps: number) {
    const h = pkg.header;
    const work = pkg.lines.reduce((a, l) => a + l.previous + l.thisPeriod, 0);
    const stored = pkg.lines.reduce((a, l) => a + l.stored, 0);
    h.retainageWork = applyBps(work, bps);
    h.retainageStored = applyBps(stored, bps);
    h.retainageTotal = h.retainageWork + h.retainageStored;
    h.totalEarnedLessRetainage = (h.totalCompletedStored ?? 0) - h.retainageTotal;
    h.currentPaymentDue = h.totalEarnedLessRetainage - (h.lessPreviousCertificates ?? 0);
    h.balanceToFinish = (h.contractSumToDate ?? 0) - h.totalEarnedLessRetainage;
    for (const l of pkg.lines) l.retainage = applyBps(l.previous + l.thisPeriod + l.stored, bps);
    if (pkg.waiver) pkg.waiver.amount = h.currentPaymentDue;
  },

  /** A typo on line 6 that the rest of the form does not follow. */
  arithmeticSlip(pkg: SamplePackage, by: number) {
    pkg.header.totalEarnedLessRetainage = (pkg.header.totalEarnedLessRetainage ?? 0) + by;
  },

  /** A line is billed past its scheduled value. */
  overbill(pkg: SamplePackage, itemNo: string, by: number) {
    const line = pkg.lines.find((l) => l.itemNo === itemNo);
    if (!line) throw new Error(`No line ${itemNo}`);
    line.thisPeriod = line.scheduledValue - line.previous - line.stored + by;
    line.total = line.previous + line.thisPeriod + line.stored;
    line.balance = line.scheduledValue - line.total;
    line.retainage = applyBps(line.previous + line.thisPeriod, pkg.retainageWorkBps) + applyBps(line.stored, pkg.retainageStoredBps);
    recompute(pkg);
  },

  /** The "previous" column on one line carries more than was certified. */
  inflatePrevious(pkg: SamplePackage, itemNo: string, by: number) {
    const line = pkg.lines.find((l) => l.itemNo === itemNo);
    if (!line) throw new Error(`No line ${itemNo}`);
    line.previous += by;
    line.total += by;
    line.balance -= by;
    line.retainage = applyBps(line.previous + line.thisPeriod, pkg.retainageWorkBps) + applyBps(line.stored, pkg.retainageStoredBps);
    recompute(pkg);
  },

  /** The lien waiver is for a different amount than the application. */
  waiverAmount(pkg: SamplePackage, amount: number) {
    if (pkg.waiver) pkg.waiver.amount = amount;
  },

  unsignedWaiver(pkg: SamplePackage) {
    if (pkg.waiver) pkg.waiver.signed = false;
  },

  noWaiver(pkg: SamplePackage) {
    pkg.waiver = null;
  },
};
