/**
 * The organisation's Procore connection: status, connecting, choosing a
 * company, disconnecting. Also the helpers the import and push use to talk to
 * Procore on behalf of an organisation.
 */
import { and, eq } from 'drizzle-orm';
import type { DB } from '@/db';
import { integrations, users } from '@/db/schema';
import { recordAudit } from '@/server/audit';
import { assertCan, UserError, type Ctx } from '@/server/auth/permissions';
import { procoreConfig, type ProcoreEnv } from '@/server/config';
import { encryptJson } from '@/server/crypto';
import { newId, randomToken } from '@/server/ids';
import { createProcoreClient, procoreId, ProcoreApiError, ProcoreAuthError, ProcoreRateLimitError, type ProcoreClient } from './client';
import {
  authorizeUrl,
  envMismatch,
  exchangeCode,
  getAccessToken,
  integrationConfig,
  loadIntegration,
  NOT_CONFIGURED,
  NOT_CONNECTED,
  ProcoreConnectionError,
  readTokens,
  RECONNECT,
  requireProcoreConfig,
  revoke,
  updateIntegration,
  type TokenSet,
} from './oauth';

export type ProcoreStatus = {
  /** PROCORE_CLIENT_ID and PROCORE_CLIENT_SECRET are set on this deployment. */
  configured: boolean;
  env: ProcoreEnv | null;
  /** This organisation holds a usable authorization. False after a failed token renewal. */
  connected: boolean;
  /** Connected, but the Procore login can see several companies and none has been chosen. */
  needsCompany: boolean;
  companyId: string | null;
  companyName: string | null;
  lastSyncAt: Date | null;
  lastError: string | null;
  connectedByName: string | null;
};

export type ProcoreCompany = { id: string; name: string };

const NEEDS_COMPANY = 'Choose which Procore company to use in Settings → Integrations.';

/** Why connecting failed, as a short code that is safe to put in a redirect URL. */
export class ProcoreConnectFailure extends UserError {
  constructor(
    public readonly code: 'not_configured' | 'code_rejected' | 'unreachable',
    message: string,
  ) {
    super(message);
    this.name = 'ProcoreConnectFailure';
  }
}

// ── Talking to Procore for an organisation ──────────────────────────────────

/** A message a finance user can act on, or null when `err` did not come from Procore. */
export function describeProcoreError(err: unknown): string | null {
  if (err instanceof ProcoreAuthError) return RECONNECT;
  if (err instanceof ProcoreRateLimitError) {
    const wait = err.retryAfterSeconds;
    const when = wait === null ? 'in a few minutes' : wait < 90 ? `in ${Math.max(1, wait)} seconds` : `in about ${Math.ceil(wait / 60)} minutes`;
    return err.status === 429 ? `Procore is limiting how many requests it accepts right now. Try again ${when}.` : `Procore is temporarily unavailable. Try again ${when}.`;
  }
  if (err instanceof ProcoreApiError) {
    const detail = err.excerpt ? ` Procore said: ${err.excerpt}` : '';
    if (err.status === 0) return `Procore could not be reached (${err.excerpt}). Try again.`;
    if (err.status === 403) return `Procore refused the request (403). The Procore user who connected does not have permission for this.${detail}`;
    if (err.status === 404) return `Procore could not find the record (404). It may have been deleted, or it belongs to a different company than the one connected.${detail}`;
    return `Procore returned an error (${err.status}).${detail}`;
  }
  return null;
}

/** Turn Procore failures into UserErrors so screens can show them. Anything else is a bug and passes through. */
export async function friendly<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof UserError) throw err;
    const message = describeProcoreError(err);
    if (message) throw new UserError(message);
    throw err;
  }
}

function clientFor(db: DB, orgId: string, companyId: string | null): ProcoreClient {
  const cfg = requireProcoreConfig();
  return createProcoreClient({ apiBase: cfg.apiBase, companyId, token: (opts) => getAccessToken(db, orgId, opts) });
}

/** A client bound to the organisation's connection and chosen company. */
export async function openProcore(db: DB, orgId: string): Promise<{ client: ProcoreClient; companyId: string; companyName: string | null }> {
  requireProcoreConfig();
  const row = await loadIntegration(db, orgId);
  if (!row || !row.credentials) throw new ProcoreConnectionError(NOT_CONNECTED);
  const config = integrationConfig(row);
  if (!config.companyId) throw new ProcoreConnectionError(NEEDS_COMPANY);
  return { client: clientFor(db, orgId, config.companyId), companyId: config.companyId, companyName: config.companyName };
}

