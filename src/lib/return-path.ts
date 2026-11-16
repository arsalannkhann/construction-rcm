/**
 * Where to go after signing in: the page someone asked for before being sent
 * to sign in. Only a path on this site is accepted, never another site, so a
 * link cannot use the sign-in page to send someone elsewhere.
 */

/** Set by src/proxy.ts on app pages: the path and query of the request. */
export const REQUEST_PATH_HEADER = 'x-rcm-path';

const NOT_A_DESTINATION = /^\/(login|signup|forgot-password|reset-password|invite|api|landing|_next)(\/|\?|$)/;

/** The path if it is a page on this site worth returning to, otherwise null. */
export function safeReturnPath(value: string | null | undefined): string | null {
  if (!value || value.length > 512) return null;
  // One leading slash, then not a second slash or backslash (which browsers read as another host).
  if (!value.startsWith('/') || value.startsWith('//') || value.startsWith('/\\')) return null;
  if (/[\u0000-\u001f\u007f\\]/.test(value)) return null;
  if (value === '/' || NOT_A_DESTINATION.test(value)) return null;
  return value;
}

/** The sign-in page, with the page to return to when there is one. */
export function loginPath(returnTo: string | null | undefined): string {
  const next = safeReturnPath(returnTo);
  return next ? `/login?next=${encodeURIComponent(next)}` : '/login';
}
