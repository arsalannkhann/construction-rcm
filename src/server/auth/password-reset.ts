/**
 * Setting a new password with a one-time link.
 *
 * A link can come from three places: the person asked for it by email
 * (`requestPasswordReset`), an owner or admin of their organisation created it
 * for them (`issueMemberPasswordReset` in services/team.ts), or the operator
 * ran `pnpm reset-password` (`createOperatorResetLink`). Whichever it was:
 *
 *   - only the sha256 of the token is stored, so the table is no use to anyone
 *     who reads it;
 *   - the link works once and for RESET_LINK_MINUTES;
 *   - creating a link deletes the person's earlier unused ones;
 *   - using it signs the account out everywhere and does not sign anyone in;
 *   - it does not touch two-step verification: someone who gets hold of a link
 *     still needs the second step.
 */
import { and, eq, gt, isNull } from 'drizzle-orm';
import type { DB } from '@/db';
import { inTransaction } from '@/db/tx';
import { loginChallenges, passwordResets, sessions, users } from '@/db/schema';
import { appUrl } from '@/server/config';
import { emailDeliveryConfigured, sendEmail } from '@/server/email';
import { newId, randomToken, sha256Hex } from '@/server/ids';
import { normaliseEmail, recordAccountEvent, validEmail } from './account';
import { hashPassword, passwordProblem } from './password';
import { UserError } from './permissions';
import { recordSuccess, reserveAttempt, resetLimits, settleAttempt } from './throttle';

export const RESET_LINK_MINUTES = 60;
const INVALID_LINK = 'This reset link is no longer valid. It may have expired, been used already, or been replaced by a newer one. Ask for a new link.';

export const resetLink = (token: string) => `${appUrl()}/reset-password/${token}`;

/**
 * Create a reset token for a person, replacing any unused one they had. Call
 * it inside the transaction that records why it was created. The raw token is
 * returned to be put in a link and is not kept anywhere.
 */
export async function issueResetToken(tx: DB, userId: string, issuedBy: string | null, now: Date = new Date()): Promise<{ token: string; expiresAt: Date }> {
  await tx.delete(passwordResets).where(and(eq(passwordResets.userId, userId), isNull(passwordResets.usedAt)));
  const token = randomToken(32);
  const expiresAt = new Date(now.getTime() + RESET_LINK_MINUTES * 60_000);
  await tx.insert(passwordResets).values({ id: newId('pwr'), userId, tokenHash: sha256Hex(token), issuedBy, expiresAt, createdAt: now });
  return { token, expiresAt };
}

/**
 * `requested`: the request was taken. That is the answer whether or not the
 * address has an account, and whether or not a link was sent, so the form
 * cannot be used to find out who has an account.
 * `unavailable`: this deployment cannot send email at all, which is true for
 * every address and is said plainly.
 */
export type ResetRequestOutcome = 'requested' | 'unavailable';

/** Runs work that must not hold up the answer. The default starts it and lets it finish on its own. */
type Defer = (work: () => Promise<void>) => void;
const detached: Defer = (work) => void work().catch((err) => console.error('[auth] a reset email could not be sent:', err instanceof Error ? err.message : 'unknown error'));

/**
 * "Forgot password": email a one-time link to the address, if it has an account.
 *
 * At most RESET_REQUESTS_PER_EMAIL requests per address per hour lead anywhere;
 * the rest get the same answer and do nothing. The email is sent after the
 * answer has been decided (`opts.defer`), so how long the provider takes does
 * not show whether there was an account to send to.
 */
export async function requestPasswordReset(db: DB, emailInput: string, opts: { defer?: Defer; now?: Date } = {}): Promise<ResetRequestOutcome> {
  if (!emailDeliveryConfigured()) return 'unavailable';
  const email = normaliseEmail(emailInput);
  if (!validEmail(email)) throw new UserError('Enter the email address you sign in with.');
  const now = opts.now ?? new Date();
  const reservation = await reserveAttempt(db, 'reset', resetLimits(email), { now });
  if (!reservation) return 'requested';
  const [user] = await db.select({ id: users.id, email: users.email }).from(users).where(eq(users.email, email));
  if (!user) return 'requested';

  const { token } = await inTransaction(db, (tx) => issueResetToken(tx, user.id, null, now));
  await settleAttempt(db, reservation, true);
  const link = resetLink(token);
  (opts.defer ?? detached)(async () => {
    const result = await sendEmail({
      to: user.email,
      subject: 'Reset your Construction RCM password',
      text: [
        'Someone asked to reset the password for the Construction RCM account that signs in with this email address.',
        '',
        'Set a new password:',
        link,
        '',
        `The link can be used once and stops working after ${RESET_LINK_MINUTES} minutes. Using it signs the account out on every device. If two-step verification is on, it stays on.`,
        '',
        'If you did not ask for this, you can ignore this email. Your password has not been changed.',
      ].join('\n'),
    });
    // The provider's reply is not logged in full, and the link never is.
    if (result.status !== 'sent') console.error(`[auth] a password reset email was not sent (${result.status === 'failed' ? result.error.split(':')[0] : 'email delivery is not configured'}).`);
  });
  return 'requested';
}

