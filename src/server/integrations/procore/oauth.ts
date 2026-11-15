/**
 * Procore OAuth 2.0 (authorization code) and token storage.
 *
 * Tokens live on the organisation's `integrations` row (provider 'procore'),
 * encrypted at rest.
 *
 * Procore's refresh tokens are single-use. Any refresh call spends the token
 * it presents, whether it succeeds or not, even when the answer is lost on the
 * way back. So:
 *   - Renewals are serialised per organisation across every server process by
 *     a dedicated PostgreSQL advisory lock (`procore-refresh:<org>`). Whoever
 *     holds it re-reads the stored pair first. If another process has already
 *     renewed, that pair is used, and a spent refresh token is never presented
 *     twice.
 *   - The renewed pair is written to the database, inside the same lock,
 *     before the new access token is handed to anyone.
 *   - A renewal that gets no answer is not treated as a lost connection. The
 *     next attempt shows whether Procore spent the token.
 *
 * The refresh lock is held across the call to Procore's token endpoint. That
 * is what makes it work. It is not the organisation's write lock: that one is
 * taken only for the moment the new pair is written, after Procore has
 * answered (see src/db/tx.ts: no network calls under the organisation lock).
 */
import { and, eq, sql } from 'drizzle-orm';
import type { DB } from '@/db';
import { integrations } from '@/db/schema';
import { currentTx, withOrgLock } from '@/db/tx';
import { UserError } from '@/server/auth/permissions';
import { appUrl, procoreConfig, type ProcoreConfig, type ProcoreEnv } from '@/server/config';
import { decryptJson, encryptJson } from '@/server/crypto';
import { ProcoreApiError, ProcoreAuthError, safeExcerpt } from './client';

const TIMEOUT_MS = 20_000;
/** Renew when the access token has less than this long to live. */
const REFRESH_MARGIN_MS = 2 * 60_000;

export type ConfiguredProcore = Extract<ProcoreConfig, { configured: true }>;
export type TokenSet = { accessToken: string; refreshToken: string; /** Epoch milliseconds. */ expiresAt: number };
export type ProcoreIntegrationConfig = { env: ProcoreEnv; companyId: string | null; companyName: string | null };
export type IntegrationRow = typeof integrations.$inferSelect;

export const NOT_CONFIGURED = 'Procore is not configured for this deployment.';
export const NOT_CONNECTED = 'Procore is not connected. Connect it in Settings → Integrations.';
export const RECONNECT = 'Procore no longer accepts this connection’s authorization. Reconnect Procore in Settings → Integrations.';
export const RENEWAL_UNANSWERED =
  'Procore did not answer while this connection was being renewed. Try again in a few minutes. If Procore then refuses the renewal, reconnect Procore in Settings → Integrations.';
const UNREADABLE = 'The stored Procore credentials could not be read. Reconnect Procore in Settings → Integrations.';

/** The connection itself is unusable (as opposed to one record being refused). */
export class ProcoreConnectionError extends UserError {
  constructor(message: string) {
    super(message);
    this.name = 'ProcoreConnectionError';
  }
}

export function requireProcoreConfig(): ConfiguredProcore {
  const cfg = procoreConfig();
  if (!cfg.configured) throw new ProcoreConnectionError(NOT_CONFIGURED);
  return cfg;
}

export function envMismatch(connectedEnv: ProcoreEnv, configuredEnv: ProcoreEnv): string {
  return `This connection was made to Procore’s ${connectedEnv} environment, but this deployment is now set to ${configuredEnv}. Reconnect Procore.`;
}

// ── OAuth endpoints ─────────────────────────────────────────────────────────

/** Must match a redirect URI registered on the app in the Procore Developer Portal, character for character. */
export function redirectUri(): string {
  return `${appUrl()}/api/integrations/procore/callback`;
}

export function authorizeUrl(state: string): string {
  const cfg = requireProcoreConfig();
  const url = new URL(`${cfg.loginBase.replace(/\/$/, '')}/oauth/authorize`);
  url.searchParams.set('client_id', cfg.clientId);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('redirect_uri', redirectUri());
  url.searchParams.set('state', state);
  return url.toString();
}

/**
 * POST to the login host. Sent as form-data, the encoding Procore's guides use
 * for /oauth/token and /oauth/revoke. Never retried: a repeated refresh would
 * present an already-spent token.
 */
