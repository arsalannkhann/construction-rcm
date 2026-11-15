/**
 * Financial reconciliation engine.
 *
 * A pure function: given what we know (contract, approved change orders,
 * schedule of values, the last approved application) and what the
 * subcontractor submitted (G702 summary + G703 lines), it
 *
 *   1. computes its own "verified" G702 from first principles, and
 *   2. emits a check result for every relationship that should hold, each
 *      explaining what is wrong, why it matters and what to do about it.
 *
 * It never trusts a number printed on the submission that it can derive
 * itself. No I/O, no clock, no randomness — everything it needs is an input,
 * which is what makes the financial behaviour exhaustively testable.
 */
import { applyBps, formatBps, formatMoney, sum } from '@/lib/money';
import { formatDate, pluralize } from '@/lib/utils';
import type {
  ClaimedField,
  ClaimedHeader,
  DocType,
  DocumentSegment,
  ExtractionConflict,
  FindingCategory,
  FindingData,
  FindingRefs,
  LineAmountField,
  OrgSettings,
  PrintedPageNumber,
  RetainageTerms,
  ScheduleGrandTotal,
  Severity,
  Tri,
  VerifiedHeader,
  WaiverType,
} from '@/server/types';
import { CLAIMED_FIELD_LABEL, CLAIMED_FIELD_LINE, DOC_TYPE_LABEL, LINE_AMOUNT_FIELDS } from '@/server/types';
import { evaluateWaivers } from '@/server/compliance/waivers';
import { printedPageGaps, sumColumn } from '@/server/documents/integrity';

// ── Inputs ──────────────────────────────────────────────────────────────────

export type ReconLine = {
  id: string;
  /** The file the row was read from; null for a row keyed by hand. */
  documentId?: string | null;
  /** The amounts as the document prints them, when a reviewer has adjusted the row for approval. */
  printed?: Partial<Record<LineAmountField, number | null>> | null;
  sovLineId: string | null;
  itemNo: string | null;
  description: string | null;
  scheduledValue: number | null;
  previous: number | null;
  thisPeriod: number | null;
  stored: number | null;
  total: number | null;
  balance: number | null;
  retainage: number | null;
};

export type ReconWaiver = {
  id: string;
  waiverType: WaiverType;
  formState: string | null;
  claimant: string | null;
  throughDate: string | null;
  amount: number | null;
  exceptions: string | null;
  signed: Tri | null;
};

export type ReconPrior = {
  kind: 'application' | 'baseline';
  applicationNumber: number;
  periodTo: string | null;
  totalEarnedLessRetainage: number;
  retainageTotal: number | null;
  currentPaymentDue: number | null;
  /** Work completed to date (columns D + E) per schedule-of-values line, as approved. */
  workToDate: Record<string, number>;
};

export type ReconInput = {
  policy: OrgSettings;
  today: string;
  project: { name: string; state: string | null };
  subcontractor: { name: string };
  contract: { number: string; originalAmount: number; retainageWorkBps: number; retainageStoredBps: number; retainageTerms?: RetainageTerms | null };
  /** Retainage releases recorded on the contract that are in force (not void). */
  retainageReleases?: Array<{ id: string; amount: number; effectiveOn: string; note: string | null }>;
  /** How the package arrived. Only email carries a sender to vouch for. */
  intake?: { via: 'upload' | 'email'; senderEmail: string | null; sender: 'contact' | 'domain' | 'team' | 'unknown' };
  changeOrders: Array<{ id: string; number: string; title: string; amount: number; status: string }>;
  sov: Array<{ id: string; itemNo: string; description: string; scheduledValue: number }>;
  prior: ReconPrior | null;
  /** Every other application on this contract that is not void. */
  siblings: Array<{ id: string; applicationNumber: number | null; periodTo: string | null; status: string }>;
  app: {
    id: string;
    applicationNumber: number | null;
    periodTo: string | null;
    claimed: ClaimedHeader;
    signed: Tri | null;
    signatureConfirmed: boolean;
    notarized: Tri | null;
    /** Extraction confidence per evidence key. */
    confidence: Record<string, number>;
  };
  lines: ReconLine[];
  documents: Array<{
    id: string;
    filename: string;
    status: string;
    statusDetail: string | null;
    segments: DocumentSegment[];
    duplicateOf: { applicationNumber: number | null; filename: string } | null;
    /** What the latest successful reading of the file saw besides the figures. Absent when it was not read. */
    integrity?: DocumentIntegrity | null;
  }>;
  waivers: ReconWaiver[];
};

/** Printed facts about a file that tell whether everything in it was read. */
export type DocumentIntegrity = {
  /** Every "page x of y" marking, in file order. */
  pageNumbering: PrintedPageNumber[];
  /** The schedule's printed grand-total row. */
  scheduleGrandTotal: ScheduleGrandTotal | null;
  /** The same fact printed with different values, or a second application in the file. */
  conflicts: ExtractionConflict[];
  /** Pages with no machine-readable text that the reader could not read. */
  unreadablePages: number[];
  /** Number of the pay application read from this file, when it holds one. */
  payApplicationNumber: number | null;
};

// ── Outputs ─────────────────────────────────────────────────────────────────

export type CheckResult = {
  code: string;
  /** Distinguishes several results of one check, e.g. the line id. */
  subjectKey: string;
  category: FindingCategory;
  severity: Severity;
  outcome: 'pass' | 'fail';
  title: string;
  detail: string;
  action?: string;
  needsQualifiedReview?: boolean;
  data?: FindingData;
  refs?: FindingRefs;
};

export type VerifiedLine = {
  sovLineId: string;
  lineId: string | null;
  itemNo: string;
  description: string;
  scheduledValue: number;
  previous: number;
  thisPeriod: number;
  stored: number;
  total: number;
  balance: number;
  retainage: number;
};

export type ReconOutput = {
  verified: VerifiedHeader;
  lines: VerifiedLine[];
  checks: CheckResult[];
};

const OPEN_SIBLING = new Set(['processing', 'needs_matching', 'needs_review', 'pending_approval', 'on_hold']);

// ── Retainage ───────────────────────────────────────────────────────────────

export type RetainageResult = {
  work: number;
  stored: number;
  total: number;
  /** Portion of recorded releases that was applied (never more than there is to release). */
  released: number;
  /** How the figure was arrived at, in words. */
  basis: string;
  /** True when the contract's terms or a release change the answer from the flat rate. */
  special: boolean;
};

/**
 * Retainage to hold on a given amount of completed work and stored material.
 *
 *   flat          base rate × completed work
 *   future_work   base rate up to the threshold, the reduced rate on work beyond it
 *   all_work      base rate until the threshold is reached, then the reduced rate on everything
 *
 * The threshold is a share of the contract sum to date, measured on completed
 * work (not stored material), so the answer depends only on the totals and not
 * on the order in which the work was billed. Releases come off last and can
 * never take retainage below zero.
 */
export function computeRetainage(args: {
  work: number;
  stored: number;
  contractSum: number;
  workBps: number;
  storedBps: number;
  terms?: RetainageTerms | null;
  released?: number;
}): RetainageResult {
  const { work, stored, contractSum, workBps, storedBps } = args;
  const reduction = args.terms?.reduction ?? null;
  const $ = (n: number) => formatMoney(n);
  let onWork: number;
  let basis: string;
  if (!reduction || work <= 0) {
    onWork = applyBps(work, workBps);
    basis = `${formatBps(workBps)} of completed work (${$(work)})`;
  } else {
    const threshold = applyBps(contractSum, reduction.atPercentBps);
    const at = `${formatBps(reduction.atPercentBps)} of the contract sum (${$(threshold)})`;
    if (reduction.appliesTo === 'future_work') {
      const below = Math.min(work, threshold);
      const beyond = Math.max(work - threshold, 0);
      onWork = applyBps(below, workBps) + applyBps(beyond, reduction.toBps);
      basis =
        beyond > 0
          ? `${formatBps(workBps)} of completed work up to ${at}, plus ${formatBps(reduction.toBps)} of the ${$(beyond)} beyond it`
          : `${formatBps(workBps)} of completed work (${$(work)}); the rate changes to ${formatBps(reduction.toBps)} for work beyond ${at}`;
    } else if (work >= threshold) {
      onWork = applyBps(work, reduction.toBps);
      basis = `${formatBps(reduction.toBps)} of completed work (${$(work)}), the reduced rate that applies once ${at} is complete`;
    } else {
      onWork = applyBps(work, workBps);
      basis = `${formatBps(workBps)} of completed work (${$(work)}); the rate drops to ${formatBps(reduction.toBps)} on all work once ${at} is complete`;
    }
  }
  const onStored = applyBps(stored, storedBps);
  if (stored !== 0 || storedBps !== workBps) basis += ` plus ${formatBps(storedBps)} of stored material (${$(stored)})`;

  const gross = onWork + onStored;
  const released = Math.min(Math.max(args.released ?? 0, 0), Math.max(gross, 0));
  if (released > 0) basis += `, less ${$(released)} released`;
  // A release comes out of retainage on completed work first.
  const workAfter = Math.max(onWork - released, 0);
  const total = gross - released;
  return { work: workAfter, stored: total - workAfter, total, released, basis, special: !!reduction || released > 0 };
}

