/**
 * Two-step verification for an account: turning it on and off, recovery
 * codes, and checking a second-step code.
 *
 * The key is stored encrypted (src/server/crypto.ts) and only counts once
 * `mfaEnabledAt` is set, which happens when the person proves their app shows
 * the right codes. Recovery codes are stored as keyed hashes and each works
 * once. `mfaLastCounter` is the last 30-second step accepted, so a code cannot
 * be used twice.
 */
import { and, eq, isNull, ne } from 'drizzle-orm';
import type { DB } from '@/db';
import { inTransaction } from '@/db/tx';
import { loginChallenges, sessions, users } from '@/db/schema';
import { decryptJson, encryptJson } from '@/server/crypto';
import { sha256Hex } from '@/server/ids';
import { confirmPassword, normaliseEmail, recordAccountEvent } from './account';
import { UserError } from './permissions';
import { mfaLimits, reserveAttempt, settleAttempt } from './throttle';
import {
  formatTotpSecret,
  generateRecoveryCodes,
  generateTotpSecret,
  hashRecoveryCode,
  otpauthUri,
  secondFactorKind,
  verifyTotp,
} from './totp';

export const MFA_ISSUER = 'Zephric';
export const TOO_MANY_CODES = 'Too many wrong codes. Wait 15 minutes, then try again.';
export const WRONG_CODE = 'That code is not right. Enter the code your authenticator app shows now, or one of your recovery codes.';
const BAD_SHAPE = 'Enter the 6-digit code from your authenticator app, or one of your recovery codes.';

export type MfaStatus = { enabled: boolean; enabledAt: Date | null; recoveryCodesLeft: number };

export async function getMfaStatus(db: DB, userId: string): Promise<MfaStatus> {
  const [user] = await db.select({ enabledAt: users.mfaEnabledAt, codes: users.mfaRecoveryCodes }).from(users).where(eq(users.id, userId));
  return { enabled: !!user?.enabledAt, enabledAt: user?.enabledAt ?? null, recoveryCodesLeft: user?.enabledAt ? (user.codes?.length ?? 0) : 0 };
}

const readSecret = (stored: string) => decryptJson<string>(stored);

/**
 * Start setting up: a new key for the authenticator app. It is stored (encrypted)
 * but does nothing until `confirmMfaSetup` succeeds. Starting again replaces it.
 * The key is returned this once, to show to its owner.
 *
 * Needs the current password: turning two-step verification on signs out every
 * other session and is not undone by a password reset, so someone holding a
 * stolen session must not be able to lock the owner out with their own phone.
 */
export async function startMfaSetup(db: DB, userId: string, password: string): Promise<{ secret: string; formattedSecret: string; uri: string }> {
  const [user] = await db.select({ email: users.email, enabledAt: users.mfaEnabledAt }).from(users).where(eq(users.id, userId));
  if (!user) throw new UserError('Your session has expired. Sign in again.');
  if (user.enabledAt) throw new UserError('Two-step verification is already on for your account.');
  await confirmPassword(db, userId, password);
  const secret = generateTotpSecret();
  await db
    .update(users)
    .set({ mfaSecret: encryptJson(secret), mfaRecoveryCodes: null, mfaLastCounter: null })
    .where(and(eq(users.id, userId), isNull(users.mfaEnabledAt)));
  return { secret, formattedSecret: formatTotpSecret(secret), uri: otpauthUri({ secret, account: user.email, issuer: MFA_ISSUER }) };
}

/**
 * Finish setting up with a code from the app. Turns two-step verification on
 * and returns ten recovery codes, which are shown once and never again.
 *
 * The session making the request (`keepToken`) is marked as having passed the
 * second step. Every other session was signed in with a password alone, so it
 * is signed out.
 */
