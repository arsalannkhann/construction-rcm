/**
 * AI document understanding with Claude.
 *
 * Division of labour, chosen for financial safety:
 *   - The model TRANSCRIBES: it reports what is printed (amounts as text,
 *     exactly as written) and where. It is told never to compute or correct.
 *   - Our code PARSES and CHECKS: text → cents, dates → ISO, and every amount
 *     is looked up in the PDF's own text layer when one exists. A value the
 *     model reports that cannot be found on the page, or that disagrees with
 *     the deterministic reader, has its confidence cut and is called out.
 *
 * Verified in this repository against a stubbed client only. A live call needs
 * ANTHROPIC_API_KEY; see README, "What is and is not verified".
 */
import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import * as z from 'zod';
import { parseMoney } from '@/lib/money';
import { parseLooseDate } from '@/lib/utils';
import { JURISDICTIONS } from '@/server/compliance/jurisdictions';
import type {
  ClaimedField,
  Extracted,
  ExtractedLine,
  ExtractedPayApp,
  ExtractedWaiver,
  ExtractionResult,
  LineAmountField,
  Tri,
} from '@/server/types';
import { CLAIMED_FIELDS, CLAIMED_FIELD_LABEL, DOC_TYPES, LINE_AMOUNT_FIELDS, WAIVER_TYPES } from '@/server/types';
import { AMOUNT_LABELS, extractFromText, locateAmount, pageFacts } from './engine-text';
import type { PdfText } from './pdf-text';

export const CLAUDE_ENGINE = 'claude';

// ── What we ask the model to return ─────────────────────────────────────────

const confidence = z.enum(['high', 'medium', 'low']);
const value = z.object({
  text: z.string().nullable().describe('The value exactly as printed. null if blank, absent or illegible.'),
  page: z.number().int().nullable().describe('1-based page number within this file where the value appears.'),
  confidence,
});
const tri = z.object({
  value: z.enum(['yes', 'no', 'unclear']),
  page: z.number().int().nullable(),
  confidence,
});
const SNAKE: Record<ClaimedField, string> = {
  originalContractSum: 'original_contract_sum',
  netChangeOrders: 'net_change_orders',
  contractSumToDate: 'contract_sum_to_date',
  totalCompletedStored: 'total_completed_stored',
  retainageWork: 'retainage_work',
  retainageStored: 'retainage_stored',
  retainageTotal: 'retainage_total',
  totalEarnedLessRetainage: 'total_earned_less_retainage',
  lessPreviousCertificates: 'less_previous_certificates',
  currentPaymentDue: 'current_payment_due',
  balanceToFinish: 'balance_to_finish',
};

const amounts = z.object({
  original_contract_sum: value,
  net_change_orders: value,
  contract_sum_to_date: value,
  total_completed_stored: value,
  retainage_work: value,
  retainage_stored: value,
  retainage_total: value,
  total_earned_less_retainage: value,
  less_previous_certificates: value,
  current_payment_due: value,
  balance_to_finish: value,
});

const amountText = z.string().nullable();

