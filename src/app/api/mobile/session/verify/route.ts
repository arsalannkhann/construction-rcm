import { z } from 'zod';
import { getDb } from '@/db';
import { requestMetaFrom } from '@/server/auth/request-meta';
import { completeSecondStep } from '@/server/auth/sign-in';
import { json, mobileError, readBody } from '@/server/mobile-http';

const verifySchema = z.object({
  challenge: z.string().min(16).max(200),
  code: z.string().trim().min(1).max(64),
});

/** The second step of signing in: a code from the authenticator app, or a recovery code. */
export async function POST(request: Request) {
  try {
    const input = await readBody(request, verifySchema);
    const result = await completeSecondStep(await getDb(), input.challenge, input.code, requestMetaFrom(request.headers));
    switch (result.status) {
      case 'signed_in':
        return json({ status: 'signed_in', token: result.session.token, expiresAt: result.session.expiresAt, deviceToken: result.deviceToken, recoveryCodesLeft: result.recoveryCodesLeft });
      case 'wrong_code':
        return json({ status: 'wrong_code', attemptsLeft: result.attemptsLeft }, { status: 400 });
      case 'locked':
        return json({ status: 'locked', error: 'Too many wrong codes for this account. Wait 15 minutes, then try again.' }, { status: 429 });
      case 'restart':
        return json(
          { status: 'restart', error: result.reason === 'too_many' ? 'Too many wrong codes. Sign in again to get another try.' : 'This sign-in has expired. Sign in again.' },
          { status: 400 },
        );
    }
  } catch (err) {
    return mobileError(err);
  }
}
