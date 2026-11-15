/**
 * What the sign-in, reset and two-step code share about a user account: how an
 * email address is compared, which organisations the person works in, and how
 * something that happened to their account is put on the record.
 */
import { and, asc, eq } from 'drizzle-orm';
import type { DB } from '@/db';
import { memberships, organizations, users } from '@/db/schema';
import { recordAudit, type AuditActor } from '@/server/audit';
import type { Role } from '@/server/types';
import { verifyPassword } from './password';
import { UserError, type Ctx } from './permissions';
import { passwordLimits, reserveAttempt, settleAttempt } from './throttle';

export const normaliseEmail = (email: string) => email.trim().toLowerCase();
export const validEmail = (email: string) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) && email.length <= 254;

/**
 * Ask a signed-in person for their password again before something sensitive
 * (changing it, turning two-step verification off). Wrong answers count
 * against the same limit as wrong passwords at sign-in, so a session left open
 * on a shared computer cannot be used to guess the password without limit.
 */
export async function confirmPassword(db: DB, userId: string, password: string): Promise<typeof users.$inferSelect> {
  const [user] = await db.select().from(users).where(eq(users.id, userId));
  if (!user) throw new UserError('Your current password is not correct.');
  const reservation = await reserveAttempt(db, 'password', passwordLimits(user.email));
  if (!reservation) throw new UserError('Too many wrong passwords. Try again in a few minutes.');
  if (!(await verifyPassword(password, user.passwordHash))) throw new UserError('Your current password is not correct.');
  await settleAttempt(db, reservation, true);
  return user;
}

export type ActiveOrganization = { id: string; name: string; isDemo: boolean; role: Role };

/** The organisations a person is an active member of, in id order. */
export async function activeOrganizations(db: DB, userId: string): Promise<ActiveOrganization[]> {
  const rows = await db
    .select({ id: organizations.id, name: organizations.name, isDemo: organizations.isDemo, role: memberships.role })
    .from(memberships)
    .innerJoin(organizations, eq(organizations.id, memberships.orgId))
    .where(and(eq(memberships.userId, userId), eq(memberships.status, 'active')))
    .orderBy(asc(organizations.id));
  return rows.map((r) => ({ ...r, role: r.role as Role }));
}

export type AccountEvent = {
  action: string;
  /**
   * Who did it. `self`: the account's owner. `system`: nobody signed in (a
   * reset link was used, the operator ran a command). A `Ctx`: an administrator
   * acting on someone else's account.
   */
  actor: 'self' | 'system' | Ctx;
  /** A plain sentence, shown to customers as written. Never a token, a code or a key. */
  summary: string | ((org: ActiveOrganization) => string);
  data?: Record<string, unknown>;
};

/**
 * Put an account event on the audit trail of every organisation the person is
 * an active member of. A password or a second step protects all of them, so
 * each one's record shows when it changed.
 *
 * Call it with the transaction that makes the change, so the record and the
 * change stand or fall together. `recordAudit` serialises writers per
 * organisation itself; the organisations are taken in id order so that two
 * account events for people who share organisations cannot deadlock.
 */
export async function recordAccountEvent(tx: DB, userId: string, event: AccountEvent): Promise<ActiveOrganization[]> {
  const [user] = await tx.select({ id: users.id, name: users.name, email: users.email }).from(users).where(eq(users.id, userId));
  if (!user) return [];
  const orgs = await activeOrganizations(tx, userId);
  for (const org of orgs) {
    const actor: AuditActor =
      event.actor === 'system'
        ? { system: true }
        : event.actor === 'self'
          ? { orgId: org.id, orgName: org.name, isDemo: org.isDemo, userId: user.id, userName: user.name, userEmail: user.email, role: org.role }
          : event.actor;
    await recordAudit(tx, {
      orgId: org.id,
      actor,
      action: event.action,
      entityType: 'user',
      entityId: user.id,
      summary: typeof event.summary === 'function' ? event.summary(org) : event.summary,
      data: event.data,
    });
  }
  return orgs;
}
