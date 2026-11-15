/**
 * The extraction evaluation harness: scoring rules, corpus loading, and the
 * honesty rules for what the report may claim. The synthetic regression gate
 * itself runs in tests/eval-synthetic.test.ts.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type Anthropic from '@anthropic-ai/sdk';
import { describe, expect, it } from 'vitest';
import { runCli } from '@/server/documents/evaluation/cli';
import { loadCorpusDir, writeCorpusDir } from '@/server/documents/evaluation/corpus-dir';
import { NO_REAL_DOCUMENTS, renderReport, reportJson, SYNTHETIC_DISCLAIMER } from '@/server/documents/evaluation/report';
import { checkGate, evaluateCorpus } from '@/server/documents/evaluation/run';
import { HIGH_CONFIDENCE, scoreCase } from '@/server/documents/evaluation/score';
import { parseTruth, type Truth } from '@/server/documents/evaluation/truth';
import type { ExtractOutcome } from '@/server/documents/extract';
import { buildSyntheticCorpus, syntheticCases } from '@/server/samples/corpus';
import { EMPTY_CLAIMED, type ExtractionResult, type Extracted } from '@/server/types';
import { sampleModelAnswer } from './helpers/sample';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'rcm-eval-'));
const capture = () => {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { out: (s: string) => out.push(s), err: (s: string) => err.push(s) }, out, err };
};
const ex = <T>(value: T | null, confidence: number): Extracted<T> => ({ value, confidence, page: 1 });

function outcomeWith(result: Partial<ExtractionResult>): ExtractOutcome {
  return { status: 'processed', detail: null, result: { engine: 'text-layer', segments: [], notes: [], ...result }, engine: 'text-layer', model: null, pageCount: 1, hasTextLayer: true, durationMs: 1 };
}
function payApp(due: Extracted<number>) {
  const amounts = Object.fromEntries(Object.keys(EMPTY_CLAIMED).map((k) => [k, ex<number>(null, 0)])) as NonNullable<ExtractionResult['payApp']>['amounts'];
  amounts.currentPaymentDue = due;
  const none = ex<string>(null, 0);
  return { applicationNumber: ex<number>(null, 0), periodTo: none, applicationDate: none, projectName: none, projectNumber: none, contractorName: none, toName: none, contractNumber: none, contractDate: none, amounts, signed: ex<'yes'>(null, 0), signerName: none, notarized: ex<'no'>(null, 0) };
}
const truthDue = (cents: number | null): Truth => ({ version: 1, payApp: { amounts: { currentPaymentDue: cents } } });

describe('scoring', () => {
  const bucket = (truth: Truth, result: Partial<ExtractionResult>, path = 'payApp.amounts.currentPaymentDue') =>
    scoreCase({ caseId: 'c', file: 'f.pdf', truth, outcome: outcomeWith(result), engineKey: 'text-layer' }).items.find((i) => i.path === path)!.bucket;

  it('separates a confidently wrong amount (dangerous) from a flagged or declined one (safe)', () => {
    expect(bucket(truthDue(10350000), { payApp: payApp(ex(10350000, 0.98)) })).toBe('correct');
    expect(bucket(truthDue(10350000), { payApp: payApp(ex(10850000, HIGH_CONFIDENCE)) })).toBe('wrong');
    expect(bucket(truthDue(10350000), { payApp: payApp(ex(10850000, HIGH_CONFIDENCE - 0.01)) })).toBe('flagged');
    expect(bucket(truthDue(10350000), { payApp: payApp(ex<number>(null, 0)) })).toBe('abstained');
  });

  it('counts a confident value where nothing is printed as wrong, and a blank left blank as correct', () => {
    expect(bucket(truthDue(null), { payApp: payApp(ex(500, 0.9)) })).toBe('wrong');
    expect(bucket(truthDue(null), { payApp: payApp(ex<number>(null, 0)) })).toBe('correct');
  });

  it('treats unread waiver exceptions as dangerous, because downstream a blank means "none"', () => {
    const truth: Truth = { version: 1, waivers: [{ page: 1, exceptions: ['Retention held'] }] };
    const waiver = (exceptions: string | null) => ({ page: 1, waiverType: ex('conditional_progress' as const, 0.9), formState: ex<string>(null, 0), title: ex<string>(null, 0), claimant: ex<string>(null, 0), customer: ex<string>(null, 0), owner: ex<string>(null, 0), jobDescription: ex<string>(null, 0), throughDate: ex<string>(null, 0), amount: ex<number>(null, 0), exceptions: ex(exceptions, exceptions ? 0.8 : 0), signed: ex<'yes'>(null, 0), signerName: ex<string>(null, 0), signerTitle: ex<string>(null, 0), signedDate: ex<string>(null, 0), notarized: ex<'no'>(null, 0) });
    expect(bucket(truth, { waivers: [waiver(null)] }, 'waivers.0.exceptions')).toBe('wrong');
    expect(bucket(truth, { waivers: [waiver('1. Retention held to date')] }, 'waivers.0.exceptions')).toBe('correct');
    expect(bucket({ version: 1, waivers: [{ page: 1, exceptions: null }] }, { waivers: [waiver('None')] }, 'waivers.0.exceptions')).toBe('correct');
  });

  it('counts a schedule row that is not on the sheet (a subtotal read as a line) as a dangerous extra row', () => {
    const truth: Truth = { version: 1, lines: [{ itemNo: '1', description: 'Mobilization', scheduledValue: 100 }] };
    const line = (itemNo: string | null, description: string, confidence: number) => ({ itemNo, description, page: 1, confidence, scheduledValue: 100, previous: null, thisPeriod: null, stored: null, total: null, balance: null, retainage: null });
    const s = scoreCase({ caseId: 'c', file: 'f', truth, outcome: outcomeWith({ lines: [line('1', 'Mobilization', 0.97), line(null, 'PAGE SUBTOTAL', 0.97)] }), engineKey: 'text-layer' });
    expect(s.rows).toEqual({ expected: 1, read: 2, matched: 1 });
    expect(s.items.find((i) => i.path === 'lines.extra.1')!.bucket).toBe('wrong');
  });
});

describe('ground truth files', () => {
  it('rejects a truth file with a mistake, saying where', () => {
    expect(() => parseTruth({ version: 1, payApp: { amounts: { currentPaymentDue: 1035.5 } } }, 'x.truth.json')).toThrow(/payApp\.amounts\.currentPaymentDue/);
    expect(() => parseTruth({ version: 1, payApp: { periodTo: '10/31/2026' } }, 'x.truth.json')).toThrow(/ISO/);
  });

  it('round-trips the synthetic corpus through the on-disk format', async () => {
    const dir = tmp();
    const cases = await buildSyntheticCorpus('legacy/package-tx');
    writeCorpusDir(dir, cases);
    fs.writeFileSync(path.join(dir, 'no-truth.pdf'), cases[0]!.file.bytes);
    const loaded = loadCorpusDir(dir);
    expect(loaded.errors).toEqual([]);
    expect(loaded.withoutTruth).toEqual(['no-truth.pdf']);
    expect(loaded.cases).toHaveLength(1);
    expect(loaded.cases[0]!.truth).toEqual(cases[0]!.truth);
    expect(loaded.cases[0]!.file.bytes).toEqual(cases[0]!.file.bytes);
  });

  it('the template people start from is itself a valid truth file', () => {
    const file = path.resolve(__dirname, '../eval/truth-template.json');
    expect(() => parseTruth(JSON.parse(fs.readFileSync(file, 'utf8')), 'eval/truth-template.json')).not.toThrow();
  });

  it('every synthetic case has a valid truth file', async () => {
    for (const c of syntheticCases().slice(0, 12)) {
      const built = await c.build();
      expect(() => parseTruth(JSON.parse(JSON.stringify(built.truth)), c.id)).not.toThrow();
    }
  });
});

describe('honesty rules in the report', () => {
  it('opens the synthetic section by saying what it is, and says real accuracy is unmeasured when there are no real documents', async () => {
    const dir = tmp();
    const { io, out } = capture();
    const code = await runCli(['--set', 'all', '--case', 'legacy/package-tx', '--real-dir', dir], io, { root: dir, ai: { configured: false } });
    expect(code).toBe(0);
    const text = out.join('\n');
    const lines = text.split('\n');
    const title = lines.findIndex((l) => l.startsWith('SYNTHETIC CORPUS'));
    expect(lines[title + 1]).toBe(SYNTHETIC_DISCLAIMER);
    expect(text).toContain(NO_REAL_DOCUMENTS);
    expect(text).not.toMatch(/REAL CORPUS ·/);
    expect(text).not.toMatch(/overall|combined|blended|all corpora/i);
  });

  it('reports synthetic and real corpora separately and never pools them, in text or JSON', async () => {
    const dir = tmp();
    const realDir = path.join(dir, 'real');
    writeCorpusDir(realDir, await buildSyntheticCorpus('separate/pay-application-only'));
    const { io, out } = capture();
    const code = await runCli(['--set', 'all', '--case', 'pay-application-only', '--real-dir', realDir, '--json', 'out.json'], io, { root: dir, ai: { configured: false } });
    expect(code).toBe(0);
    const text = out.join('\n');
    expect(text).toContain(SYNTHETIC_DISCLAIMER);
    expect(text).toMatch(/^REAL: 1 customer document from real, checked against hand-keyed truth files/m);
    expect(text).not.toContain(NO_REAL_DOCUMENTS);
    // One summary block per corpus, each under its own disclaimer; no figure covers both.
    expect(text.match(/Document type, per page/g)).toHaveLength(2);
    const json = JSON.parse(fs.readFileSync(path.join(dir, 'out.json'), 'utf8'));
    expect(Object.keys(json).sort()).toEqual(['corpora', 'meta']);
    expect(json.corpora.map((c: { kind: string }) => c.kind)).toEqual(['synthetic', 'real']);
  });

  it('refuses --engine claude without an API key, and evaluates nothing', async () => {
    const { io, out, err } = capture();
    const code = await runCli(['--engine', 'claude', '--set', 'synthetic'], io, { ai: { configured: false } });
    expect(code).toBe(2);
    expect(out).toEqual([]);
    expect(err.join('\n')).toMatch(/needs ANTHROPIC_API_KEY/);
    expect(err.join('\n')).toMatch(/never invents or simulates a model result/);
  });

  it('the JSON for an empty real corpus says it is unmeasured and carries no real figures', () => {
    const json = reportJson({ synthetic: [], real: [], realRequested: true, meta: {} });
    expect(json).toEqual({ meta: {}, corpora: [], real: NO_REAL_DOCUMENTS });
    expect(renderReport({ realRequested: true, realDir: 'eval/real', header: 'h' })).toContain(NO_REAL_DOCUMENTS);
  });

  it('rejects a broken truth file in the real corpus with exit code 2', async () => {
    const dir = tmp();
    fs.writeFileSync(path.join(dir, 'a.pdf'), new Uint8Array([1]));
    fs.writeFileSync(path.join(dir, 'a.pdf.truth.json'), JSON.stringify({ version: 1, payApp: { amounts: { currentPaymentDue: 'lots' } } }));
    const { io, out } = capture();
    expect(await runCli(['--set', 'real', '--real-dir', dir], io, { root: dir, ai: { configured: false } })).toBe(2);
    expect(out.join('\n')).toMatch(/not a valid truth file/);
  });
});

describe('running an engine over a corpus', () => {
  it('scores the Claude engine through the real pipeline with a stubbed client, and leaves out cases where it fell back', async () => {
    const cases = await buildSyntheticCorpus('legacy/package-tx');
    const answer = sampleModelAnswer();
    const client = (reply: () => unknown) =>
      ({ beta: { messages: { stream: () => ({ finalMessage: async () => reply() }) } } }) as unknown as Pick<Anthropic, 'beta'>;
    const ok = await evaluateCorpus('synthetic', cases, { engine: 'claude', ai: { configured: true, apiKey: 'test', model: 'claude-opus-5-5' }, claudeClient: client(() => ({ model: 'claude-opus-5-5', stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(answer) }] })) });
    expect(ok.excluded).toEqual([]);
    expect(ok.scored[0]!.engine).toBe('claude');
    expect(ok.summary.groups.header.correct).toBe(11);

    const failing = await evaluateCorpus('synthetic', cases, {
      engine: 'claude',
      ai: { configured: true, apiKey: 'test', model: 'claude-opus-5-5' },
      claudeClient: client(() => {
        throw new Error('network down');
      }),
    });
    expect(failing.scored).toEqual([]);
    expect(failing.excluded[0]!.reason).toMatch(/AI extraction failed/);
  });

  it('the gate fails on any confidently wrong value', () => {
    const result = { kind: 'synthetic' as const, engine: 'text' as const, model: null, scored: [], excluded: [], summary: { confidentlyWrong: 1 } } as unknown as Parameters<typeof checkGate>[0];
    (result.summary as unknown as Record<string, unknown>).groups = { pageType: { n: 0 }, header: { n: 0 }, identity: { n: 0 }, line: { n: 0 }, lineTotal: { n: 0 }, waiver: { n: 0 } };
    (result.summary as unknown as Record<string, unknown>).rows = { expected: 0 };
    (result.summary as unknown as Record<string, unknown>).flags = { expected: 0 };
    expect(checkGate(result, { maxConfidentlyWrong: 0, min: {} })).toEqual(['1 values were wrong with high confidence (allowed: 0).']);
  });
});
