/**
 * Chooses how to read a file and reports honestly what happened.
 *
 *   AI configured           → Claude reads it; the text layer (if any) grounds the answer.
 *   AI call fails           → fall back to the text layer if there is one, and say so.
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
};

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
    } catch {
      return done({ status: 'failed', detail: 'This file could not be opened as a PDF. It may be damaged or password-protected.', result: null, engine: null, model: null, pageCount: null, hasTextLayer: null });
    }
  }
  const meta = { pageCount: pdf?.pageCount ?? (file.mimeType.startsWith('image/') ? 1 : null), hasTextLayer: pdf?.hasTextLayer ?? (file.mimeType === 'application/pdf' ? false : null) };

  let aiFailure: string | null = null;
  if (ai.configured && claudeSupports(file.mimeType)) {
    try {
      const result = await extractWithClaude(file, pdf, { apiKey: ai.apiKey, model: ai.model, client: options.claudeClient });
      return done({ status: 'processed', detail: null, result, engine: result.engine, model: result.model ?? ai.model, ...meta });
    } catch (err) {
      aiFailure = describeClaudeError(err);
      console.error(`[extract] AI extraction failed for ${file.filename}: ${aiFailure}`);
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
