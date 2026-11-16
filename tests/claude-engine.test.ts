/**
 * The AI engine, exercised with a stubbed Anthropic client. These tests cover
 * everything on our side of the API call: how a model answer is parsed,
 * grounded against the PDF's own text, cross-checked with the deterministic
 * reader, and what happens when the call fails. They do not prove anything
 * about a live model's reading accuracy.
 */
import Anthropic from '@anthropic-ai/sdk';
import { beforeAll, describe, expect, it } from 'vitest';
import { describeClaudeError, extractWithClaude, fromModelOutput, type ModelOutput } from '@/server/documents/engine-claude';
import { extractDocument, extractionTimeoutMs } from '@/server/documents/extract';
import { readPdfText, type PdfText } from '@/server/documents/pdf-text';
import { renderPackage, renderTextlessPdf } from '@/server/samples/pdf';
import { DEFAULT_ORG_SETTINGS } from '@/server/types';
import { dollars as D, samplePackage } from './helpers/sample';

const v = (text: string | null, page: number | null = 1, confidence: 'high' | 'medium' | 'low' = 'high') => ({ text, page, confidence });
const tri = (value: 'yes' | 'no' | 'unclear', page = 1) => ({ value, page, confidence: 'high' as const });

/** What a careful model would return for the standard sample package. */
function answer(overrides: (o: ModelOutput) => void = () => {}): ModelOutput {
  const out: ModelOutput = {
    segments: [
      { type: 'pay_application', page_start: 1, page_end: 1, confidence: 'high' },
      { type: 'continuation_sheet', page_start: 2, page_end: 2, confidence: 'high' },
      { type: 'lien_waiver', page_start: 3, page_end: 3, confidence: 'high' },
    ],
    pay_application: {
      application_number: v('2'),
      period_to: v('10/31/2026'),
      application_date: v('10/28/2026'),
      project_name: v('Riverside Medical Office Building'),
      project_number: v('2301'),
      contractor_name: v('Lone Star Electric, LLC'),
      to_name: v('Northline Constructors, Inc.'),
      contract_number: v('SC-2301-16'),
      contract_date: v('03/02/2026'),
      amounts: {
        original_contract_sum: v('500,000.00'),
        net_change_orders: v('0.00'),
        contract_sum_to_date: v('500,000.00'),
        total_completed_stored: v('225,000.00'),
        retainage_work: v('21,500.00'),
        retainage_stored: v('1,000.00'),
        retainage_total: v('22,500.00'),
        total_earned_less_retainage: v('202,500.00'),
        less_previous_certificates: v('99,000.00'),
        current_payment_due: v('$103,500.00'),
        balance_to_finish: v('297,500.00'),
      },
      signed: tri('yes'),
      signer_name: v('Maria Alvarez'),
      notarized: tri('yes'),
    },
    line_items: [
      { item_no: '1', description: 'Mobilization', scheduled_value: '50,000.00', previous: '50,000.00', this_period: '0.00', stored: '0.00', total: '50,000.00', balance: '0.00', retainage: '5,000.00', page: 2, confidence: 'high' },
      { item_no: '2', description: 'Rough-in, levels 1-3', scheduled_value: '300,000.00', previous: '60,000.00', this_period: '90,000.00', stored: '0.00', total: '150,000.00', balance: '150,000.00', retainage: '15,000.00', page: 2, confidence: 'high' },
      { item_no: '3', description: 'Fixtures and trim', scheduled_value: '150,000.00', previous: '0.00', this_period: '15,000.00', stored: '10,000.00', total: '25,000.00', balance: '125,000.00', retainage: '2,500.00', page: 2, confidence: 'high' },
    ],
    line_totals: null,
    lien_waivers: [
      {
        page: 3,
        waiver_type: 'conditional_progress',
        waiver_type_confidence: 'high',
        statutory_form_state: 'TX',
        title: v('CONDITIONAL WAIVER AND RELEASE ON PROGRESS PAYMENT', 3),
        claimant: v('Lone Star Electric, LLC', 3),
        customer: v('Northline Constructors, Inc.', 3),
        owner: v('Riverside Health Partners', 3),
        job_description: v('Electrical', 3),
        through_date: v(null, 3),
        amount: v('$103,500.00', 3),
        exceptions: v(null, 3),
        signed: tri('yes', 3),
        signer_name: v('Maria Alvarez', 3),
        signer_title: v('Controller', 3),
        signed_date: v('October 28, 2026', 3),
        notarized: tri('no', 3),
      },
    ],
    notes: [],
  };
  overrides(out);
  return out;
}

