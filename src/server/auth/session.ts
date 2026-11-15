/** Cookie-backed sessions for the web app. The token in the cookie is random; only its hash is stored. */
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { cache } from 'react';
import { getDb } from '@/db';
import { appUrl, isProduction } from '@/server/config';
import { createSession, destroySession, resolveSession, type SessionInfo } from '@/server/services/team';
import type { Ctx } from './permissions';

const COOKIE = 'rcm_session';

export async function sessionToken(): Promise<string | null> {
  return (await cookies()).get(COOKIE)?.value ?? null;
}

/** The signed-in user, resolved once per request. */
export const getSession = cache(async (): Promise<SessionInfo | null> => {
  const token = await sessionToken();
  if (!token) return null;
  return resolveSession(await getDb(), token);
});

/** For pages and actions that need a signed-in member of an organisation. */
export async function requireCtx(): Promise<Ctx> {
  const session = await getSession();
  if (!session) redirect('/login');
  if (!session.ctx) redirect('/welcome');
  return session.ctx;
}

export async function requireUser(): Promise<SessionInfo['user']> {
  const session = await getSession();
  if (!session) redirect('/login');
  return session.user;
}

export async function startSession(userId: string, orgId?: string | null): Promise<void> {
  const { token, expiresAt } = await createSession(await getDb(), userId, orgId);
  (await cookies()).set(COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: isProduction() && appUrl().startsWith('https://'),
    path: '/',
    expires: expiresAt,
  });
}

export async function endSession(): Promise<void> {
  const jar = await cookies();
  await destroySession(await getDb(), jar.get(COOKIE)?.value);
  jar.delete(COOKIE);
}
