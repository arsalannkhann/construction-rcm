/**
 * Checks that a database restored from a backup is complete and usable:
 *
 *   DATABASE_URL=postgres://…/restored pnpm backup:check [--expect counts.json] [--write counts.json]
 *
 *  1. Every migration this code needs is recorded (Supabase's history, or the app's own).
 *  2. Every organisation's audit trail verifies, hash by hash.
 *  3. Every stored file's bytes match their recorded SHA-256 and size, and every
 *     document and transfer file the records point to is there.
 *  4. Row counts per table; with --expect, they must equal the counts taken from
 *     the source when the dump was made (--write takes them).
 *
 * Prints counts and results only, never any organisation's data or identifiers (the
 * nightly backup runs in a public repository's CI log). Exits 1 on any failure.
 * It only reads; it never applies migrations to the database it checks.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Client } from 'pg';
import { listMigrations } from '../src/db/migrations';

type Counts = Record<string, number>;

async function main() {
  const args = process.argv.slice(2);
  const flag = (name: string) => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('Set DATABASE_URL to the database to check.');
  const client = new Client({ connectionString: url });
  await client.connect();
  const failures: string[] = [];
  const q = async <T = Record<string, unknown>>(text: string, params: unknown[] = []) => (await client.query(text, params)).rows as T[];

  try {
    // 4. Counts first, so --write can be used on the source.
    const tables = await q<{ name: string }>(`select c.relname as name from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind = 'r' order by 1`);
    const counts: Counts = {};
    for (const { name } of tables) counts[name] = Number((await q<{ n: string }>(`select count(*)::text as n from public."${name.replace(/"/g, '""')}"`))[0]!.n);
    const writeTo = flag('--write');
    if (writeTo) {
      fs.writeFileSync(writeTo, JSON.stringify(counts, null, 2) + '\n');
      console.log(`Wrote row counts for ${tables.length} tables to ${writeTo}.`);
      return;
    }
    const expectFrom = flag('--expect');
    if (expectFrom) {
      const expected = JSON.parse(fs.readFileSync(expectFrom, 'utf8')) as Counts;
      for (const name of new Set([...Object.keys(expected), ...Object.keys(counts)])) {
        if (expected[name] !== counts[name]) failures.push(`Table ${name}: ${counts[name] ?? 'missing'} rows restored, ${expected[name] ?? 'none'} in the source.`);
      }
    }
    console.log(`Tables: ${tables.length}, rows: ${Object.values(counts).reduce((a, b) => a + b, 0)}`);

    // 1. Migrations.
    const wanted = listMigrations(path.join(process.cwd(), 'drizzle'));
    const [{ supabase, drizzle }] = await q<{ supabase: boolean; drizzle: boolean }>(
      `select to_regclass('supabase_migrations.schema_migrations') is not null as supabase, to_regclass('drizzle.__drizzle_migrations') is not null as drizzle`,
    );
    if (supabase) {
      const applied = new Set((await q<{ version: string }>('select version from supabase_migrations.schema_migrations')).map((r) => String(r.version)));
      const missing = wanted.filter((m) => !applied.has(m.version));
      if (missing.length) failures.push(`Migrations missing from the Supabase history: ${missing.map((m) => `${m.version}_${m.tag}`).join(', ')}.`);
      else console.log(`Migrations: all ${wanted.length} recorded (Supabase history).`);
    } else if (drizzle) {
      const [{ n }] = await q<{ n: string }>('select count(*)::text as n from drizzle.__drizzle_migrations');
      if (Number(n) < wanted.length) failures.push(`Only ${n} of ${wanted.length} migrations are recorded.`);
      else console.log(`Migrations: all ${wanted.length} recorded (applied by the app).`);
    } else {
      failures.push('No migration history was restored (neither supabase_migrations nor drizzle). Include those schemas in the dump.');
    }

    // 2. Audit trails, recomputed with the app's own rule.
    const { verifyAuditChain } = await import('../src/server/audit');
    const { drizzle: wrap } = await import('drizzle-orm/node-postgres');
    const db = wrap(client) as unknown as Parameters<typeof verifyAuditChain>[0];
    const orgs = await q<{ id: string }>('select id from organizations order by id');
    let events = 0;
    // Organisations are numbered, not named: this output can land in a public CI log.
    for (const [i, { id }] of orgs.entries()) {
      const chain = await verifyAuditChain(db, id);
      events += chain.events;
      if (!chain.ok) failures.push(`Organisation ${i + 1} of ${orgs.length}: the audit trail is broken at event ${chain.brokenAtSeq}.`);
    }
    console.log(`Audit trails: ${orgs.length} organisation(s), ${events} events checked.`);

    // 3. Stored files, read in batches so a large database does not have to fit in memory.
    let objects = 0;
    let bytes = 0;
    let damaged = 0;
    let after = '';
    for (;;) {
      const batch = await q<{ key: string; sha256: string; size: number; bytes: Buffer }>('select key, sha256, size, bytes from stored_objects where key > $1 order by key limit 50', [after]);
      if (!batch.length) break;
      for (const o of batch) {
        objects += 1;
        bytes += o.bytes.length;
        const actual = createHash('sha256').update(o.bytes).digest('hex');
        if (actual !== o.sha256 || o.bytes.length !== o.size) damaged += 1;
      }
      after = batch.at(-1)!.key;
    }
    console.log(`Stored files: ${objects} checked, ${(bytes / 1_048_576).toFixed(1)} MB.`);
    if (damaged) failures.push(`${damaged} stored file(s) do not match their recorded checksum or size.`);
    const storedInDb = objects > 0;
    if (storedInDb) {
      const [{ n: lostDocs }] = await q<{ n: string }>('select count(*)::text as n from documents d where not exists (select 1 from stored_objects o where o.key = d.storage_key)');
      const [{ n: lostFiles }] = await q<{ n: string }>(
        `select count(*)::text as n from transfers t where t.storage_key is not null and not exists (select 1 from stored_objects o where o.key = t.storage_key)`,
      );
      if (Number(lostDocs) > 0) failures.push(`${lostDocs} document(s) point to files that were not restored.`);
      if (Number(lostFiles) > 0) failures.push(`${lostFiles} exported file(s) point to files that were not restored.`);
    }
  } finally {
    await client.end();
  }

  if (failures.length) {
    console.error(`\nRESTORE CHECK FAILED (${failures.length}):`);
    for (const f of failures) console.error(`- ${f}`);
    process.exitCode = 1;
  } else {
    console.log('\nRestore check passed.');
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