/** A stand-in for the SDK client that returns one canned message, or throws. */
function fakeClient(reply: { json?: unknown; stop_reason?: string; throws?: unknown }) {
  const calls: Array<Record<string, unknown>> = [];
  const client = {
    beta: {
      messages: {
        stream: (params: Record<string, unknown>) => {
          calls.push(params);
          return {
            finalMessage: async () => {
              if (reply.throws) throw reply.throws;
              return {
                model: 'claude-opus-5-5',
                stop_reason: reply.stop_reason ?? 'end_turn',
                stop_details: reply.stop_reason === 'refusal' ? { type: 'refusal', category: null, explanation: 'declined' } : null,
                content: [{ type: 'text', text: JSON.stringify(reply.json ?? {}) }],
              };
            },
          };
        },
      },
    },
  };
  return { client: client as unknown as Pick<Anthropic, 'beta'>, calls };
}

/** A stand-in for a model call that never finishes: it ends only when the caller stops it, as the SDK does. */
function hangingClient() {
  let calls = 0;
  const client = {
    beta: {
      messages: {
        stream: (_params: unknown, options?: { signal?: AbortSignal }) => {
          calls++;
          return {
            finalMessage: () =>
              new Promise((_resolve, reject) => {
                const signal = options?.signal;
                if (!signal) return; // never settles: the test would time out
                if (signal.aborted) reject(new Anthropic.APIUserAbortError());
                signal.addEventListener('abort', () => reject(new Anthropic.APIUserAbortError()));
              }),
          };
        },
      },
    },
  };
  return { client: client as unknown as Pick<Anthropic, 'beta'>, calls: () => calls };
}

let bytes: Uint8Array;
let pdf: PdfText;
beforeAll(async () => {
  bytes = await renderPackage(samplePackage());
  pdf = await readPdfText(bytes);
});
const file = () => ({ filename: 'payapp-2.pdf', mimeType: 'application/pdf', bytes });