/** Split `total` across `weights` in proportion, in whole cents, so the parts add up exactly. */
export function allocate(total: number, weights: number[]): number[] {
  const whole = sum(weights);
  if (whole === 0 || total === 0) return weights.map(() => 0);
  const exact = weights.map((w) => (total * w) / whole);
  const parts = exact.map((x) => Math.trunc(x));
  let remainder = total - sum(parts);
  const step = remainder >= 0 ? 1 : -1;
  // Hand the leftover cents to the parts that lost the most to truncation.
  const order = exact.map((x, i) => ({ i, lost: Math.abs(x - Math.trunc(x)) })).sort((a, b) => b.lost - a.lost || a.i - b.i);
  for (let k = 0; remainder !== 0; k = (k + 1) % order.length) {
    parts[order[k]!.i]! += step;
    remainder -= step;
  }
  return parts;
}

// ── Engine ──────────────────────────────────────────────────────────────────

export function reconcile(input: ReconInput): ReconOutput {
  const { policy, contract, prior, app } = input;
  const tol = policy.toleranceCents;
  const claimed = app.claimed;
  const checks: CheckResult[] = [];
  const near = (a: number, b: number) => Math.abs(a - b) <= tol;
  const $ = (n: number | null | undefined) => formatMoney(n);
  const lineLabel = (l: { itemNo: string | null; description: string | null }) =>
    [l.itemNo ? `Item ${l.itemNo}` : null, l.description].filter(Boolean).join(' · ') || 'Unlabelled line';

  // ── 1. Verified figures ────────────────────────────────────────────────────

  const approvedCos = input.changeOrders.filter((c) => c.status === 'approved');
  const pendingCos = input.changeOrders.filter((c) => c.status === 'pending');
  const netChangeOrders = sum(approvedCos.map((c) => c.amount));
  const contractSumToDate = contract.originalAmount + netChangeOrders;

  const lineBySov = new Map<string, ReconLine>();
  for (const line of input.lines) if (line.sovLineId) lineBySov.set(line.sovLineId, line);
  const unmatched = input.lines.filter((l) => !l.sovLineId);

  // Verified totals run over the contract's schedule of values, not over the
  // submitted sheet: a line the subcontractor left off still carries its prior
  // billing, and a line that is not in the contract contributes nothing.
  const verifiedLines: VerifiedLine[] = input.sov.map((s) => {
    const line = lineBySov.get(s.id) ?? null;
    const previous = prior?.workToDate[s.id] ?? 0;
    const thisPeriod = line?.thisPeriod ?? 0;
    const stored = line?.stored ?? 0;
    const total = previous + thisPeriod + stored;
    return {
      sovLineId: s.id,
      lineId: line?.id ?? null,
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

  const workToDate = sum(verifiedLines.map((l) => l.previous + l.thisPeriod));
  const storedToDate = sum(verifiedLines.map((l) => l.stored));
  const totalCompletedStored = workToDate + storedToDate;
  // A release counts from the period it takes effect in. With no period read yet, count them all.
  const releasesInForce = (input.retainageReleases ?? []).filter((r) => !app.periodTo || r.effectiveOn <= app.periodTo);
  const releasedToDate = sum(releasesInForce.map((r) => r.amount));
  const retainageFor = (work: number, stored: number) =>
    computeRetainage({ work, stored, contractSum: contractSumToDate, workBps: contract.retainageWorkBps, storedBps: contract.retainageStoredBps, terms: contract.retainageTerms, released: releasedToDate });
  // Retainage is computed on the totals (as the G702 does), not summed from per-line rounding.
  const held = retainageFor(workToDate, storedToDate);
  const retainageWork = held.work;
  const retainageStored = held.stored;
  const retainageTotal = held.total;
  if (held.special) {
    // With a stepped rate or a release there is no per-line rate; share the total out in proportion.
    const shares = allocate(retainageTotal, verifiedLines.map((l) => l.retainage));
    verifiedLines.forEach((l, i) => (l.retainage = shares[i]!));
  }
  const totalEarnedLessRetainage = totalCompletedStored - retainageTotal;
  const lessPreviousCertificates = prior?.totalEarnedLessRetainage ?? 0;
  const currentPaymentDue = totalEarnedLessRetainage - lessPreviousCertificates;

  const verified: VerifiedHeader = {
    originalContractSum: contract.originalAmount,
    netChangeOrders,
    contractSumToDate,
    totalCompletedStored,
    retainageWork,
    retainageStored,
    retainageTotal,
    totalEarnedLessRetainage,
    lessPreviousCertificates,
    currentPaymentDue,
    balanceToFinish: contractSumToDate - totalEarnedLessRetainage,
    priorApplicationNumber: prior?.applicationNumber ?? null,
    excludedLines: unmatched.length,
    retainageReleased: held.released,
    retainageBasis: held.basis,
  };

  // The subcontractor reports earlier billing but we hold no history for this contract.
  const statedPrevious = sum(input.lines.map((l) => l.previous));
  const noHistory = !prior && (statedPrevious !== 0 || (claimed.lessPreviousCertificates ?? 0) !== 0);

  // ── 2. Package completeness ────────────────────────────────────────────────

  const segments = input.documents.flatMap((d) => d.segments.map((s) => ({ ...s, documentId: d.id })));
  const hasType = (t: DocumentSegment['type']) => segments.some((s) => s.type === t);
  const firstOf = (t: DocumentSegment['type']) => segments.find((s) => s.type === t);

  // A package that arrived by email is only as trustworthy as its sender.
  if (input.intake?.via === 'email') {
    const { senderEmail, sender } = input.intake;
    const known = sender !== 'unknown';
    checks.push({
      code: 'intake.sender',
      subjectKey: '',
      category: 'documents',
      severity: 'blocking',
      outcome: known ? 'pass' : 'fail',
      title: known ? 'Sent from a known address' : 'Sent from an address that is not on file',
      detail: known
        ? `Received by email from ${senderEmail}, ${sender === 'contact' ? `the contact address on file for ${input.subcontractor.name}` : sender === 'domain' ? `which is on the same email domain as the contact on file for ${input.subcontractor.name}` : 'a member of your team'}.`
        : `This package arrived by email from ${senderEmail ?? 'an unknown address'}, which is not the contact on file for ${input.subcontractor.name} and is not anyone on your team. Anyone who knows the intake address can send to it, and a sender address can be forged.`,
      action: known ? undefined : `Confirm with ${input.subcontractor.name} that they sent it. If the address is theirs, add it to the subcontractor’s record and this clears by itself.`,
    });
  }

  const payAppSeg = firstOf('pay_application');
  checks.push(
    payAppSeg
      ? {
          code: 'doc.pay_application',
          subjectKey: '',
          category: 'documents',
          severity: 'blocking',
          outcome: 'pass',
          title: 'Pay application received',
          detail: 'The package includes an application and certificate for payment.',
          refs: { documentId: payAppSeg.documentId, page: payAppSeg.pageStart, tab: 'documents' },
        }
      : {
          code: 'doc.pay_application',
          subjectKey: '',
          category: 'documents',
          severity: 'blocking',
          outcome: 'fail',
          title: 'No pay application in the package',
          detail:
            'None of the documents was recognised as an application and certificate for payment (G702 or equivalent). Without it there is no signed request for a specific amount.',
          action: 'Add the pay application, or request it from the subcontractor.',
          refs: { tab: 'documents' },
        },
  );

  const sheetSeg = firstOf('continuation_sheet');
  checks.push(
    sheetSeg
      ? {
          code: 'doc.continuation_sheet',
          subjectKey: '',
          category: 'documents',
          severity: 'blocking',
          outcome: 'pass',
          title: 'Schedule of values received',
          detail: `The continuation sheet was read: ${pluralize(input.lines.length, 'line item')}.`,
          refs: { documentId: sheetSeg.documentId, page: sheetSeg.pageStart, tab: 'documents' },
        }
      : {
          code: 'doc.continuation_sheet',
          subjectKey: '',
          category: 'documents',
          severity: 'blocking',
          outcome: 'fail',
          title: 'No schedule of values in the package',
          detail:
            'There is no continuation sheet (G703 or equivalent). Without line-by-line billing, the work claimed cannot be checked against the contract or against what was billed before.',
          action: 'Add the continuation sheet, or key the line items by hand.',
          refs: { tab: 'documents' },
        },
  );

  if (sheetSeg && input.lines.length === 0) {
    checks.push({
      code: 'extract.no_lines',
      subjectKey: '',
      category: 'extraction',
      severity: 'blocking',
      outcome: 'fail',
      title: 'Line items could not be read from the schedule of values',
      detail: 'A continuation sheet is present but no line items were recognised on it.',
      action: 'Add the line items by hand from the document, or request a clearer copy.',
      refs: { documentId: sheetSeg.documentId, page: sheetSeg.pageStart, tab: 'lines' },
    });
  }

  for (const doc of input.documents) {
    if (doc.status === 'unreadable' || doc.status === 'failed') {
      checks.push({
        code: 'doc.unreadable',
        subjectKey: doc.id,
        category: 'extraction',
        severity: 'blocking',
        outcome: 'fail',
        title: `“${doc.filename}” could not be read automatically`,
        detail:
          doc.statusDetail ??
          'This file has no machine-readable text and automatic reading is not available for it.',
        action:
          'Open the document and key its values by hand, then accept this item to confirm you have accounted for it — or request a clearer copy.',
        refs: { documentId: doc.id, page: 1, tab: 'documents' },
      });
    }
    if (doc.duplicateOf) {
      const where =
        doc.duplicateOf.applicationNumber !== null
          ? `application #${doc.duplicateOf.applicationNumber}`
          : 'another submission';
      checks.push({
        code: 'doc.duplicate_file',
        subjectKey: doc.id,
        category: 'documents',
        severity: 'blocking',
        outcome: 'fail',
        title: `“${doc.filename}” was already submitted`,
        detail: `This exact file (byte-for-byte) was received before as “${doc.duplicateOf.filename}” on ${where}. Paying it again would be a duplicate payment.`,
        action: 'Confirm this is not a duplicate submission. If it is, void this application.',
        refs: { documentId: doc.id, page: 1, tab: 'documents' },
      });
    }
  }

  // What the reading of each file saw besides the figures: pages it could not read, pages missing
  // from the printed numbering, and the same fact printed twice with different values. Each of
  // these can hide a line item or an amount, so each blocks until a person has looked.
  const marks = input.documents.flatMap((d) => (d.integrity?.pageNumbering ?? []).map((m) => ({ ...m, documentId: d.id })));
  for (const doc of input.documents) {
    const facts = doc.integrity;
    if (!facts || doc.status === 'unreadable' || doc.status === 'failed') continue; // the whole file is already flagged

    const unread = facts.unreadablePages;
    if (unread.length > 0) {
      const one = unread.length === 1;
      checks.push({
        code: 'doc.unreadable_pages',
        subjectKey: doc.id,
        category: 'extraction',
        severity: 'blocking',
        outcome: 'fail',
        title: `${one ? 'Page' : 'Pages'} ${listNumbers(unread)} of “${doc.filename}” could not be read automatically`,
        detail: `${one ? 'This page has' : 'These pages have'} no machine-readable text (a blank page or a scanned image), so nothing on ${one ? 'it' : 'them'} was read or checked. A line item, amount or signature there is missing from the figures in this review.`,
        action: `Open the ${one ? 'page' : 'pages'} and key anything ${one ? 'it holds' : 'they hold'} by hand (line items on the Lines tab, summary figures on the Summary tab), then accept this item to confirm you have accounted for ${one ? 'it' : 'them'}. Or request a copy with a text layer.`,
        data: { actualText: unread.join(',') },
        refs: { documentId: doc.id, page: unread[0], tab: 'documents' },
      });
    }

    // A number printed on another file of the package is not missing: an application and its
    // schedule are often numbered as one document and sent as two files.
    const gaps = printedPageGaps(facts.pageNumbering)
      .map((g) => ({ ...g, missing: g.missing.filter((n) => !marks.some((m) => m.documentId !== doc.id && m.of === g.of && m.number === n)) }))
      .filter((g) => g.missing.length > 0);
    if (gaps.length > 0) {
      const what = gaps.map((g) => `${g.missing.length === 1 ? 'page' : 'pages'} ${listNumbers(g.missing)}${g.of !== null ? ` of ${g.of}` : ''}`).join(' and ');
      const first = gaps[0]!;
      const sample = facts.pageNumbering.find((m) => m.page === first.pages[0]);
      checks.push({
        code: 'doc.page_missing',
        subjectKey: doc.id,
        category: 'documents',
        severity: 'blocking',
        outcome: 'fail',
        title: `“${doc.filename}” is missing ${what}`,
        detail: `The pages are numbered${sample ? ` (page ${sample.page} of the file is marked “${sample.source}”)` : ''}, but printed ${what} ${gaps.length === 1 && first.missing.length === 1 ? 'is' : 'are'} not in this file or in any other file of the package. A missing page of a schedule of values hides its line items; a missing page of an application or waiver can hide an amount, a condition or the signature.`,
        action: 'Request the missing pages from the subcontractor. If nothing is missing (the numbering on the document is wrong), accept this item with a note saying so.',
        data: { actualText: gaps.map((g) => `${g.missing.join(',')}/${g.of ?? ''}`).join(';') },
        refs: { documentId: doc.id, page: first.pages[0], tab: 'documents' },
      });
    }

    for (const conflict of facts.conflicts) {
      // Amounts within the tolerance agree; application numbers must match exactly.
      const same = (a: number | null, b: number | null) => a !== null && b !== null && (conflict.kind === 'total' ? near(a, b) : a === b);
      const conflicting = conflict.others.filter((o) => !same(o.value, conflict.reported.value));
      const other = conflicting[0];
      if (!other) continue;
      const reported = conflict.reported;
      const at = (v: { page: number | null }) => (v.page !== null ? `page ${v.page}` : 'another page');
      const base = {
        code: 'doc.conflict',
        subjectKey: `${doc.id}:${conflict.kind}:${conflict.field}`,
        category: 'documents' as const,
        outcome: 'fail' as const,
        refs: { documentId: doc.id, page: other.page ?? reported.page ?? 1, tab: 'documents' as const },
      };
      if (conflict.kind === 'second_pay_application') {
        const numbers = conflicting.map((o) => (o.value !== null ? `#${o.value}` : null)).filter(Boolean);
        checks.push({
          ...base,
          severity: 'blocking',
          title: `“${doc.filename}” holds more than one pay application`,
          detail: `Only the application on ${at(reported)}${reported.value !== null ? ` (#${reported.value})` : ''} was read. ${pluralize(conflicting.length, 'other application')}${numbers.length > 0 ? ` (${numbers.join(', ')})` : ''} ${conflicting.length === 1 ? 'starts' : 'start'} on ${conflicting.map(at).join(', ')}; ${conflicting.length === 1 ? 'its' : 'their'} figures and schedule are not part of this review and nothing on ${conflicting.length === 1 ? 'it' : 'them'} has been checked. Paying both, or the wrong one, would pay the wrong amount.`,
          action: 'Submit each application as its own package, or confirm the extra one is a copy of this application and accept this item with a note.',
          data: { expected: reported.value, actual: other.value, actualText: conflicting.map((o) => `${o.value ?? '?'}@${o.page ?? '?'}`).join(',') },
        });
      } else if (conflict.kind === 'application_number') {
        const values = [...new Set(conflicting.map((o) => o.value))];
        checks.push({
          ...base,
          severity: 'blocking',
          title: `“${doc.filename}” states two different application numbers`,
          detail: `The pay application (${at(reported)}) is numbered ${reported.value ?? 'unreadable'}, but the ${docTypeName(other.docType)} (${conflicting.map(at).join(', ')}) says ${values.map((v) => v ?? 'unreadable').join(', ')}. The application number decides which earlier application counts as previous billing and whether this one is a duplicate.`,
          action: 'Confirm the number with the subcontractor and correct it on the Summary tab if it was misread, then accept this item; or request corrected documents.',
          data: { expected: reported.value, actual: other.value },
        });
      } else {
        const field = conflict.field as ClaimedField;
        // Line 4 against the schedule is already settled by the row sums (math.sheet_total and
        // math.grand_total say which side is off); reporting it here too would say it twice.
        if (field === 'totalCompletedStored' && input.lines.length > 0 && claimed.totalCompletedStored !== null) continue;
        const label = CLAIMED_FIELD_LABEL[field] ?? humanKey(conflict.field);
        const line = CLAIMED_FIELD_LINE[field];
        const diff = reported.value !== null && other.value !== null ? other.value - reported.value : null;
        checks.push({
          ...base,
          // The contract sum does not enter the payment; the others do.
          severity: field === 'contractSumToDate' ? 'warning' : 'blocking',
          title: `The application and its schedule print different figures for “${label}”`,
          detail: `${line ? `Line ${line} of the pay application` : 'The pay application'} (${at(reported)}) says ${$(reported.value)}, but the ${docTypeName(other.docType)}’s printed total on ${at(other)} says ${$(other.value)}${diff !== null ? ` (${$(Math.abs(diff))} apart)` : ''}. The two documents disagree, so one of them is wrong or a page or line is missing.`,
          action: 'Compare both pages with the document. If the document itself is inconsistent, request a corrected application.',
          data: { expected: reported.value, actual: other.value, delta: diff },
        });
      }
    }
  }

  // Two files in the package carrying pay applications with different numbers: only one was read.
  const numbered = input.documents.filter((d) => d.integrity?.payApplicationNumber != null);
  const distinct = [...new Set(numbered.map((d) => d.integrity!.payApplicationNumber!))];
  if (distinct.length > 1) {
    checks.push({
      code: 'doc.conflict',
      subjectKey: 'package:applicationNumber',
      category: 'documents',
      severity: 'blocking',
      outcome: 'fail',
      title: 'The package holds pay applications with different numbers',
      detail: `${numbered.map((d) => `“${d.filename}” is application #${d.integrity!.payApplicationNumber}`).join('; ')}. Only one application can be reviewed per package; the figures of the other were not checked.`,
      action: 'Remove the file that belongs to another application and submit it on its own, then re-run the review.',
      data: { actualText: numbered.map((d) => `${d.id}:${d.integrity!.payApplicationNumber}`).join(',') },
      refs: { documentId: numbered[0]!.id, page: 1, tab: 'documents' },
    });
  }

  // Signature
  if (payAppSeg && policy.requireSignature) {
    const base = {
      code: 'doc.signature',
      subjectKey: '',
      category: 'documents' as const,
      severity: 'blocking' as const,
      refs: { field: 'signed', tab: 'summary' as const },
    };
    if (app.signed === 'yes') {
      checks.push({ ...base, outcome: 'pass', title: 'Pay application is signed', detail: 'A signature was detected in the contractor’s certification block.' });
    } else if (app.signatureConfirmed) {
      checks.push({ ...base, outcome: 'pass', title: 'Signature confirmed by reviewer', detail: 'A reviewer looked at the document and confirmed the signature is present.' });
    } else if (app.signed === 'no') {
      checks.push({
        ...base,
        outcome: 'fail',
        title: 'Pay application is not signed',
        detail: 'The contractor’s certification block appears to be blank. An unsigned application is not a certified request for payment.',
        action: 'Request a signed copy. If the signature is there and was missed, confirm it.',
      });
    } else {
      checks.push({
        ...base,
        outcome: 'fail',
        title: 'Signature could not be confirmed automatically',
        detail: 'The system could not tell whether the contractor’s certification is signed (for example a handwritten signature on a scan).',
        action: 'Look at the signature block and confirm the signature if it is present.',
      });
    }
  }
  if (payAppSeg && policy.requireNotarization) {
    const base = { code: 'doc.notarization', subjectKey: '', category: 'documents' as const, severity: 'warning' as const, refs: { field: 'signed', tab: 'summary' as const } };
    checks.push(
      app.notarized === 'yes'
        ? { ...base, outcome: 'pass', title: 'Pay application is notarised', detail: 'A notary acknowledgement was detected.' }
        : {
            ...base,
            outcome: 'fail',
            title: app.notarized === 'no' ? 'Pay application is not notarised' : 'Notarisation could not be confirmed',
            detail: 'Your policy requires pay applications to be notarised, and a completed notary block was not detected.',
            action: 'Check the notary block on the document; request a notarised copy if it is blank.',
          },
    );
  }

  // ── 3. Identity & sequence ─────────────────────────────────────────────────

  if (app.applicationNumber === null) {
    checks.push({
      code: 'seq.number_missing',
      subjectKey: '',
      category: 'prior_billing',
      severity: 'blocking',
      outcome: 'fail',
      title: 'Application number is missing',
      detail: 'No application number could be read. It is needed to place this billing in sequence and to detect duplicates.',
      action: 'Enter the application number from the document.',
      refs: { field: 'applicationNumber', tab: 'summary' },
    });
  }
  if (app.periodTo === null) {
    checks.push({
      code: 'seq.period_missing',
      subjectKey: '',
      category: 'prior_billing',
      severity: 'blocking',
      outcome: 'fail',
      title: 'Billing period is missing',
      detail: 'No “period to” date could be read from the application.',
      action: 'Enter the period end date from the document.',
      refs: { field: 'periodTo', tab: 'summary' },
    });
  }

  const live = input.siblings.filter((s) => s.status !== 'rejected' && s.status !== 'void');
  if (app.applicationNumber !== null) {
    const n = app.applicationNumber;
    const sameNumber = live.filter((s) => s.applicationNumber === n);
    const earlierOpen = live.filter((s) => s.applicationNumber !== null && s.applicationNumber < n && OPEN_SIBLING.has(s.status));
    const laterApproved = live.filter((s) => s.applicationNumber !== null && s.applicationNumber > n && s.status === 'approved');
    const base = prior?.applicationNumber ?? 0;

    if (sameNumber.length > 0) {
      checks.push({
        code: 'seq.duplicate_number',
        subjectKey: '',
        category: 'prior_billing',
        severity: 'blocking',
        outcome: 'fail',
        title: `Application #${n} already exists for this contract`,
        detail: `Another application numbered ${n} is on file (${sameNumber.map((s) => s.status.replace('_', ' ')).join(', ')}). Approving both would pay the same billing twice.`,
        action: 'If this is a corrected resubmission, void or reject the earlier one. If it is a duplicate, void this one.',
        refs: { field: 'applicationNumber', tab: 'summary' },
      });
    } else if (laterApproved.length > 0) {
      checks.push({
        code: 'seq.duplicate_number',
        subjectKey: '',
        category: 'prior_billing',
        severity: 'blocking',
        outcome: 'fail',
        title: `A later application (#${laterApproved[0]!.applicationNumber}) is already approved`,
        detail: `Application #${n} comes before one that has already been approved. Its amounts would not be reflected in what was certified afterwards.`,
        action: 'Check the application number. If this billing was missed, it has to be handled outside the normal sequence.',
        refs: { field: 'applicationNumber', tab: 'summary' },
      });
    } else if (prior && n <= base) {
      checks.push({
        code: 'seq.duplicate_number',
        subjectKey: '',
        category: 'prior_billing',
        severity: 'blocking',
        outcome: 'fail',
        title: `Application #${n} is not after the last approved application (#${base})`,
        detail: 'The application number has already been used or superseded.',
        action: 'Check the application number on the document.',
        refs: { field: 'applicationNumber', tab: 'summary' },
      });
    } else {
      checks.push({
        code: 'seq.duplicate_number',
        subjectKey: '',
        category: 'prior_billing',
        severity: 'blocking',
        outcome: 'pass',
        title: 'No duplicate application number',
        detail: `No other application numbered ${n} exists for this contract.`,
      });
    }

    if (earlierOpen.length > 0) {
      const list = earlierOpen.map((s) => `#${s.applicationNumber}`).join(', ');
      checks.push({
        code: 'seq.prior_pending',
        subjectKey: '',
        category: 'prior_billing',
        severity: 'blocking',
        outcome: 'fail',
        title: `Earlier application ${list} has not been decided`,
        detail: `The “previous” amounts on this application depend on what gets approved for ${list}. Until then the verified figures here are provisional.`,
        action: `Approve or reject ${list} first; this application will be re-checked automatically.`,
        refs: { tab: 'summary' },
      });
    } else if (!noHistory && n > base + 1) {
      const missing = n - base - 1;
      checks.push({
        code: 'seq.gap',
        subjectKey: '',
        category: 'prior_billing',
        severity: 'warning',
        outcome: 'fail',
        title: `Application number jumps from #${base} to #${n}`,
        detail: `${pluralize(missing, 'application')} between the last approved one and this one ${missing === 1 ? 'was' : 'were'} never approved here. Billing may be missing from the record.`,
        action: 'Confirm with the subcontractor whether an application was skipped or never submitted.',
        refs: { field: 'applicationNumber', tab: 'summary' },
      });
    } else if (!noHistory) {
      checks.push({
        code: 'seq.gap',
        subjectKey: '',
        category: 'prior_billing',
        severity: 'warning',
        outcome: 'pass',
        title: 'Application is next in sequence',
        detail: base === 0 ? 'This is the first application for the contract.' : `It follows application #${base}.`,
      });
    }
  }

  if (app.periodTo !== null) {
    const samePeriod = live.filter((s) => s.periodTo === app.periodTo && s.applicationNumber !== app.applicationNumber);
    if (samePeriod.length > 0) {
      checks.push({
        code: 'seq.duplicate_period',
        subjectKey: '',
        category: 'prior_billing',
        severity: 'blocking',
        outcome: 'fail',
        title: `Another application covers the same period (to ${formatDate(app.periodTo)})`,
        detail: `Application ${samePeriod.map((s) => `#${s.applicationNumber ?? '?'}`).join(', ')} has the same period end date. Two applications for one period usually means a duplicate or a revision.`,
        action: 'Confirm which one is current and void the other.',
        refs: { field: 'periodTo', tab: 'summary' },
      });
    }
    if (prior?.periodTo && app.periodTo <= prior.periodTo) {
      checks.push({
        code: 'seq.period_order',
        subjectKey: '',
        category: 'prior_billing',
        severity: 'warning',
        outcome: 'fail',
        title: 'Billing period does not advance',
        detail: `This application’s period ends ${formatDate(app.periodTo)}, which is not after the previous approved period (${formatDate(prior.periodTo)}).`,
        action: 'Check the period date on the document.',
        refs: { field: 'periodTo', tab: 'summary' },
      });
    }
    if (app.periodTo > addDays(input.today, 31)) {
      checks.push({
        code: 'seq.period_future',
        subjectKey: '',
        category: 'prior_billing',
        severity: 'warning',
        outcome: 'fail',
        title: 'Billing period ends in the future',
        detail: `The period end date (${formatDate(app.periodTo)}) is more than a month ahead. Work cannot be certified before it is performed.`,
        action: 'Check the period date on the document.',
        refs: { field: 'periodTo', tab: 'summary' },
      });
    }
  }

  // ── 4. Required values ─────────────────────────────────────────────────────

  if (payAppSeg) {
    const required: Array<[ClaimedField, Severity]> = [
      ['originalContractSum', 'blocking'],
      ['contractSumToDate', 'blocking'],
      ['totalCompletedStored', 'blocking'],
      ['currentPaymentDue', 'blocking'],
      ['totalEarnedLessRetainage', 'warning'],
      ['lessPreviousCertificates', 'warning'],
    ];
    for (const [field, severity] of required) {
      if (claimed[field] === null) {
        checks.push({
          code: 'extract.missing_value',
          subjectKey: field,
          category: 'extraction',
          severity,
          outcome: 'fail',
          title: `“${CLAIMED_FIELD_LABEL[field]}” was not found on the application`,
          detail: `Line ${CLAIMED_FIELD_LINE[field]} of the pay application could not be read, so it cannot be compared with the verified figure (${$(verified[field])}).`,
          action: 'Enter the value from the document. Leave it blank only if the document itself leaves it blank.',
          refs: { field, tab: 'summary' },
        });
      }
    }

    // Signature confidence is handled by its own check above.
    const shaky = Object.entries(app.confidence)
      .filter(([key, c]) => key !== 'signed' && c < policy.lowConfidenceThreshold)
      .map(([key]) => key);
    if (shaky.length > 0) {
      checks.push({
        code: 'extract.low_confidence',
        subjectKey: '',
        category: 'extraction',
        severity: 'warning',
        outcome: 'fail',
        title: `${pluralize(shaky.length, 'value')} read with low confidence`,
        detail: `Check these against the document: ${shaky.map((k) => CLAIMED_FIELD_LABEL[k as ClaimedField] ?? humanKey(k)).join(', ')}.`,
        action: 'Correct any that are wrong. Editing a value marks it as confirmed.',
        data: { actualText: shaky.join(',') },
        refs: { field: shaky[0], tab: 'summary' },
      });
    }
  }

  // ── 5. Arithmetic on the submitted figures ─────────────────────────────────

  const arithmetic = (
    code: string,
    severity: Severity,
    result: ClaimedField,
    formula: string,
    expected: number | null,
    why: string,
  ) => {
    const actual = claimed[result];
    if (actual === null || expected === null) return;
    const ok = near(actual, expected);
    checks.push({
      code,
      subjectKey: '',
      category: 'math',
      severity,
      outcome: ok ? 'pass' : 'fail',
      title: ok
        ? `Line ${CLAIMED_FIELD_LINE[result]} adds up (${formula})`
        : `Line ${CLAIMED_FIELD_LINE[result]} does not add up`,
      detail: ok
        ? `${CLAIMED_FIELD_LABEL[result]}: ${$(actual)}.`
        : `${CLAIMED_FIELD_LABEL[result]} is stated as ${$(actual)}, but ${formula} using the application’s own figures gives ${$(expected)} — a difference of ${$(Math.abs(actual - expected))}. ${why}`,
      action: ok ? undefined : 'Compare with the document. If the document itself is wrong, request a corrected application.',
      data: { expected, actual, delta: actual - expected },
      refs: { field: result, tab: 'summary' },
    });
  };
  const c = claimed;
  const both = (a: number | null, b: number | null, f: (x: number, y: number) => number) => (a === null || b === null ? null : f(a, b));

  arithmetic('math.contract_sum', 'blocking', 'contractSumToDate', 'line 1 + line 2', both(c.originalContractSum, c.netChangeOrders ?? 0, (a, b) => a + b), 'The contract sum drives the balance to finish.');
  const claimedRetainage = c.retainageTotal ?? (c.retainageWork !== null || c.retainageStored !== null ? (c.retainageWork ?? 0) + (c.retainageStored ?? 0) : null);
  if (c.retainageTotal !== null && (c.retainageWork !== null || c.retainageStored !== null)) {
    arithmetic('math.retainage_sum', 'warning', 'retainageTotal', 'line 5a + line 5b', (c.retainageWork ?? 0) + (c.retainageStored ?? 0), 'The parts of retainage should sum to the total withheld.');
  }
  arithmetic('math.earned', 'blocking', 'totalEarnedLessRetainage', 'line 4 − line 5', both(c.totalCompletedStored, claimedRetainage, (a, b) => a - b), 'An error here flows straight into the payment requested.');
  arithmetic('math.current_due', 'blocking', 'currentPaymentDue', 'line 6 − line 7', both(c.totalEarnedLessRetainage, c.lessPreviousCertificates, (a, b) => a - b), 'This is the amount the subcontractor is asking to be paid.');
  arithmetic('math.balance', 'warning', 'balanceToFinish', 'line 3 − line 6', both(c.contractSumToDate, c.totalEarnedLessRetainage, (a, b) => a - b), 'The balance to finish is what remains committed on the contract.');

  // Line-level arithmetic
  if (input.lines.length > 0) {
    let badTotals = 0;
    let badBalances = 0;
    for (const line of input.lines) {
      if (line.total !== null) {
        const expected = (line.previous ?? 0) + (line.thisPeriod ?? 0) + (line.stored ?? 0);
        if (!near(line.total, expected)) {
          badTotals++;
          checks.push({
            code: 'math.line_total',
            subjectKey: line.id,
            category: 'math',
            severity: 'blocking',
            outcome: 'fail',
            title: `${lineLabel(line)}: row total does not add up`,
            detail: `Total completed and stored is stated as ${$(line.total)}, but previous ${$(line.previous ?? 0)} + this period ${$(line.thisPeriod ?? 0)} + stored ${$(line.stored ?? 0)} = ${$(expected)}.`,
            action: 'Check the row against the document and correct any misread cell.',
            data: { expected, actual: line.total, delta: line.total - expected },
            refs: { lineId: line.id, tab: 'lines' },
          });
        }
      }
      if (line.balance !== null && line.scheduledValue !== null && line.total !== null) {
        const expected = line.scheduledValue - line.total;
        if (!near(line.balance, expected)) {
          badBalances++;
          checks.push({
            code: 'math.line_balance',
            subjectKey: line.id,
            category: 'math',
            severity: 'warning',
            outcome: 'fail',
            title: `${lineLabel(line)}: balance to finish does not add up`,
            detail: `Balance is stated as ${$(line.balance)}, but scheduled value ${$(line.scheduledValue)} − total ${$(line.total)} = ${$(expected)}.`,
            data: { expected, actual: line.balance, delta: line.balance - expected },
            refs: { lineId: line.id, tab: 'lines' },
          });
        }
      }
    }
    if (badTotals === 0 && badBalances === 0) {
      checks.push({
        code: 'math.line_total',
        subjectKey: '',
        category: 'math',
        severity: 'blocking',
        outcome: 'pass',
        title: 'Every row on the schedule adds up',
        detail: `Previous + this period + stored equals the row total on all ${pluralize(input.lines.length, 'line')}.`,
        refs: { tab: 'lines' },
      });
    }

    const sheetTotal = sum(input.lines.map((l) => l.total ?? (l.previous ?? 0) + (l.thisPeriod ?? 0) + (l.stored ?? 0)));
    if (claimed.totalCompletedStored !== null) {
      const ok = near(sheetTotal, claimed.totalCompletedStored);
      checks.push({
        code: 'math.sheet_total',
        subjectKey: '',
        category: 'math',
        severity: 'blocking',
        outcome: ok ? 'pass' : 'fail',
        title: ok ? 'Schedule of values ties to line 4' : 'Schedule of values does not tie to line 4',
        detail: ok
          ? `The line items total ${$(sheetTotal)}, matching total completed and stored on the application.`
          : `The line items add up to ${$(sheetTotal)}, but line 4 of the application says ${$(claimed.totalCompletedStored)} — ${$(Math.abs(sheetTotal - claimed.totalCompletedStored))} apart. One of the two documents is wrong.`,
        action: ok ? undefined : 'Check for a line that was missed or misread; otherwise request a corrected application.',
        data: { expected: sheetTotal, actual: claimed.totalCompletedStored, delta: claimed.totalCompletedStored - sheetTotal },
        refs: { field: 'totalCompletedStored', tab: 'summary' },
      });
    }

    // The schedule's printed grand total against its rows, column by column: a row or page that
    // was not read, or a misread cell, shows up here. Plain integer-cent sums of the rows under
    // review; nothing the reader computed is trusted.
    const totalled = input.documents.filter((d) => d.integrity?.scheduleGrandTotal);
    for (const doc of totalled) {
      const g = doc.integrity!.scheduleGrandTotal!;
      // With one printed total in the package every row counts toward it, including rows keyed by
      // hand and rows of a schedule split across files. With several, each covers its own file.
      const rows = (totalled.length === 1 ? input.lines : input.lines.filter((l) => l.documentId === doc.id))
        // A reviewer's adjustment changes what is approved, not what the document says.
        .map((l) => ({ ...l, ...(l.printed ?? {}) }))
        .map((l) => ({ ...l, total: l.total ?? (l.previous ?? 0) + (l.thisPeriod ?? 0) + (l.stored ?? 0) }));
      const columns = LINE_AMOUNT_FIELDS.filter((f) => typeof g.values[f] === 'number');
      if (rows.length === 0 || columns.length === 0) continue;
      const compared = columns.map((field) => {
        const printed = g.values[field] as number;
        const { sum: rowSum, blanks } = sumColumn(rows, field);
        return { field, printed, rowSum, blanks, ok: near(rowSum, printed) };
      });
      const off = compared.filter((c) => !c.ok);
      const where = `${g.page !== null ? `page ${g.page} of ` : ''}“${doc.filename}”`;
      const refs: FindingRefs = { documentId: doc.id, ...(g.page !== null ? { page: g.page } : {}), tab: 'lines' };
      if (off.length === 0) {
        checks.push({
          code: 'math.grand_total',
          subjectKey: doc.id,
          category: 'math',
          severity: 'blocking',
          outcome: 'pass',
          title: 'Schedule rows add up to its printed grand total',
          detail: `The ${pluralize(rows.length, 'row')} add up to the ${g.label ? `“${g.label}” row` : 'grand total'} printed on ${where} in every column (${compared.map((c) => GRAND_TOTAL_COLUMN[c.field]).join(', ')}).`,
          refs,
        });
        continue;
      }
      // Only the columns that feed the payment block; the others still point at a missing row.
      const blocking = off.some((c) => c.field !== 'scheduledValue' && c.field !== 'previous' && c.field !== 'balance');
      const main = off.find((c) => c.field === 'total') ?? off.find((c) => c.field === 'thisPeriod') ?? off[0]!;
      const blanks = Math.max(...off.map((c) => c.blanks));
      checks.push({
        code: 'math.grand_total',
        subjectKey: doc.id,
        category: 'math',
        severity: blocking ? 'blocking' : 'warning',
        outcome: 'fail',
        title: 'Schedule rows do not add up to its printed grand total',
        detail:
          `The ${g.label ? `“${g.label}” row` : 'grand total'} printed on ${where} does not equal the sum of the ${pluralize(rows.length, 'row')} under review: ` +
          off.map((c) => `${GRAND_TOTAL_COLUMN[c.field]} is printed as ${$(c.printed)} but the rows add up to ${$(c.rowSum)} (${$(Math.abs(c.printed - c.rowSum))} ${c.rowSum < c.printed ? 'short' : 'over'})`).join('; ') +
          `. A row or page that was not read, or a misread figure, is the usual cause; otherwise the schedule itself does not add up.` +
          (blanks > 0 ? ` ${pluralize(blanks, 'row')} ${blanks === 1 ? 'has' : 'have'} no figure in ${off.length === 1 ? 'that column' : 'one of these columns'}.` : '') +
          (g.confidence < policy.lowConfidenceThreshold ? ' The printed total was itself read with low confidence; check it against the document too.' : ''),
        action: 'Find the row that is missing or misread: key a missing row or correct the figure on the Lines tab. If the schedule itself does not add up, request a corrected schedule.',
        data: {
          expected: main.rowSum,
          actual: main.printed,
          delta: main.printed - main.rowSum,
          expectedText: off.map((c) => `${c.field}:${c.rowSum}`).join(','),
          actualText: off.map((c) => `${c.field}:${c.printed}`).join(','),
        },
        refs,
      });
    }
  }

  // ── 6. Contract value & change orders ──────────────────────────────────────

  if (claimed.originalContractSum !== null) {
    const ok = near(claimed.originalContractSum, contract.originalAmount);
    checks.push({
      code: 'contract.original_sum',
      subjectKey: '',
      category: 'contract',
      severity: 'blocking',
      outcome: ok ? 'pass' : 'fail',
      title: ok ? 'Original contract sum matches the contract' : 'Original contract sum does not match the contract',
      detail: ok
        ? `${$(contract.originalAmount)} on subcontract ${contract.number}.`
        : `The application states ${$(claimed.originalContractSum)}; subcontract ${contract.number} is ${$(contract.originalAmount)} — ${$(Math.abs(claimed.originalContractSum - contract.originalAmount))} ${claimed.originalContractSum > contract.originalAmount ? 'higher' : 'lower'}.`,
      action: ok ? undefined : 'Check that this application is matched to the right contract, and that the contract value on file is correct.',
      data: { expected: contract.originalAmount, actual: claimed.originalContractSum, delta: claimed.originalContractSum - contract.originalAmount },
      refs: { field: 'originalContractSum', tab: 'summary' },
    });
  }

  {
    const stated = claimed.netChangeOrders ?? 0;
    const ok = near(stated, netChangeOrders);
    let detail: string;
    if (ok) {
      detail =
        approvedCos.length === 0
          ? 'No change orders are approved on this contract and none are billed.'
          : `${pluralize(approvedCos.length, 'approved change order')} totalling ${$(netChangeOrders)}.`;
    } else {
      const delta = stated - netChangeOrders;
      const explain = explainWithPending(delta, pendingCos, tol);
      detail =
        `The application includes ${$(stated)} of change orders; approved change orders on file total ${$(netChangeOrders)}. ` +
        (explain
          ? `The ${$(Math.abs(delta))} difference equals ${explain}, which ${explain.includes(' and ') ? 'have' : 'has'} not been approved.`
          : `The ${$(Math.abs(delta))} difference does not correspond to any change order on file.`);
    }
    if (claimed.netChangeOrders !== null || netChangeOrders !== 0) {
      checks.push({
        code: 'co.net_change',
        subjectKey: '',
        category: 'change_orders',
        severity: 'blocking',
        outcome: ok ? 'pass' : 'fail',
        title: ok ? 'Change orders match approved change orders' : 'Change orders billed do not match approved change orders',
        detail,
        action: ok ? undefined : 'Approve the change order on the contract if it has been executed; otherwise the unapproved amount cannot be billed.',
        data: { expected: netChangeOrders, actual: stated, delta: stated - netChangeOrders },
        refs: { field: 'netChangeOrders', tab: 'summary' },
      });
    }
  }

  // ── 7. Schedule of values ──────────────────────────────────────────────────

  if (input.sov.length === 0) {
    checks.push({
      code: 'sov.none_on_contract',
      subjectKey: '',
      category: 'schedule',
      severity: 'blocking',
      outcome: 'fail',
      title: 'The contract has no schedule of values on file',
      detail: 'Line items cannot be verified against the contract until its schedule of values is recorded.',
      action: 'Adopt this application’s schedule as the contract’s schedule of values (after checking it), or enter it on the contract.',
      refs: { tab: 'lines' },
    });
  } else {
    const sovTotal = sum(input.sov.map((s) => s.scheduledValue));
    if (!near(sovTotal, contractSumToDate)) {
      checks.push({
        code: 'sov.contract_total',
        subjectKey: '',
        category: 'schedule',
        severity: 'warning',
        outcome: 'fail',
        title: 'Your schedule of values does not total the contract sum',
        detail: `The schedule of values on file totals ${$(sovTotal)}, but the contract sum to date is ${$(contractSumToDate)} (original ${$(contract.originalAmount)} + approved change orders ${$(netChangeOrders)}). This is a problem in the contract record, not in the submission.`,
        action: 'Correct the schedule of values or change orders on the contract.',
        data: { expected: contractSumToDate, actual: sovTotal, delta: sovTotal - contractSumToDate },
        refs: { tab: 'lines' },
      });
    }

    for (const line of unmatched) {
      const billed = (line.thisPeriod ?? 0) + (line.stored ?? 0);
      checks.push({
        code: 'sov.unknown_line',
        subjectKey: line.id,
        category: 'change_orders',
        severity: 'blocking',
        outcome: 'fail',
        title: `${lineLabel(line)} is not on the contract`,
        detail:
          `This line (scheduled value ${$(line.scheduledValue)}) does not match anything on the contract’s schedule of values` +
          (billed !== 0 ? `, and ${$(billed)} is billed against it this period` : '') +
          '. It is usually a change order that has not been approved. It is excluded from the verified amount.',
        action: 'If the change order has been executed, approve it on the contract and the line will match. Otherwise leave it excluded or request a corrected application.',
        data: { actual: billed },
        refs: { lineId: line.id, tab: 'lines' },
      });
    }

    let mismatched = 0;
    let over = 0;
    let previousWrong = 0;
    for (const s of input.sov) {
      const line = lineBySov.get(s.id);
      const v = verifiedLines.find((x) => x.sovLineId === s.id)!;
      if (!line) continue;

      if (line.scheduledValue !== null && !near(line.scheduledValue, s.scheduledValue)) {
        mismatched++;
        checks.push({
          code: 'sov.scheduled_value',
          subjectKey: line.id,
          category: 'schedule',
          severity: 'blocking',
          outcome: 'fail',
          title: `${lineLabel(line)}: scheduled value differs from the contract`,
          detail: `The application shows ${$(line.scheduledValue)}; the contract’s schedule of values has ${$(s.scheduledValue)}. Scheduled values can only change through an approved change order.`,
          action: 'Check the cell against the document. If the subcontractor has re-allocated values, that needs an approved change.',
          data: { expected: s.scheduledValue, actual: line.scheduledValue, delta: line.scheduledValue - s.scheduledValue },
          refs: { lineId: line.id, sovLineId: s.id, tab: 'lines' },
        });
      }

      // A deduct (negative scheduled value, e.g. a deductive change order) is billed as a credit:
      // the valid range runs from the scheduled value up to zero, the mirror image of a normal line.
      const deduct = s.scheduledValue < 0;
      if (!deduct && v.total > s.scheduledValue + tol) {
        over++;
        checks.push({
          code: 'sov.overbilled',
          subjectKey: line.id,
          category: 'schedule',
          severity: 'blocking',
          outcome: 'fail',
          title: `${lineLabel(line)}: billed beyond its scheduled value`,
          detail: `Completed and stored to date would be ${$(v.total)} against a scheduled value of ${$(s.scheduledValue)} — ${$(v.total - s.scheduledValue)} over (${s.scheduledValue ? Math.round((v.total / s.scheduledValue) * 100) : '∞'}%).`,
          action: 'Reduce this period’s amount to what is contractually billable, or request a corrected application.',
          data: { expected: s.scheduledValue, actual: v.total, delta: v.total - s.scheduledValue },
          refs: { lineId: line.id, sovLineId: s.id, tab: 'lines' },
        });
      } else if (deduct && (v.total < s.scheduledValue - tol || v.total > tol)) {
        over++;
        const tooMuchCredit = v.total < s.scheduledValue - tol;
        checks.push({
          code: 'sov.overbilled',
          subjectKey: line.id,
          category: 'schedule',
          severity: 'blocking',
          outcome: 'fail',
          title: tooMuchCredit ? `${lineLabel(line)}: more credit taken than the deduct allows` : `${lineLabel(line)}: a deduct is billed as a charge`,
          detail: tooMuchCredit
            ? `This line is a deduct of ${$(s.scheduledValue)}. Credit to date would be ${$(v.total)}, ${$(s.scheduledValue - v.total)} more than the deduct.`
            : `This line is a deduct of ${$(s.scheduledValue)}, so it can only reduce the billing. The application shows ${$(v.total)} billed against it.`,
          action: 'Check the sign and the amount on this line against the change order.',
          data: { expected: s.scheduledValue, actual: v.total, delta: v.total - s.scheduledValue },
          refs: { lineId: line.id, sovLineId: s.id, tab: 'lines' },
        });
      }

      if (!deduct && ((line.thisPeriod ?? 0) < 0 || (line.stored ?? 0) < 0)) {
        checks.push({
          code: 'sov.negative_billing',
          subjectKey: line.id,
          category: 'schedule',
          severity: 'warning',
          outcome: 'fail',
          title: `${lineLabel(line)}: negative amount this period`,
          detail: `This period shows ${$(line.thisPeriod ?? 0)} of work and ${$(line.stored ?? 0)} of stored material. A negative amount reverses earlier billing.`,
          action: 'Confirm the credit is intended.',
          refs: { lineId: line.id, sovLineId: s.id, tab: 'lines' },
        });
      }

      if (!noHistory && line.previous !== null && !near(line.previous, v.previous)) {
        previousWrong++;
        const delta = line.previous - v.previous;
        checks.push({
          code: 'prior.line_previous',
          subjectKey: line.id,
          category: 'prior_billing',
          severity: 'blocking',
          outcome: 'fail',
          title: `${lineLabel(line)}: “previous” does not match what was approved`,
          detail:
            `The application carries ${$(line.previous)} forward as previously completed; ${prior ? `${$(v.previous)} was approved through application #${prior.applicationNumber}` : 'nothing has been approved on this line before'}. ` +
            (delta > 0
              ? `The extra ${$(delta)} was never approved, so it would be paid without ever having been reviewed.`
              : `${$(-delta)} of approved work is missing, which understates what has already been certified.`),
          action: 'The verified amount uses the approved history. Request a corrected application if the subcontractor’s records disagree.',
          data: { expected: v.previous, actual: line.previous, delta },
          refs: { lineId: line.id, sovLineId: s.id, tab: 'lines' },
        });
      }
    }

    const matchedCount = input.lines.length - unmatched.length;
    if (matchedCount > 0 && mismatched === 0) {
      checks.push({
        code: 'sov.scheduled_value',
        subjectKey: '',
        category: 'schedule',
        severity: 'blocking',
        outcome: 'pass',
        title: 'Scheduled values match the contract',
        detail: `All ${pluralize(matchedCount, 'matched line')} carry the scheduled value on file.`,
        refs: { tab: 'lines' },
      });
    }
    if (matchedCount > 0 && over === 0) {
      checks.push({
        code: 'sov.overbilled',
        subjectKey: '',
        category: 'schedule',
        severity: 'blocking',
        outcome: 'pass',
        title: 'No line is billed beyond its scheduled value',
        detail: 'Completed and stored to date is within the scheduled value on every line.',
        refs: { tab: 'lines' },
      });
    }
    if (!noHistory && matchedCount > 0 && previousWrong === 0) {
      checks.push({
        code: 'prior.line_previous',
        subjectKey: '',
        category: 'prior_billing',
        severity: 'blocking',
        outcome: 'pass',
        title: 'Previous amounts match approved history',
        detail: prior
          ? `Every line carries forward what was approved through application #${prior.applicationNumber}.`
          : 'This is the first application; no line carries previous billing.',
        refs: { tab: 'lines' },
      });
    }

    if (input.lines.length > 0) {
      const missing = input.sov.filter((s) => !lineBySov.has(s.id));
      if (missing.length > 0) {
        const withHistory = missing.filter((s) => (prior?.workToDate[s.id] ?? 0) !== 0);
        checks.push({
          code: 'sov.missing_lines',
          subjectKey: '',
          category: 'schedule',
          severity: 'warning',
          outcome: 'fail',
          title: `${pluralize(missing.length, 'contract line')} missing from the application`,
          detail:
            `Not on the submitted schedule: ${missing.slice(0, 6).map((s) => `${s.itemNo} ${s.description}`).join('; ')}${missing.length > 6 ? '…' : ''}.` +
            (withHistory.length > 0
              ? ` ${pluralize(withHistory.length, 'of them has', 'of them have')} earlier approved billing, which the verified total still counts.`
              : ''),
          action: 'Confirm nothing was missed when the sheet was read; a complete schedule should list every contract line.',
          refs: { tab: 'lines' },
        });
      }
    }

    if (totalCompletedStored > contractSumToDate + tol) {
      checks.push({
        code: 'sov.contract_overbilled',
        subjectKey: '',
        category: 'schedule',
        severity: 'blocking',
        outcome: 'fail',
        title: 'Total billed exceeds the contract sum',
        detail: `Completed and stored to date (${$(totalCompletedStored)}) is ${$(totalCompletedStored - contractSumToDate)} more than the contract sum to date (${$(contractSumToDate)}).`,
        action: 'Resolve the over-billed lines above.',
        data: { expected: contractSumToDate, actual: totalCompletedStored, delta: totalCompletedStored - contractSumToDate },
        refs: { field: 'totalCompletedStored', tab: 'summary' },
      });
    }
  }

  // ── 8. Prior billing ───────────────────────────────────────────────────────

  if (noHistory) {
    checks.push({
      code: 'prior.no_history',
      subjectKey: '',
      category: 'prior_billing',
      severity: 'blocking',
      outcome: 'fail',
      title: 'Earlier billing is reported, but there is no history on file',
      detail: `The application reports ${$(statedPrevious)} of previously completed work and ${$(claimed.lessPreviousCertificates ?? 0)} of previous certificates, but no earlier application for this contract has been approved here. Until a starting point exists, “previous” amounts cannot be verified.`,
      action: 'If this contract was already under way before you started using Zephric, set its opening balances from this application after checking them against your records. Otherwise investigate.',
      data: { actual: claimed.lessPreviousCertificates ?? statedPrevious },
      refs: { field: 'lessPreviousCertificates', tab: 'summary' },
    });
  } else if (claimed.lessPreviousCertificates !== null) {
    const ok = near(claimed.lessPreviousCertificates, lessPreviousCertificates);
    const delta = claimed.lessPreviousCertificates - lessPreviousCertificates;
    checks.push({
      code: 'prior.previous_certificates',
      subjectKey: '',
      category: 'prior_billing',
      severity: 'blocking',
      outcome: ok ? 'pass' : 'fail',
      title: ok ? 'Previous certificates match what was approved' : 'Previous certificates do not match what was approved',
      detail: ok
        ? prior
          ? `${$(lessPreviousCertificates)} certified through ${prior.kind === 'baseline' ? 'the opening balance' : `application #${prior.applicationNumber}`}.`
          : 'Nothing has been certified before; line 7 is zero.'
        : `Line 7 states ${$(claimed.lessPreviousCertificates)}; ${prior ? `${$(lessPreviousCertificates)} was certified through ${prior.kind === 'baseline' ? 'the opening balance' : `application #${prior.applicationNumber}`}` : 'nothing has been certified before'}. ` +
          (delta < 0
            ? `Deducting ${$(-delta)} too little would pay that amount a second time.`
            : `It deducts ${$(delta)} more than was certified, which under-bills this period.`),
      action: ok ? undefined : 'The verified payment uses the approved history. Request a corrected application if needed.',
      data: { expected: lessPreviousCertificates, actual: claimed.lessPreviousCertificates, delta },
      refs: { field: 'lessPreviousCertificates', tab: 'summary' },
    });
  }

  // ── 9. Retainage ───────────────────────────────────────────────────────────

  if (claimedRetainage !== null && !noHistory) {
    // Test the RATE the subcontractor applied, on what they billed. Lines that are not on the
    // contract are excluded from the verified payment, but that is a separate finding; folding
    // it in here would make a correctly calculated retainage look wrong.
    const basisWork = workToDate + sum(unmatched.map((l) => (l.previous ?? 0) + (l.thisPeriod ?? 0)));
    const basisStored = storedToDate + sum(unmatched.map((l) => l.stored ?? 0));
    const expected = unmatched.length > 0 ? retainageFor(basisWork, basisStored) : held;
    const expectedRetainage = expected.total;
    const ok = near(claimedRetainage, expectedRetainage);
    const delta = claimedRetainage - expectedRetainage;
    const basis = expected.basis + (unmatched.length > 0 ? ', counting the lines that are not on the contract' : '');
    checks.push({
      code: 'ret.amount',
      subjectKey: '',
      category: 'retainage',
      severity: 'blocking',
      outcome: ok ? 'pass' : 'fail',
      title: ok ? 'Retainage is calculated per the contract' : delta < 0 ? 'Too little retainage is withheld' : 'Retainage withheld is higher than the contract requires',
      detail: ok
        ? `${$(expectedRetainage)} — ${basis}.`
        : `The contract requires ${basis} = ${$(expectedRetainage)}. The application withholds ${$(claimedRetainage)}, ${$(Math.abs(delta))} ${delta < 0 ? 'short. Under-withholding releases money the contract says to hold back.' : 'more than required.'}`,
      action: ok ? undefined : 'The verified payment applies the contract’s terms. If a reduced rate or a release of retainage has been agreed, record it on the contract first; this then clears by itself.',
      data: { expected: expectedRetainage, actual: claimedRetainage, delta },
      refs: { field: 'retainageTotal', tab: 'summary' },
    });

    if (prior?.retainageTotal != null && claimedRetainage < prior.retainageTotal - tol) {
      // Retainage going down means previously withheld money is being billed. That is fine when the
      // contract's own terms or a recorded release account for it, and a red flag when nothing does.
      const authorised = prior.retainageTotal - expectedRetainage; // how far the contract lets it fall
      const billed = prior.retainageTotal - claimedRetainage;
      const explained = authorised > 0 && billed <= authorised + tol;
      checks.push({
        code: 'ret.release',
        subjectKey: '',
        category: 'retainage',
        severity: 'warning',
        outcome: explained ? 'pass' : 'fail',
        title: explained ? 'Retainage released per the contract' : 'Retainage held would go down',
        detail: explained
          ? `Retainage goes from ${$(prior.retainageTotal)} after the last approved application to ${$(claimedRetainage)}, paying out ${$(billed)}. The contract’s retainage terms and recorded releases allow up to ${$(authorised)}.`
          : `Retainage was ${$(prior.retainageTotal)} after the last approved application and is ${$(claimedRetainage)} on this one. That bills ${$(billed)} of previously withheld retainage` +
            (authorised > 0 ? `, but the contract’s terms and recorded releases only account for ${$(authorised)}.` : ', and no release or reduced rate is recorded on the contract.'),
        action: explained ? undefined : 'Confirm a release was authorised. If it was, record it on the contract; the verified payment then includes it.',
        data: { expected: prior.retainageTotal, actual: claimedRetainage, delta: claimedRetainage - prior.retainageTotal },
        refs: { field: 'retainageTotal', tab: 'summary' },
      });
    }
  }

  // ── 10. The bottom line ────────────────────────────────────────────────────

  if (claimed.currentPaymentDue !== null && input.sov.length > 0 && !noHistory) {
    const ok = near(claimed.currentPaymentDue, currentPaymentDue);
    const delta = claimed.currentPaymentDue - currentPaymentDue;
    checks.push({
      code: 'pay.current_due',
      subjectKey: '',
      category: 'payment',
      severity: 'blocking',
      outcome: ok ? 'pass' : 'fail',
      title: ok
        ? 'Requested payment matches the verified amount'
        : `Requested payment is ${$(Math.abs(delta))} ${delta > 0 ? 'more' : 'less'} than the verified amount`,
      detail: ok
        ? `${$(currentPaymentDue)} is due this period based on the contract, approved change orders and billing history.`
        : `The subcontractor requests ${$(claimed.currentPaymentDue)}. Recomputed from the contract, approved change orders, approved billing history and this period’s line items, ${$(currentPaymentDue)} is due. The items above explain the difference.`,
      action: ok ? undefined : 'Resolve the items above so the amounts agree, or accept this item to approve at the verified amount.',
      data: { expected: currentPaymentDue, actual: claimed.currentPaymentDue, delta },
      refs: { field: 'currentPaymentDue', tab: 'summary' },
    });
  }
  if (input.sov.length > 0 && !noHistory && currentPaymentDue <= 0 && input.lines.length > 0) {
    checks.push({
      code: 'pay.not_positive',
      subjectKey: '',
      category: 'payment',
      severity: 'warning',
      outcome: 'fail',
      title: currentPaymentDue === 0 ? 'Nothing is due on this application' : 'The verified amount is negative',
      detail: `The verified payment is ${$(currentPaymentDue)}. ${currentPaymentDue < 0 ? 'More has been certified than has been earned to date.' : ''}`.trim(),
      action: 'Confirm this is expected before approving.',
      refs: { field: 'currentPaymentDue', tab: 'summary' },
    });
  }

  // ── 11. Lien waivers ───────────────────────────────────────────────────────

  checks.push(
    ...evaluateWaivers({
      policy,
      projectState: input.project.state,
      subcontractorName: input.subcontractor.name,
      applicationNumber: app.applicationNumber,
      periodTo: app.periodTo,
      claimedPayment: claimed.currentPaymentDue,
      verifiedPayment: input.sov.length > 0 && !noHistory ? currentPaymentDue : null,
      priorPayment: prior?.kind === 'application' ? prior.currentPaymentDue : null,
      hasWaiverDocument: hasType('lien_waiver'),
      waivers: input.waivers,
      tolerance: tol,
    }),
  );

  return { verified, lines: verifiedLines, checks };
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function addDays(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function humanKey(key: string): string {
  return key.replace(/([A-Z])/g, ' $1').toLowerCase();
}

/** "3", "3 and 5", "2–4 and 7". */
function listNumbers(ns: number[]): string {
  const sorted = [...new Set(ns)].sort((a, b) => a - b);
  const parts: string[] = [];
  for (let i = 0; i < sorted.length; ) {
    let j = i;
    while (j + 1 < sorted.length && sorted[j + 1] === sorted[j]! + 1) j++;
    // Three or more in a row read better as a range.
    if (j - i >= 2) parts.push(`${sorted[i]}–${sorted[j]}`);
    else for (let k = i; k <= j; k++) parts.push(`${sorted[k]}`);
    i = j + 1;
  }
  return parts.length <= 1 ? parts.join('') : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}

/** "schedule of values", for use inside a sentence. */
function docTypeName(t: DocType): string {
  return DOC_TYPE_LABEL[t].replace(/\s*\(.*\)$/, '').toLowerCase();
}

const GRAND_TOTAL_COLUMN: Record<LineAmountField, string> = {
  scheduledValue: 'scheduled value (C)',
  previous: 'previous applications (D)',
  thisPeriod: 'this period (E)',
  stored: 'materials stored (F)',
  total: 'completed and stored to date (G)',
  balance: 'balance to finish (H)',
  retainage: 'retainage',
};

/**
 * If the gap between billed and approved change orders is exactly one or two
 * pending change orders, name them — that is almost always the explanation.
 */
function explainWithPending(
  delta: number,
  pending: Array<{ number: string; title: string; amount: number }>,
  tol: number,
): string | null {
  const label = (c: { number: string; title: string; amount: number }) =>
    `pending change order ${c.number} “${c.title}” (${formatMoney(c.amount)})`;
  for (const a of pending) if (Math.abs(a.amount - delta) <= tol) return label(a);
  for (let i = 0; i < pending.length; i++) {
    for (let j = i + 1; j < pending.length; j++) {
      if (Math.abs(pending[i]!.amount + pending[j]!.amount - delta) <= tol) return `${label(pending[i]!)} and ${label(pending[j]!)}`;
    }
  }
  return null;
}