/** Whether a link still works, for the page that asks for the new password. Says nothing about why it does not. */
export async function findPasswordReset(db: DB, token: string, opts: { now?: Date } = {}): Promise<{ email: string } | null> {
  if (!token) return null;
  const now = opts.now ?? new Date();
  const [row] = await db
    .select({ email: users.email })
    .from(passwordResets)
    .innerJoin(users, eq(users.id, passwordResets.userId))
    .where(and(eq(passwordResets.tokenHash, sha256Hex(token)), isNull(passwordResets.usedAt), gt(passwordResets.expiresAt, now)));
  return row ?? null;
}

/**
 * Use a reset link to set a new password. The account is signed out
 * everywhere and nobody is signed in: the person signs in afterwards, with
 * their second step if they have one.
 */
export async function completePasswordReset(db: DB, token: string, password: string, opts: { now?: Date } = {}): Promise<void> {
  const now = opts.now ?? new Date();
  const [row] = token
    ? await db
        .select({ id: passwordResets.id, issuedBy: passwordResets.issuedBy, userId: users.id, name: users.name, email: users.email })
        .from(passwordResets)
        .innerJoin(users, eq(users.id, passwordResets.userId))
        .where(and(eq(passwordResets.tokenHash, sha256Hex(token)), isNull(passwordResets.usedAt), gt(passwordResets.expiresAt, now)))
    : [];
  if (!row) throw new UserError(INVALID_LINK);
  const problem = passwordProblem(password, { email: row.email, name: row.name });
  if (problem) throw new UserError(problem);
  // Hashing is slow on purpose, so it is done before the transaction opens.
  const passwordHash = await hashPassword(password);

  await inTransaction(db, async (tx) => {
    // Claim the link. If two requests arrive with it at once, only one finds it unused.
    const [claimed] = await tx
      .update(passwordResets)
      .set({ usedAt: now })
      .where(and(eq(passwordResets.id, row.id), isNull(passwordResets.usedAt), gt(passwordResets.expiresAt, now)))
      .returning({ id: passwordResets.id });
    if (!claimed) throw new UserError(INVALID_LINK);
    await tx.update(users).set({ passwordHash, passwordChangedAt: now }).where(eq(users.id, row.userId));
    await tx.delete(passwordResets).where(and(eq(passwordResets.userId, row.userId), isNull(passwordResets.usedAt)));
    const gone = await tx.delete(sessions).where(eq(sessions.userId, row.userId)).returning({ id: sessions.id });
    await tx.delete(loginChallenges).where(eq(loginChallenges.userId, row.userId));
    // Whoever was guessing at the old password is no longer guessing at the right thing.
    await recordSuccess(tx, 'password', row.email, now);

    const [issuer] = row.issuedBy ? await tx.select({ name: users.name }).from(users).where(eq(users.id, row.issuedBy)) : [];
    const how = issuer ? `the one-time reset link created by ${issuer.name}` : 'a one-time reset link';
    const signedOut = gone.length > 0 ? ` ${row.name} was signed out on every device.` : '';
    await recordAccountEvent(tx, row.userId, {
      action: 'team.password_reset_completed',
      // Nobody is signed in at this point: all that is known is that the link was used.
      actor: 'system',
      summary: `A new password was set for ${row.name} using ${how}.${signedOut}`.replace(/\.$/, ''),
      data: { userId: row.userId, issuedBy: row.issuedBy },
    });
  });
}

/**
 * For the operator, from the command line: a one-time link for an account
 * whose owner cannot get one any other way (a sole owner who is locked out,
 * on a deployment that cannot send email). It is on the record of every
 * organisation the person belongs to.
 */
export async function createOperatorResetLink(db: DB, emailInput: string): Promise<{ link: string; expiresAt: Date; name: string; email: string }> {
  const email = normaliseEmail(emailInput);
  const [user] = await db.select({ id: users.id, name: users.name, email: users.email }).from(users).where(eq(users.email, email));
  // Whoever runs this can read the database, so there is nothing to hide from them.
  if (!user) throw new UserError(`No account signs in with ${email}.`);
  const { token, expiresAt } = await inTransaction(db, async (tx) => {
    const issued = await issueResetToken(tx, user.id, null);
    await recordAccountEvent(tx, user.id, {
      action: 'team.password_reset_issued',
      actor: 'system',
      summary: `A one-time password reset link for ${user.name} was created by the system operator from the command line`,
      data: { userId: user.id, expiresAt: issued.expiresAt.toISOString() },
    });
    return issued;
  });
  return { link: resetLink(token), expiresAt, name: user.name, email: user.email };
}