export const ModelOutput = z.object({
  segments: z
    .array(z.object({ type: z.enum(DOC_TYPES), page_start: z.number().int(), page_end: z.number().int(), confidence }))
    .describe('Every page of the file assigned to exactly one segment, in page order.'),
  pay_application: z
    .object({
      application_number: value,
      period_to: value,
      application_date: value,
      project_name: value,
      project_number: value,
      contractor_name: value.describe('The party requesting payment (the subcontractor).'),
      to_name: value.describe('The party the application is addressed to.'),
      contract_number: value,
      contract_date: value,
      amounts,
      signed: tri.describe('Is the contractor certification signed?'),
      signer_name: value,
      notarized: tri,
    })
    .nullable(),
  line_items: z.array(
    z.object({
      item_no: z.string().nullable(),
      description: z.string().nullable(),
      scheduled_value: amountText,
      previous: amountText.describe('Work completed from previous application (column D).'),
      this_period: amountText.describe('Work completed this period (column E).'),
      stored: amountText.describe('Materials presently stored (column F).'),
      total: amountText.describe('Total completed and stored to date (column G).'),
      balance: amountText.describe('Balance to finish (column H).'),
      retainage: amountText.describe('Retainage (column I), if the sheet has that column.'),
      page: z.number().int(),
      confidence,
    }),
  ),
  line_totals: z
    .object({ scheduled_value: amountText, previous: amountText, this_period: amountText, stored: amountText, total: amountText, balance: amountText, retainage: amountText })
    .nullable()
    .describe('The grand-total row printed on the schedule, if any.'),
  lien_waivers: z.array(
    z.object({
      page: z.number().int(),
      waiver_type: z.enum(WAIVER_TYPES),
      waiver_type_confidence: confidence,
      statutory_form_state: z.enum(['TX', 'CA', 'FL', 'none']),
      title: value,
      claimant: value,
      customer: value,
      owner: value,
      job_description: value,
      through_date: value,
      amount: value,
      exceptions: value.describe('Exceptions or carve-outs written into the waiver beyond its pre-printed form text. null if none.'),
      signed: tri,
      signer_name: value,
      signer_title: value,
      signed_date: value,
      notarized: tri,
    }),
  ),
  notes: z.array(z.string()).describe('Anything illegible, ambiguous, cut off or internally contradictory, in plain language.'),
});
export type ModelOutput = z.infer<typeof ModelOutput>;

const formHints = Object.values(JURISDICTIONS)
  .map((j) => `- ${j.state}: ${j.statute}. Progress-payment form title: “${j.forms.conditional_progress?.title}”.`)
  .join('\n');

export const SYSTEM_PROMPT = `You read subcontractor billing documents for a US general contractor's finance team: applications for payment (AIA G702 style), continuation sheets / schedules of values (AIA G703 style), lien waivers, invoices, change orders and similar. A file may contain several of these one after another. Your output feeds a financial reconciliation system, and a person will review it against the original document.

Your job is transcription, not judgement. The system does all arithmetic and all comparison itself, and it does them better when it receives exactly what is on the page — including the mistakes. A subcontractor's arithmetic error or inconsistent figure is precisely what the reviewers need to see, so:

- Report every amount exactly as printed, as text, including thousands separators, decimals, a leading minus or accounting parentheses. Do not add, round, reformat, correct or reconcile anything.
- Report dates and names as printed.
- If a value is blank, missing, cut off or illegible, return null for it with low confidence and say what the problem is in notes. A null that a person fills in is far better than a plausible-looking value that is wrong. Do not infer a value from other fields.
- Give the 1-based page number, within this file, where each value appears.
- Confidence: high when the value is clearly legible and unambiguous; medium when legible but you had to choose between candidates or the print is poor; low when you are unsure.

Segments: assign every page to one segment by document type. Consecutive pages of the same document form one segment; each lien waiver is its own segment.

Pay application: the summary lines are usually numbered 1–9 (original contract sum; net change by change orders; contract sum to date; total completed and stored to date; retainage, often split into a part on completed work and a part on stored material, plus a total; total earned less retainage; less previous certificates for payment; current payment due; balance to finish including retainage). Some forms word these differently. Take each from its own line, not from a change-order summary table elsewhere on the page.

Schedule of values: one entry per line item, in order, across all its pages. Skip heading rows and subtotal rows; report the grand-total row separately. Leave a cell null when it is blank on the sheet.

Signatures: "yes" only when you can see a signature — ink, a stamp, or an electronic signature block. A blank signature line is "no". If the area is unreadable or you cannot tell, "unclear".

Lien waivers: classify as conditional or unconditional, and progress or final, from the document's own wording; use "unknown" if it does not say. Set statutory_form_state only when the wording follows that state's statutory form, otherwise "none":
${formHints}
Do not offer any view on whether a waiver is valid or enforceable.`;

