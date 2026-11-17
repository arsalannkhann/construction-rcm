/**
 * The front door of the subcontractor portal's routes and page: looks the link
 * up, and counts failed lookups per network address so nobody can work
 * through tokens. A valid link costs no write; a wrong one is recorded.
 */
import { getDb } from '@/db';
import { clientIp } from '@/server/auth/request-meta';
import { isLimited, reserveAttempt } from '@/server/auth/throttle';
import { portalGuessLimit, resolvePortalToken, type PortalAccess } from '@/server/services/portal';

export type PortalLookup = { ok: true; access: PortalAccess } | { ok: false; reason: 'limited' | 'not_found' };

export const PORTAL_NOT_FOUND = 'This link is not active. It may have been replaced or turned off. Ask the contractor who sent it for a new one.';
export const PORTAL_LIMITED = 'Too many attempts from your network. Wait a few minutes and try again.';

export async function lookUpPortal(token: string, headers: { get(name: string): string | null }): Promise<PortalLookup> {
  const db = await getDb();
  const limit = portalGuessLimit(clientIp(headers));
  if (await isLimited(db, 'portal', [limit])) return { ok: false, reason: 'limited' };
  const access = await resolvePortalToken(db, token);
  if (access) return { ok: true, access };
  // Written as a failure; once there are enough of them this address is refused.
  await reserveAttempt(db, 'portal', [limit]);
  return { ok: false, reason: 'not_found' };
}

/** The JSON answer for a lookup that failed. */
export function portalRefusal(reason: 'limited' | 'not_found'): Response {
  return Response.json({ error: reason === 'limited' ? PORTAL_LIMITED : PORTAL_NOT_FOUND }, { status: reason === 'limited' ? 429 : 404, headers: { 'cache-control': 'no-store' } });
}