async function fetchCompanies(db: DB, orgId: string): Promise<ProcoreCompany[]> {
  const rows = await clientFor(db, orgId, null).getAll<Record<string, unknown>>('/rest/v1.0/companies');
  const out: ProcoreCompany[] = [];
  for (const r of rows) {
    const id = procoreId(r.id);
    if (!id || r.is_active === false) continue;
    out.push({ id, name: typeof r.name === 'string' && r.name.trim() ? r.name.trim() : `Company ${id}` });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

// ── Public API ──────────────────────────────────────────────────────────────

export async function procoreStatus(db: DB, ctx: Ctx): Promise<ProcoreStatus> {
  const cfg = procoreConfig();
  const env = cfg.configured ? cfg.env : null;
  const [row] = await db
    .select({ integration: integrations, connectedByName: users.name })
    .from(integrations)
    .leftJoin(users, eq(users.id, integrations.connectedBy))
    .where(and(eq(integrations.orgId, ctx.orgId), eq(integrations.provider, 'procore')));
  if (!row) return { configured: cfg.configured, env, connected: false, needsCompany: false, companyId: null, companyName: null, lastSyncAt: null, lastError: null, connectedByName: null };

  const config = integrationConfig(row.integration);
  const wrongEnv = cfg.configured && config.env !== cfg.env;
  const connected = cfg.configured && !wrongEnv && row.integration.status === 'connected' && !!row.integration.credentials;
  return {
    configured: cfg.configured,
    env,
    connected,
    needsCompany: connected && !config.companyId,
    companyId: config.companyId,
    companyName: config.companyName,
    lastSyncAt: row.integration.lastSyncAt,
    lastError: wrongEnv && cfg.configured ? envMismatch(config.env, cfg.env) : row.integration.lastError,
    connectedByName: row.connectedByName ?? null,
  };
}

/** Start the OAuth round trip. The caller keeps `state` (in a cookie) and sends the user to `url`. */
export function beginConnect(ctx: Ctx): { url: string; state: string } {
  assertCan(ctx, 'integrations:manage');
  if (!procoreConfig().configured) throw new ProcoreConnectFailure('not_configured', NOT_CONFIGURED);
  const state = randomToken(24);
  return { url: authorizeUrl(state), state };
}

/**
 * Finish the OAuth round trip: exchange the code, store the tokens, then look
 * at which companies the login can see. Exactly one is selected automatically;
 * with several the user is asked to choose.
 */
export async function completeConnect(db: DB, ctx: Ctx, code: string): Promise<void> {
  assertCan(ctx, 'integrations:manage');
  const cfg = procoreConfig();
  if (!cfg.configured) throw new ProcoreConnectFailure('not_configured', NOT_CONFIGURED);

  let tokens: TokenSet;
  try {
    tokens = await exchangeCode(code);
  } catch (err) {
    if (err instanceof ProcoreAuthError) {
      throw new ProcoreConnectFailure('code_rejected', 'Procore did not accept the authorization. The code may have expired (it lasts 10 minutes), or the redirect URI registered on the Procore app does not match this deployment. Try connecting again.');
    }
    if (err instanceof ProcoreApiError || err instanceof ProcoreRateLimitError) {
      throw new ProcoreConnectFailure('unreachable', describeProcoreError(err) ?? 'Procore could not be reached. Try connecting again.');
    }
    throw err;
  }

  const previous = await loadIntegration(db, ctx.orgId);
  // Reconnecting after an expired authorization keeps the company that imported records came from.
  const previousConfig = previous ? integrationConfig(previous) : null;
  const keepCompanyId = previousConfig && previousConfig.env === cfg.env ? previousConfig.companyId : null;
  const values = { status: 'connected', config: { env: cfg.env, companyId: null, companyName: null }, credentials: encryptJson(tokens), lastError: null, connectedBy: ctx.userId };
  const integrationId = previous?.id ?? newId('int');
  if (previous) await updateIntegration(db, ctx.orgId, values);
  else await db.insert(integrations).values({ id: integrationId, orgId: ctx.orgId, provider: 'procore', ...values });

  let company: ProcoreCompany | null = null;
  let companyCount: number | null = null;
  let note: string | null = null;
  try {
    const companies = await fetchCompanies(db, ctx.orgId);
    companyCount = companies.length;
    company = (keepCompanyId ? companies.find((c) => c.id === keepCompanyId) : undefined) ?? (companies.length === 1 ? companies[0]! : null);
  } catch (err) {
    const message = err instanceof UserError ? err.message : describeProcoreError(err);
    if (!message) throw err;
    // The authorization is stored and good; the user can still pick a company once Procore answers.
    note = `Connected, but the list of Procore companies could not be loaded. ${message}`;
  }
  await updateIntegration(db, ctx.orgId, { config: { env: cfg.env, companyId: company?.id ?? null, companyName: company?.name ?? null }, lastError: note });

  await recordAudit(db, {
    orgId: ctx.orgId,
    actor: ctx,
    action: 'integration.connected',
    entityType: 'integration',
    entityId: integrationId,
    summary: `Connected Procore (${cfg.env})${company ? `, company ${company.name}` : companyCount === null ? '; companies could not be listed yet' : companyCount === 0 ? '; the Procore login has no active company' : `; ${companyCount} companies available, none chosen yet`}`,
    data: { provider: 'procore', env: cfg.env, companyId: company?.id ?? null, companyName: company?.name ?? null },
  });
}

export async function listCompanies(db: DB, ctx: Ctx): Promise<ProcoreCompany[]> {
  assertCan(ctx, 'integrations:manage');
  return friendly(() => fetchCompanies(db, ctx.orgId));
}

export async function selectCompany(db: DB, ctx: Ctx, companyId: string): Promise<void> {
  assertCan(ctx, 'integrations:manage');
  const id = procoreId(companyId);
  if (!id) throw new UserError('Choose a Procore company.');
  // Only a company the connected login can actually see may be chosen.
  const company = (await listCompanies(db, ctx)).find((c) => c.id === id);
  if (!company) throw new UserError('That company is not available to the connected Procore login.');
  const row = await loadIntegration(db, ctx.orgId);
  if (!row) throw new UserError(NOT_CONNECTED);
  const previous = integrationConfig(row);
  if (previous.companyId === company.id && previous.companyName === company.name) return;
  await updateIntegration(db, ctx.orgId, { config: { env: previous.env, companyId: company.id, companyName: company.name } });
  await recordAudit(db, {
    orgId: ctx.orgId,
    actor: ctx,
    action: 'integration.company_selected',
    entityType: 'integration',
    entityId: row.id,
    summary: `Set the Procore company to ${company.name}${previous.companyName && previous.companyId !== company.id ? ` (was ${previous.companyName})` : ''}`,
    data: { provider: 'procore', companyId: company.id, companyName: company.name, previousCompanyId: previous.companyId },
  });
}

/** Revoke the authorization at Procore if we can, then forget it. Imported records are kept. */
export async function disconnect(db: DB, ctx: Ctx): Promise<void> {
  assertCan(ctx, 'integrations:manage');
  const row = await loadIntegration(db, ctx.orgId);
  if (!row) return;
  const config = integrationConfig(row);
  const tokens = readTokens(row);

  let revoked = false;
  if (tokens && procoreConfig().configured) {
    const results = await Promise.allSettled([revoke(tokens.accessToken), revoke(tokens.refreshToken)]);
    revoked = results.every((r) => r.status === 'fulfilled');
  }
  await db.delete(integrations).where(and(eq(integrations.orgId, ctx.orgId), eq(integrations.provider, 'procore')));

  await recordAudit(db, {
    orgId: ctx.orgId,
    actor: ctx,
    action: 'integration.disconnected',
    entityType: 'integration',
    entityId: row.id,
    summary:
      `Disconnected Procore${config.companyName ? ` (company ${config.companyName})` : ''}. Records imported from Procore were kept. ` +
      (revoked ? 'Procore confirmed the authorization was revoked.' : 'Procore did not confirm that the authorization was revoked; the stored tokens were deleted here. To be certain, remove this app’s access in Procore.'),
    data: { provider: 'procore', env: config.env, companyId: config.companyId, revokedAtProcore: revoked },
  });
}
