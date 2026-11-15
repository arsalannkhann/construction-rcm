/**
 * Compares one reader result with its ground truth, value by value.
 *
 * Every scored value lands in exactly one bucket:
 *   correct    the value matches the truth (amounts to the cent).
 *   abstained  the reader returned nothing (null, or "unclear" for yes/no). Safe: a person keys it.
 *   flagged    the value is wrong, but its confidence is below the review threshold, so the
 *              product puts it in front of a person. Safe.
 *   wrong      the value is wrong and its confidence is at or above the threshold. DANGEROUS:
 *              nothing downstream asks a person to look at it.
 *
 * The threshold is the product's own: values below `lowConfidenceThreshold`
 * are raised as "read with low confidence" findings during reconciliation.
 */
import type { ExtractOutcome } from '@/server/documents/extract';
import { printedPageGaps, type NumberingGap } from '@/server/documents/integrity';
import { CLAIMED_FIELDS, DEFAULT_ORG_SETTINGS, LINE_AMOUNT_FIELDS, type ExtractedLine, type ExtractedWaiver, type ExtractionResult, type LineAmountField } from '@/server/types';
import { expectedOutcome, matchesAbstain, type Flag, type Outcome, type Truth, type TruthLine, type TruthWaiver } from './truth';

export const HIGH_CONFIDENCE = DEFAULT_ORG_SETTINGS.lowConfidenceThreshold;

export type Bucket = 'correct' | 'abstained' | 'flagged' | 'wrong';
export type FieldGroup = 'pageType' | 'header' | 'identity' | 'line' | 'lineTotal' | 'waiver';

export type Scored = {
  group: FieldGroup;
  /** Field name within its group, e.g. `currentPaymentDue`, `thisPeriod`, `amount`, `row`. */
  field: string;
  /** Where in the result, e.g. `payApp.amounts.currentPaymentDue`, `lines.3.thisPeriod`. */
  path: string;
  expected: unknown;
  actual: unknown;
  confidence: number | null;
  bucket: Bucket;
  /** The truth is "not printed" (null). */
  absent: boolean;
  /** The truth file says declining is the right behaviour for this value. */
  expectedAbstain: boolean;
};

export type FlagCheck = { flag: Flag; met: boolean; how: string | null };

export type CaseScore = {
  caseId: string;
  file: string;
  /** Engine that produced the result (null when nothing could be read). */
  engine: string | null;
  status: ExtractOutcome['status'];
  detail: string | null;
  expectedOutcome: Outcome;
  outcomeMet: boolean;
  items: Scored[];
  rows: { expected: number; read: number; matched: number };
  flags: FlagCheck[];
  /** Conflicts the reader reported that the truth does not expect. */
  unexpectedConflicts: string[];
  notePatterns: Array<{ pattern: string; met: boolean }>;
  knownLimitation: string | null;
  notes: string[];
  durationMs: number;
};

// ── Comparing values ────────────────────────────────────────────────────────

export function normaliseText(s: string): string {
  return s
    .normalize('NFKC')
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—−]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[.,;:]+$/, '')
    .toLowerCase();
}

const isNone = (s: string) => /^(none|n\/?a|nil|no exceptions?|-+)$/.test(normaliseText(s));

function bucketFor(expected: unknown, actual: unknown, confidence: number | null, equal: (a: unknown, b: unknown) => boolean): Bucket {
  const high = (confidence ?? 0) >= HIGH_CONFIDENCE;
  if (actual === null || actual === undefined) return expected === null ? 'correct' : 'abstained';
  if (expected === null) return high ? 'wrong' : 'flagged';
  if (equal(expected, actual)) return 'correct';
  return high ? 'wrong' : 'flagged';
}

const same = (a: unknown, b: unknown) => a === b;
const sameText = (a: unknown, b: unknown) => typeof a === 'string' && typeof b === 'string' && normaliseText(a) === normaliseText(b);

type Ctx = { truth: Truth; items: Scored[] };

