/**
 * Shared by the connect and callback routes: the short-lived cookie that ties
 * the OAuth round trip to this browser and this organisation.
 */
import { timingSafeEqual } from 'node:crypto';
import { NextResponse } from 'next/server';
import { appUrl, isProduction } from '@/server/config';

export const STATE_COOKIE = 'rcm_procore_state';
const STATE_MAX_AGE_SECONDS = 10 * 60;
/** Only the two OAuth routes ever receive the cookie. */
const COOKIE_PATH = '/api/integrations/procore';

const cookieOptions = () => ({ httpOnly: true, sameSite: 'lax' as const, secure: isProduction() && appUrl().startsWith('https://'), path: COOKIE_PATH });

/** The cookie carries the organisation too, so a connection cannot land on a different one than it was started from. */
export function setStateCookie(res: NextResponse, state: string, orgId: string): void {
  res.cookies.set(STATE_COOKIE, `${state}.${orgId}`, { ...cookieOptions(), maxAge: STATE_MAX_AGE_SECONDS });
}

export function clearStateCookie(res: NextResponse): void {
  res.cookies.set(STATE_COOKIE, '', { ...cookieOptions(), maxAge: 0 });
}

export function readStateCookie(value: string | undefined): { state: string; orgId: string } | null {
  if (!value) return null;
  const dot = value.indexOf('.');
  if (dot <= 0 || dot === value.length - 1) return null;
  return { state: value.slice(0, dot), orgId: value.slice(dot + 1) };
}

export function sameState(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && x.length > 0 && timingSafeEqual(x, y);
}

/** A redirect within this application. Relative, so it is right behind any proxy and on any port. */
export function goTo(path: string): NextResponse {
  return new NextResponse(null, { status: 302, headers: { Location: path, 'Cache-Control': 'no-store' } });
}

/** Back to the integrations page with an outcome: `connected=1` or a short error code. Never anything from Procore. */
export function backToSettings(outcome: { connected: true } | { error: string }): NextResponse {
  return goTo(`/settings/integrations?${'connected' in outcome ? 'connected=1' : `error=${encodeURIComponent(outcome.error)}`}`);
}