// ── Convert the model's answer into our extraction shape ────────────────────

const CONF = { high: 0.95, medium: 0.75, low: 0.4 } as const;
type Val = z.infer<typeof value>;

function asText(v: Val): Extracted<string> {
  const text = v.text?.trim() || null;
  if (!text) return { value: null, confidence: 0, page: v.page };
  return { value: text, confidence: CONF[v.confidence], page: v.page, source: text };
}

function asDate(v: Val, notes: string[], what: string): Extracted<string> {
  const text = v.text?.trim() || null;
  if (!text) return { value: null, confidence: 0, page: v.page };
  const iso = parseLooseDate(text);
  if (!iso) {
    notes.push(`The ${what} was read as “${text}”, which is not a recognisable date.`);
    return { value: null, confidence: 0.2, page: v.page, source: text };
  }
  return { value: iso, confidence: CONF[v.confidence], page: v.page, source: text };
}

function asTri(t: z.infer<typeof tri>): Extracted<Tri> {
  return { value: t.value, confidence: CONF[t.confidence], page: t.page };
}

function asAmount(v: Val, notes: string[], what: string): Extracted<number> {
  const text = v.text?.trim() || null;
  if (!text) return { value: null, confidence: 0, page: v.page };
  const cents = parseMoney(text);
  if (cents === null) {
    notes.push(`${what} was read as “${text}”, which is not a clean amount. Enter it by hand.`);
    return { value: null, confidence: 0.2, page: v.page, source: text };
  }
  return { value: cents, confidence: CONF[v.confidence], page: v.page, source: text };
}

const lineAmount = (text: string | null): number | null => (text?.trim() ? parseMoney(text) : null);

/**
 * Turn a model answer into an ExtractionResult, grounding it against the PDF's
 * text layer when there is one.
 */