function score(ctx: Ctx, group: FieldGroup, field: string, path: string, expected: unknown, actual: unknown, confidence: number | null, equal = same) {
  if (expected === undefined) return; // not in the truth file: not scored
  const bucket = bucketFor(expected, actual, confidence, equal);
  ctx.items.push({ group, field, path, expected, actual: actual ?? null, confidence, bucket, absent: expected === null, expectedAbstain: matchesAbstain(ctx.truth, path) });
}

/** yes/no. "unclear" is an abstention. */
function scoreTri(ctx: Ctx, group: FieldGroup, field: string, path: string, expected: 'yes' | 'no' | undefined, actual: { value: string | null; confidence: number } | undefined) {
  const v = actual?.value === 'unclear' ? null : (actual?.value ?? null);
  score(ctx, group, field, path, expected, v, actual?.confidence ?? null);
}

/**
 * Waiver exceptions. Downstream, a missing value means "no exceptions", so a
 * waiver whose exceptions were not read looks clean: a miss here is dangerous
 * whatever the confidence. A false "exceptions" reading only causes a review,
 * so it is safe.
 */
function scoreExceptions(ctx: Ctx, path: string, expected: string[] | null | undefined, actual: { value: string | null; confidence: number } | undefined) {
  if (expected === undefined) return;
  const got = actual?.value?.trim() || null;
  const listed = got !== null && !isNone(got);
  let bucket: Bucket;
  if (expected === null || expected.length === 0) bucket = listed ? 'flagged' : 'correct';
  else if (!listed) bucket = 'wrong';
  else bucket = expected.every((e) => normaliseText(got!).includes(normaliseText(e))) ? 'correct' : (actual!.confidence >= HIGH_CONFIDENCE ? 'wrong' : 'flagged');
  ctx.items.push({ group: 'waiver', field: 'exceptions', path, expected: expected && expected.length ? expected : null, actual: got, confidence: actual?.confidence ?? null, bucket, absent: !expected || expected.length === 0, expectedAbstain: matchesAbstain(ctx.truth, path) });
}

// ── Lines ───────────────────────────────────────────────────────────────────

function matchRows(truth: TruthLine[], read: ExtractedLine[]): Array<[number, number]> {
  const pairs: Array<{ t: number; r: number; s: number; d: number }> = [];
  truth.forEach((t, ti) =>
    read.forEach((r, ri) => {
      const item = t.itemNo && r.itemNo && normaliseText(t.itemNo) === normaliseText(r.itemNo);
      const td = t.description ? normaliseText(t.description) : null;
      const rd = r.description ? normaliseText(r.description) : null;
      const desc = td && rd && td === rd;
      const prefix = td && rd && rd.length >= 6 && (td.startsWith(rd) || rd.startsWith(td));
      if (!item && !desc && !prefix) return;
      const s = (item ? 4 : 0) + (desc ? 2 : prefix ? 1 : 0) + (t.scheduledValue !== undefined && t.scheduledValue === r.scheduledValue ? 1 : 0);
      pairs.push({ t: ti, r: ri, s, d: Math.abs(ti - ri) });
    }),
  );
  pairs.sort((a, b) => b.s - a.s || a.d - b.d);
  const usedT = new Set<number>();
  const usedR = new Set<number>();
  const out: Array<[number, number]> = [];
  for (const p of pairs) {
    if (usedT.has(p.t) || usedR.has(p.r)) continue;
    usedT.add(p.t);
    usedR.add(p.r);
    out.push([p.t, p.r]);
  }
  return out;
}

const rowLabel = (l: { itemNo?: string | null; description?: string | null }) => [l.itemNo, l.description].filter(Boolean).join(' ') || '(unlabelled row)';

