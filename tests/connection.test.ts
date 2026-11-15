/**
 * TLS to the database. Managed providers such as Supabase sign their server
 * certificates with their own authority, which node-postgres does not trust by
 * default; DATABASE_CA_CERT makes the app trust exactly that authority. The
 * last block runs a real PostgreSQL server with TLS on and a certificate from a
 * throwaway authority, and checks that verification really happens.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connectionConfig, connectPool, DatabaseSetupError, type Env, explainConnectError, isSupabaseHost, tlsMode } from '@/db/connection';

const PEM = '-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n';
const URL_ = 'postgres://u:p%40ss@db.example.com:5432/app';

describe('connection settings', () => {
  it('passes DATABASE_URL through untouched without a CA certificate', () => {
    expect(connectionConfig(`${URL_}?sslmode=require`, {})).toEqual({ connectionString: `${URL_}?sslmode=require`, max: 10 });
    expect(connectionConfig(URL_, { DATABASE_POOL_MAX: '4' }).max).toBe(4);
  });

  it('with a CA certificate, verifies against it and drops TLS settings from the URL, which would otherwise win', () => {
    const c = connectionConfig(`${URL_}?sslmode=no-verify&application_name=rcm`, { DATABASE_CA_CERT: PEM });
    expect(c.ssl).toEqual({ ca: PEM.trim(), rejectUnauthorized: true });
    expect(c.connectionString).toBe(`${URL_}?application_name=rcm`);
  });

  it('accepts the certificate pasted into one line, or as a file', () => {
    expect(connectionConfig(URL_, { DATABASE_CA_CERT: PEM.replace(/\n/g, '\\n') }).ssl).toEqual({ ca: PEM, rejectUnauthorized: true });
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'rcm-ca-')), 'ca.crt');
    fs.writeFileSync(file, PEM);
    expect(connectionConfig(URL_, { DATABASE_CA_CERT: file }).ssl).toEqual({ ca: PEM, rejectUnauthorized: true });
  });

  it('refuses a DATABASE_CA_CERT that is not a certificate', () => {
    expect(() => connectionConfig(URL_, { DATABASE_CA_CERT: '/nonexistent/ca.crt' })).toThrow(DatabaseSetupError);
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'rcm-ca-')), 'ca.crt');
    fs.writeFileSync(file, 'not a certificate');
    expect(() => connectionConfig(URL_, { DATABASE_CA_CERT: file })).toThrow(/no PEM certificate/);
  });

  it('reports whether connections are encrypted and verified, by node-postgres 8 rules', () => {
    const mode = (q: string, env: Env = {}) => tlsMode(connectionConfig(`${URL_}${q}`, env), env);
    expect(mode('')).toBe('off');
    expect(mode('?sslmode=disable')).toBe('off');
    expect(mode('?sslmode=require')).toBe('verified'); // node-postgres 8 verifies here, against Node's own CA list
    expect(mode('?sslmode=verify-full')).toBe('verified');
    expect(mode('?sslmode=no-verify')).toBe('unverified');
    expect(mode('?uselibpqcompat=true&sslmode=require')).toBe('unverified');
    expect(mode('', { PGSSLMODE: 'require' })).toBe('verified');
    expect(mode('?sslmode=no-verify', { DATABASE_CA_CERT: PEM })).toBe('verified');
  });

  it('recognises Supabase hosts', () => {
    expect(isSupabaseHost('postgres://postgres.abc:x@aws-1-ap-southeast-1.pooler.supabase.com:5432/postgres')).toBe(true);
    expect(isSupabaseHost('postgres://postgres:x@db.abc.supabase.co:5432/postgres')).toBe(true);
    expect(isSupabaseHost('postgres://rcm:x@db:5432/rcm')).toBe(false);
    expect(isSupabaseHost('not a url')).toBe(false);
  });

  it('explains certificate failures and leaves other errors alone', () => {
    expect(explainConnectError(Object.assign(new Error('self-signed certificate in certificate chain'), { code: 'SELF_SIGNED_CERT_IN_CHAIN' }))).toBeInstanceOf(DatabaseSetupError);
    const refused = Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
    expect(explainConnectError(refused)).toBe(refused);
  });
});

const openssl = (args: string[], cwd: string) => {
  const r = spawnSync('openssl', args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`openssl ${args[0]} failed: ${r.stderr}`);
};
const hasOpenssl = spawnSync('openssl', ['version']).status === 0;

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

/** An authority, and a server certificate for "localhost" signed by it. */
function makeCertificates(dir: string) {
  const ca = (name: string) =>
    openssl(['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', `${name}.key`, '-out', `${name}.crt`, '-days', '2', '-subj', `/CN=${name}`, '-addext', 'basicConstraints=critical,CA:TRUE', '-addext', 'keyUsage=critical,keyCertSign,cRLSign'], dir);
  ca('test-ca');
  ca('other-ca');
  openssl(['req', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'server.key', '-out', 'server.csr', '-subj', '/CN=localhost'], dir);
  fs.writeFileSync(path.join(dir, 'ext.cnf'), 'subjectAltName=DNS:localhost\nbasicConstraints=CA:FALSE\nkeyUsage=digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\n');
  openssl(['x509', '-req', '-in', 'server.csr', '-CA', 'test-ca.crt', '-CAkey', 'test-ca.key', '-CAcreateserial', '-out', 'server.crt', '-days', '2', '-extfile', 'ext.cnf'], dir);
  fs.chmodSync(path.join(dir, 'server.key'), 0o600); // PostgreSQL refuses a key others can read
}

