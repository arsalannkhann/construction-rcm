import { afterAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { closeDb, dbDriver, getDb } from '@/db';

afterAll(async () => {
  await closeDb();
});

describe('database driver', () => {
  it('uses node-postgres when the suite runs against a PostgreSQL server, and the embedded database otherwise', async () => {
    const driver = await dbDriver();
    expect(driver).toBe(process.env.RCM_TEST_PG_ADMIN_URL ? 'postgres' : 'pglite');
    const db = await getDb();
    const result = await db.execute(sql`select version() as v`);
    const rows = (result as unknown as { rows: Array<{ v: string }> }).rows;
    expect(rows[0]!.v).toMatch(/PostgreSQL/);
    if (driver === 'postgres') console.info(`[test] running against ${rows[0]!.v.split(' on ')[0]}`);
  });
});