function scoreLines(ctx: Ctx, truth: TruthLine[] | null | undefined, read: ExtractedLine[] | undefined): CaseScore['rows'] {
  if (truth === undefined) return { expected: 0, read: read?.length ?? 0, matched: 0 };
  const lines = read ?? [];
  const t = truth ?? [];
  const pairs = matchRows(t, lines);
  const byTruth = new Map(pairs.map(([ti, ri]) => [ti, ri]));
  const matchedRead = new Set(pairs.map(([, ri]) => ri));
  t.forEach((tl, ti) => {
    const ri = byTruth.get(ti);
    const r = ri === undefined ? undefined : lines[ri];
    const conf = r ? r.confidence : null;
    score(ctx, 'line', 'row', `lines.${ti}`, rowLabel(tl), r ? rowLabel(r) : null, conf, () => true);
    score(ctx, 'line', 'itemNo', `lines.${ti}.itemNo`, tl.itemNo, r?.itemNo ?? null, conf, sameText);
    score(ctx, 'line', 'description', `lines.${ti}.description`, tl.description, r?.description ?? null, conf, sameText);
    for (const f of LINE_AMOUNT_FIELDS) score(ctx, 'line', f, `lines.${ti}.${f}`, tl[f], r ? r[f] : null, conf);
  });
  // Rows the reader reported that are not on the schedule (a subtotal read as a line, a second
  // schedule's rows): a high-confidence one would be counted twice downstream.
  lines.forEach((r, ri) => {
    if (matchedRead.has(ri)) return;
    ctx.items.push({ group: 'line', field: 'row', path: `lines.extra.${ri}`, expected: null, actual: rowLabel(r), confidence: r.confidence, bucket: r.confidence >= HIGH_CONFIDENCE ? 'wrong' : 'flagged', absent: true, expectedAbstain: false });
  });
  return { expected: t.length, read: lines.length, matched: pairs.length };
}

// ── Waivers ─────────────────────────────────────────────────────────────────

function scoreWaivers(ctx: Ctx, truth: TruthWaiver[] | undefined, read: ExtractedWaiver[] | undefined) {
  if (truth === undefined) return;
  const ws = read ?? [];
  const used = new Set<number>();
  const pairs: Array<[TruthWaiver, ExtractedWaiver | undefined, number]> = truth.map((tw, i) => {
    let idx = ws.findIndex((w, j) => !used.has(j) && w.page === tw.page);
    if (idx >= 0) used.add(idx);
    else idx = -1;
    return [tw, idx >= 0 ? ws[idx] : undefined, i];
  });
  for (const [tw, w, i] of pairs) {
    const p = `waivers.${i}`;
    score(ctx, 'waiver', 'waiver', p, `waiver on page ${tw.page}`, w ? `waiver on page ${w.page}` : null, w ? Math.max(w.waiverType.confidence, w.amount.confidence) : null, () => true);
    score(ctx, 'waiver', 'waiverType', `${p}.waiverType`, tw.waiverType, w?.waiverType.value === 'unknown' && tw.waiverType !== 'unknown' ? null : (w?.waiverType.value ?? null), w?.waiverType.confidence ?? null);
    score(ctx, 'waiver', 'formState', `${p}.formState`, tw.formState, w?.formState.value ?? null, w?.formState.confidence ?? null);
    score(ctx, 'waiver', 'claimant', `${p}.claimant`, tw.claimant, w?.claimant.value ?? null, w?.claimant.confidence ?? null, sameText);
    score(ctx, 'waiver', 'customer', `${p}.customer`, tw.customer, w?.customer.value ?? null, w?.customer.confidence ?? null, sameText);
    score(ctx, 'waiver', 'owner', `${p}.owner`, tw.owner, w?.owner.value ?? null, w?.owner.confidence ?? null, sameText);
    score(ctx, 'waiver', 'throughDate', `${p}.throughDate`, tw.throughDate, w?.throughDate.value ?? null, w?.throughDate.confidence ?? null);
    score(ctx, 'waiver', 'amount', `${p}.amount`, tw.amount, w?.amount.value ?? null, w?.amount.confidence ?? null);
    scoreExceptions(ctx, `${p}.exceptions`, tw.exceptions, w?.exceptions);
    scoreTri(ctx, 'waiver', 'signed', `${p}.signed`, tw.signed, w?.signed);
  }
  // A waiver the reader found where there is none (a cover letter that mentions one, say).
  ws.forEach((w, j) => {
    if (used.has(j)) return;
    const conf = Math.max(w.waiverType.confidence, w.amount.confidence);
    ctx.items.push({ group: 'waiver', field: 'waiver', path: `waivers.extra.${j}`, expected: null, actual: `waiver on page ${w.page}`, confidence: conf, bucket: conf >= HIGH_CONFIDENCE ? 'wrong' : 'flagged', absent: true, expectedAbstain: false });
  });
}

