// Every test file gets its own database and its own in-memory document store.
//
// `pnpm test`     the embedded database (PGlite), in memory.
// `pnpm test:pg`  a real PostgreSQL server through node-postgres. The global
//                 setup starts the server; here each file creates a database
//                 of its own on it, so files stay isolated and can run in parallel.
import { randomBytes } from 'node:crypto';

process.env.RCM_DATA_DIR = ':memory:';
delete process.env.DATABASE_URL;
delete process.env.ANTHROPIC_API_KEY;
delete process.env.RESEND_API_KEY;
delete process.env.PROCORE_CLIENT_ID;
delete process.env.PROCORE_CLIENT_SECRET;
delete process.env.RCM_STORAGE;

const admin = process.env.RCM_TEST_PG_ADMIN_URL;
if (admin) {
  const { default: pg } = await import('pg');
  const name = `rcm_t_${randomBytes(6).toString('hex')}`;
  const client = new pg.Client({ connectionString: admin });
  await client.connect();
  await client.query(`create database ${name}`);
  await client.end();
  const url = new URL(admin);
  url.pathname = `/${name}`;
  process.env.DATABASE_URL = url.toString();
}