describe('AI engine: turning a model answer into figures', () => {
  it('parses amounts the model transcribed as text into exact cents and ISO dates', () => {
    const r = fromModelOutput(answer(), 'claude-opus-5-5', pdf);
    expect(r.engine).toBe('claude');
    expect(r.payApp!.amounts.currentPaymentDue.value).toBe(D(103500));
    expect(r.payApp!.amounts.lessPreviousCertificates.value).toBe(D(99000));
    expect(r.payApp!.periodTo.value).toBe('2026-10-31');
    expect(r.payApp!.applicationNumber.value).toBe(2);
    expect(r.lines).toHaveLength(3);
    expect(r.lines![2]).toMatchObject({ itemNo: '3', thisPeriod: D(15000), stored: D(10000) });
    expect(r.waivers![0]!.amount.value).toBe(D(103500));
    expect(r.waivers![0]!.signedDate.value).toBe('2026-10-28');
    expect(r.notes).toEqual([]);
  });

  it('ties every amount to a place on the page, and trusts it more when both readers agree', () => {
    const r = fromModelOutput(answer(), 'claude-opus-5-5', pdf);
    const due = r.payApp!.amounts.currentPaymentDue;
    expect(due.bbox).toHaveLength(4);
    expect(due.page).toBe(1);
    expect(due.confidence).toBeGreaterThanOrEqual(0.98);
    expect(r.lines![1]!.bbox).toHaveLength(4);
    expect(r.lines![1]!.confidence).toBeGreaterThanOrEqual(0.97);
  });

  it('does not accept a figure that is not on the document', () => {
    const r = fromModelOutput(
      answer((o) => {
        o.pay_application!.amounts.current_payment_due = v('108,500.00'); // a plausible misreading
      }),
      'claude-opus-5-5',
      pdf,
    );
    const due = r.payApp!.amounts.currentPaymentDue;
    expect(due.value).toBe(D(108500)); // reported as read, not silently replaced…
    expect(due.confidence).toBeLessThan(0.5); // …but flagged for a person
    expect(due.bbox).toBeNull();
    expect(r.notes.join(' ')).toMatch(/does not appear anywhere in the document/);
    expect(r.notes.join(' ')).toMatch(/two readers disagree/);
  });

  it('flags schedule rows where the two readers disagree', () => {
    const r = fromModelOutput(
      answer((o) => {
        o.line_items[1]!.this_period = '9,000.00';
      }),
      'claude-opus-5-5',
      pdf,
    );
    expect(r.lines![1]!.thisPeriod).toBe(D(9000));
    expect(r.lines![1]!.confidence).toBeLessThan(0.5);
    expect(r.lines![0]!.confidence).toBeGreaterThan(0.9);
    expect(r.notes.join(' ')).toMatch(/1 schedule line the AI reading and the text layer disagree/);
  });

  it('keeps a blank blank, and refuses text that is not a clean amount', () => {
    const r = fromModelOutput(
      answer((o) => {
        o.pay_application!.amounts.retainage_stored = v(null, 1, 'low');
        o.pay_application!.amounts.balance_to_finish = v('approx. 297k', 1, 'low');
      }),
      'claude-opus-5-5',
      pdf,
    );
    expect(r.payApp!.amounts.retainageStored).toMatchObject({ value: null, confidence: 0 });
    expect(r.payApp!.amounts.balanceToFinish.value).toBeNull();
    expect(r.notes.join(' ')).toMatch(/not a clean amount/);
  });

  it('reads a dash printed in an amount cell as zero, as the text reader does', () => {
    const r = fromModelOutput(
      answer((o) => {
        o.line_items[0]!.this_period = '-';
        o.line_items[0]!.stored = '—';
        o.line_items[1]!.stored = null;
        o.pay_application!.amounts.net_change_orders = v('-');
      }),
      'claude-opus-5-5',
      null,
    );
    expect(r.lines![0]).toMatchObject({ thisPeriod: 0, stored: 0 });
    expect(r.lines![1]!.stored).toBeNull();
    expect(r.payApp!.amounts.netChangeOrders).toMatchObject({ value: 0, confidence: 0.95 });
    expect(r.notes.join(' ')).not.toMatch(/not a clean amount/);
  });

  it('lets the wording decide the statutory form, whatever the model says', () => {
    const r = fromModelOutput(
      answer((o) => {
        o.lien_waivers[0]!.statutory_form_state = 'CA';
      }),
      'claude-opus-5-5',
      pdf,
    );
    expect(r.waivers![0]!.formState.value).toBe('TX');
  });

  it('works without a text layer, with page-level evidence only', () => {
    const r = fromModelOutput(answer(), 'claude-opus-5-5', null);
    const due = r.payApp!.amounts.currentPaymentDue;
    expect(due.value).toBe(D(103500));
    expect(due.page).toBe(1);
    expect(due.bbox ?? null).toBeNull();
    expect(due.confidence).toBe(0.95);
    expect(r.pageNumbering).toBeUndefined();
  });

  const grandTotal = (o: ModelOutput, total = '225,000.00') => {
    o.line_totals = { scheduled_value: '500,000.00', previous: '110,000.00', this_period: '105,000.00', stored: '10,000.00', total, balance: '275,000.00', retainage: '22,500.00' };
  };

  it('reports the printed grand-total row, placed on the page when the text layer has the same row', () => {
    const r = fromModelOutput(answer((o) => grandTotal(o)), 'claude-opus-5-5', pdf);
    expect(r.scheduleGrandTotal).toMatchObject({ page: 2, confidence: 0.97, values: { total: D(225000), thisPeriod: D(105000), retainage: D(22500) } });
    expect(r.scheduleGrandTotal!.bbox).toHaveLength(4);
    expect(r.lineTotals!.total).toBe(D(225000));
  });

  it('marks a grand total the text layer does not show, and never places it', () => {
    const r = fromModelOutput(answer((o) => grandTotal(o, '252,000.00')), 'claude-opus-5-5', pdf);
    expect(r.scheduleGrandTotal!.values.total).toBe(D(252000));
    expect(r.scheduleGrandTotal!.confidence).toBeLessThan(0.5);
    expect(r.scheduleGrandTotal!.bbox).toBeNull();
    expect(r.notes.join(' ')).toMatch(/grand-total row differs from the text layer/);
    // Without a text layer there is nothing to check it against: reported, below the review threshold.
    expect(fromModelOutput(answer((o) => grandTotal(o)), 'claude-opus-5-5', null).scheduleGrandTotal!.confidence).toBe(0.7);
  });

  it('takes printed page numbers and conflicts from the text layer, not from the model', () => {
    const r = fromModelOutput(answer(), 'claude-opus-5-5', pdf);
    expect(r.pageNumbering?.map((p) => [p.page, p.number, p.of])).toEqual([
      [1, 1, 2],
      [2, 2, 2],
    ]);
    expect(r.conflicts).toBeUndefined();
    expect(r.unreadablePages).toBeUndefined();
  });
});