export async function confirmMfaSetup(db: DB, userId: string, code: string, keepToken?: string | null, opts: { now?: Date } = {}): Promise<{ recoveryCodes: string[] }> {
  const now = opts.now ?? new Date();
  const [user] = await db.select().from(users).where(eq(users.id, userId));
  if (!user) throw new UserError('Your session has expired. Sign in again.');
  if (user.mfaEnabledAt) throw new UserError('Two-step verification is already on for your account.');
  if (!user.mfaSecret) throw new UserError('Start again: choose Set up two-step verification to get a new key.');
  const digits = code.replace(/\s/g, '');
  if (!/^\d{6}$/.test(digits)) throw new UserError('Enter the 6-digit code your authenticator app shows.');
  const reservation = await reserveAttempt(db, 'mfa', mfaLimits(user.email), { now });
  if (!reservation) throw new UserError(TOO_MANY_CODES);
  const counter = verifyTotp(readSecret(user.mfaSecret), digits, { at: now });
  if (counter === null) throw new UserError('That code is not right. Check that your phone sets its clock automatically, then enter the code your app shows now.');

  const recoveryCodes = generateRecoveryCodes();
  const keep = keepToken ? sha256Hex(keepToken) : '';
  await inTransaction(db, async (tx) => {
    // Only the key that was just checked can be turned on: a second setup started meanwhile wins.
    const [on] = await tx
      .update(users)
      .set({ mfaEnabledAt: now, mfaLastCounter: counter, mfaRecoveryCodes: recoveryCodes.map(hashRecoveryCode) })
      .where(and(eq(users.id, userId), isNull(users.mfaEnabledAt), eq(users.mfaSecret, user.mfaSecret!)))
      .returning({ id: users.id });
    if (!on) throw new UserError('Your setup was restarted somewhere else. Start again to get a new key.');
    if (keep) await tx.update(sessions).set({ mfaVerifiedAt: now }).where(and(eq(sessions.id, keep), eq(sessions.userId, userId)));
    const gone = await tx.delete(sessions).where(and(eq(sessions.userId, userId), ne(sessions.id, keep))).returning({ id: sessions.id });
    await recordAccountEvent(tx, userId, {
      action: 'team.mfa_enabled',
      actor: 'self',
      summary: gone.length > 0 ? `Turned on two-step verification. Their other sessions (${gone.length}) were signed out` : 'Turned on two-step verification',
    });
  });
  await settleAttempt(db, reservation, true);
  return { recoveryCodes };
}

export type UsedFactor = { kind: 'totp' } | { kind: 'recovery'; remaining: number };

/**
 * Check and use up a second-step code: a code from the app (which then cannot
 * be used again) or a recovery code (which is then deleted). Must run inside a
 * transaction; the account row is locked, so two requests with the same code
 * cannot both succeed. Returns null for a wrong code and changes nothing.
 */
export async function useSecondFactor(tx: DB, userId: string, input: string, now: Date = new Date()): Promise<UsedFactor | null> {
  const [user] = await tx
    .select({ secret: users.mfaSecret, enabledAt: users.mfaEnabledAt, lastCounter: users.mfaLastCounter, codes: users.mfaRecoveryCodes })
    .from(users)
    .where(eq(users.id, userId))
    .for('update');
  if (!user?.enabledAt || !user.secret) return null;
  const kind = secondFactorKind(input);
  if (kind === 'totp') {
    const counter = verifyTotp(readSecret(user.secret), input.replace(/[\s-]/g, ''), { at: now, after: user.lastCounter });
    if (counter === null) return null;
    await tx.update(users).set({ mfaLastCounter: counter }).where(eq(users.id, userId));
    return { kind: 'totp' };
  }
  if (kind === 'recovery') {
    const hash = hashRecoveryCode(input);
    const codes = user.codes ?? [];
    if (!codes.includes(hash)) return null;
    const remaining = codes.filter((c) => c !== hash);
    await tx.update(users).set({ mfaRecoveryCodes: remaining }).where(eq(users.id, userId));
    return { kind: 'recovery', remaining: remaining.length };
  }
  return null;
}