// ── Flags ───────────────────────────────────────────────────────────────────

/** Page-number gaps visible in the result: for each "of y", numbers 1..y that were not seen. */
/** Gaps in the printed page numbering, by the same rule reconciliation uses. */
export function numberingGaps(result: ExtractionResult | null): NumberingGap[] {
  return printedPageGaps(result?.pageNumbering ?? []);
}

function checkFlag(flag: Flag, outcome: ExtractOutcome): FlagCheck {
  const r = outcome.result;
  const conflict = (kind: string) => {
    const c = r?.conflicts?.find((x) => x.kind === kind);
    return { flag, met: !!c, how: c ? `conflicts: ${c.kind} (${c.field})` : null };
  };
  switch (flag) {
    case 'missing_page': {
      const gaps = numberingGaps(r);
      if (gaps.length > 0) return { flag, met: true, how: `page numbering gap: ${gaps.map((g) => `${g.missing.join(', ')} of ${g.of}`).join('; ')}` };
      const printed = r?.scheduleGrandTotal?.values ?? r?.lineTotals;
      if (printed && r?.lines) {
        for (const f of LINE_AMOUNT_FIELDS) {
          const want = printed[f];
          if (want === null || want === undefined) continue;
          const sum = r.lines.reduce((a, l) => a + (l[f] ?? 0), 0);
          if (sum !== want) return { flag, met: true, how: `rows do not add up to the printed grand total (${f})` };
        }
      }
      return { flag, met: false, how: null };
    }
    case 'total_conflict':
      return conflict('total');
    case 'application_number_conflict':
      return conflict('application_number');
    case 'second_pay_application':
      return conflict('second_pay_application');
    case 'unreadable_page': {
      if (outcome.status === 'unreadable') return { flag, met: true, how: 'file reported unreadable' };
      const pages = r?.unreadablePages ?? [];
      return { flag, met: pages.length > 0, how: pages.length ? `unreadable pages: ${pages.join(', ')}` : null };
    }
  }
}

const CONFLICT_FLAG: Record<string, Flag> = { total: 'total_conflict', application_number: 'application_number_conflict', second_pay_application: 'second_pay_application' };

// ── One case ────────────────────────────────────────────────────────────────