describe('AI engine: doubt, scans and files with two applications', () => {
  it('sends a value the model was only fairly sure of to a person', () => {
    const r = fromModelOutput(
      answer((o) => {
        o.pay_application!.amounts.current_payment_due = v('$103,500.00', 1, 'medium');
      }),
      'claude-opus-5-5',
      null,
    );
    expect(r.payApp!.amounts.currentPaymentDue.value).toBe(D(103500));
    expect(r.payApp!.amounts.currentPaymentDue.confidence).toBeLessThan(DEFAULT_ORG_SETTINGS.lowConfidenceThreshold);
  });

  it('says when nothing could be cross-checked because the file is a scan or an image', () => {
    const scan: PdfText = { ...pdf, hasTextLayer: false, pages: pdf.pages.map((p) => ({ ...p, lines: [], text: '', chars: 0 })) };
    expect(fromModelOutput(answer(), 'claude-opus-5-5', scan).notes.join(' ')).toMatch(/scan with no machine-readable text/);
    expect(fromModelOutput(answer(), 'claude-opus-5-5', null).notes.join(' ')).toMatch(/an image \(a scan or a photo\)/);
    // A text PDF needs no such note.
    expect(fromModelOutput(answer(), 'claude-opus-5-5', pdf).notes.join(' ')).not.toMatch(/scan|image/);
  });

  it('does not doubt a value only because it sits on a scanned page of a text PDF', () => {
    const mixed: PdfText = { ...pdf, pages: pdf.pages.map((p) => (p.page === 3 ? { ...p, lines: [], text: '', chars: 0, images: [{ x: 0, y: 0, w: p.width, h: p.height }] } : p)) };
    const r = fromModelOutput(answer(), 'claude-opus-5-5', mixed);
    expect(r.waivers![0]!.amount).toMatchObject({ value: D(103500), confidence: 0.95 });
    expect(r.notes.join(' ')).toMatch(/Page 3 is a scanned image/);
    expect(r.notes.join(' ')).not.toMatch(/does not appear anywhere/);
    // On a page that does have text, a figure that is not there is still doubted.
    const wrong = fromModelOutput(
      answer((o) => {
        o.pay_application!.amounts.current_payment_due = v('$130,500.00');
      }),
      'claude-opus-5-5',
      mixed,
    );
    expect(wrong.payApp!.amounts.currentPaymentDue.confidence).toBeLessThan(0.5);
  });

  it('reads only the first of two pay applications, and raises the second even without a text layer', () => {
    const r = fromModelOutput(
      answer((o) => {
        o.segments = [
          { type: 'pay_application', page_start: 1, page_end: 1, confidence: 'high' },
          { type: 'continuation_sheet', page_start: 2, page_end: 2, confidence: 'high' },
          { type: 'pay_application', page_start: 3, page_end: 3, confidence: 'high' },
          { type: 'continuation_sheet', page_start: 4, page_end: 4, confidence: 'high' },
        ];
        o.line_items = [...o.line_items, ...o.line_items.map((l) => ({ ...l, page: 4 }))];
        o.lien_waivers = [];
      }),
      'claude-opus-5-5',
      null,
    );
    expect(r.lines).toHaveLength(3);
    expect(r.lines!.every((l) => l.page === 2)).toBe(true);
    expect(r.conflicts).toEqual([
      expect.objectContaining({ kind: 'second_pay_application', reported: expect.objectContaining({ value: 2, page: 1 }), others: [expect.objectContaining({ page: 3 })] }),
    ]);
    expect(r.notes.join(' ')).toMatch(/holds 2 pay applications/);
  });

  it('asks for transcription only, with exceptions that exclude the form’s own wording', async () => {
    const { client, calls } = fakeClient({ json: { ...answer(), line_items: undefined, line_totals: undefined } });
    await extractWithClaude(file(), pdf, { apiKey: 'test', model: 'claude-opus-5-5', client }).catch(() => {});
    const system = String(calls[0]?.system);
    expect(system).toMatch(/standard printed wording is not an exception/);
    expect(system).toMatch(/report the first one/);
    expect(system).toMatch(/never refer to them/);
  });
});