export function fromModelOutput(out: ModelOutput, model: string, pdf: PdfText | null): ExtractionResult {
  const notes = [...out.notes];
  const grounded = pdf?.hasTextLayer ? pdf : null;
  const second = grounded ? extractFromText(grounded) : null;
  const pageOf = (n: number | null) => (grounded && n && n >= 1 && n <= grounded.pages.length ? grounded.pages[n - 1]! : null);

  const result: ExtractionResult = {
    engine: CLAUDE_ENGINE,
    model,
    segments: out.segments.map((s) => ({ type: s.type, pageStart: s.page_start, pageEnd: s.page_end, confidence: CONF[s.confidence] })),
    notes,
  };

  /** Tie an amount to a position, and cross-check it with the deterministic reader. */
  const ground = (e: Extracted<number>, label: RegExp | undefined, what: string, other: Extracted<number> | undefined): Extracted<number> => {
    if (!grounded || e.value === null) return e;
    const preferred = pageOf(e.page);
    let hit = preferred ? locateAmount(preferred, e.value, label) : null;
    let page = e.page;
    if (!hit) {
      for (const candidate of grounded.pages) {
        hit = locateAmount(candidate, e.value, label);
        if (hit) {
          page = candidate.page;
          break;
        }
      }
    }
    let conf = e.confidence;
    if (!hit) {
      conf = Math.min(conf, 0.45);
      notes.push(`${what}: the amount read (${e.source}) does not appear anywhere in the document’s text. Verify it against the page.`);
    }
    if (other && other.value !== null && other.value !== e.value) {
      conf = Math.min(conf, 0.45);
      notes.push(`${what}: two readers disagree — AI read ${e.source}, the text layer shows ${other.source}. Verify it against the page.`);
    } else if (hit && other && other.value === e.value) {
      conf = Math.max(conf, 0.98);
    }
    return { ...e, page, confidence: conf, bbox: hit?.bbox ?? null };
  };

  if (out.pay_application) {
    const p = out.pay_application;
    const amountsOut = {} as Record<ClaimedField, Extracted<number>>;
    for (const field of CLAIMED_FIELDS) {
      const raw = (p.amounts as Record<string, Val>)[SNAKE[field]]!;
      const what = CLAIMED_FIELD_LABEL[field];
      amountsOut[field] = ground(asAmount(raw, notes, what), AMOUNT_LABELS[field].patterns[0], what, second?.payApp?.amounts[field]);
    }
    const appNo = p.application_number.text ? /\d{1,4}/.exec(p.application_number.text) : null;
    const payApp: ExtractedPayApp = {
      applicationNumber: appNo
        ? { value: Number(appNo[0]), confidence: CONF[p.application_number.confidence], page: p.application_number.page, source: p.application_number.text }
        : { value: null, confidence: 0, page: p.application_number.page },
      periodTo: asDate(p.period_to, notes, 'period end date'),
      applicationDate: asDate(p.application_date, notes, 'application date'),
      projectName: asText(p.project_name),
      projectNumber: asText(p.project_number),
      contractorName: asText(p.contractor_name),
      toName: asText(p.to_name),
      contractNumber: asText(p.contract_number),
      contractDate: asDate(p.contract_date, notes, 'contract date'),
      amounts: amountsOut,
      signed: asTri(p.signed),
      signerName: asText(p.signer_name),
      notarized: asTri(p.notarized),
    };
    // Borrow positions for non-amount fields from the deterministic reader when it found the same thing.
    if (second?.payApp) {
      for (const key of ['applicationNumber', 'periodTo', 'applicationDate', 'projectName', 'contractorName', 'contractNumber'] as const) {
        const mine = payApp[key] as Extracted<unknown>;
        const theirs = second.payApp[key] as Extracted<unknown>;
        if (mine.value !== null && theirs.value !== null && String(mine.value) === String(theirs.value)) mine.bbox = theirs.bbox ?? null;
      }
      if (payApp.signed.value === second.payApp.signed.value) payApp.signed.bbox = second.payApp.signed.bbox ?? null;
    }
    result.payApp = payApp;
  }

  if (out.line_items.length > 0 || out.segments.some((s) => s.type === 'continuation_sheet')) {
    const byItem = new Map<string, ExtractedLine>();
    for (const l of second?.lines ?? []) if (l.itemNo) byItem.set(l.itemNo, l);
    let disagreements = 0;
    result.lines = out.line_items.map((l) => {
      const line: ExtractedLine = {
        itemNo: l.item_no?.trim() || null,
        description: l.description?.trim() || null,
        page: l.page,
        confidence: CONF[l.confidence],
        scheduledValue: lineAmount(l.scheduled_value),
        previous: lineAmount(l.previous),
        thisPeriod: lineAmount(l.this_period),
        stored: lineAmount(l.stored),
        total: lineAmount(l.total),
        balance: lineAmount(l.balance),
        retainage: lineAmount(l.retainage),
      };
      const twin = line.itemNo ? byItem.get(line.itemNo) : undefined;
      if (twin) {
        line.bbox = twin.bbox ?? null;
        line.page = twin.page;
        const differs = LINE_AMOUNT_FIELDS.some((f: LineAmountField) => twin[f] !== null && line[f] !== null && twin[f] !== line[f]);
        if (differs) {
          disagreements++;
          line.confidence = Math.min(line.confidence, 0.45);
        } else {
          line.confidence = Math.max(line.confidence, 0.97);
        }
      }
      return line;
    });
    if (disagreements > 0) notes.push(`On ${disagreements} schedule line${disagreements === 1 ? '' : 's'} the AI reading and the text layer disagree. Those rows are marked low confidence; check them against the sheet.`);
    if (second?.lines && second.lines.length !== result.lines.length && second.lines.length > 0) {
      notes.push(`The AI read ${result.lines.length} schedule lines; the text layer has ${second.lines.length}. A row may have been missed or merged.`);
    }
    if (out.line_totals) {
      const t = out.line_totals;
      result.lineTotals = {
        scheduledValue: lineAmount(t.scheduled_value),
        previous: lineAmount(t.previous),
        thisPeriod: lineAmount(t.this_period),
        stored: lineAmount(t.stored),
        total: lineAmount(t.total),
        balance: lineAmount(t.balance),
        retainage: lineAmount(t.retainage),
      };
      // The printed grand-total row, tied to its place on the page when the text layer has the same row.
      const values = result.lineTotals;
      const theirs = second?.scheduleGrandTotal;
      const read = LINE_AMOUNT_FIELDS.filter((f) => values[f] !== null && values[f] !== undefined);
      if (read.length > 0) {
        const agrees = !!theirs && read.every((f) => theirs.values[f] === undefined || theirs.values[f] === null || theirs.values[f] === values[f]);
        if (theirs && !agrees) notes.push('The AI reading of the schedule’s grand-total row differs from the text layer. Check the totals row against the sheet.');
        result.scheduleGrandTotal = {
          page: theirs?.page ?? null,
          label: theirs?.label ?? null,
          bbox: agrees ? (theirs?.bbox ?? null) : null,
          confidence: !theirs ? (grounded ? 0.45 : 0.7) : agrees ? 0.97 : 0.45,
          values,
        };
      }
    }
  }

  // Facts only the text layer can establish: page numbers printed in the margins, and the same value printed
  // differently in two places. The AI's reading of the page images is not asked for these.
  if (grounded) {
    const facts = pageFacts(grounded);
    if (facts.pageNumbering.length > 0) result.pageNumbering = facts.pageNumbering;
    if (second?.conflicts?.length) {
      result.conflicts = second.conflicts;
      notes.push(`The text layer shows ${second.conflicts.length === 1 ? 'a value' : 'values'} printed differently in two places (${second.conflicts.map((c) => c.kind.replace(/_/g, ' ')).join(', ')}). See the findings.`);
    }
  }

  if (out.lien_waivers.length > 0) {
    result.waivers = out.lien_waivers.map((w): ExtractedWaiver => {
      const twin = second?.waivers?.find((x) => x.page === w.page);
      const amount = ground(asAmount(w.amount, notes, 'Lien waiver amount'), undefined, 'Lien waiver amount', twin?.amount);
      // Statutory-form recognition is a wording match; the deterministic matcher has the final say when text exists.
      let formState: Extracted<string> =
        w.statutory_form_state === 'none' ? { value: null, confidence: 0, page: w.page } : { value: w.statutory_form_state, confidence: 0.8, page: w.page };
      if (twin) formState = twin.formState;
      return {
        page: w.page,
        waiverType: { value: twin?.waiverType.value && twin.formState.value ? twin.waiverType.value : w.waiver_type, confidence: CONF[w.waiver_type_confidence], page: w.page, bbox: twin?.waiverType.bbox ?? null, source: w.title.text },
        formState,
        title: asText(w.title),
        claimant: asText(w.claimant),
        customer: asText(w.customer),
        owner: asText(w.owner),
        jobDescription: asText(w.job_description),
        throughDate: asDate(w.through_date, notes, 'waiver through date'),
        amount,
        exceptions: asText(w.exceptions),
        signed: asTri(w.signed),
        signerName: asText(w.signer_name),
        signerTitle: asText(w.signer_title),
        signedDate: asDate(w.signed_date, notes, 'waiver signature date'),
        notarized: asTri(w.notarized),
      };
    });
  }

  return result;
}