describe.skipIf(!hasOpenssl)('a PostgreSQL server with TLS and its own certificate authority', () => {
  let dir = '';
  let port = 0;
  const password = 'tls-test-password';
  let server: { stop: () => Promise<void> } | null = null;
  const url = (host: string, query = '') => `postgres://postgres:${password}@${host}:${port}/postgres${query}`;

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rcm-tls-'));
    makeCertificates(dir);
    port = await freePort();
    const { default: EmbeddedPostgres } = await import('embedded-postgres');
    const pg = new EmbeddedPostgres({
      databaseDir: path.join(dir, 'data'),
      user: 'postgres',
      password,
      port,
      persistent: false,
      onLog: () => {},
      onError: () => {},
      postgresFlags: ['-c', 'ssl=on', '-c', `ssl_cert_file=${path.join(dir, 'server.crt')}`, '-c', `ssl_key_file=${path.join(dir, 'server.key')}`],
    });
    await pg.initialise();
    await pg.start();
    server = pg;
  }, 120_000);

  afterAll(async () => {
    await server?.stop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });

  const encrypted = async (connectionUrl: string, env: Env) => {
    const { pool, client, tls } = await connectPool(connectionUrl, env);
    try {
      const { rows } = await client.query<{ ssl: boolean }>('select ssl from pg_stat_ssl where pid = pg_backend_pid()');
      return { tls, ssl: rows[0]!.ssl };
    } finally {
      client.release();
      await pool.end();
    }
  };

  it('connects encrypted and verified with the authority set, even if the URL asks for no TLS', async () => {
    const ca = path.join(dir, 'test-ca.crt');
    expect(await encrypted(url('localhost', '?sslmode=disable'), { DATABASE_CA_CERT: ca })).toEqual({ tls: 'verified', ssl: true });
    const oneLine = fs.readFileSync(ca, 'utf8').trim().replace(/\n/g, '\\n');
    expect(await encrypted(url('localhost'), { DATABASE_CA_CERT: oneLine })).toEqual({ tls: 'verified', ssl: true });
  });

  it('refuses the server with sslmode=require alone, and says to set DATABASE_CA_CERT', async () => {
    await expect(connectPool(url('localhost', '?sslmode=require'), {})).rejects.toThrow(/not signed by an authority this server trusts.*DATABASE_CA_CERT/);
  });

  it('refuses a server whose certificate comes from a different authority', async () => {
    await expect(connectPool(url('localhost'), { DATABASE_CA_CERT: path.join(dir, 'other-ca.crt') })).rejects.toBeInstanceOf(DatabaseSetupError);
  });

  it('refuses a certificate issued for another host name', async () => {
    await expect(connectPool(url('127.0.0.1'), { DATABASE_CA_CERT: path.join(dir, 'test-ca.crt') })).rejects.toThrow(/different host name/);
  });

  it('reports an unencrypted connection as such', async () => {
    expect(await encrypted(url('localhost'), {})).toEqual({ tls: 'off', ssl: false });
  });
});
