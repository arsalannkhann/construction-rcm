/**
 * Runs a reader over a corpus and scores it. One corpus at a time, always:
 * synthetic and real results are never pooled.
 */
import type { AiConfig } from '@/server/config';
import { extractDocument, type ExtractOptions, type ExtractOutcome } from '@/server/documents/extract';
import type { CorpusCase } from '@/server/samples/corpus';
import { accuracy, scoreCase, summarize, type CaseScore, type Summary } from './score';

export type CorpusKind = 'synthetic' | 'real';
export type EngineChoice = 'text' | 'claude' | 'auto';

export type CorpusResult = {
  kind: CorpusKind;
  /** The engine asked for. */
  engine: EngineChoice;
  /** Model, when the Claude engine ran. */
  model: string | null;
  scored: CaseScore[];
  /** Cases left out of the scores, with the reason (e.g. the AI call failed and the text reader answered instead). */
  excluded: Array<{ caseId: string; reason: string }>;
  summary: Summary;
};

export type RunOptions = {
  engine: EngineChoice;
  /** Required for `claude`; for `auto`, whatever is configured. */
  ai: AiConfig;
  /** Injected in tests; never a live client there. */
  claudeClient?: ExtractOptions['claudeClient'];
  /** Replaces extraction entirely (tests). */
  extract?: (file: CorpusCase['file']) => Promise<ExtractOutcome>;
  onCase?: (c: CaseScore) => void;
  /** Files read at once (default 1). Results keep the corpus order whatever this is. */
  concurrency?: number;
};

export async function evaluateCorpus(kind: CorpusKind, cases: CorpusCase[], opts: RunOptions): Promise<CorpusResult> {
  if (opts.engine === 'claude' && !opts.ai.configured) throw new Error('The Claude engine needs ANTHROPIC_API_KEY.');
  const ai: AiConfig = opts.engine === 'text' ? { configured: false } : opts.ai;
  const slots: Array<{ scored?: CaseScore; excluded?: CorpusResult['excluded'][number] }> = new Array(cases.length);
  let next = 0;
  const worker = async () => {
    while (next < cases.length) {
      const i = next++;
      const c = cases[i]!;
      const outcome = opts.extract ? await opts.extract(c.file) : await extractDocument(c.file, { ai, claudeClient: opts.claudeClient });
      // When Claude was asked for but the text reader answered (the AI call failed), that result says nothing about Claude.
      if (opts.engine === 'claude' && outcome.engine !== 'claude') {
        slots[i] = { excluded: { caseId: c.id, reason: outcome.detail ?? `the ${outcome.engine ?? 'no'} engine answered instead of Claude` } };
        continue;
      }
      const engineKey = opts.engine === 'text' ? 'text-layer' : opts.engine === 'claude' ? 'claude' : (outcome.engine ?? (ai.configured ? 'claude' : 'text-layer'));
      const s = scoreCase({ caseId: c.id, file: c.file.filename, truth: c.truth, outcome, engineKey });
      slots[i] = { scored: s };
      opts.onCase?.(s);
    }
  };
  const n = Math.max(1, Math.min(opts.concurrency ?? 1, cases.length || 1));
  await Promise.all(Array.from({ length: n }, worker));
  const scored = slots.flatMap((s) => (s?.scored ? [s.scored] : []));
  const excluded = slots.flatMap((s) => (s?.excluded ? [s.excluded] : []));
  return { kind, engine: opts.engine, model: ai.configured ? ai.model : null, scored, excluded, summary: summarize(scored) };
}

// ── Cost and time ───────────────────────────────────────────────────────────

/** List prices in US dollars per million tokens (input, output). An estimate: the invoice is what counts. */
const PRICES: Record<string, [number, number]> = {
  'claude-opus-5-5': [4, 20],
  'claude-opus-5': [5, 25],
  'claude-sonnet-5-5': [2, 10],
  'claude-haiku-5-5': [0.1, 0.5],
  'claude-fable-5-2': [8, 40],
};

export type CostSummary = {
  files: number;
  inputTokens: number;
  outputTokens: number;
  /** null when the model's price is not in the table. */
  dollars: number | null;
  seconds: { median: number; p90: number; max: number } | null;
};

export function costSummary(result: CorpusResult): CostSummary {
  const used = result.scored.filter((c) => c.usage);
  const sum = (f: (u: NonNullable<CaseScore['usage']>) => number) => used.reduce((a, c) => a + f(c.usage!), 0);
  const inputTokens = sum((u) => u.inputTokens + u.cacheReadTokens + u.cacheWriteTokens);
  const outputTokens = sum((u) => u.outputTokens);
  const price = result.model ? PRICES[result.model] : undefined;
  const dollars = price
    ? (sum((u) => u.inputTokens) * price[0] + sum((u) => u.cacheWriteTokens) * price[0] * 1.25 + sum((u) => u.cacheReadTokens) * price[0] * 0.05 + outputTokens * price[1]) / 1e6
    : null;
  const times = result.scored.map((c) => c.durationMs / 1000).sort((a, b) => a - b);
  const at = (q: number) => times[Math.min(times.length - 1, Math.floor(q * times.length))]!;
  return { files: used.length, inputTokens, outputTokens, dollars, seconds: times.length ? { median: at(0.5), p90: at(0.9), max: times[times.length - 1]! } : null };
}

// ── Regression gate ─────────────────────────────────────────────────────────

/** Minimum shares are 0..1. Applies to the synthetic corpus only. */
export type Gate = {
  maxConfidentlyWrong: number;
  min: Partial<Record<'pageType' | 'header' | 'identity' | 'lineRecall' | 'lineCells' | 'lineTotal' | 'waiver' | 'flags' | 'outcomes', number>>;
};
export type GateFile = Record<string, Gate>;

export function gateMetrics(s: Summary): Record<keyof Gate['min'], number | null> {
  const lineCells = (() => {
    const t = s.groups.line;
    return t.n === 0 ? null : t.correct / t.n;
  })();
  return {
    pageType: accuracy(s.groups.pageType),
    header: accuracy(s.groups.header),
    identity: accuracy(s.groups.identity),
    lineRecall: s.rows.expected === 0 ? null : s.rows.matched / s.rows.expected,
    lineCells,
    lineTotal: accuracy(s.groups.lineTotal),
    waiver: accuracy(s.groups.waiver),
    flags: s.flags.expected === 0 ? null : s.flags.met / s.flags.expected,
    outcomes: s.cases === 0 ? null : s.outcomesMet / s.cases,
  };
}

/** What breaches the gate, in words. Empty when it passes. */
export function checkGate(result: CorpusResult, gate: Gate | undefined): string[] {
  if (result.kind !== 'synthetic' || !gate) return [];
  const out: string[] = [];
  if (result.summary.confidentlyWrong > gate.maxConfidentlyWrong) out.push(`${result.summary.confidentlyWrong} values were wrong with high confidence (allowed: ${gate.maxConfidentlyWrong}).`);
  const m = gateMetrics(result.summary);
  for (const [k, min] of Object.entries(gate.min) as Array<[keyof Gate['min'], number]>) {
    const v = m[k];
    if (v !== null && v + 1e-9 < min) out.push(`${k} is ${(v * 100).toFixed(1)}%, below the ${(min * 100).toFixed(1)}% floor.`);
  }
  return out;
}
