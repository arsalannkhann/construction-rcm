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
import { runCli } from '../src/server/documents/evaluation/cli';

runCli(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err) => {
    console.error(err instanceof Error ? (err.stack ?? err.message) : err);
    process.exit(2);
  },
);
