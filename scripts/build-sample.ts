/**
 * Rebuilds what the public sample page (/sample) shows: the snapshot in
 * src/content/sample-workflow.json and the PDF under public/sample.
 *
 *   pnpm sample:build
 *
 * The sample is produced by the real pipeline, on a database that exists only
 * in this process's memory. It never opens the data directory or a configured
 * database, so it is safe to run while the dev server is up. Run it again
 * whenever tests/sample-workflow.test.ts says the snapshot is out of date.
 */
import fs from 'node:fs';
import path from 'node:path';

// Set before the database is opened: an embedded in-memory database, documents kept in memory, no AI reading.
process.env.RCM_DATA_DIR = ':memory:';
delete process.env.DATABASE_URL;
delete process.env.RCM_STORAGE;
delete process.env.ANTHROPIC_API_KEY;

/** The moment the sample is "looked at". Fixed, and the same in the test, so every build gives the same snapshot. */
const NOW = new Date('2026-11-05T15:00:00Z');

async function main() {
  // Loaded here, not at the top, so nothing reads the environment before the lines above have run.
  const { closeDb, getDb } = await import('../src/db');
  const { buildSampleWorkflow } = await import('../src/server/services/sample-workflow');

  const { snapshot, pdf } = await buildSampleWorkflow(await getDb(), NOW);
  await closeDb();

  const json = path.join(process.cwd(), 'src', 'content', 'sample-workflow.json');
  const file = path.join(process.cwd(), 'public', ...snapshot.document.url.split('/').filter(Boolean));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(json, `${JSON.stringify(snapshot, null, 2)}\n`);
  fs.writeFileSync(file, pdf);

  const rel = (p: string) => path.relative(process.cwd(), p);
  console.log(`Wrote ${rel(json)} and ${rel(file)} (${snapshot.document.pageCount} pages).`);
  console.log(`Application #${snapshot.application.number}: ${snapshot.checks.blocking} blocking, ${snapshot.checks.warnings} warnings, ${snapshot.checks.passed} checks passed.`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
