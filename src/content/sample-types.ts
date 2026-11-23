/**
 * The public sample workflow (`/sample`): one fictitious billing package, read
 * and checked by the same reader and checks the product uses, saved as a
 * snapshot so the page needs no account and no database.
 *
 * The snapshot (`sample-workflow.json`) is written by `pnpm sample:build` and
 * `tests/sample-workflow.test.ts` fails when it no longer matches what the
 * product produces, so the page cannot drift from the product. Amounts are
 * integer cents. Nothing here comes from a customer.
 */

/** [x, y, width, height] as fractions of the displayed page (the same frame the review workspace highlights in). */
export type SampleBox = [number, number, number, number];

/** Where a figure is printed on the sample document. */
export type SampleSource = { page: number; bbox: SampleBox | null };

export type SampleFinding = {
  id: string;
  severity: 'blocking' | 'warning';
  /** The check family, as the review workspace labels it ("Prior billing", "Retainage", "Lien waivers"…). */
  category: string;
  title: string;
  /** The explanation the reviewer reads, with the figures in it. */
  message: string;
  /** Formatted money or text, as the workspace shows them; null when the check has no such figure. */
  expected: string | null;
  onDocument: string | null;
  difference: string | null;
  /** The product's "What to do" line. */
  whatToDo: string | null;
  source: SampleSource | null;
};

export type SampleSnapshot = {
  /** Which reader produced the figures (the deterministic text-layer reader for this sample). */
  reader: string;
  parties: {
    generalContractor: string;
    project: string;
    projectLocation: string;
    owner: string;
    subcontractor: string;
    trade: string;
    contractNumber: string;
    contractTitle: string;
  };
  contract: {
    originalAmount: number;
    approvedChangeOrders: number;
    contractSumToDate: number;
    /** Basis points: 1000 is 10%. */
    retainageWorkBps: number;
    retainageStoredBps: number;
    /** Earlier applications on this subcontract, already approved, that the checks compare against. */
    history: Array<{ number: number; periodTo: string; approved: number }>;
  };
  application: {
    number: number;
    periodTo: string;
    requested: number;
    verified: number;
    /** verified − requested. */
    difference: number;
    retainageHeld: number;
    statusLabel: string;
  };
  document: {
    filename: string;
    /** Public path of the PDF, under /sample/. */
    url: string;
    pageCount: number;
    pages: Array<{ page: number; label: string; width: number; height: number }>;
  };
  /** The pay application's summary lines (the G702 face), as read and as recomputed. */
  summary: Array<{
    key: string;
    label: string;
    onDocument: number | null;
    verified: number | null;
    agrees: boolean;
    source: SampleSource | null;
  }>;
  /** The schedule of values (continuation sheet) lines as read. */
  lines: Array<{
    itemNo: string;
    description: string;
    scheduledValue: number;
    previous: number;
    thisPeriod: number;
    stored: number;
    completedToDate: number;
    percent: number;
    source: SampleSource | null;
  }>;
  checks: {
    passed: number;
    blocking: number;
    warnings: number;
    /** Names of the check families with nothing open. */
    passedGroups: string[];
  };
  findings: SampleFinding[];
  /** What "Request correction" would send to the subcontractor: the product's own drafted wording. Never sent from the sample. */
  correction: { subject: string; body: string } | null;
};
