/**
 * Procore OAuth 2.0 (authorization code) and token storage.
 *
 * Tokens live on the organisation's `integrations` row (provider 'procore'),
 * encrypted at rest. Procore rotates refresh tokens: every refresh returns a
 * new one and the old one stops working, so a renewed pair is always written
 * to the database before the new access token is handed to anyone.
 */
import { and, eq } from 'drizzle-orm';
import type { DB } from '@/db';
import { integrations } from '@/db/schema';
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

async function loginRequest(path: '/oauth/token' | '/oauth/revoke', fields: Record<string, string>): Promise<unknown> {
  const cfg = requireProcoreConfig();
  const secrets = [cfg.clientSecret, fields.code, fields.refresh_token, fields.token];
  let response: Response;
  let text: string;
  try {
    response = await fetch(`${cfg.loginBase.replace(/\/$/, '')}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams({ client_id: cfg.clientId, client_secret: cfg.clientSecret, ...fields }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    text = await response.text();
  } catch (err) {
    const timedOut = err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError');
    throw new ProcoreApiError(0, timedOut ? `no response within ${TIMEOUT_MS / 1000} seconds` : 'the connection failed');
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

/** Returns a NEW refresh token; the one passed in stops working. Persist the result before using it. */
export async function refreshTokens(refreshToken: string): Promise<TokenSet> {
  const now = Date.now();
  return toTokenSet(await loginRequest('/oauth/token', { grant_type: 'refresh_token', refresh_token: refreshToken, redirect_uri: redirectUri() }), now);
}

export async function revoke(token: string): Promise<void> {
  await loginRequest('/oauth/revoke', { token });
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

export async function updateIntegration(db: DB, orgId: string, values: Partial<typeof integrations.$inferInsert>): Promise<void> {
  await db.update(integrations).set(values).where(procoreRow(orgId));
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

/** One refresh at a time per organisation: a rotated refresh token can only be spent once. */
const refreshing = new Map<string, Promise<string>>();

/**
 * A valid access token for the organisation's Procore connection, renewing it
 * when it expires within two minutes (or when `forceRefresh` is set because
 * Procore just answered 401).
 */
export async function getAccessToken(db: DB, orgId: string, opts: { forceRefresh?: boolean } = {}): Promise<string> {
  const cfg = requireProcoreConfig();
  const row = await loadIntegration(db, orgId);
  if (!row || !row.credentials) throw new ProcoreConnectionError(NOT_CONNECTED);
  const env = integrationConfig(row).env;
  if (env !== cfg.env) throw new ProcoreConnectionError(envMismatch(env, cfg.env));
  if (row.status !== 'connected') throw new ProcoreConnectionError(RECONNECT);

  const tokens = readTokens(row);
  if (!tokens) {
    const message = 'The stored Procore credentials could not be read. Reconnect Procore in Settings → Integrations.';
    await updateIntegration(db, orgId, { status: 'error', lastError: message });
    throw new ProcoreConnectionError(message);
  }
  if (!opts.forceRefresh && tokens.expiresAt - Date.now() > REFRESH_MARGIN_MS) return tokens.accessToken;

  const running = refreshing.get(orgId);
  if (running) return running;
  const mine = renew(db, orgId, row.credentials, tokens).finally(() => refreshing.delete(orgId));
  refreshing.set(orgId, mine);
  return mine;
}

async function renew(db: DB, orgId: string, storedCiphertext: string, tokens: TokenSet): Promise<string> {
  let next: TokenSet;
  try {
    next = await refreshTokens(tokens.refreshToken);
  } catch (err) {
    if (err instanceof ProcoreAuthError) {
      // Another server process may have rotated the pair between our read and our request.
      const latest = await loadIntegration(db, orgId);
      if (latest?.status === 'connected' && latest.credentials && latest.credentials !== storedCiphertext) {
        const theirs = readTokens(latest);
        if (theirs && theirs.expiresAt - Date.now() > REFRESH_MARGIN_MS) return theirs.accessToken;
      }
      await updateIntegration(db, orgId, { status: 'error', lastError: RECONNECT });
      throw new ProcoreConnectionError(RECONNECT);
    }
    // Procore did not answer, or answered with a server error. The stored refresh token is still good.
    const message = 'Procore could not be reached to renew the connection. Try again in a few minutes.';
    await updateIntegration(db, orgId, { lastError: message });
    throw new ProcoreConnectionError(message);
  }
  // Persist first: if we lost this pair, the connection would be unrecoverable.
  await updateIntegration(db, orgId, { credentials: encryptJson(next), status: 'connected', lastError: null });
  return next.accessToken;
}
