/**
 * Measures how well the document readers read billing packages, against
 * ground truth. See docs/extraction-evaluation.md.
 *
 *   pnpm eval:extraction --set synthetic --engine text
 *   pnpm eval:extraction --set real --engine claude --json out.json
 *
 * Synthetic results come from this project's own renderer and say nothing
 * about real documents. Real results come only from eval/real.
 */
import fs from 'node:fs';
import { runCli } from '../src/server/documents/evaluation/cli';
import { parseEnv } from './ai-key-lib';

// The AI settings saved by `pnpm ai:key`, when the shell does not set them (`ANTHROPIC_API_KEY=` in the
// shell turns AI off). Only these: the local .env may point at a live database, and this harness has no
// business with it.
if (fs.existsSync('.env')) {
  const local = parseEnv(fs.readFileSync('.env', 'utf8'));
  for (const name of ['ANTHROPIC_API_KEY', 'RCM_EXTRACTION_MODEL', 'RCM_EXTRACTION_TIMEOUT_SECONDS', 'RCM_EXTRACTION_FALLBACKS']) {
    if (process.env[name] === undefined && local[name]) process.env[name] = local[name];
  }
}

runCli(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err) => {
    console.error(err instanceof Error ? (err.stack ?? err.message) : err);
    process.exit(2);
  },
);
