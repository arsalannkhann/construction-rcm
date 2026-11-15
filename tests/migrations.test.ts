/**
 * The schema is applied two ways (by the app, or by Supabase's GitHub
 * integration from supabase/migrations) and must keep the records out of reach
 * of Supabase's Data API either way.
 */
import fs from 'node:fs';
import path from 'node:path';
import { sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { assertMigrationsApplied, assertSchemaNotAppliedExternally, listMigrations, SchemaBehindError, supabaseMigrationFile, supabaseVersion } from '@/db/migrations';
import { dataApiExposure } from '@/server/services/system';
import { createWorld } from './helpers/world';

const drizzleDir = path.join(process.cwd(), 'drizzle');
const supabaseDir = path.join(process.cwd(), 'supabase', 'migrations');
const rows = async <T,>(p: Promise<unknown>) => ((await p) as { rows: T[] }).rows;

describe('supabase/migrations', () => {
  it('is an exact, ordered copy of drizzle/ (run `pnpm db:supabase` after `pnpm db:generate`)', () => {
    const expected = listMigrations(drizzleDir).map(supabaseMigrationFile);
    const actual = fs.readdirSync(supabaseDir).filter((f) => f.endsWith('.sql')).sort();
    expect(actual).toEqual(expected.map((e) => e.name));
    for (const e of expected) expect(fs.readFileSync(path.join(supabaseDir, e.name), 'utf8')).toBe(e.content);
    // Supabase applies files in version order, so the versions must follow the drizzle order.
    const versions = expected.map((e) => e.name.slice(0, 14));
    expect([...versions].sort()).toEqual(versions);
  });

  it('versions migrations by their UTC creation time', () => {
    expect(supabaseVersion(Date.UTC(2026, 10, 13, 10, 23, 53, 593))).toBe('20261113102353');
  });
});

describe('checking the schema when migrations are applied elsewhere', () => {
  const all = listMigrations(drizzleDir).map((m) => ({ version: m.version }));

  it('refuses to start on a database with no Supabase migration history', async () => {
    const query = async () => {
      throw new Error('relation "supabase_migrations.schema_migrations" does not exist');
    };
    await expect(assertMigrationsApplied(query, drizzleDir)).rejects.toBeInstanceOf(SchemaBehindError);
  });

  it('refuses to start on a schema older than the code, naming what is missing', async () => {
    const latest = listMigrations(drizzleDir).at(-1)!;
    const query = async () => ({ rows: all.slice(0, -1) });
    await expect(assertMigrationsApplied(query, drizzleDir)).rejects.toThrow(new RegExp(`${latest.version}_${latest.tag} not applied`));
  });

  it('starts when every migration has been applied', async () => {
    await expect(assertMigrationsApplied(async () => ({ rows: all }), drizzleDir)).resolves.toBeUndefined();
  });
});

describe('applying migrations in the app', () => {
  const catalog = (supabase: boolean, app: boolean, versions: Array<{ version: string }>) => async (text: string) =>
    text.includes('to_regclass') ? { rows: [{ supabase, app }] } : { rows: versions };
  const ours = listMigrations(drizzleDir).map((m) => ({ version: m.version }));

  it('refuses when Supabase already applied this schema, and says to set RCM_MIGRATIONS=external', async () => {
    await expect(assertSchemaNotAppliedExternally(catalog(true, false, ours), drizzleDir)).rejects.toThrow(/RCM_MIGRATIONS=external/);
  });

  it('carries on for a fresh database, one it manages itself, or a Supabase history of unrelated migrations', async () => {
    await expect(assertSchemaNotAppliedExternally(catalog(false, false, []), drizzleDir)).resolves.toBeUndefined();
    await expect(assertSchemaNotAppliedExternally(catalog(true, true, ours), drizzleDir)).resolves.toBeUndefined();
    await expect(assertSchemaNotAppliedExternally(catalog(true, false, [{ version: '20200101000000' }]), drizzleDir)).resolves.toBeUndefined();
  });

  it('checks a real database without error', async () => {
    const w = await createWorld();
    const query = async (text: string) => (await w.db.execute(sql.raw(text))) as unknown as { rows: Array<Record<string, unknown>> };
    await expect(assertSchemaNotAppliedExternally(query, drizzleDir)).resolves.toBeUndefined();
  });
});

describe("Supabase's Data API", () => {
  it('can reach no table: every table has row level security, whoever applied the migrations', async () => {
    const w = await createWorld();
    const exposure = await dataApiExposure(w.db);
    expect(exposure.tablesWithoutRls).toEqual([]);
  });

  it('loses any privileges it had on the tables, and sees no rows even if they are granted again', async () => {
    const w = await createWorld();
    // Stand in for a Supabase project, whose API roles get full privileges on every new table by default.
    for (const role of ['anon', 'authenticated']) {
      await w.db.execute(sql.raw(`do $$ begin if not exists (select 1 from pg_roles where rolname = '${role}') then create role ${role} nologin; end if; end $$`));
      await w.db.execute(sql.raw(`grant select, insert, update, delete on all tables in schema public to ${role}`));
    }
    expect((await dataApiExposure(w.db)).exposedTables).toContain('pay_applications');

    // Migration 0002, exactly as Supabase or the app applies it.
    await w.db.execute(sql.raw(fs.readFileSync(path.join(drizzleDir, '0002_deny_data_api.sql'), 'utf8')));
    const after = await dataApiExposure(w.db);
    expect(after).toMatchObject({ rolesPresent: true, exposedTables: [], tablesWithoutRls: [] });

    // Even if someone grants access again, row level security with no policies returns nothing.
    await w.db.execute(sql`grant select on public.organizations to anon`);
    const seen = await w.db.transaction(async (tx) => {
      await tx.execute(sql`set local role anon`);
      const r = await rows<{ n: number }>(tx.execute(sql`select count(*)::int as n from public.organizations`));
      await tx.execute(sql`reset role`);
      return r[0]!.n;
    });
    expect(seen).toBe(0);
    const total = await rows<{ n: number }>(w.db.execute(sql`select count(*)::int as n from public.organizations`));
    expect(total[0]!.n).toBeGreaterThan(0);
    await w.db.execute(sql`revoke all on public.organizations from anon`);
  });
});