async function loginRequest(path: '/oauth/token' | '/oauth/revoke', fields: Record<string, string>): Promise<unknown> {
  const cfg = requireProcoreConfig();
  const secrets = [cfg.clientSecret, fields.code, fields.refresh_token, fields.token];
  const form = new FormData();
  for (const [key, value] of Object.entries({ client_id: cfg.clientId, client_secret: cfg.clientSecret, ...fields })) form.set(key, value);
  let response: Response;
  let text: string;
  try {
    response = await fetch(`${cfg.loginBase.replace(/\/$/, '')}${path}`, {
      method: 'POST',
      headers: { Accept: 'application/json' },
      body: form,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    text = await response.text();
  } catch (err) {
    const timedOut = err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError');
    throw new ProcoreApiError(0, timedOut ? `no response within ${TIMEOUT_MS / 1000} seconds` : 'the connection failed', true);
  }
  // invalid_grant, invalid_client and friends: the code or token we presented is not good.
  if (response.status === 400 || response.status === 401) throw new ProcoreAuthError(`Procore refused the authorization: ${safeExcerpt(text, secrets) || response.status}`);
  if (!response.ok) throw new ProcoreApiError(response.status, safeExcerpt(text, secrets));
  if (!text.trim()) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    // Never echo the body here: a token response is exactly what it would contain.
    throw new ProcoreApiError(response.status, 'the response was not JSON');
  }
}

function toTokenSet(data: unknown, now: number): TokenSet {
  const o = (data ?? {}) as Record<string, unknown>;
  if (typeof o.access_token !== 'string' || !o.access_token || typeof o.refresh_token !== 'string' || !o.refresh_token) {
    throw new ProcoreApiError(200, 'the token response did not contain an access token and a refresh token');
  }
  const expiresIn = Number(o.expires_in);
  return { accessToken: o.access_token, refreshToken: o.refresh_token, expiresAt: now + (Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn : 5400) * 1000 };
}

/** Trade the single-use authorization code (valid 10 minutes) for tokens. */
export async function exchangeCode(code: string): Promise<TokenSet> {
  const now = Date.now();
  return toTokenSet(await loginRequest('/oauth/token', { grant_type: 'authorization_code', code, redirect_uri: redirectUri() }), now);
}

/**
 * Returns a NEW pair. The refresh token passed in is spent by this call
 * whatever happens, even if the answer never arrives. Persist the result
 * before using it. Only `renewAccessToken` should call this outside tests.
 */
export async function refreshTokens(refreshToken: string): Promise<TokenSet> {
  const now = Date.now();
  return toTokenSet(await loginRequest('/oauth/token', { grant_type: 'refresh_token', refresh_token: refreshToken, redirect_uri: redirectUri() }), now);
}

/**
 * Revoke an access token, which also revokes its refresh token. Procore answers
 * 200 even for a token it does not recognise, so success here confirms
 * revocation only when the token was known to be valid.
 */
export async function revoke(accessToken: string): Promise<void> {
  await loginRequest('/oauth/revoke', { token: accessToken });
}

// ── Stored connection ───────────────────────────────────────────────────────

const procoreRow = (orgId: string) => and(eq(integrations.orgId, orgId), eq(integrations.provider, 'procore'));

export async function loadIntegration(db: DB, orgId: string): Promise<IntegrationRow | null> {
  const [row] = await db.select().from(integrations).where(procoreRow(orgId));
  return row ?? null;
}

export function integrationConfig(row: IntegrationRow): ProcoreIntegrationConfig {
  const c = row.config as Partial<Record<keyof ProcoreIntegrationConfig, unknown>>;
  return {
    env: c.env === 'production' ? 'production' : 'sandbox',
    companyId: typeof c.companyId === 'string' && c.companyId ? c.companyId : null,
    companyName: typeof c.companyName === 'string' && c.companyName ? c.companyName : null,
  };
}

/** Write to the organisation's Procore row. Callers hold the organisation lock (`withOrgLock`). */
export async function updateIntegration(db: DB, orgId: string, values: Partial<typeof integrations.$inferInsert>): Promise<void> {
  await db.update(integrations).set(values).where(procoreRow(orgId));
}

/** The stored config with `patch` applied, keeping keys this module does not interpret (such as push records). */
export function patchConfig(row: IntegrationRow | null, patch: Record<string, unknown>): Record<string, unknown> {
  return { ...(row?.config ?? {}), ...patch };
}

export function readTokens(row: IntegrationRow): TokenSet | null {
  if (!row.credentials) return null;
  try {
    const t = decryptJson<Partial<TokenSet>>(row.credentials);
    if (typeof t.accessToken !== 'string' || typeof t.refreshToken !== 'string' || typeof t.expiresAt !== 'number') return null;
    return { accessToken: t.accessToken, refreshToken: t.refreshToken, expiresAt: t.expiresAt };
  } catch {
    return null;
  }
}

const fresh = (tokens: TokenSet) => tokens.expiresAt - Date.now() > REFRESH_MARGIN_MS;

/** One renewal per organisation at a time in this process. The database lock covers other processes. */
const refreshing = new Map<string, Promise<string>>();

/**
 * A valid access token for the organisation's Procore connection, renewing it
 * when it expires within two minutes (or when `forceRefresh` is set because
 * Procore just answered 401 to it).
 */
export async function getAccessToken(db: DB, orgId: string, opts: { forceRefresh?: boolean } = {}): Promise<string> {
  const cfg = requireProcoreConfig();
  const row = await loadIntegration(db, orgId);
  if (!row || !row.credentials) throw new ProcoreConnectionError(NOT_CONNECTED);
  const env = integrationConfig(row).env;
  if (env !== cfg.env) throw new ProcoreConnectionError(envMismatch(env, cfg.env));
  if (row.status !== 'connected') throw new ProcoreConnectionError(row.lastError || RECONNECT);

  const tokens = readTokens(row);
  if (!tokens) {
    await withOrgLock(db, orgId, (tx) => updateIntegration(tx, orgId, { status: 'error', lastError: UNREADABLE }));
    throw new ProcoreConnectionError(UNREADABLE);
  }
  if (!opts.forceRefresh && fresh(tokens)) return tokens.accessToken;

  const running = refreshing.get(orgId);
  if (running) return running;
  const mine = renewAccessToken(db, orgId, { stale: tokens.accessToken }).finally(() => refreshing.delete(orgId));
  refreshing.set(orgId, mine);
  return mine;
}

type Renewal = { token: string } | { failure: string };

/**
 * Renew the organisation's tokens, at most once however many processes ask at
 * the same moment. `stale` is the access token the caller found expiring or saw
 * refused. If the stored token is no longer that one, someone else has already
 * renewed, and their token is returned without calling Procore.
 *
 * Exported for tests that stand in for several server processes. Everything
 * else calls getAccessToken.
 */
export async function renewAccessToken(db: DB, orgId: string, { stale }: { stale: string }): Promise<string> {
  // Holding the organisation lock while waiting on Procore would stall every write for this organisation.
  if (currentTx()) throw new Error('A Procore token renewal was started inside a locked database transaction. Call Procore before or after the transaction, never inside it.');
  const outcome = await db.transaction(async (raw): Promise<Renewal> => {
    const tx = raw as unknown as DB;
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`procore-refresh:${orgId}`}))`);
    const mark = (values: Partial<typeof integrations.$inferInsert>) => withOrgLock(tx, orgId, (locked) => updateIntegration(locked, orgId, values));

    const row = await loadIntegration(tx, orgId);
    if (!row || !row.credentials) return { failure: NOT_CONNECTED };
    if (row.status !== 'connected') return { failure: row.lastError || RECONNECT };
    const current = readTokens(row);
    if (!current) {
      await mark({ status: 'error', lastError: UNREADABLE });
      return { failure: UNREADABLE };
    }
    // Renewed by someone else while we waited for the lock.
    if (current.accessToken !== stale && fresh(current)) return { token: current.accessToken };

    let next: TokenSet;
    try {
      next = await refreshTokens(current.refreshToken);
    } catch (err) {
      if (err instanceof ProcoreAuthError) {
        // We presented the newest stored refresh token and Procore refused it: it is spent or revoked.
        // The one exception is a reconnect that replaced the whole row while we were asking.
        const latest = await loadIntegration(tx, orgId);
        const theirs = latest?.status === 'connected' && latest.credentials !== row.credentials ? (latest ? readTokens(latest) : null) : null;
        if (theirs && fresh(theirs)) return { token: theirs.accessToken };
        await mark({ status: 'error', lastError: RECONNECT });
        return { failure: RECONNECT };
      }
      // No answer, or a server error. Procore may have spent the refresh token or may not have.
      // Keep the connection; the next attempt will find out.
      await mark({ lastError: RENEWAL_UNANSWERED });
      return { failure: RENEWAL_UNANSWERED };
    }
    // Persist before anyone uses the new token: losing this pair would lose the connection.
    await mark({ credentials: encryptJson(next), status: 'connected', lastError: null });
    return { token: next.accessToken };
  });
  if ('failure' in outcome) throw new ProcoreConnectionError(outcome.failure);
  return outcome.token;
}
