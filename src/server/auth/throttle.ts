/**
 * Limits on guessing: passwords, second-step codes and reset requests.
 *
 * Every attempt is a row in `auth_attempts`, so a limit holds across a restart
 * and across every instance of the app that shares the database. Nothing here
 * is kept in memory.
 *
 * An attempt is counted before it is evaluated. `reserveAttempt` takes a lock
 * on the subject, counts what is already there and, if there is room, writes
 * the attempt as a failure; `settleAttempt` turns it into a success afterwards
 * if that is how it went. Two instances receiving guesses at the same moment
 * therefore cannot both slip one in under the limit, and a process that dies
 * half-way leaves the attempt counted.
 */
import { and, desc, eq, gt, inArray, lt, sql } from 'drizzle-orm';
import type { DB } from '@/db';
import { inTransaction } from '@/db/tx';
import { authAttempts, loginChallenges, passwordResets, sessions } from '@/db/schema';
import { newId } from '@/server/ids';

const MINUTE = 60_000;

export type AttemptKind = 'password' | 'mfa' | 'reset' | 'signup' | 'portal';

export type Limit = {
  subject: string;
  /** Attempts allowed inside the window. */
  max: number;
  windowMs: number;
  /**
   * `failures`: failed attempts. `failures_since_success`: failed attempts
   * after the subject's most recent success, so a person who mistypes and then
   * gets it right starts from zero. `all`: every attempt, whatever its outcome.
   */
  count: 'failures' | 'failures_since_success' | 'all';
  /**
   * A browser that has signed in to the account before (src/server/auth/device.ts)
   * is not held back by this limit, though its attempts still count towards it.
   * Used for the limits a stranger could fill up on purpose to keep someone out.
   */
  soft?: boolean;
};

export const PASSWORD_ATTEMPTS_PER_EMAIL = 8;
export const PASSWORD_ATTEMPTS_PER_IP = 30;
export const PASSWORD_WINDOW_MS = 15 * MINUTE;
export const MFA_ATTEMPTS_PER_USER = 10;
export const MFA_WINDOW_MS = 15 * MINUTE;
export const RESET_REQUESTS_PER_EMAIL = 3;
export const RESET_WINDOW_MS = 60 * MINUTE;
export const SIGNUPS_PER_IP = 10;
export const SIGNUP_WINDOW_MS = 60 * MINUTE;
const KEEP_MS = 24 * 60 * MINUTE;

/** How an IP address is written as a throttle subject. */
export const ipSubject = (ip: string) => `ip:${ip}`;

/**
 * Password guesses, in 15-minute windows:
 *
 *  - An email address from one IP address: 8 wrong passwords, then that pair
 *    is locked. A success clears the count.
 *  - An email address from anywhere: 8 wrong passwords, then new browsers are
 *    refused for that address. A browser that has signed in to the account
 *    before can still try, so a stranger cannot keep someone out of their own
 *    account by guessing at it. A success clears the count.
 *  - An IP address across all email addresses: 30 wrong passwords. A success
 *    does not clear that, or one working account would let its owner guess at
 *    others without limit. A remembered browser is not held back by it, so
 *    wrong passwords sent in an office's name cannot lock that office out.
 *
 * However many IP addresses a guesser uses, an address takes at most 8 wrong
 * passwords per window from browsers that never signed in to it.
 */
export function passwordLimits(email: string | null, ipAddress?: string | null): Limit[] {
  const limits: Limit[] = [];
  if (email) limits.push({ subject: email, max: PASSWORD_ATTEMPTS_PER_EMAIL, windowMs: PASSWORD_WINDOW_MS, count: 'failures_since_success', soft: true });
  if (email && ipAddress) limits.push({ subject: `${email}|${ipSubject(ipAddress)}`, max: PASSWORD_ATTEMPTS_PER_EMAIL, windowMs: PASSWORD_WINDOW_MS, count: 'failures_since_success' });
  if (ipAddress) limits.push({ subject: ipSubject(ipAddress), max: PASSWORD_ATTEMPTS_PER_IP, windowMs: PASSWORD_WINDOW_MS, count: 'failures', soft: true });
  return limits;
}

/**
 * A signed-in person confirming their password before something sensitive:
 * 8 wrong passwords in 15 minutes. Kept apart from the sign-in count, so
 * strangers guessing at the address at the sign-in page do not stop the
 * account's owner from changing their own password.
 */
export function reauthLimits(email: string): Limit[] {
  return [{ subject: `${email}|reauth`, max: PASSWORD_ATTEMPTS_PER_EMAIL, windowMs: PASSWORD_WINDOW_MS, count: 'failures_since_success' }];
}

/** Second-step codes: 10 wrong codes per account in 15 minutes, however many sign-ins they are spread over. */
export function mfaLimits(email: string): Limit[] {
  return [{ subject: email, max: MFA_ATTEMPTS_PER_USER, windowMs: MFA_WINDOW_MS, count: 'failures' }];
}

