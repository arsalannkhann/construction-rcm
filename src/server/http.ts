/** Small helpers for route handlers. */
import { timingSafeEqual } from 'node:crypto';
import { headers } from 'next/headers';
import { NextResponse } from 'next/server';
import { getDb } from '@/db';
import { ConflictError, PermissionError, UserError, type Ctx } from '@/server/auth/permissions';
import { getSession } from '@/server/auth/session';
import { resolveSession, type SessionInfo } from '@/server/services/team';

/** A session token as issued (src/server/ids.ts randomToken: base64url). */
const BEARER = /^Bearer ([A-Za-z0-9_-]{32,128})$/;

/** The session token an app (the mobile app) sends in the Authorization header, if any. Never read from the query string. */
export async function bearerSessionToken(): Promise<string | null> {
  return (await headers()).get('authorization')?.match(BEARER)?.[1] ?? null;
}

/**
 * The session behind this request: the mobile app's bearer token, or the
 * browser's cookie. Both are the same kind of session (src/server/services/team.ts),
 * with the same lifetime, idle limit, second-step rule and revocation.
 * A bearer token cannot be sent by another site the way a cookie can, so it
 * needs no same-origin check.
 */
export async function apiSession(): Promise<SessionInfo | null> {
  const token = await bearerSessionToken();
  if (token) return resolveSession(await getDb(), token);
  return getSession();
}

/** The acting member, or a 401 response. Route handlers must not redirect to an HTML page. */
export async function apiCtx(): Promise<Ctx | NextResponse> {
  const session = await apiSession();
  if (!session) return NextResponse.json({ error: 'Not signed in.', code: 'signed_out' }, { status: 401 });
  if (session.mfaRequired) {
    return NextResponse.json({ error: `${session.mfaRequired.orgName} requires two-step verification. Set it up on the website to continue.`, code: 'mfa_required' }, { status: 401 });
  }
  if (!session.ctx) return NextResponse.json({ error: 'You are not a member of an organisation.', code: 'no_organization' }, { status: 401 });
  return session.ctx;
}

export function apiError(err: unknown): NextResponse {
  if (err instanceof PermissionError) return NextResponse.json({ error: err.message }, { status: 403 });
  if (err instanceof ConflictError) return NextResponse.json({ error: err.message, code: 'conflict' }, { status: 409 });
  if (err instanceof UserError) return NextResponse.json({ error: err.message }, { status: 400 });
  console.error('[api] unexpected error:', err);
  return NextResponse.json({ error: 'Something went wrong on our side. Please try again.' }, { status: 500 });
}

/** Reject cross-site form posts: a state-changing request must come from our own origin. */
export function sameOrigin(request: Request): boolean {
  const origin = request.headers.get('origin');
  if (!origin) return true; // non-browser client; the session cookie is SameSite=Lax
  try {
    return new URL(origin).host === (request.headers.get('x-forwarded-host') ?? request.headers.get('host'));
  } catch {
    return false;
  }
}

export function contentDisposition(kind: 'inline' | 'attachment', filename: string): string {
  const ascii = filename.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `${kind}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

/**
 * Whether an Authorization header carries `Bearer <secret>`, compared in
 * constant time. null when no secret is configured, so the caller can refuse
 * instead of letting everyone in.
 */
export function bearerMatches(header: string | null, secret: string | undefined): boolean | null {
  if (!secret) return null;
  const given = Buffer.from(header ?? '');
  const want = Buffer.from(`Bearer ${secret}`);
  return given.length === want.length && timingSafeEqual(given, want);
}
