/**
 * Loads a corpus from a directory: every document file that has a
 * `<file name>.truth.json` beside it is a case. Subdirectories are searched.
 *
 *   eval/real/acme-electric/payapp-07.pdf
 *   eval/real/acme-electric/payapp-07.pdf.truth.json
 */
import fs from 'node:fs';
import path from 'node:path';
import type { CorpusCase } from '@/server/samples/corpus';
import { parseTruth, type Truth } from './truth';

const MIME: Record<string, string> = {
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
};
const TRUTH_SUFFIX = '.truth.json';

export type LoadedCorpus = {
  dir: string;
  cases: CorpusCase[];
  /** Documents with no truth file beside them. They are not evaluated. */
  withoutTruth: string[];
  /** Truth files that are invalid or have no document beside them. */
  errors: string[];
};

function walk(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

export function loadCorpusDir(dir: string): LoadedCorpus {
  const files = walk(dir);
  const set = new Set(files);
  const cases: CorpusCase[] = [];
  const withoutTruth: string[] = [];
  const errors: string[] = [];
  for (const file of files) {
    const rel = path.relative(dir, file);
    if (file.endsWith(TRUTH_SUFFIX)) {
      if (!set.has(file.slice(0, -TRUTH_SUFFIX.length))) errors.push(`${rel}: no document named ${path.basename(file.slice(0, -TRUTH_SUFFIX.length))} beside it.`);
      continue;
    }
    const mimeType = MIME[path.extname(file).toLowerCase()];
    if (!mimeType) continue; // READMEs, notes, anything that is not a document
    const truthPath = file + TRUTH_SUFFIX;
    if (!set.has(truthPath)) {
      withoutTruth.push(rel);
      continue;
    }
    let truth: Truth;
    try {
      truth = parseTruth(JSON.parse(fs.readFileSync(truthPath, 'utf8')), path.relative(dir, truthPath));
    } catch (err) {
      errors.push(err instanceof SyntaxError ? `${rel}${TRUTH_SUFFIX}: not valid JSON (${err.message}).` : (err as Error).message);
      continue;
    }
    cases.push({ id: rel.split(path.sep).join('/'), file: { filename: path.basename(file), mimeType, bytes: new Uint8Array(fs.readFileSync(file)) }, truth });
  }
  return { dir, cases, withoutTruth, errors };
}

/** Write cases to a directory in the corpus format (used to inspect the synthetic corpus). */
export function writeCorpusDir(dir: string, cases: CorpusCase[]): void {
  fs.mkdirSync(dir, { recursive: true });
  for (const c of cases) {
    const file = path.join(dir, c.file.filename);
    fs.writeFileSync(file, c.file.bytes);
    fs.writeFileSync(file + TRUTH_SUFFIX, JSON.stringify(c.truth, null, 2) + '\n');
  }
}