describe('AI engine: the API call', () => {
  it('sends the PDF with a structured-output schema and streams the response', async () => {
    const { client, calls } = fakeClient({ json: answer() });
    const r = await extractWithClaude(file(), pdf, { apiKey: 'test', model: 'claude-opus-5-5', client });
    expect(r.model).toBe('claude-opus-5-5');
    const sent = calls[0]!;
    expect(sent.model).toBe('claude-opus-5-5');
    expect(sent.thinking).toEqual({ type: 'adaptive' });
    expect((sent.output_config as { effort: string; format: { type: string } }).effort).toBe('high');
    expect((sent.output_config as { format: { type: string } }).format.type).toBe('json_schema');
    const content = (sent.messages as Array<{ content: Array<{ type: string; source?: { media_type: string } }> }>)[0]!.content;
    expect(content[0]).toMatchObject({ type: 'document', source: { type: 'base64', media_type: 'application/pdf' } });
    expect(String(sent.system)).toContain('Your job is transcription, not judgement');
  });

  it('rejects an answer that does not match the schema', async () => {
    const { client } = fakeClient({ json: { segments: 'nope' } });
    await expect(extractWithClaude(file(), pdf, { apiKey: 'test', model: 'claude-opus-5-5', client })).rejects.toThrow(/did not match the expected structure/);
  });

  it('treats a refusal and a truncated response as failures, not as empty documents', async () => {
    await expect(extractWithClaude(file(), pdf, { apiKey: 'test', model: 'm', client: fakeClient({ stop_reason: 'refusal' }).client })).rejects.toThrow(/declined/);
    await expect(extractWithClaude(file(), pdf, { apiKey: 'test', model: 'm', client: fakeClient({ stop_reason: 'max_tokens' }).client })).rejects.toThrow(/too long/);
  });
});

