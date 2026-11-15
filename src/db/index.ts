/**
 * Database access.
 *
 * - DATABASE_URL set  → PostgreSQL via node-postgres (production).
 * - otherwise         → PGlite, real Postgres compiled to WASM, running
 *                       in-process and persisted under RCM_DATA_DIR. This is
 *                       what makes `pnpm dev` and the test suite zero-setup
 *                       while keeping one SQL dialect and one set of migrations.
 *
 * PGlite is single-process. A pid lock stops a second process (for example a
 * seed script run while the dev server is up) from corrupting the data files.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import { dataDir, isInMemory } from '@/server/config';
import { connectPool, isSupabaseHost, type TlsMode } from './connection';
import { assertMigrationsApplied, assertSchemaNotAppliedExternally, migrationMode } from './migrations';

export type DB = PgDatabase<PgQueryResultHKT, Record<string, never>>;

type Handle = { db: DB; close: () => Promise<void>; driver: 'pglite' | 'postgres'; tls: TlsMode | null; supabase: boolean };

const g = globalThis as unknown as { __rcmDb?: Promise<Handle> };

function migrationsFolder(): string {
  return path.join(process.cwd(), 'drizzle');
}

function acquireLock(dir: string): () => void {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'db.lock');
  if (fs.existsSync(file)) {
    const pid = Number(fs.readFileSync(file, 'utf8').trim());
    if (pid && pid !== process.pid) {
      let alive = false;
      try {
        process.kill(pid, 0);
        alive = true;
      } catch {
        alive = false;
      }
      if (alive) {
        throw new Error(
          `The embedded database in ${dir} is already open in process ${pid} (is the dev server running?). ` +
            'Stop that process first, or point RCM_DATA_DIR at a different directory.',
        );
      }
    }
  }
  fs.writeFileSync(file, String(process.pid));
  const release = () => {
    try {
      if (fs.readFileSync(file, 'utf8').trim() === String(process.pid)) fs.unlinkSync(file);
    } catch {
      /* already gone */
    }
  };
  process.once('exit', release);
  return release;
}

async function open(): Promise<Handle> {
  const url = process.env.DATABASE_URL;
  if (url) {
    const { drizzle } = await import('drizzle-orm/node-postgres');
    const { migrate } = await import('drizzle-orm/node-postgres/migrator');
    const { pool, client, tls } = await connectPool(url);
    if (tls === 'off' && isSupabaseHost(url)) console.warn('[db] the connection to Supabase is not encrypted. Set DATABASE_CA_CERT; see docs/operations.md.');
    try {
      const query = (text: string) => client.query(text);
      if (migrationMode() === 'external') {
        // Supabase's GitHub integration applies them; refuse to run on a schema older than this code.
        await assertMigrationsApplied(query, migrationsFolder());
      } else {
        await assertSchemaNotAppliedExternally(query, migrationsFolder());
        // Several app instances starting together must not apply the same migration twice.
        // A session-level lock: connect through a direct connection or a session-mode pooler, not a transaction-mode one.
        await client.query('select pg_advisory_lock(hashtext($1))', ['rcm:migrations']);
        try {
          await migrate(drizzle(client), { migrationsFolder: migrationsFolder() });
        } finally {
          await client.query('select pg_advisory_unlock(hashtext($1))', ['rcm:migrations']).catch(() => {});
        }
      }
    } catch (err) {
      client.release();
      await pool.end().catch(() => {});
      throw err;
    }
    client.release();
    const db = drizzle(pool);
    return { db: db as unknown as DB, close: () => pool.end(), driver: 'postgres', tls, supabase: isSupabaseHost(url) };
  }

  const { PGlite } = await import('@electric-sql/pglite');
  const { drizzle } = await import('drizzle-orm/pglite');
  const { migrate } = await import('drizzle-orm/pglite/migrator');
  let release = () => {};
  let client;
  if (isInMemory()) {
    client = new PGlite();
  } else {
    const dir = dataDir();
    release = acquireLock(dir);
    client = new PGlite(path.join(dir, 'pg'));
  }
  const db = drizzle(client);
  await migrate(db, { migrationsFolder: migrationsFolder() });
  return {
    db: db as unknown as DB,
    driver: 'pglite',
    tls: null,
    supabase: false,
    close: async () => {
      await client.close();
      release();
    },
  };
}

export async function getDb(): Promise<DB> {
  if (!g.__rcmDb) {
    g.__rcmDb = open().catch((err) => {
      g.__rcmDb = undefined;
      throw err;
    });
  }
  return (await g.__rcmDb).db;
}

export async function dbDriver(): Promise<'pglite' | 'postgres'> {
  await getDb();
  return (await g.__rcmDb!).driver;
}

/** How this process is connected: which driver, whether the connection is encrypted, and whether it is a Supabase host. */
export async function dbConnection(): Promise<{ driver: 'pglite' | 'postgres'; tls: TlsMode | null; supabase: boolean }> {
  await getDb();
  const { driver, tls, supabase } = await g.__rcmDb!;
  return { driver, tls, supabase };
}

/** Close the connection. Used by scripts and tests. */
export async function closeDb(): Promise<void> {
  if (!g.__rcmDb) return;
  const handle = await g.__rcmDb.catch(() => null);
  g.__rcmDb = undefined;
  if (handle) await handle.close();
}
