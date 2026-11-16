/**
 * Route helpers for the mobile app's API (src/app/api/mobile).
 *
 * The app authenticates with its session token in the Authorization header,
 * never a cookie, so these routes cannot be driven by another website the way
 * a cookie-authenticated form post can. The session itself is the website's
 * kind (src/server/services/team.ts): same lifetime, idle limit, second-step
 * rule and revocation. Every response is marked not to be cached.
 */
import { NextResponse } from 'next/server';
import type { z } from 'zod';
import { getDb } from '@/db';
import { UserError, type Ctx } from '@/server/auth/permissions';
import { apiError, bearerSessionToken } from '@/server/http';
import { DesktopRequired } from '@/server/services/mobile';
import { resolveSession, type SessionInfo } from '@/server/services/team';

const NO_STORE = { 'cache-control': 'no-store, private', vary: 'authorization' };

export function json(body: unknown, init: ResponseInit = {}): NextResponse {
  return NextResponse.json(body, { ...init, headers: { ...NO_STORE, ...(init.headers ?? {}) } });
}

function refuse(error: string, code: string, status = 401): NextResponse {
  return json({ error, code }, { status });
}

/** The signed-in person behind the bearer token, organisation or not. */
export async function mobileSession(): Promise<{ token: string; session: SessionInfo } | NextResponse> {
  const token = await bearerSessionToken();
  if (!token) return refuse('Sign in to continue.', 'signed_out');
  const session = await resolveSession(await getDb(), token);
  if (!session) return refuse('Your session has ended. Sign in again.', 'signed_out');
  return { token, session };
}

/** The acting member of an organisation, or the reason there is none. */
export async function mobileCtx(): Promise<{ token: string; session: SessionInfo; ctx: Ctx } | NextResponse> {
  const s = await mobileSession();
  if (s instanceof NextResponse) return s;
  if (s.session.mfaRequired) {
    return refuse(`${s.session.mfaRequired.orgName} requires two-step verification. Turn it on in Zephric on the web, then sign in again.`, 'mfa_required', 403);
  }
  if (!s.session.ctx) return refuse('You are not a member of an organisation yet. Finish setting up on the web.', 'no_organization', 403);
  return { ...s, ctx: s.session.ctx };
}

export function mobileError(err: unknown): NextResponse {
  if (err instanceof DesktopRequired) return json({ error: err.message, code: 'desktop_required' }, { status: 409 });
  const res = apiError(err);
  for (const [k, v] of Object.entries(NO_STORE)) res.headers.set(k, v);
  return res;
}

/** The request's JSON body, checked against a schema. Anything else is the person's mistake, not ours. */
export async function readBody<S extends z.ZodTypeAny>(request: Request, schema: S): Promise<z.output<S>> {
  let value: unknown;
  try {
    value = await request.json();
  } catch {
    throw new UserError('The request was not understood. Update the app and try again.');
  }
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new UserError('The request was not understood. Update the app and try again.');
  return parsed.data;
}
