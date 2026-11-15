/**
 * The synthetic regression gate (eval/synthetic/gate.json), and the text reader's
 * known limitations pinned so that a change in behaviour is noticed.
 *
 * SYNTHETIC: every document here comes from this project's own renderer. Passing
 * says nothing about accuracy on real subcontractor documents, which is unmeasured.
 */
import fs from 'node:fs';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { checkGate, evaluateCorpus, type CorpusResult, type GateFile } from '@/server/documents/evaluation/run';
import { extractDocument } from '@/server/documents/extract';
import { buildSyntheticCorpus } from '@/server/samples/corpus';
import type { ExtractionResult } from '@/server/types';

const gates: GateFile = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../eval/synthetic/gate.json'), 'utf8'));

async function read(caseId: string): Promise<ExtractionResult> {
  const [c] = await buildSyntheticCorpus(caseId);
  const outcome = await extractDocument(c!.file, { ai: { configured: false } });
  return outcome.result!;
}

describe('synthetic regression gate (text-layer)', () => {
  let result: CorpusResult;
  beforeAll(async () => {
    result = await evaluateCorpus('synthetic', await buildSyntheticCorpus(), { engine: 'text', ai: { configured: false } });
  }, 120_000);

  it('allows no confidently wrong value, and the gate file never loosens that', () => {
    expect(gates['text-layer']!.maxConfidentlyWrong).toBe(0);
    expect(result.summary.confidentlyWrong).toBe(0);
  });

  it('meets every floor in eval/synthetic/gate.json', () => {
    expect(checkGate(result, gates['text-layer'])).toEqual([]);
  });
});

describe('known limitations of the text reader, pinned', () => {
  it('a handwritten correction over a printed figure: keeps the printed figure but will not vouch for it', async () => {
    // The text layer carries the printed 103,500.00; the ink says 98,500.00. Reading ink needs a
    // vision engine. The text reader can only see that an image covers the figure.
    const r = await read('ink/handwritten-correction');
    const due = r.payApp!.amounts.currentPaymentDue;
    expect(due.value).toBe(10350000);
    expect(due.confidence).toBeLessThanOrEqual(0.5);
    expect(r.notes.join(' ')).toMatch(/drawn over/);
  });

  it('European number formats: declines every amount rather than guess at the separators', async () => {
    const r = await read('amounts/european-separators');
    const amounts = Object.values(r.payApp?.amounts ?? {}).filter((a) => a.value !== null);
    expect(amounts).toEqual([]);
    expect(r.lines ?? []).toEqual([]);
  });

  it('a waiver amount written in words only: declined, with a note', async () => {
    const r = await read('waiver/amount-in-words-only');
    expect(r.waivers![0]!.amount.value).toBeNull();
    expect(r.notes.join(' ')).toMatch(/written only in words/);
  });

  it('a signature drawn in ink: reported as unclear, never as signed', async () => {
    const r = await read('ink/payapp-signed-in-ink');
    expect(r.payApp!.signed.value).toBe('unclear');
  });

  it('a scanned page inside a text PDF: reported as unreadable, not read', async () => {
    const r = await read('scan/one-scanned-page-in-text-pdf');
    expect(r.unreadablePages).toEqual([2]);
    expect(r.lines ?? []).toEqual([]);
  });
});