/** New accounts: 10 per IP address per hour, so sign-up cannot be used to test many addresses for an account. */
export function signupLimits(ipAddress: string | null | undefined): Limit[] {
  return ipAddress ? [{ subject: ipSubject(ipAddress), max: SIGNUPS_PER_IP, windowMs: SIGNUP_WINDOW_MS, count: 'all' }] : [];
}

/** Reset requests: 3 per address per hour, whether or not they led to a link. */
export function resetLimits(email: string): Limit[] {
  return [{ subject: email, max: RESET_REQUESTS_PER_EMAIL, windowMs: RESET_WINDOW_MS, count: 'all' }];
}

export type Reservation = { ids: string[] };

async function used(tx: DB, kind: AttemptKind, limit: Limit, now: Date): Promise<number> {
  let since = new Date(now.getTime() - limit.windowMs);
  if (limit.count === 'failures_since_success') {
    const [last] = await tx
      .select({ at: authAttempts.createdAt })
      .from(authAttempts)
      .where(and(eq(authAttempts.subject, limit.subject), eq(authAttempts.kind, kind), eq(authAttempts.succeeded, true), gt(authAttempts.createdAt, since)))
      .orderBy(desc(authAttempts.createdAt))
      .limit(1);
    if (last) since = last.at;
  }
  const [row] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(authAttempts)
    .where(
      and(
        eq(authAttempts.subject, limit.subject),
        eq(authAttempts.kind, kind),
        gt(authAttempts.createdAt, since),
        limit.count === 'all' ? undefined : eq(authAttempts.succeeded, false),
      ),
    );
  return row?.n ?? 0;
}

/**
 * Count an attempt against every limit that applies to it. Returns null when
 * one of them is already used up: the attempt must then be refused without
 * being evaluated, and it is not recorded, so someone hammering a locked
 * address cannot keep it locked for longer than the window. With
 * `rememberedDevice`, soft limits are counted but do not refuse.
 */
export async function reserveAttempt(db: DB, kind: AttemptKind, limits: Limit[], opts: { now?: Date; rememberedDevice?: boolean } = {}): Promise<Reservation | null> {
  if (limits.length === 0) return { ids: [] };
  const now = opts.now ?? new Date();
  // Locks are always taken in the same order, so two attempts that share subjects cannot deadlock.
  const ordered = [...limits].sort((a, b) => a.subject.localeCompare(b.subject));
  const reservation = await inTransaction(db, async (tx) => {
    for (const limit of ordered) {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`auth:${kind}:${limit.subject}`}))`);
    }
    for (const limit of ordered) {
      if (limit.soft && opts.rememberedDevice) continue;
      if ((await used(tx, kind, limit, now)) >= limit.max) return null;
    }
    const rows = ordered.map((limit) => ({ id: newId('att'), subject: limit.subject, kind, succeeded: false, createdAt: now }));
    await tx.insert(authAttempts).values(rows);
    return { ids: rows.map((r) => r.id) };
  });
  // Housekeeping rides along with a small share of attempts; it never decides the outcome of one.
  if (Math.random() < 0.02) await pruneAuthRecords(db, now).catch((err) => console.error('[auth] housekeeping failed:', err instanceof Error ? err.message : err));
  return reservation;
}

/** Record that a reserved attempt succeeded. A failed attempt needs nothing: it was written as a failure. */
export async function settleAttempt(db: DB, reservation: Reservation, succeeded: boolean): Promise<void> {
  if (!succeeded || reservation.ids.length === 0) return;
  await db.update(authAttempts).set({ succeeded: true }).where(inArray(authAttempts.id, reservation.ids));
}

/** Record a success that was not preceded by a guess, such as completing a password reset, which clears the address's failed attempts. */
export async function recordSuccess(db: DB, kind: AttemptKind, subject: string, now: Date = new Date()): Promise<void> {
  await db.insert(authAttempts).values({ id: newId('att'), subject, kind, succeeded: true, createdAt: now });
}

/** Whether a limit is used up right now, without counting an attempt. */
export async function isLimited(db: DB, kind: AttemptKind, limits: Limit[], now: Date = new Date(), opts: { rememberedDevice?: boolean } = {}): Promise<boolean> {
  for (const limit of limits) {
    if (limit.soft && opts.rememberedDevice) continue;
    if ((await used(db, kind, limit, now)) >= limit.max) return true;
  }
  return false;
}

/**
 * Delete what no longer matters: attempts older than a day (the longest window
 * is an hour), and sign-in challenges, reset links and sessions that expired
 * more than a day ago.
 */
export async function pruneAuthRecords(db: DB, now: Date = new Date()): Promise<void> {
  const cutoff = new Date(now.getTime() - KEEP_MS);
  await db.delete(authAttempts).where(lt(authAttempts.createdAt, cutoff));
  await db.delete(loginChallenges).where(lt(loginChallenges.expiresAt, cutoff));
  await db.delete(passwordResets).where(lt(passwordResets.expiresAt, cutoff));
  await db.delete(sessions).where(lt(sessions.expiresAt, cutoff));
}
