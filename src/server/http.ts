/** Small helpers for route handlers. */
import { timingSafeEqual } from 'node:crypto';
import { NextResponse } from 'next/server';
import { PermissionError, UserError, type Ctx } from '@/server/auth/permissions';
import { getSession } from '@/server/auth/session';

/** The acting member, or a 401 response. Route handlers must not redirect to an HTML page. */
export async function apiCtx(): Promise<Ctx | NextResponse> {
  const session = await getSession();
  if (!session?.ctx) return NextResponse.json({ error: 'Not signed in.' }, { status: 401 });
  return session.ctx;
}

export function apiError(err: unknown): NextResponse {
  if (err instanceof PermissionError) return NextResponse.json({ error: err.message }, { status: 403 });
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
