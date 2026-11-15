/**
 * Cookie-backed sessions for the web app.
 *
 * The cookie holds a random token; only its sha256 is stored, so the sessions
 * table cannot be turned back into a working cookie. Both cookies here are
 * HttpOnly (no script can read them), SameSite=Lax (not sent on cross-site
 * form posts) and Secure in production, as is the remembered-device cookie
 * (src/server/auth/device.ts).
 */
import { cookies, headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { cache } from 'react';
import { getDb } from '@/db';
import { appUrl, isProduction } from '@/server/config';
import { createSession, destroySession, resolveSession, type SessionInfo } from '@/server/services/team';
import { DEVICE_COOKIE, DEVICE_COOKIE_DAYS, parseDeviceCookie, rememberDevice } from './device';
import type { Ctx } from './permissions';
import { requestMetaFrom } from './request-meta';

const COOKIE = 'rcm_session';
/** Set between a correct password and a correct second-step code. */
const CHALLENGE_COOKIE = 'rcm_login';

/**
 * Secure in production. The one exception is a production build served from
 * http://localhost (trying out `pnpm start` or the compose file locally),
 * where a Secure cookie would not be stored and nobody could sign in.
 */
export function cookieSecure(): boolean {
  if (!isProduction()) return false;
  return !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(appUrl());
}

export const authCookieOptions = (expires: Date) => ({ httpOnly: true, sameSite: 'lax' as const, secure: cookieSecure(), path: '/', expires });

export async function sessionToken(): Promise<string | null> {
  return (await cookies()).get(COOKIE)?.value ?? null;
}

/** The browser and address of the current request, for the session record and the sign-in limits. */
export async function requestMeta(): Promise<{ userAgent: string | null; ipAddress: string | null }> {
  return requestMetaFrom(await headers());
}

/** The signed-in user, resolved once per request. */
export const getSession = cache(async (): Promise<SessionInfo | null> => {
  const token = await sessionToken();
  if (!token) return null;
  return resolveSession(await getDb(), token);
});

/**
 * For pages and actions that need a signed-in member of an organisation.
 *
 * A member of an organisation that requires two-step verification who has not
 * turned it on gets no context: they are sent to set it up, and nothing that
 * runs through here (every page and action in the app) works for them in that
 * organisation until they have.
 */
export async function requireCtx(): Promise<Ctx> {
  const session = await getSession();
  if (!session) redirect('/login');
  if (session.mfaRequired) redirect('/mfa-required');
  if (!session.ctx) redirect('/welcome');
  return session.ctx;
}

export async function requireUser(): Promise<SessionInfo['user']> {
  const session = await getSession();
  if (!session) redirect('/login');
  return session.user;
}

export async function setSessionCookie(token: string, expiresAt: Date): Promise<void> {
  (await cookies()).set(COOKIE, token, authCookieOptions(expiresAt));
}

/** Start a session for someone who has just proved who they are, and set its cookie. */
export async function startSession(userId: string, orgId?: string | null, opts: { mfaVerified?: boolean } = {}): Promise<void> {
  const { token, expiresAt } = await createSession(await getDb(), userId, orgId, { ...(await requestMeta()), mfaVerified: opts.mfaVerified });
  await setSessionCookie(token, expiresAt);
}

export async function endSession(): Promise<void> {
  const jar = await cookies();
  await destroySession(await getDb(), jar.get(COOKIE)?.value);
  jar.delete(COOKIE);
}

export async function setLoginChallengeCookie(token: string, expiresAt: Date): Promise<void> {
  (await cookies()).set(CHALLENGE_COOKIE, token, authCookieOptions(expiresAt));
}

export async function loginChallengeToken(): Promise<string | null> {
  return (await cookies()).get(CHALLENGE_COOKIE)?.value ?? null;
}

export async function clearLoginChallengeCookie(): Promise<void> {
  (await cookies()).delete(CHALLENGE_COOKIE);
}

/** The remembered-device tokens this browser holds. */
export async function deviceTokens(): Promise<string[]> {
  return parseDeviceCookie((await cookies()).get(DEVICE_COOKIE)?.value);
}

/** Remember this browser for the account that just signed in. A null token (no secret key) changes nothing. */
export async function rememberThisDevice(token: string | null): Promise<void> {
  if (!token) return;
  const value = rememberDevice(await deviceTokens(), token);
  (await cookies()).set(DEVICE_COOKIE, value, authCookieOptions(new Date(Date.now() + DEVICE_COOKIE_DAYS * 86_400_000)));
}
