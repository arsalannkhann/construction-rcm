/**
 * Signing in: the password, then, for an account with two-step verification,
 * the second step.
 *
 * A correct password on such an account does not create a session. It creates
 * a login challenge: a row whose id is the sha256 of a random token that goes
 * in a short-lived HttpOnly cookie. The challenge lasts CHALLENGE_MINUTES and
 * takes CHALLENGE_MAX_ATTEMPTS codes; on top of that an account takes at most
 * 10 wrong codes in 15 minutes however many challenges they are spread over.
 * Only a correct code creates the session, marked as having passed the second step.
 *
 * A challenge can also carry an invitation being accepted by an account with
 * two-step verification: the membership is created together with the session,
 * once the code is right.
 */
import { and, eq, gt, lt, sql } from 'drizzle-orm';
import type { DB } from '@/db';
import { inTransaction } from '@/db/tx';
import { loginChallenges, users } from '@/db/schema';
import { randomToken, sha256Hex } from '@/server/ids';
import { acceptInvitationAfterSecondStep, authenticate, createSession, type SessionMeta } from '@/server/services/team';
import { deviceToken } from './device';
import { recordAccountEvent } from './account';
import { useSecondFactor } from './mfa';
import { UserError } from './permissions';
import { mfaLimits, reserveAttempt, settleAttempt } from './throttle';
import { secondFactorKind } from './totp';

export const CHALLENGE_MINUTES = 10;
export const CHALLENGE_MAX_ATTEMPTS = 5;

type Issued = { token: string; expiresAt: Date };

/** `deviceToken` is for the browser to keep once the sign-in is complete (src/server/auth/device.ts). */
export type SignInResult = { step: 'done'; session: Issued; deviceToken: string | null } | { step: 'second_factor'; challenge: Issued };

/** Null when the email and password do not match an account; the reason is not given. */
export async function signIn(db: DB, email: string, password: string, meta: SessionMeta & { deviceTokens?: string[] } = {}): Promise<SignInResult | null> {
  const user = await authenticate(db, email, password, { ipAddress: meta.ipAddress, deviceTokens: meta.deviceTokens });
  if (!user) return null;
  if (!user.mfaEnabled) return { step: 'done', session: await createSession(db, user.id, null, meta), deviceToken: user.deviceToken };
  return { step: 'second_factor', challenge: await createLoginChallenge(db, user.id, { now: meta.now }) };
}

export async function createLoginChallenge(db: DB, userId: string, opts: { now?: Date; invitationId?: string } = {}): Promise<Issued> {
  const now = opts.now ?? new Date();
  const token = randomToken(32);
  const expiresAt = new Date(now.getTime() + CHALLENGE_MINUTES * 60_000);
  await db.insert(loginChallenges).values({ id: sha256Hex(token), userId, invitationId: opts.invitationId ?? null, attempts: 0, expiresAt, createdAt: now });
  return { token, expiresAt };
}

/** Whether a challenge can still be answered, for the page that asks for the code. */
export async function findLoginChallenge(
  db: DB,
  token: string | null | undefined,
  now: Date = new Date(),
): Promise<{ attemptsLeft: number; expiresAt: Date; mfaEnabledAt: Date | null } | null> {
  if (!token) return null;
  const [row] = await db
    .select({ attempts: loginChallenges.attempts, expiresAt: loginChallenges.expiresAt, mfaEnabledAt: users.mfaEnabledAt })
    .from(loginChallenges)
    .innerJoin(users, eq(users.id, loginChallenges.userId))
    .where(and(eq(loginChallenges.id, sha256Hex(token)), gt(loginChallenges.expiresAt, now)));
  if (!row || row.attempts >= CHALLENGE_MAX_ATTEMPTS) return null;
  return { attemptsLeft: CHALLENGE_MAX_ATTEMPTS - row.attempts, expiresAt: row.expiresAt, mfaEnabledAt: row.mfaEnabledAt };
}

