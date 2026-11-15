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
};

export async function evaluateCorpus(kind: CorpusKind, cases: CorpusCase[], opts: RunOptions): Promise<CorpusResult> {
  if (opts.engine === 'claude' && !opts.ai.configured) throw new Error('The Claude engine needs ANTHROPIC_API_KEY.');
  const ai: AiConfig = opts.engine === 'text' ? { configured: false } : opts.ai;
  const scored: CaseScore[] = [];
  const excluded: CorpusResult['excluded'] = [];
  for (const c of cases) {
    const outcome = opts.extract ? await opts.extract(c.file) : await extractDocument(c.file, { ai, claudeClient: opts.claudeClient });
    // When Claude was asked for but the text reader answered (the AI call failed), that result says nothing about Claude.
    if (opts.engine === 'claude' && outcome.engine !== 'claude') {
      excluded.push({ caseId: c.id, reason: outcome.detail ?? `the ${outcome.engine ?? 'no'} engine answered instead of Claude` });
      continue;
    }
    const engineKey = opts.engine === 'text' ? 'text-layer' : opts.engine === 'claude' ? 'claude' : (outcome.engine ?? (ai.configured ? 'claude' : 'text-layer'));
    const s = scoreCase({ caseId: c.id, file: c.file.filename, truth: c.truth, outcome, engineKey });
    scored.push(s);
    opts.onCase?.(s);
  }
  return { kind, engine: opts.engine, model: ai.configured ? ai.model : null, scored, excluded, summary: summarize(scored) };
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
