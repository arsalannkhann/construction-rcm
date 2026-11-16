/**
 * Chooses how to read a file and reports honestly what happened.
 *
 *   AI configured           → Claude reads it; the text layer (if any) grounds the answer.
 *   AI call fails, or runs  → fall back to the text layer if there is one, and say so.
 *   out of time
 *   No AI, has text layer   → deterministic text-layer reader.
 *   No AI, no text layer    → "unreadable": a person keys the values.
 */
import { aiConfig, type AiConfig } from '@/server/config';
import type { ExtractionResult } from '@/server/types';
import { claudeSupports, describeClaudeError, extractWithClaude, type ClaudeDeps } from './engine-claude';
import { extractFromText, TEXT_ENGINE } from './engine-text';
import { readPdfText, type PdfText } from './pdf-text';

export type ExtractOutcome = {
  status: 'processed' | 'unreadable' | 'failed';
  /** Explanation shown to reviewers when status is not "processed", or when a fallback was used. */
  detail: string | null;
  result: ExtractionResult | null;
  engine: string | null;
  model: string | null;
  pageCount: number | null;
  hasTextLayer: boolean | null;
  durationMs: number;
};

export type ExtractOptions = {
  ai?: AiConfig;
  /** Injected in tests. */
  claudeClient?: ClaudeDeps['client'];
  /** Epoch ms by which the read must be over (the job's time limit). The AI read is stopped then. */
  readBy?: number;
  /** Longest one AI read may take, in ms. Default: RCM_EXTRACTION_TIMEOUT_SECONDS, else 240 seconds. */
  timeoutMs?: number;
};

const DEFAULT_TIMEOUT_MS = 240_000;

/** The longest one AI read may take, from RCM_EXTRACTION_TIMEOUT_SECONDS. */
export function extractionTimeoutMs(env: Record<string, string | undefined> = process.env): number {
  const seconds = Number(env.RCM_EXTRACTION_TIMEOUT_SECONDS);
  return Number.isFinite(seconds) && seconds >= 10 ? Math.round(seconds * 1000) : DEFAULT_TIMEOUT_MS;
}

function asSeconds(ms: number): string {
  const n = Math.max(1, Math.round(ms / 1000));
  return `${n} second${n === 1 ? '' : 's'}`;
}

export async function extractDocument(
  file: { filename: string; mimeType: string; bytes: Uint8Array },
  options: ExtractOptions = {},
): Promise<ExtractOutcome> {
  const started = Date.now();
  const ai = options.ai ?? aiConfig();
  const done = (o: Omit<ExtractOutcome, 'durationMs'>): ExtractOutcome => ({ ...o, durationMs: Date.now() - started });

  let pdf: PdfText | null = null;
  if (file.mimeType === 'application/pdf') {
    try {
      pdf = await readPdfText(file.bytes);
    } catch (err) {
      // Usually the file, but also the reader itself failing to load: log the cause so the two can be told apart.
      console.error(`[extract] could not open ${file.filename} as a PDF: ${err instanceof Error ? err.message : String(err)}`);
      return done({ status: 'failed', detail: 'This file could not be opened as a PDF. It may be damaged or password-protected.', result: null, engine: null, model: null, pageCount: null, hasTextLayer: null });
    }
  }
  const meta = { pageCount: pdf?.pageCount ?? (file.mimeType.startsWith('image/') ? 1 : null), hasTextLayer: pdf?.hasTextLayer ?? (file.mimeType === 'application/pdf' ? false : null) };

  let aiFailure: string | null = null;
  if (ai.configured && claudeSupports(file.mimeType)) {
    // However long the model takes, the read ends by the time limit: a cut-off server would lose it all.
    const cap = options.timeoutMs ?? extractionTimeoutMs();
    const left = options.readBy !== undefined ? options.readBy - Date.now() : Infinity;
    const allowed = Math.min(cap, left);
    if (allowed <= 0) {
      aiFailure = 'there was no time left for AI reading in this run';
    } else {
      const timer = new AbortController();
      const stop = setTimeout(() => timer.abort(), allowed);
      try {
        const result = await extractWithClaude(file, pdf, { apiKey: ai.apiKey, model: ai.model, client: options.claudeClient, signal: timer.signal });
        return done({ status: 'processed', detail: null, result, engine: result.engine, model: result.model ?? ai.model, ...meta });
      } catch (err) {
        aiFailure = timer.signal.aborted ? `the AI reading did not finish within the ${asSeconds(allowed)} available and was stopped` : describeClaudeError(err);
        console.error(`[extract] AI extraction failed for ${file.filename}: ${aiFailure}`);
      } finally {
        clearTimeout(stop);
      }
    }
  }

  if (pdf?.hasTextLayer) {
    const result = extractFromText(pdf);
    if (aiFailure) result.notes.unshift(`AI extraction was attempted but failed (${aiFailure}); these values come from the rule-based text reader instead.`);
    return done({ status: 'processed', detail: aiFailure ? `AI extraction failed: ${aiFailure}. Read with the text-layer parser instead.` : null, result, engine: TEXT_ENGINE, model: null, ...meta });
  }

  if (aiFailure) {
    return done({ status: 'failed', detail: `This file has no machine-readable text, and AI extraction failed: ${aiFailure}.`, result: null, engine: null, model: null, ...meta });
  }
  const kind = file.mimeType === 'application/pdf' ? 'This PDF has no machine-readable text (it looks like a scan).' : file.mimeType.startsWith('image/') ? 'This is an image, not a text document.' : `Files of type ${file.mimeType || 'unknown'} are stored but not read automatically.`;
  return done({
    status: 'unreadable',
    detail: `${kind} Reading scans and photos needs AI extraction, which is not configured on this deployment.`,
    result: null,
    engine: null,
    model: null,
    ...meta,
  });
}