export function scoreCase(input: { caseId: string; file: string; truth: Truth; outcome: ExtractOutcome; engineKey: string }): CaseScore {
  const { truth, outcome } = input;
  const ctx: Ctx = { truth, items: [] };
  const r = outcome.result;

  // Document type, page by page.
  for (const d of truth.documents ?? []) {
    for (let page = d.pageStart; page <= d.pageEnd; page++) {
      const seg = r?.segments.find((s) => page >= s.pageStart && page <= s.pageEnd);
      score(ctx, 'pageType', 'page', `pages.${page}`, d.type, seg?.type ?? null, seg?.confidence ?? null);
    }
  }

  if (truth.payApp !== undefined) {
    const t = truth.payApp;
    const p = r?.payApp;
    const val = <K extends keyof NonNullable<typeof t>>(k: K) => (t === null ? null : t[k]);
    for (const f of CLAIMED_FIELDS) {
      const want = t === null ? null : t.amounts?.[f];
      score(ctx, 'header', f, `payApp.amounts.${f}`, want, p?.amounts[f].value ?? null, p?.amounts[f].confidence ?? null);
    }
    score(ctx, 'identity', 'applicationNumber', 'payApp.applicationNumber', val('applicationNumber'), p?.applicationNumber.value ?? null, p?.applicationNumber.confidence ?? null);
    for (const k of ['periodTo', 'applicationDate', 'contractDate'] as const) score(ctx, 'identity', k, `payApp.${k}`, val(k), p?.[k].value ?? null, p?.[k].confidence ?? null);
    for (const k of ['projectName', 'projectNumber', 'contractorName', 'toName', 'contractNumber'] as const) score(ctx, 'identity', k, `payApp.${k}`, val(k), p?.[k].value ?? null, p?.[k].confidence ?? null, sameText);
    scoreTri(ctx, 'identity', 'signed', 'payApp.signed', t === null ? undefined : t.signed, p?.signed);
    scoreTri(ctx, 'identity', 'notarized', 'payApp.notarized', t === null ? undefined : t.notarized, p?.notarized);
  }

  const rows = scoreLines(ctx, truth.lines, r?.lines);

  if (truth.lineTotals !== undefined) {
    const printed = r?.scheduleGrandTotal?.values ?? r?.lineTotals;
    const conf = r?.scheduleGrandTotal?.confidence ?? (r?.lineTotals ? 0.9 : null);
    for (const f of LINE_AMOUNT_FIELDS) {
      const want = truth.lineTotals === null ? null : truth.lineTotals[f as LineAmountField];
      score(ctx, 'lineTotal', f, `lineTotals.${f}`, want, printed?.[f] ?? null, conf);
    }
  }

  scoreWaivers(ctx, truth.waivers, r?.waivers);

  const expected = expectedOutcome(truth, input.engineKey);
  const flags = (truth.expect?.flags ?? []).map((f) => checkFlag(f, outcome));
  const wantFlags = new Set(truth.expect?.flags ?? []);
  const unexpectedConflicts = (r?.conflicts ?? []).filter((c) => !wantFlags.has(CONFLICT_FLAG[c.kind]!)).map((c) => `${c.kind} (${c.field})`);
  const allNotes = [...(r?.notes ?? []), ...(outcome.detail ? [outcome.detail] : [])];
  const notePatterns = (truth.expect?.notes ?? []).map((pattern) => ({ pattern, met: allNotes.some((n) => new RegExp(pattern, 'i').test(n)) }));

  return {
    caseId: input.caseId,
    file: input.file,
    engine: outcome.engine,
    status: outcome.status,
    detail: outcome.detail,
    expectedOutcome: expected,
    outcomeMet: outcome.status === expected,
    items: ctx.items,
    rows,
    flags,
    unexpectedConflicts,
    notePatterns,
    knownLimitation: truth.expect?.knownLimitation ?? null,
    notes: allNotes,
    durationMs: outcome.durationMs,
  };
}

// ── A corpus ────────────────────────────────────────────────────────────────

export type Tally = { n: number; correct: number; abstained: number; flagged: number; wrong: number; absentN: number; absentCorrect: number; spuriousFlagged: number; spuriousWrong: number };
const emptyTally = (): Tally => ({ n: 0, correct: 0, abstained: 0, flagged: 0, wrong: 0, absentN: 0, absentCorrect: 0, spuriousFlagged: 0, spuriousWrong: 0 });

function add(t: Tally, s: Scored) {
  if (s.absent) {
    t.absentN++;
    if (s.bucket === 'correct') t.absentCorrect++;
    else if (s.bucket === 'wrong') t.spuriousWrong++;
    else if (s.bucket === 'flagged') t.spuriousFlagged++;
  } else {
    t.n++;
    t[s.bucket]++;
  }
}

export const CALIBRATION_BUCKETS: Array<[number, number]> = [
  [0, 0.5],
  [0.5, HIGH_CONFIDENCE],
  [HIGH_CONFIDENCE, 0.9],
  [0.9, 0.97],
  [0.97, 1.0001],
];

export type Miss = { caseId: string; path: string; expected: unknown; actual: unknown; confidence: number | null; bucket: Bucket | 'unmet'; expectedAbstain: boolean; limitation: boolean };