describe('choosing how to read a document', () => {
  const ai = { configured: true as const, apiKey: 'test', model: 'claude-opus-5-5' };

  it('uses the AI engine when it is configured', async () => {
    const out = await extractDocument(file(), { ai, claudeClient: fakeClient({ json: answer() }).client });
    expect(out).toMatchObject({ status: 'processed', engine: 'claude', model: 'claude-opus-5-5', detail: null, pageCount: 3, hasTextLayer: true });
  });

  it('falls back to the text reader when the AI call fails, and says so', async () => {
    const out = await extractDocument(file(), { ai, claudeClient: fakeClient({ throws: new Anthropic.APIConnectionError({ message: 'network down' }) }).client });
    expect(out.status).toBe('processed');
    expect(out.engine).toBe('text-layer');
    expect(out.detail).toMatch(/AI extraction failed: the AI service could not be reached/);
    expect(out.result!.notes[0]).toMatch(/rule-based text reader instead/);
    expect(out.result!.payApp!.amounts.currentPaymentDue.value).toBe(D(103500));
  });

  it('reports a scan as failed when the AI call fails and there is no text to fall back on', async () => {
    const scan = { filename: 'scan.pdf', mimeType: 'application/pdf', bytes: await renderTextlessPdf() };
    const out = await extractDocument(scan, { ai, claudeClient: fakeClient({ stop_reason: 'refusal' }).client });
    expect(out).toMatchObject({ status: 'failed', result: null, hasTextLayer: false });
    expect(out.detail).toMatch(/no machine-readable text, and AI extraction failed/);
  });

  it('reads a scan with the AI engine when it works', async () => {
    const scan = { filename: 'scan.pdf', mimeType: 'application/pdf', bytes: await renderTextlessPdf() };
    const out = await extractDocument(scan, { ai, claudeClient: fakeClient({ json: answer() }).client });
    expect(out.status).toBe('processed');
    expect(out.result!.payApp!.amounts.currentPaymentDue).toMatchObject({ value: D(103500), page: 1 });
  });

  it('stops an AI read that runs past its time limit and falls back to the text reader, saying why', async () => {
    const out = await extractDocument(file(), { ai, claudeClient: hangingClient().client, timeoutMs: 50 });
    expect(out).toMatchObject({ status: 'processed', engine: 'text-layer' });
    expect(out.detail).toMatch(/AI extraction failed: the AI reading did not finish within the 1 second available and was stopped/);
    expect(out.result!.payApp!.amounts.currentPaymentDue.value).toBe(D(103500));
  });

  it('marks a scan as failed, with the reason, when its AI read runs out of time', async () => {
    const scan = { filename: 'scan.pdf', mimeType: 'application/pdf', bytes: await renderTextlessPdf() };
    const out = await extractDocument(scan, { ai, claudeClient: hangingClient().client, timeoutMs: 50 });
    expect(out).toMatchObject({ status: 'failed', result: null });
    expect(out.detail).toMatch(/no machine-readable text, and AI extraction failed: the AI reading did not finish/);
  });

  it('does not start an AI read when the run has no time left for one', async () => {
    const hanging = hangingClient();
    const out = await extractDocument(file(), { ai, claudeClient: hanging.client, readBy: Date.now() - 1 });
    expect(hanging.calls()).toBe(0);
    expect(out).toMatchObject({ status: 'processed', engine: 'text-layer' });
    expect(out.detail).toMatch(/no time left for AI reading/);
  });

  it('takes the per-read time limit from RCM_EXTRACTION_TIMEOUT_SECONDS, ignoring nonsense', () => {
    expect(extractionTimeoutMs({})).toBe(240_000);
    expect(extractionTimeoutMs({ RCM_EXTRACTION_TIMEOUT_SECONDS: '90' })).toBe(90_000);
    expect(extractionTimeoutMs({ RCM_EXTRACTION_TIMEOUT_SECONDS: '2' })).toBe(240_000);
    expect(extractionTimeoutMs({ RCM_EXTRACTION_TIMEOUT_SECONDS: 'soon' })).toBe(240_000);
  });

  it('names the provider failures a reviewer may see', () => {
    const headers = new Headers();
    expect(describeClaudeError(new Anthropic.APIUserAbortError())).toMatch(/stopped before it finished/);
    expect(describeClaudeError(new Anthropic.APIConnectionTimeoutError())).toMatch(/did not respond in time/);
    expect(describeClaudeError(new Anthropic.InternalServerError(529, { type: 'error', error: { type: 'overloaded_error' } }, 'Overloaded', headers))).toMatch(/temporary problem \(HTTP 529\)/);
    expect(describeClaudeError(new Anthropic.ContentTooLargeError(413, undefined, 'too large', headers))).toMatch(/larger than the AI service accepts/);
    expect(describeClaudeError(new Anthropic.RateLimitError(429, undefined, 'slow down', headers))).toMatch(/rate-limiting/);
  });

  it('without AI, reads text PDFs and is plain about scans', async () => {
    const none = { configured: false as const };
    expect(await extractDocument(file(), { ai: none })).toMatchObject({ status: 'processed', engine: 'text-layer' });
    const scan = await extractDocument({ filename: 'scan.pdf', mimeType: 'application/pdf', bytes: await renderTextlessPdf() }, { ai: none });
    expect(scan).toMatchObject({ status: 'unreadable', result: null });
    expect(scan.detail).toMatch(/needs AI extraction, which is not configured/);
    const junk = await extractDocument({ filename: 'x.pdf', mimeType: 'application/pdf', bytes: new TextEncoder().encode('not a pdf') }, { ai: none });
    expect(junk).toMatchObject({ status: 'failed' });
  });
});
