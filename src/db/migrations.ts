/**
 * One chain of migrations, two ways to apply it.
 *
 *   app       (default) The app applies `drizzle/` itself when it starts,
 *             under an advisory lock. Any PostgreSQL, including Docker Compose.
 *   external  Something else applies them: on Supabase, the GitHub integration
 *             runs `supabase/migrations/` (generated from `drizzle/` by
 *             `pnpm db:supabase`) when changes reach the production branch.
 *             The app only checks, at start, that every migration it was built
 *             with has been applied, and refuses to run on an older schema.
 *
 * Set RCM_MIGRATIONS=external for the second. Never let both apply to the same
 * database: each keeps its own history and would try to create the tables again.
 */
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSetupError } from './connection';

export type MigrationMode = 'app' | 'external';

export function migrationMode(): MigrationMode {
  return process.env.RCM_MIGRATIONS === 'external' ? 'external' : 'app';
}

export type Migration = { tag: string; version: string; file: string };

/** The migrations in `folder`, in order, with the Supabase version (UTC timestamp) each one is published under. */
export function listMigrations(folder: string): Migration[] {
  const journal = JSON.parse(fs.readFileSync(path.join(folder, 'meta', '_journal.json'), 'utf8')) as { entries: Array<{ tag: string; when: number }> };
  return journal.entries.map((e) => ({ tag: e.tag, version: supabaseVersion(e.when), file: path.join(folder, `${e.tag}.sql`) }));
}

/** 1794695033593 → "20261113102353": Supabase orders migrations by this prefix. */
export function supabaseVersion(epochMs: number): string {
  return new Date(epochMs).toISOString().replace(/[-:T]/g, '').slice(0, 14);
}

/** The file name and content `pnpm db:supabase` writes for a migration. */
export function supabaseMigrationFile(m: Migration): { name: string; content: string } {
  const sql = fs.readFileSync(m.file, 'utf8');
  return {
    name: `${m.version}_${m.tag}.sql`,
    content: `-- Generated from drizzle/${m.tag}.sql by \`pnpm db:supabase\`. Do not edit: change the schema and run \`pnpm db:generate\` instead.\n${sql}`,
  };
}

export class SchemaBehindError extends DatabaseSetupError {
  constructor(message: string) {
    super(message);
    this.name = 'SchemaBehindError';
  }
}

type Query = (text: string) => Promise<{ rows: Array<Record<string, unknown>> }>;

/**
 * In `app` mode: refuse to apply `drizzle/` to a database whose schema already
 * came from `supabase/migrations`. It would fail on the first CREATE TABLE
 * (harmlessly: drizzle applies its batch in one transaction), but with an
 * error that does not say what is wrong.
 */
export async function assertSchemaNotAppliedExternally(query: Query, folder: string): Promise<void> {
  const { rows } = await query(
    "select to_regclass('supabase_migrations.schema_migrations') is not null as supabase, to_regclass('drizzle.__drizzle_migrations') is not null as app",
  );
  if (!rows[0]?.supabase || rows[0]?.app) return;
  const { rows: applied } = await query('select version from supabase_migrations.schema_migrations');
  const ours = new Set(listMigrations(folder).map((m) => m.version));
  if (applied.some((r) => ours.has(String(r.version)))) {
    throw new DatabaseSetupError(
      'This database’s schema was applied from supabase/migrations (by Supabase’s GitHub integration or `supabase db push`), not by the app. ' +
        'Set RCM_MIGRATIONS=external so the app checks the schema instead of applying its migrations a second time.',
    );
  }
}

/** In `external` mode: throw unless every migration this build knows has been applied. */
export async function assertMigrationsApplied(query: Query, folder: string): Promise<void> {
  const expected = listMigrations(folder);
  let applied: Set<string>;
  try {
    const { rows } = await query('select version from supabase_migrations.schema_migrations');
    applied = new Set(rows.map((r) => String(r.version)));
  } catch {
    throw new SchemaBehindError(
      'RCM_MIGRATIONS is "external" but this database has no Supabase migration history (supabase_migrations.schema_migrations). Apply supabase/migrations first, or unset RCM_MIGRATIONS to let the app apply its own migrations.',
    );
  }
  const missing = expected.filter((m) => !applied.has(m.version));
  if (missing.length > 0) {
    throw new SchemaBehindError(
      `The database schema is behind this version of the app: ${missing.map((m) => `${m.version}_${m.tag}`).join(', ')} not applied. ` +
        'Apply supabase/migrations (the Supabase GitHub integration does this when the change reaches the production branch), then restart.',
    );
  }
}