export type Summary = {
  cases: number;
  pages: number;
  outcomes: Record<string, number>;
  outcomesMet: number;
  groups: Record<FieldGroup, Tally>;
  fields: Record<string, Tally>;
  rows: { expected: number; read: number; matched: number };
  flags: { expected: number; met: number };
  notePatterns: { expected: number; met: number };
  unexpectedConflicts: number;
  /** Wrong values reported at or above the confidence threshold. */
  confidentlyWrong: number;
  /** Wrong values the product would put in front of a person, plus values the reader declined to give. */
  safe: { flagged: number; abstained: number };
  calibration: Array<{ from: number; to: number; reported: number; correct: number }>;
  misses: Miss[];
};

export function summarize(cases: CaseScore[]): Summary {
  const groups = Object.fromEntries((['pageType', 'header', 'identity', 'line', 'lineTotal', 'waiver'] as FieldGroup[]).map((g) => [g, emptyTally()])) as Record<FieldGroup, Tally>;
  const fields: Record<string, Tally> = {};
  const calibration = CALIBRATION_BUCKETS.map(([from, to]) => ({ from, to: Math.min(1, to), reported: 0, correct: 0 }));
  const misses: Miss[] = [];
  const outcomes: Record<string, number> = {};
  let pages = 0;
  for (const c of cases) {
    outcomes[c.status] = (outcomes[c.status] ?? 0) + 1;
    const limitation = !!c.knownLimitation;
    for (const s of c.items) {
      if (s.group === 'pageType') pages++;
      add(groups[s.group], s);
      const key = `${s.group}.${s.field}`;
      fields[key] ??= emptyTally();
      add(fields[key], s);
      if (s.actual !== null && s.confidence !== null) {
        const b = calibration.findIndex((_, i) => s.confidence! >= CALIBRATION_BUCKETS[i]![0] && s.confidence! < CALIBRATION_BUCKETS[i]![1]);
        if (b >= 0) {
          calibration[b]!.reported++;
          if (s.bucket === 'correct') calibration[b]!.correct++;
        }
      }
      if (s.bucket !== 'correct') misses.push({ caseId: c.caseId, path: s.path, expected: s.expected, actual: s.actual, confidence: s.confidence, bucket: s.bucket, expectedAbstain: s.expectedAbstain, limitation });
    }
    if (!c.outcomeMet) misses.push({ caseId: c.caseId, path: 'outcome', expected: c.expectedOutcome, actual: c.status, confidence: null, bucket: 'unmet', expectedAbstain: false, limitation });
    for (const f of c.flags) if (!f.met) misses.push({ caseId: c.caseId, path: `flag:${f.flag}`, expected: 'raised', actual: 'not raised', confidence: null, bucket: 'unmet', expectedAbstain: false, limitation });
    for (const n of c.notePatterns) if (!n.met) misses.push({ caseId: c.caseId, path: `note:/${n.pattern}/i`, expected: 'a matching note', actual: 'none', confidence: null, bucket: 'unmet', expectedAbstain: false, limitation });
  }
  const all = Object.values(groups);
  return {
    cases: cases.length,
    pages,
    outcomes,
    outcomesMet: cases.filter((c) => c.outcomeMet).length,
    groups,
    fields,
    rows: cases.reduce((a, c) => ({ expected: a.expected + c.rows.expected, read: a.read + c.rows.read, matched: a.matched + c.rows.matched }), { expected: 0, read: 0, matched: 0 }),
    flags: { expected: cases.reduce((a, c) => a + c.flags.length, 0), met: cases.reduce((a, c) => a + c.flags.filter((f) => f.met).length, 0) },
    notePatterns: { expected: cases.reduce((a, c) => a + c.notePatterns.length, 0), met: cases.reduce((a, c) => a + c.notePatterns.filter((n) => n.met).length, 0) },
    unexpectedConflicts: cases.reduce((a, c) => a + c.unexpectedConflicts.length, 0),
    confidentlyWrong: all.reduce((a, t) => a + t.wrong + t.spuriousWrong, 0),
    safe: { flagged: all.reduce((a, t) => a + t.flagged + t.spuriousFlagged, 0), abstained: all.reduce((a, t) => a + t.abstained, 0) },
    calibration,
    misses,
  };
}

/** Share of present values read correctly. null when there is nothing to measure. */
export const accuracy = (t: Tally): number | null => (t.n === 0 ? null : t.correct / t.n);
