/**
 * Starts a throwaway PostgreSQL server for `pnpm test:pg`, so the whole suite
 * runs against real PostgreSQL through node-postgres (the production driver)
 * instead of the embedded database. Each test file gets its own database on
 * this server; see tests/setup.ts.
 */
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import EmbeddedPostgres from 'embedded-postgres';

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as net.AddressInfo;
      server.close(() => resolve(port));
    });
  });
}

export default async function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rcm-pg-'));
  const port = await freePort();
  const password = randomBytes(12).toString('hex');
  const server = new EmbeddedPostgres({
    databaseDir: path.join(dir, 'data'),
    user: 'postgres',
    password,
    port,
    persistent: false,
    onLog: () => {},
    onError: (message) => {
      const text = String(message ?? '');
      if (/FATAL|PANIC/.test(text)) console.error('[postgres]', text);
    },
  });
  await server.initialise();
  await server.start();
  process.env.RCM_TEST_PG_ADMIN_URL = `postgres://postgres:${password}@127.0.0.1:${port}/postgres`;

  return async () => {
    await server.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  };
}
