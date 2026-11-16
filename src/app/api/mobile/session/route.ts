import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getDb } from '@/db';
import { requestMetaFrom } from '@/server/auth/request-meta';
import { signIn } from '@/server/auth/sign-in';
import { json, mobileError, mobileSession, readBody } from '@/server/mobile-http';
import { destroySession } from '@/server/services/team';

const signInSchema = z.object({
  email: z.string().trim().min(1).max(254),
  password: z.string().min(1).max(200),
  /** The remembered-device token this phone was given at an earlier sign-in (src/server/auth/device.ts). */
  deviceToken: z.string().max(200).optional(),
});

/**
 * Sign in from the mobile app. The same check as the website's sign-in, with
 * the same limits; an account with two-step verification gets a challenge to
 * answer at /api/mobile/session/verify instead of a session.
 */
export async function POST(request: Request) {
  try {
    const input = await readBody(request, signInSchema);
    const result = await signIn(await getDb(), input.email, input.password, { ...requestMetaFrom(request.headers), deviceTokens: input.deviceToken ? [input.deviceToken] : [] });
    if (!result) return json({ error: 'That email and password do not match an account.', code: 'bad_credentials' }, { status: 401 });
    if (result.step === 'second_factor') return json({ status: 'verify', challenge: result.challenge.token, expiresAt: result.challenge.expiresAt });
    return json({ status: 'signed_in', token: result.session.token, expiresAt: result.session.expiresAt, deviceToken: result.deviceToken });
  } catch (err) {
    return mobileError(err);
  }
}

/** Sign out: the session ends on the server, not only on the phone. */
export async function DELETE() {
  const s = await mobileSession();
  if (s instanceof NextResponse) return json({ ok: true });
  try {
    await destroySession(await getDb(), s.token);
    return json({ ok: true });
  } catch (err) {
    return mobileError(err);
  }
}
