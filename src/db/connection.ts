/**
 * How the app connects to PostgreSQL: pool size, and TLS.
 *
 * node-postgres 8 treats `sslmode=require` as full verification against the
 * certificate authorities Node.js ships with. Managed databases that sign their
 * certificates with their own authority (Supabase does) then refuse to connect.
 * The secure fix is to trust that authority, not to switch verification off:
 *
 *   DATABASE_CA_CERT   the authority's PEM certificate, or the path to a file
 *                      holding it. For Supabase: Database settings → SSL
 *                      configuration → Download certificate.
 *
 * With it set, every connection is encrypted and the server's certificate and
 * host name are checked against that authority, whatever DATABASE_URL says
 * about sslmode.
 */
import fs from 'node:fs';
import type { Pool, PoolClient, PoolConfig } from 'pg';

/** A problem with how the database is set up, explained well enough to fix it. Shown on /api/health. */
export class DatabaseSetupError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'DatabaseSetupError';
  }
}

/**
 * verified    encrypted; the server proved who it is
 * unverified  encrypted, but anyone in the network path could pose as the server
 * off         not encrypted
 */
export type TlsMode = 'verified' | 'unverified' | 'off';

/** The environment variables read here; process.env by default. */
export type Env = Record<string, string | undefined>;

const URL_TLS_PARAMS = ['sslmode', 'sslrootcert', 'sslcert', 'sslkey', 'uselibpqcompat', 'ssl'];

function readCa(value: string | undefined): string | null {
  const v = value?.trim();
  if (!v) return null;
  // A certificate pasted into a one-line environment variable usually arrives with literal "\n".
  if (v.includes('-----BEGIN CERTIFICATE-----')) return v.replace(/\\n/g, '\n');
  try {
    const pem = fs.readFileSync(v, 'utf8');
    if (!pem.includes('-----BEGIN CERTIFICATE-----')) throw new Error('the file holds no PEM certificate');
    return pem;
  } catch (err) {
    throw new DatabaseSetupError(`DATABASE_CA_CERT is neither a PEM certificate nor a readable certificate file (${(err as Error).message}).`);
  }
}

/** The node-postgres pool settings for DATABASE_URL and the environment. */
export function connectionConfig(url: string, env: Env = process.env): PoolConfig {
  // On serverless hosting every instance has its own pool; keep each one small.
  const max = Number(env.DATABASE_POOL_MAX) || (env.VERCEL ? 3 : 10);
  const ca = readCa(env.DATABASE_CA_CERT);
  if (!ca) return { connectionString: url, max };
  // node-postgres lets TLS settings in the URL override the `ssl` option, so take them out.
  const u = new URL(url);
  for (const p of URL_TLS_PARAMS) u.searchParams.delete(p);
  return { connectionString: u.toString(), max, ssl: { ca, rejectUnauthorized: true } };
}

/** Whether connections made with `config` are encrypted and verified, following node-postgres 8's rules. */
export function tlsMode(config: PoolConfig, env: Env = process.env): TlsMode {
  if (config.ssl && typeof config.ssl === 'object') return config.ssl.rejectUnauthorized === false ? 'unverified' : 'verified';
  const q = new URL(config.connectionString ?? 'postgres://localhost').searchParams;
  const mode = q.get('sslmode');
  if (mode) {
    if (mode === 'disable') return 'off';
    if (mode === 'no-verify') return 'unverified';
    if (q.get('uselibpqcompat') === 'true' && (mode === 'prefer' || mode === 'require')) return 'unverified';
    return 'verified';
  }
  const ssl = q.get('ssl');
  if (ssl !== null) return ssl === '0' || ssl === 'false' ? 'off' : 'verified';
  const envMode = env.PGSSLMODE;
  if (!envMode || envMode === 'disable') return 'off';
  return envMode === 'no-verify' ? 'unverified' : 'verified';
}

/**
 * Without DATABASE_URL the app falls back to the embedded database on local
 * disk. Serverless hosting has no writable disk that outlives a request, so
 * there it says what is missing instead of failing on a read-only file system.
 */
export function missingDatabaseUrl(env: Env = process.env): DatabaseSetupError | null {
  if (env.DATABASE_URL || !env.VERCEL) return null;
  return new DatabaseSetupError(
    'DATABASE_URL is not set. On Vercel, add it under Project Settings → Environment Variables (for Supabase, the session pooler connection string), together with DATABASE_CA_CERT, then redeploy. See docs/operations.md, "Deploy on Vercel".',
  );
}

/** Supabase's hosts, where TLS is always available and a connection without it is a mistake. */
export function isSupabaseHost(url: string): boolean {
  try {
    const host = new URL(url).hostname;
    return host.endsWith('.supabase.co') || host.endsWith('.supabase.com');
  } catch {
    return false;
  }
}

const UNTRUSTED_CERT = new Set(['SELF_SIGNED_CERT_IN_CHAIN', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY', 'UNABLE_TO_GET_ISSUER_CERT']);

/** Rewrites a TLS failure into what to do about it. Other errors pass through unchanged. */
export function explainConnectError(err: unknown): unknown {
  const code = (err as { code?: string } | null)?.code;
  if (code && UNTRUSTED_CERT.has(code)) {
    return new DatabaseSetupError(
      'The database server’s TLS certificate is not signed by an authority this server trusts. ' +
        'Set DATABASE_CA_CERT to the database provider’s CA certificate (for Supabase: Database settings → SSL configuration → Download certificate). ' +
        'Do not turn certificate checks off.',
      { cause: err },
    );
  }
  if (code === 'ERR_TLS_CERT_ALTNAME_INVALID') {
    return new DatabaseSetupError('The database server’s TLS certificate was issued for a different host name than the one in DATABASE_URL. Use the host name the provider gives you.', { cause: err });
  }
  return err;
}

/** A pool for DATABASE_URL, with one connection already open: a misconfiguration fails here, at start, with an explanation. */
export async function connectPool(url: string, env: Env = process.env): Promise<{ pool: Pool; client: PoolClient; tls: TlsMode }> {
  const pg = await import('pg');
  const config = connectionConfig(url, env);
  const pool = new pg.default.Pool(config);
  // A connection that drops while idle (a database restart, a failover) is replaced on next use.
  // Without a listener, node-postgres would take the whole process down with it.
  pool.on('error', (err) => console.error('[db] an idle database connection failed and will be replaced:', err.message));
  if (env.VERCEL) {
    // Fluid compute suspends idle instances; this closes idle connections first, so they do not hold pooler slots while frozen.
    const { attachDatabasePool } = await import('@vercel/functions');
    attachDatabasePool(pool);
  }
  try {
    const client = await pool.connect();
    return { pool, client, tls: tlsMode(config, env) };
  } catch (err) {
    await pool.end().catch(() => {});
    throw explainConnectError(err);
  }
}