// ── The API call ────────────────────────────────────────────────────────────

const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);

export function claudeSupports(mimeType: string): boolean {
  return mimeType === 'application/pdf' || IMAGE_TYPES.has(mimeType);
}

export class ExtractionRefused extends Error {
  constructor(public category: string | null) {
    super('The AI model declined to read this document.');
    this.name = 'ExtractionRefused';
  }
}

export type ClaudeDeps = {
  apiKey: string;
  model: string;
  /** Injected in tests. */
  client?: Pick<Anthropic, 'beta'>;
  /** Stops the read (and any retries) when aborted. */
  signal?: AbortSignal;
};

export async function extractWithClaude(
  file: { filename: string; mimeType: string; bytes: Uint8Array },
  pdf: PdfText | null,
  deps: ClaudeDeps,
): Promise<ExtractionResult> {
  const client = deps.client ?? new Anthropic({ apiKey: deps.apiKey, maxRetries: 3 });
  const data = Buffer.from(file.bytes).toString('base64');
  const document: Anthropic.Beta.BetaContentBlockParam =
    file.mimeType === 'application/pdf'
      ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data } }
      : { type: 'image', source: { type: 'base64', media_type: file.mimeType as 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif', data } };

  // Server-side refusal fallback: if a safety classifier declines on the primary
  // model, the API retries on a fallback model in the same call. Billing
  // documents should never trip this, but an unread document is a worse outcome
  // than a read by a different model. Disable with RCM_EXTRACTION_FALLBACKS=off.
  const useFallbacks = process.env.RCM_EXTRACTION_FALLBACKS !== 'off';

  // Streaming, because a long schedule of values means a long response.
  const message = await client.beta.messages
    .stream({
      model: deps.model,
      max_tokens: 64000,
      thinking: { type: 'adaptive' },
      output_config: { effort: 'high', format: zodOutputFormat(ModelOutput) },
      ...(useFallbacks ? { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' as const } : {}),
      system: SYSTEM_PROMPT,
      messages: [
        {
          role: 'user',
          content: [document, { type: 'text', text: `File name: ${file.filename}\n\nRead this file and report what is printed on it.` }],
        },
      ],
    }, { signal: deps.signal })
    .finalMessage();

  if (message.stop_reason === 'refusal') throw new ExtractionRefused(message.stop_details?.category ?? null);
  if (message.stop_reason === 'max_tokens') throw new Error('The document was too long to read in one pass.');

  const text = message.content.find((b) => b.type === 'text');
  if (!text || text.type !== 'text') throw new Error('The AI model returned no structured answer.');
  const parsed = ModelOutput.safeParse(JSON.parse(text.text));
  if (!parsed.success) throw new Error('The AI model returned an answer that did not match the expected structure.');
  return fromModelOutput(parsed.data, message.model, pdf);
}

/** A short, user-presentable reason for an extraction failure. Never includes secrets. */
export function describeClaudeError(err: unknown): string {
  if (err instanceof ExtractionRefused) return 'the AI model declined to read this document';
  // Before APIError, which both of these extend.
  if (err instanceof Anthropic.APIUserAbortError) return 'the AI reading was stopped before it finished';
  if (err instanceof Anthropic.APIConnectionTimeoutError) return 'the AI service did not respond in time';
  if (err instanceof Anthropic.AuthenticationError) return 'the AI service rejected the configured API key';
  if (err instanceof Anthropic.PermissionDeniedError) return 'the configured API key is not permitted to use this model';
  if (err instanceof Anthropic.NotFoundError) return 'the configured extraction model was not found';
  if (err instanceof Anthropic.RateLimitError) return 'the AI service is rate-limiting requests';
  if (err instanceof Anthropic.InternalServerError) return `the AI service had a temporary problem (HTTP ${err.status ?? 'unknown'})`;
  if (err instanceof Anthropic.ContentTooLargeError) return 'the file is larger than the AI service accepts in one request';
  if (err instanceof Anthropic.BadRequestError) return 'the AI service rejected the request (the file may be too large or malformed)';
  if (err instanceof Anthropic.APIConnectionError) return 'the AI service could not be reached';
  if (err instanceof Anthropic.APIError) return `the AI service returned an error (HTTP ${err.status ?? 'unknown'})`;
  if (err instanceof SyntaxError) return 'the AI model returned an answer that was not valid JSON';
  return err instanceof Error ? err.message : 'an unexpected error occurred';
}
