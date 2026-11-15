/**
 * The ground-truth format for evaluating document readers.
 *
 * One truth file describes one document file: what is printed on it, page by
 * page, as a careful person would key it. It sits beside the document as
 * `<document file name>.truth.json` (for example `payapp-07.pdf` and
 * `payapp-07.pdf.truth.json`). The full description, with an example, is in
 * docs/extraction-evaluation.md.
 *
 * Conventions:
 *   - Money is integer cents. 10350000 is $103,500.00. A credit is negative.
 *   - Dates are ISO (2026-10-31).
 *   - A field that is OMITTED is not scored (use this for anything you could
 *     not determine). A field that is `null` means "not printed on the
 *     document", and the right answer for a reader is null too.
 *   - Values are what the document says, including the subcontractor's own
 *     mistakes. Never correct a figure in the truth file.
 */
import * as z from 'zod';
import { CLAIMED_FIELDS, DOC_TYPES, LINE_AMOUNT_FIELDS, WAIVER_TYPES } from '@/server/types';

export const TRUTH_VERSION = 1;

const cents = z.number().int();
const iso = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'dates are ISO, e.g. 2026-10-31');
const text = z.string().min(1);
const yesNo = z.enum(['yes', 'no']);

/** What a reader must surface for this file, beyond the values themselves. */
export const FLAGS = [
  /** A page of the file is missing: the printed page numbering has a gap, or the schedule rows cannot add up to its printed grand total. */
  'missing_page',
  /** The pay application and the schedule print different figures for the same total. */
  'total_conflict',
  /** Two pages of the file state different application numbers. */
  'application_number_conflict',
  /** The file contains more than one pay application. */
  'second_pay_application',
  /** At least one page has no machine-readable text. */
  'unreadable_page',
] as const;
export type Flag = (typeof FLAGS)[number];

export const OUTCOMES = ['processed', 'unreadable', 'failed'] as const;
export type Outcome = (typeof OUTCOMES)[number];

const amounts = z.object(Object.fromEntries(CLAIMED_FIELDS.map((f) => [f, cents.nullable().optional()])) as Record<(typeof CLAIMED_FIELDS)[number], z.ZodOptional<z.ZodNullable<z.ZodNumber>>>).strict();
const lineAmounts = Object.fromEntries(LINE_AMOUNT_FIELDS.map((f) => [f, cents.nullable().optional()])) as Record<(typeof LINE_AMOUNT_FIELDS)[number], z.ZodOptional<z.ZodNullable<z.ZodNumber>>>;

export const TruthPayApp = z
  .object({
    applicationNumber: z.number().int().nullable().optional(),
    periodTo: iso.nullable().optional(),
    applicationDate: iso.nullable().optional(),
    projectName: text.nullable().optional(),
    projectNumber: text.nullable().optional(),
    contractorName: text.nullable().optional(),
    toName: text.nullable().optional(),
    contractNumber: text.nullable().optional(),
    contractDate: iso.nullable().optional(),
    amounts: amounts.optional(),
    /** Is the contractor's certification signed (by any means)? */
    signed: yesNo.optional(),
    /** How it is signed, when it is. `ink` covers wet ink and an image of a signature. */
    signatureMark: z.enum(['electronic', 'ink']).nullable().optional(),
    notarized: yesNo.optional(),
  })
  .strict();

export const TruthLine = z
  .object({
    itemNo: text.nullable().optional(),
    description: text.nullable().optional(),
    /** 1-based page of this file the row is printed on. */
    page: z.number().int().positive().optional(),
    ...lineAmounts,
  })
  .strict();