/** Password and second step, for turning it off or replacing the recovery codes. */
async function reauthenticate<T>(db: DB, userId: string, password: string, code: string, now: Date, then: (tx: DB, used: UsedFactor) => Promise<T>): Promise<T> {
  if (!secondFactorKind(code)) throw new UserError(BAD_SHAPE);
  const user = await confirmPassword(db, userId, password);
  if (!user.mfaEnabledAt) throw new UserError('Two-step verification is not on for your account.');
  const reservation = await reserveAttempt(db, 'mfa', mfaLimits(user.email), { now });
  if (!reservation) throw new UserError(TOO_MANY_CODES);
  const outcome = await inTransaction(db, async (tx) => {
    const used = await useSecondFactor(tx, userId, code, now);
    if (!used) return { ok: false as const };
    return { ok: true as const, value: await then(tx, used) };
  });
  if (!outcome.ok) throw new UserError(WRONG_CODE);
  await settleAttempt(db, reservation, true);
  return outcome.value;
}

/** Turn two-step verification off. Needs the password and a current code (or a recovery code). */
export async function disableMfa(db: DB, userId: string, password: string, code: string, opts: { now?: Date } = {}): Promise<void> {
  await reauthenticate(db, userId, password, code, opts.now ?? new Date(), async (tx) => {
    await tx.update(users).set({ mfaSecret: null, mfaEnabledAt: null, mfaRecoveryCodes: null, mfaLastCounter: null }).where(eq(users.id, userId));
    await tx.delete(loginChallenges).where(eq(loginChallenges.userId, userId));
    await recordAccountEvent(tx, userId, { action: 'team.mfa_disabled', actor: 'self', summary: 'Turned off two-step verification' });
  });
}

/** Replace all ten recovery codes. The old ones stop working. Returns the new ones, shown once. */
export async function regenerateRecoveryCodes(db: DB, userId: string, password: string, code: string, opts: { now?: Date } = {}): Promise<string[]> {
  const codes = generateRecoveryCodes();
  await reauthenticate(db, userId, password, code, opts.now ?? new Date(), async (tx) => {
    await tx.update(users).set({ mfaRecoveryCodes: codes.map(hashRecoveryCode) }).where(eq(users.id, userId));
    await recordAccountEvent(tx, userId, { action: 'team.mfa_recovery_codes_regenerated', actor: 'self', summary: 'Replaced their two-step verification recovery codes. The previous codes no longer work' });
  });
  return codes;
}

/**
 * For the operator, from the command line: turn off two-step verification for
 * an account whose owner has lost their phone and their recovery codes and
 * has no owner or admin who could reset it for them. Signs the account out
 * everywhere and puts it on the record of every organisation they belong to.
 */
export async function resetMfaByOperator(db: DB, emailInput: string): Promise<{ name: string; wasOn: boolean }> {
  const email = normaliseEmail(emailInput);
  const [user] = await db.select({ id: users.id, name: users.name, enabledAt: users.mfaEnabledAt }).from(users).where(eq(users.email, email));
  if (!user) throw new UserError(`No account signs in with ${email}.`);
  if (!user.enabledAt) return { name: user.name, wasOn: false };
  await inTransaction(db, async (tx) => {
    await tx.update(users).set({ mfaSecret: null, mfaEnabledAt: null, mfaRecoveryCodes: null, mfaLastCounter: null }).where(eq(users.id, user.id));
    await tx.delete(sessions).where(eq(sessions.userId, user.id));
    await tx.delete(loginChallenges).where(eq(loginChallenges.userId, user.id));
    await recordAccountEvent(tx, user.id, {
      action: 'team.mfa_reset',
      actor: 'system',
      summary: `Two-step verification for ${user.name} was reset by the system operator from the command line, and they were signed out on every device`,
      data: { userId: user.id },
    });
  });
  return { name: user.name, wasOn: true };
}
