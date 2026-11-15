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

export type DB = PgDatabase<PgQueryResultHKT, Record<string, never>>;

type Handle = { db: DB; close: () => Promise<void>; driver: 'pglite' | 'postgres' };

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
    const pg = await import('pg');
    const { drizzle } = await import('drizzle-orm/node-postgres');
    const { migrate } = await import('drizzle-orm/node-postgres/migrator');
    const pool = new pg.default.Pool({ connectionString: url, max: 10 });
    const db = drizzle(pool);
    await migrate(db, { migrationsFolder: migrationsFolder() });
    return { db: db as unknown as DB, close: () => pool.end(), driver: 'postgres' };
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

/** Close the connection. Used by scripts and tests. */
export async function closeDb(): Promise<void> {
  if (!g.__rcmDb) return;
  const handle = await g.__rcmDb.catch(() => null);
  g.__rcmDb = undefined;
  if (handle) await handle.close();
}