export const TruthWaiver = z
  .object({
    /** 1-based page of this file. */
    page: z.number().int().positive(),
    waiverType: z.enum(WAIVER_TYPES).optional(),
    /** The state whose statutory wording the waiver follows, or null if it follows none. */
    formState: z.enum(['TX', 'CA', 'FL']).nullable().optional(),
    claimant: text.nullable().optional(),
    customer: text.nullable().optional(),
    owner: text.nullable().optional(),
    throughDate: iso.nullable().optional(),
    amount: cents.nullable().optional(),
    /** Exceptions written into the waiver, one string per exception (a distinctive part of each is enough). null: none. */
    exceptions: z.array(text).nullable().optional(),
    signed: yesNo.optional(),
    signatureMark: z.enum(['electronic', 'ink']).nullable().optional(),
  })
  .strict();

export const Truth = z
  .object({
    version: z.literal(TRUTH_VERSION),
    description: z.string().optional(),
    tags: z.array(z.string()).optional(),
    /** Files that were submitted together share a package id. */
    package: z.string().optional(),
    pageCount: z.number().int().positive().optional(),
    /** The document type of every page, as ranges in page order. */
    documents: z.array(z.object({ type: z.enum(DOC_TYPES), pageStart: z.number().int().positive(), pageEnd: z.number().int().positive() }).strict()).optional(),
    /** The pay application the file is for (the first one, if it holds several). null: the file has none. */
    payApp: TruthPayApp.nullable().optional(),
    /** Every schedule-of-values line printed in the file, in order. Subtotal, carried-forward and grand-total rows are not lines. null: the file has no schedule. */
    lines: z.array(TruthLine).nullable().optional(),
    /** The grand-total row printed on the schedule, column by column. null: none is printed. */
    lineTotals: z.object(lineAmounts).strict().nullable().optional(),
    waivers: z.array(TruthWaiver).optional(),
    /** Every "page x of y" marking printed in the file. */
    pageNumbering: z.array(z.object({ page: z.number().int().positive(), number: z.number().int().positive(), of: z.number().int().positive().nullable() }).strict()).optional(),
    expect: z
      .object({
        /** What the reader should report for the file as a whole. Either one outcome, or one per engine (`text-layer`, `claude`). Default: processed. */
        outcome: z.union([z.enum(OUTCOMES), z.record(z.string(), z.enum(OUTCOMES))]).optional(),
        /** Conditions the reader's result must make visible. */
        flags: z.array(z.enum(FLAGS)).optional(),
        /**
         * Field paths where the right behaviour for a reader is to decline (null or low
         * confidence), e.g. an amount whose format is ambiguous. `*` matches any key or index:
         * `payApp.amounts.*`, `lines.*.thisPeriod`, `waivers.0.amount`.
         */
        abstain: z.array(z.string()).optional(),
        /** Regular expressions (case-insensitive); each must match at least one of the reader's notes. */
        notes: z.array(z.string()).optional(),
        /** A limitation of a reader that this case pins down, in words. Misses in such a case are still counted. */
        knownLimitation: z.string().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export type Truth = z.infer<typeof Truth>;
export type TruthPayApp = z.infer<typeof TruthPayApp>;
export type TruthLine = z.infer<typeof TruthLine>;
export type TruthWaiver = z.infer<typeof TruthWaiver>;

/** Validate a parsed truth file, with messages that say which field is wrong. */
export function parseTruth(json: unknown, where: string): Truth {
  const parsed = Truth.safeParse(json);
  if (parsed.success) return parsed.data;
  const issues = parsed.error.issues.map((i) => `  ${i.path.join('.') || '(top level)'}: ${i.message}`).join('\n');
  throw new Error(`${where} is not a valid truth file:\n${issues}`);
}

export function expectedOutcome(truth: Truth, engine: string): Outcome {
  const o = truth.expect?.outcome;
  if (!o) return 'processed';
  if (typeof o === 'string') return o;
  return o[engine] ?? 'processed';
}

/** Does `path` (like `lines.3.thisPeriod`) match one of the `abstain` patterns? */
export function matchesAbstain(truth: Truth, path: string): boolean {
  const parts = path.split('.');
  return (truth.expect?.abstain ?? []).some((pattern) => {
    const p = pattern.split('.');
    return p.length === parts.length && p.every((seg, i) => seg === '*' || seg === parts[i]);
  });
}