export type SecondStepResult =
  | {
      status: 'signed_in';
      session: Issued;
      usedRecoveryCode: boolean;
      recoveryCodesLeft: number | null;
      deviceToken: string | null;
      /** For a sign-in that was accepting an invitation: whether the organisation was joined, or the invitation had stopped being valid. */
      invitation: 'joined' | 'no_longer_valid' | null;
    }
  | { status: 'wrong_code'; attemptsLeft: number }
  /** The challenge has expired or used up its attempts: sign in again from the start. */
  | { status: 'restart'; reason: 'expired' | 'too_many' }
  /** The account has had too many wrong codes recently, across sign-ins. */
  | { status: 'locked' };

/** Answer a login challenge with a code from the app or a recovery code. */
export async function completeSecondStep(db: DB, token: string | null | undefined, code: string, meta: SessionMeta = {}): Promise<SecondStepResult> {
  const now = meta.now ?? new Date();
  if (!token) return { status: 'restart', reason: 'expired' };
  if (!secondFactorKind(code)) throw new UserError('Enter the 6-digit code from your authenticator app, or one of your recovery codes.');
  const id = sha256Hex(token);
  const [found] = await db
    .select({ challenge: loginChallenges, email: users.email, passwordHash: users.passwordHash })
    .from(loginChallenges)
    .innerJoin(users, eq(users.id, loginChallenges.userId))
    .where(and(eq(loginChallenges.id, id), gt(loginChallenges.expiresAt, now)));
  if (!found) return { status: 'restart', reason: 'expired' };
  if (found.challenge.attempts >= CHALLENGE_MAX_ATTEMPTS) {
    await db.delete(loginChallenges).where(eq(loginChallenges.id, id));
    return { status: 'restart', reason: 'too_many' };
  }
  const reservation = await reserveAttempt(db, 'mfa', mfaLimits(found.email), { now });
  if (!reservation) return { status: 'locked' };

  const outcome = await inTransaction(db, async (tx): Promise<SecondStepResult> => {
    // The attempt is counted first, in the same statement that checks there is one left,
    // so concurrent guesses cannot get past the limit, and a wrong guess stays counted.
    const [challenge] = await tx
      .update(loginChallenges)
      .set({ attempts: sql`${loginChallenges.attempts} + 1` })
      .where(and(eq(loginChallenges.id, id), gt(loginChallenges.expiresAt, now), lt(loginChallenges.attempts, CHALLENGE_MAX_ATTEMPTS)))
      .returning();
    if (!challenge) return { status: 'restart', reason: 'too_many' };
    const used = await useSecondFactor(tx, challenge.userId, code, now);
    if (!used) {
      const attemptsLeft = CHALLENGE_MAX_ATTEMPTS - challenge.attempts;
      if (attemptsLeft > 0) return { status: 'wrong_code', attemptsLeft };
      await tx.delete(loginChallenges).where(eq(loginChallenges.id, id));
      return { status: 'restart', reason: 'too_many' };
    }
    await tx.delete(loginChallenges).where(eq(loginChallenges.id, id));
    const joined = challenge.invitationId ? await acceptInvitationAfterSecondStep(tx, challenge.invitationId, challenge.userId) : null;
    const session = await createSession(tx, challenge.userId, joined, { ...meta, mfaVerified: true, now });
    if (used.kind === 'recovery') {
      await recordAccountEvent(tx, challenge.userId, {
        action: 'team.mfa_recovery_code_used',
        actor: 'self',
        summary: `Signed in with a recovery code instead of their authenticator app (${used.remaining} ${used.remaining === 1 ? 'code' : 'codes'} left)`,
      });
    }
    return {
      status: 'signed_in',
      session,
      usedRecoveryCode: used.kind === 'recovery',
      recoveryCodesLeft: used.kind === 'recovery' ? used.remaining : null,
      deviceToken: deviceToken({ id: challenge.userId, passwordHash: found.passwordHash }),
      invitation: challenge.invitationId ? (joined ? 'joined' : 'no_longer_valid') : null,
    };
  });
  if (outcome.status === 'signed_in') await settleAttempt(db, reservation, true);
  return outcome;
}
