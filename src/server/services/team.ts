/**
 * Accounts, organisations, sessions, invitations and roles.
 * Framework-free: the cookie handling lives in src/server/auth/session.ts.
 */
import { and, desc, eq, gt, isNull, ne, sql } from 'drizzle-orm';
import type { DB } from '@/db';
import { inTransaction, locked, withOrgLock } from '@/db/tx';
import { invitations, loginChallenges, memberships, organizations, passwordResets, payApplications, sessions, users, nextVersion } from '@/db/schema';
import { recordAudit } from '@/server/audit';
import { confirmPassword, normaliseEmail, recordAccountEvent, validEmail } from '@/server/auth/account';
import { DUMMY_PASSWORD_HASH, hashPassword, passwordProblem, verifyPassword } from '@/server/auth/password';
import { issueResetToken, resetLink, RESET_LINK_MINUTES } from '@/server/auth/password-reset';
import { assertCan, can, ROLE_LABEL, UserError, type Ctx } from '@/server/auth/permissions';
import { isRememberedDevice, deviceToken } from '@/server/auth/device';
import { passwordLimits, reserveAttempt, settleAttempt, signupLimits } from '@/server/auth/throttle';
import { describeUserAgent } from '@/server/auth/user-agent';
import { newId, randomToken, sha256Hex } from '@/server/ids';
import type { OrgSettings, Role } from '@/server/types';
import { DEFAULT_ORG_SETTINGS, OPEN_STATUSES, ROLES, resolveSettings } from '@/server/types';
import { inArray } from 'drizzle-orm';
import { notifyUsers } from './notify';
import { runReconciliation } from './reconcile';

const DAY_MS = 86_400_000;
/** A session ends this long after it was started, however much it is used. */
export const SESSION_DAYS = 14;
/** A session that has not been used for this long ends, even if its absolute lifetime has not run out. */
export const SESSION_IDLE_DAYS = 14;
/** `lastSeenAt` is written at most this often, so reading a page does not mean a write on every request. */
export const SESSION_SEEN_INTERVAL_MS = 5 * 60_000;
const INVITE_DAYS = 7;

// ── Organisations ───────────────────────────────────────────────────────────

export async function createOrganization(db: DB, userId: string, name: string, opts: { isDemo?: boolean; at?: Date } = {}): Promise<string> {
  const clean = name.trim();
  if (clean.length < 2 || clean.length > 120) throw new UserError('Enter your company name.');
  const id = newId('org');
  // The organisation, its first owner and the first line of its audit trail are written together.
  await withOrgLock(db, id, async (tx) => {
    await tx.insert(organizations).values({ id, name: clean, isDemo: opts.isDemo ?? false, intakeToken: randomToken(18), settings: { ...DEFAULT_ORG_SETTINGS }, createdAt: opts.at ?? new Date() });
    await tx.insert(memberships).values({ id: newId('mem'), orgId: id, userId, role: 'owner', createdAt: opts.at ?? new Date() });
    const [user] = await tx.select().from(users).where(eq(users.id, userId));
    await recordAudit(tx, {
      orgId: id,
      actor: { orgId: id, orgName: clean, isDemo: !!opts.isDemo, userId, userName: user?.name ?? 'Unknown', userEmail: user?.email ?? '', role: 'owner' },
      action: 'organization.created',
      entityType: 'organization',
      entityId: id,
      summary: `Created organisation ${clean}${opts.isDemo ? ' (demo workspace)' : ''}`,
      at: opts.at,
    });
  });
  return id;
}

export const TOO_MANY_SIGN_UPS = 'Too many new accounts from this network. Try again in an hour.';

/**
 * Create an account and its organisation. Sign-ups are limited per IP address
 * (`signupLimits`), because the answer for an address that already has an
 * account would otherwise let anyone test addresses without limit.
 */
export async function signUp(db: DB, input: { name: string; email: string; password: string; orgName: string }, meta: { ipAddress?: string | null } = {}): Promise<{ userId: string; orgId: string }> {
  const email = normaliseEmail(input.email);
  const name = input.name.trim();
  if (name.length < 2) throw new UserError('Enter your name.');
  if (!validEmail(email)) throw new UserError('Enter a valid work email.');
  const problem = passwordProblem(input.password, { email, name });
  if (problem) throw new UserError(problem);
  if (input.orgName.trim().length < 2) throw new UserError('Enter your company name.');
  if (!(await reserveAttempt(db, 'signup', signupLimits(meta.ipAddress)))) throw new UserError(TOO_MANY_SIGN_UPS);
  const [existing] = await db.select({ id: users.id }).from(users).where(eq(users.email, email));
  if (existing) throw new UserError('An account with that email already exists. Sign in instead.');
  const userId = newId('usr');
  const passwordHash = await hashPassword(input.password);
  // The account and its organisation are created together or not at all.
  return inTransaction(db, async (tx) => {
    await tx.insert(users).values({ id: userId, email, name, passwordHash });
    const orgId = await createOrganization(tx, userId, input.orgName);
    return { userId, orgId };
  });
}

// ── Sign-in ─────────────────────────────────────────────────────────────────

export const TOO_MANY_SIGN_INS = 'Too many sign-in attempts. Try again in a few minutes.';

/**
 * Check an email address and password. Returns the account on success and
 * null on any failure, without saying which part was wrong. It does not start
 * a session: an account with two-step verification still owes its second step
 * (see src/server/auth/sign-in.ts).
 *
 * Attempts are counted in the database (src/server/auth/throttle.ts,
 * `passwordLimits`). A refused attempt gets the same answer whether or not the
 * address has an account, and the password is not looked at. `deviceTokens`
 * are the remembered-device tokens the browser sent (src/server/auth/device.ts);
 * on success the account's current token is returned for the browser to keep.
 */
export async function authenticate(
  db: DB,
  emailInput: string,
  password: string,
  meta: { ipAddress?: string | null; deviceTokens?: string[] } = {},
): Promise<{ id: string; mfaEnabled: boolean; deviceToken: string | null } | null> {
  const email = normaliseEmail(emailInput);
  const [user] = validEmail(email) ? await db.select().from(users).where(eq(users.email, email)) : [];
  const rememberedDevice = !!user && isRememberedDevice(user, meta.deviceTokens ?? []);
  // Something that is not an email address cannot be an account; it still counts against the IP address.
  const reservation = await reserveAttempt(db, 'password', passwordLimits(validEmail(email) ? email : null, meta.ipAddress), { rememberedDevice });
  if (!reservation) throw new UserError(TOO_MANY_SIGN_INS);
  // Always run the hash so the response time does not reveal whether the account exists.
  const ok = await verifyPassword(password, user?.passwordHash ?? DUMMY_PASSWORD_HASH);
  if (!user || !ok) return null;
  await settleAttempt(db, reservation, true);
  return { id: user.id, mfaEnabled: !!user.mfaEnabledAt, deviceToken: deviceToken(user) };
}

/** What is recorded about the device a session is started from. Best effort: both come from request headers. */
export type SessionMeta = { userAgent?: string | null; ipAddress?: string | null; /** The second step was passed while signing in. */ mfaVerified?: boolean; now?: Date };

export async function createSession(db: DB, userId: string, orgId?: string | null, meta: SessionMeta = {}): Promise<{ token: string; expiresAt: Date }> {
  const now = meta.now ?? new Date();
  let org = orgId ?? null;
  if (!org) {
    // Prefer a real workspace over a demo one.
    const rows = await db
      .select({ orgId: memberships.orgId, isDemo: organizations.isDemo, createdAt: memberships.createdAt })
      .from(memberships)
      .innerJoin(organizations, eq(organizations.id, memberships.orgId))
      .where(and(eq(memberships.userId, userId), eq(memberships.status, 'active')));
    rows.sort((a, b) => Number(a.isDemo) - Number(b.isDemo) || a.createdAt.getTime() - b.createdAt.getTime());
    org = rows[0]?.orgId ?? null;
  }
  const token = randomToken(32);
  const expiresAt = new Date(now.getTime() + SESSION_DAYS * DAY_MS);
  // Only the hash of the token is stored: reading the sessions table does not give anyone a working cookie.
  await db.insert(sessions).values({
    id: sha256Hex(token),
    userId,
    orgId: org,
    createdAt: now,
    expiresAt,
    lastSeenAt: now,
    userAgent: meta.userAgent ? meta.userAgent.slice(0, 400) : null,
    ipAddress: meta.ipAddress ? meta.ipAddress.slice(0, 64) : null,
    mfaVerifiedAt: meta.mfaVerified ? now : null,
  });
  // Starting a session is what counts as signing in: a correct password that still owes a second step does not.
  await db.update(users).set({ lastLoginAt: now }).where(eq(users.id, userId));
  return { token, expiresAt };
}

export type SessionInfo = {
  /** The acting member, or null when the person has no organisation or cannot use the one the session is in (see `mfaRequired`). */
  ctx: Ctx | null;
  user: { id: string; name: string; email: string; mfaEnabled: boolean };
  /** The stored id of this session: the hash of its token, never the token. */
  sessionId: string;
  /**
   * Set when the session's organisation requires two-step verification and this
   * person has not turned it on. `ctx` is null in that case, so nothing in the
   * organisation can be read or changed until they have.
   */
  mfaRequired: { orgId: string; orgName: string } | null;
};

/**
 * Resolve a cookie token to the acting user and their active organisation.
 *
 * A session is refused when it is past its absolute lifetime, when it has not
 * been used for SESSION_IDLE_DAYS, or when the account has two-step
 * verification turned on and this session never passed the second step.
 */
export async function resolveSession(db: DB, token: string | undefined | null, opts: { now?: Date } = {}): Promise<SessionInfo | null> {
  if (!token) return null;
  const now = opts.now ?? new Date();
  const id = sha256Hex(token);
  const [row] = await db
    .select({ session: sessions, user: users })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(and(eq(sessions.id, id), gt(sessions.expiresAt, now)));
  if (!row) return null;
  const lastSeen = row.session.lastSeenAt ?? row.session.createdAt;
  if (now.getTime() - lastSeen.getTime() > SESSION_IDLE_DAYS * DAY_MS) {
    await db.delete(sessions).where(eq(sessions.id, id));
    return null;
  }
  if (row.user.mfaEnabledAt && !row.session.mfaVerifiedAt) return null;
  if (now.getTime() - lastSeen.getTime() >= SESSION_SEEN_INTERVAL_MS) {
    await db.update(sessions).set({ lastSeenAt: now }).where(eq(sessions.id, id));
  }

  const user = { id: row.user.id, name: row.user.name, email: row.user.email, mfaEnabled: !!row.user.mfaEnabledAt };
  const none: SessionInfo = { ctx: null, user, sessionId: id, mfaRequired: null };
  if (!row.session.orgId) return none;
  const [m] = await db
    .select({ role: memberships.role, org: organizations })
    .from(memberships)
    .innerJoin(organizations, eq(organizations.id, memberships.orgId))
    .where(and(eq(memberships.userId, user.id), eq(memberships.orgId, row.session.orgId), eq(memberships.status, 'active')));
  if (!m) return none;
  // The organisation's rule is applied here, where every page, action and API route gets its
  // context from, so it cannot be skipped by going around the screens.
  if (resolveSettings(m.org.settings).requireMfa && !user.mfaEnabled) {
    return { ...none, mfaRequired: { orgId: m.org.id, orgName: m.org.name } };
  }
  return {
    ...none,
    ctx: { orgId: m.org.id, orgName: m.org.name, isDemo: m.org.isDemo, userId: user.id, userName: user.name, userEmail: user.email, role: m.role as Role },
  };
}

/** Signing out deletes the session, so the cookie stops working even if a copy of it survives somewhere. */
export async function destroySession(db: DB, token: string | undefined | null): Promise<void> {
  if (token) await db.delete(sessions).where(eq(sessions.id, sha256Hex(token)));
}

/**
 * The id a session is known by on screen. It is derived from the stored id, so
 * the device list never hands the browser anything that is looked up directly.
 */
export const publicSessionId = (storedId: string) => sha256Hex(`session:${storedId}`).slice(0, 24);

export type SessionSummary = {
  /** `publicSessionId`, for signing this one out. */
  id: string;
  /** The session this list was asked for from. */
  current: boolean;
  /** For example "Chrome on macOS"; "Unknown device" when the browser did not say. */
  device: string;
  ipAddress: string | null;
  organization: string | null;
  createdAt: Date;
  lastSeenAt: Date;
  expiresAt: Date;
};

/** The sessions signed in to this account right now: the current one first, then the most recently used. */
export async function listSessions(db: DB, userId: string, currentToken?: string | null, opts: { now?: Date } = {}): Promise<SessionSummary[]> {
  const now = opts.now ?? new Date();
  const current = currentToken ? sha256Hex(currentToken) : null;
  const rows = await db
    .select({ session: sessions, orgName: organizations.name })
    .from(sessions)
    .leftJoin(organizations, eq(organizations.id, sessions.orgId))
    .where(and(eq(sessions.userId, userId), gt(sessions.expiresAt, now)));
  return rows
    .map(({ session, orgName }) => ({
      id: publicSessionId(session.id),
      current: session.id === current,
      device: describeUserAgent(session.userAgent),
      ipAddress: session.ipAddress,
      organization: orgName,
      createdAt: session.createdAt,
      lastSeenAt: session.lastSeenAt ?? session.createdAt,
      expiresAt: session.expiresAt,
    }))
    .filter((s) => now.getTime() - s.lastSeenAt.getTime() <= SESSION_IDLE_DAYS * DAY_MS)
    .sort((a, b) => Number(b.current) - Number(a.current) || b.lastSeenAt.getTime() - a.lastSeenAt.getTime());
}

/** Sign out one of your own other sessions, by the id the device list shows. */
export async function revokeSession(db: DB, userId: string, publicId: string, currentToken?: string | null): Promise<void> {
  if (currentToken && publicSessionId(sha256Hex(currentToken)) === publicId) throw new UserError('That is the session you are using. Choose Sign out to end it.');
  await inTransaction(db, async (tx) => {
    // Only this person's own sessions are searched: an id from someone else's account matches nothing.
    const mine = await tx.select({ id: sessions.id }).from(sessions).where(eq(sessions.userId, userId));
    const target = mine.find((s) => publicSessionId(s.id) === publicId);
    if (!target) return;
    const [gone] = await tx.delete(sessions).where(and(eq(sessions.userId, userId), eq(sessions.id, target.id))).returning({ userAgent: sessions.userAgent });
    if (!gone) return;
    await recordAccountEvent(tx, userId, { action: 'team.session_revoked', actor: 'self', summary: `Signed out one of their own sessions (${describeUserAgent(gone.userAgent)})` });
  });
}

/** Sign out every session of this account except the one asking. Returns how many were ended. */
export async function revokeOtherSessions(db: DB, userId: string, currentToken: string): Promise<number> {
  return inTransaction(db, async (tx) => {
    const gone = await tx.delete(sessions).where(and(eq(sessions.userId, userId), ne(sessions.id, sha256Hex(currentToken)))).returning({ id: sessions.id });
    if (gone.length > 0) {
      await recordAccountEvent(tx, userId, { action: 'team.session_revoked', actor: 'self', summary: `Signed out all of their other sessions (${gone.length})`, data: { sessions: gone.length } });
    }
    return gone.length;
  });
}

export async function listMyOrganizations(db: DB, userId: string) {
  const rows = await db
    .select({ id: organizations.id, name: organizations.name, isDemo: organizations.isDemo, role: memberships.role, settings: organizations.settings })
    .from(memberships)
    .innerJoin(organizations, eq(organizations.id, memberships.orgId))
    .where(and(eq(memberships.userId, userId), eq(memberships.status, 'active')))
    .orderBy(organizations.isDemo, organizations.name);
  return rows.map(({ settings, ...org }) => ({ ...org, requiresMfa: resolveSettings(settings).requireMfa }));
}

export async function switchOrganization(db: DB, token: string, userId: string, orgId: string): Promise<void> {
  const [m] = await db.select({ id: memberships.id }).from(memberships).where(and(eq(memberships.userId, userId), eq(memberships.orgId, orgId), eq(memberships.status, 'active')));
  if (!m) throw new UserError('You are not a member of that organisation.');
  await db.update(sessions).set({ orgId }).where(and(eq(sessions.id, sha256Hex(token)), eq(sessions.userId, userId)));
}

// ── Team ────────────────────────────────────────────────────────────────────

export async function listMembers(db: DB, ctx: Ctx) {
  return db
    .select({
      userId: users.id,
      name: users.name,
      email: users.email,
      role: memberships.role,
      status: memberships.status,
      joinedAt: memberships.createdAt,
      lastLoginAt: users.lastLoginAt,
      // Whether it is on, and nothing else about it.
      mfaEnabled: sql<boolean>`${users.mfaEnabledAt} is not null`,
    })
    .from(memberships)
    .innerJoin(users, eq(users.id, memberships.userId))
    .where(eq(memberships.orgId, ctx.orgId))
    .orderBy(users.name);
}

export async function listInvitations(db: DB, ctx: Ctx) {
  return db
    .select()
    .from(invitations)
    .where(and(eq(invitations.orgId, ctx.orgId), isNull(invitations.acceptedAt), isNull(invitations.revokedAt)))
    .orderBy(desc(invitations.createdAt));
}

function assertAssignable(ctx: Ctx, role: string): asserts role is Role {
  if (!(ROLES as readonly string[]).includes(role)) throw new UserError('Unknown role.');
  if (role === 'owner' && ctx.role !== 'owner') throw new UserError('Only an owner can make someone an owner.');
}

/** Create an invitation and return the one-time token (shown once, stored only as a hash). */
export const inviteMember = locked(async function inviteMember(db: DB, ctx: Ctx, input: { email: string; role: string }): Promise<{ id: string; token: string }> {
  assertCan(ctx, 'team:manage');
  const email = normaliseEmail(input.email);
  if (!validEmail(email)) throw new UserError('Enter a valid email address.');
  assertAssignable(ctx, input.role);
  const [member] = await db
    .select({ id: memberships.id })
    .from(memberships)
    .innerJoin(users, eq(users.id, memberships.userId))
    .where(and(eq(memberships.orgId, ctx.orgId), eq(users.email, email)));
  if (member) throw new UserError('That person is already a member.');
  // One live invitation per address.
  await db.update(invitations).set({ revokedAt: new Date() }).where(and(eq(invitations.orgId, ctx.orgId), eq(invitations.email, email), isNull(invitations.acceptedAt), isNull(invitations.revokedAt)));
  const token = randomToken(24);
  const id = newId('inv');
  await db.insert(invitations).values({ id, orgId: ctx.orgId, email, role: input.role, tokenHash: sha256Hex(token), invitedBy: ctx.userId, expiresAt: new Date(Date.now() + INVITE_DAYS * 86_400_000) });
  await recordAudit(db, { orgId: ctx.orgId, actor: ctx, action: 'team.invited', entityType: 'invitation', entityId: id, summary: `Invited ${email} as ${ROLE_LABEL[input.role]}`, data: { email, role: input.role } });
  return { id, token };
});

export const revokeInvitation = locked(async function revokeInvitation(db: DB, ctx: Ctx, id: string): Promise<void> {
  assertCan(ctx, 'team:manage');
  const [inv] = await db.select().from(invitations).where(and(eq(invitations.orgId, ctx.orgId), eq(invitations.id, id)));
  if (!inv || inv.acceptedAt || inv.revokedAt) return;
  await db.update(invitations).set({ revokedAt: new Date() }).where(eq(invitations.id, id));
  await recordAudit(db, { orgId: ctx.orgId, actor: ctx, action: 'team.invitation_revoked', entityType: 'invitation', entityId: id, summary: `Revoked the invitation for ${inv.email}` });
});

export async function findInvitation(db: DB, token: string) {
  const [row] = await db
    .select({ inv: invitations, orgName: organizations.name })
    .from(invitations)
    .innerJoin(organizations, eq(organizations.id, invitations.orgId))
    .where(eq(invitations.tokenHash, sha256Hex(token)));
  if (!row || row.inv.acceptedAt || row.inv.revokedAt || row.inv.expiresAt < new Date()) return null;
  const [existing] = await db.select({ id: users.id }).from(users).where(eq(users.email, row.inv.email));
  return { id: row.inv.id, orgId: row.inv.orgId, orgName: row.orgName, email: row.inv.email, role: row.inv.role as Role, hasAccount: !!existing };
}

const INVALID_INVITATION = 'This invitation is no longer valid. Ask for a new one.';

export type AcceptOutcome =
  /** The person is now a member and may be signed in to the organisation. */
  | { status: 'joined'; userId: string; orgId: string }
  /**
   * The account has two-step verification. Nothing has been joined yet: the
   * caller starts a login challenge carrying `invitationId`, and the
   * membership is created when the second step passes
   * (`acceptInvitationAfterSecondStep`).
   */
  | { status: 'second_factor'; userId: string; invitationId: string };

/**
 * Accept an invitation, creating the account if the invitee does not have one.
 *
 * For an existing account the password is checked. If the account has
 * two-step verification the invitation is not used up here: joining an
 * organisation with a password alone would let someone who knows the password
 * put the account in an organisation they control, then recover it from there.
 */
export async function acceptInvitation(db: DB, token: string, input: { name?: string; password: string }): Promise<AcceptOutcome> {
  const inv = await findInvitation(db, token);
  if (!inv) throw new UserError(INVALID_INVITATION);
  const [existing] = await db.select().from(users).where(eq(users.email, inv.email));

  // Passwords are checked and hashed before the organisation's lock is taken: both are slow on purpose.
  if (existing) {
    // Holding the link is not enough to join as someone else, and guesses here count like guesses at sign-in.
    const reservation = await reserveAttempt(db, 'password', passwordLimits(inv.email));
    if (!reservation) throw new UserError('Too many attempts. Try again in a few minutes.');
    if (!(await verifyPassword(input.password, existing.passwordHash))) throw new UserError('That password is not correct for this account.');
    await settleAttempt(db, reservation, true);
    if (existing.mfaEnabledAt) return { status: 'second_factor', userId: existing.id, invitationId: inv.id };
    if (!(await joinWithInvitation(db, inv, { id: existing.id, name: existing.name, email: existing.email }))) throw new UserError(INVALID_INVITATION);
    return { status: 'joined', userId: existing.id, orgId: inv.orgId };
  }

  const name = input.name?.trim() ?? '';
  if (name.length < 2) throw new UserError('Enter your name.');
  const problem = passwordProblem(input.password, { email: inv.email, name });
  if (problem) throw new UserError(problem);
  const created = { id: newId('usr'), name, email: inv.email, passwordHash: await hashPassword(input.password) };
  if (!(await joinWithInvitation(db, inv, created, created.passwordHash))) throw new UserError(INVALID_INVITATION);
  return { status: 'joined', userId: created.id, orgId: inv.orgId };
}

/**
 * Finish accepting an invitation once the second step has passed. Returns the
 * organisation joined, or null when the invitation was accepted, revoked or
 * expired in the meantime, or is not for this account. Runs inside the caller's
 * transaction when there is one.
 */
export async function acceptInvitationAfterSecondStep(db: DB, invitationId: string, userId: string): Promise<string | null> {
  const [row] = await db
    .select({ inv: invitations, orgName: organizations.name })
    .from(invitations)
    .innerJoin(organizations, eq(organizations.id, invitations.orgId))
    .where(eq(invitations.id, invitationId));
  const [user] = await db.select({ id: users.id, name: users.name, email: users.email }).from(users).where(eq(users.id, userId));
  if (!row || !user || row.inv.email !== user.email) return null;
  const inv = { id: row.inv.id, orgId: row.inv.orgId, orgName: row.orgName, role: row.inv.role as Role };
  return (await joinWithInvitation(db, inv, user)) ? inv.orgId : null;
}


/**
 * Use up an invitation and make the person a member. The account (when
 * `newPasswordHash` is given, it is created here), the membership, the
 * used-up invitation and the audit event are written together. False when the
 * invitation can no longer be used: only one request can accept it.
 */
async function joinWithInvitation(
  db: DB,
  inv: { id: string; orgId: string; orgName: string; role: Role },
  user: { id: string; name: string; email: string },
  newPasswordHash?: string,
): Promise<boolean> {
  return withOrgLock(db, inv.orgId, async (tx) => {
    const now = new Date();
    const [claimed] = await tx
      .update(invitations)
      .set({ acceptedAt: now })
      .where(and(eq(invitations.id, inv.id), isNull(invitations.acceptedAt), isNull(invitations.revokedAt), gt(invitations.expiresAt, now)))
      .returning({ id: invitations.id });
    if (!claimed) return false;
    if (newPasswordHash) await tx.insert(users).values({ id: user.id, email: user.email, name: user.name, passwordHash: newPasswordHash });
    const [already] = await tx.select({ id: memberships.id }).from(memberships).where(and(eq(memberships.orgId, inv.orgId), eq(memberships.userId, user.id)));
    if (!already) await tx.insert(memberships).values({ id: newId('mem'), orgId: inv.orgId, userId: user.id, role: inv.role });
    await recordAudit(tx, {
      orgId: inv.orgId,
      actor: { orgId: inv.orgId, orgName: inv.orgName, isDemo: false, userId: user.id, userName: user.name, userEmail: user.email, role: inv.role },
      action: 'team.joined',
      entityType: 'membership',
      entityId: user.id,
      summary: `${user.name} joined as ${ROLE_LABEL[inv.role]}`,
    });
    return true;
  });
}

async function ownerCount(db: DB, orgId: string, exceptUserId?: string): Promise<number> {
  const rows = await db.select({ userId: memberships.userId }).from(memberships).where(and(eq(memberships.orgId, orgId), eq(memberships.role, 'owner'), eq(memberships.status, 'active')));
  return rows.filter((r) => r.userId !== exceptUserId).length;
}

export const changeRole = locked(async function changeRole(db: DB, ctx: Ctx, userId: string, role: string): Promise<void> {
  assertCan(ctx, 'team:manage');
  assertAssignable(ctx, role);
  if (userId === ctx.userId) throw new UserError('You cannot change your own role. Ask another admin.');
  const [m] = await db.select().from(memberships).where(and(eq(memberships.orgId, ctx.orgId), eq(memberships.userId, userId)));
  if (!m) throw new UserError('Member not found.');
  if (m.role === role) return;
  if (m.role === 'owner') {
    if (ctx.role !== 'owner') throw new UserError('Only an owner can change another owner’s role.');
    if ((await ownerCount(db, ctx.orgId, userId)) === 0) throw new UserError('An organisation needs at least one owner.');
  }
  await db.update(memberships).set({ role }).where(eq(memberships.id, m.id));
  const [user] = await db.select({ name: users.name }).from(users).where(eq(users.id, userId));
  await recordAudit(db, { orgId: ctx.orgId, actor: ctx, action: 'team.role_changed', entityType: 'membership', entityId: userId, summary: `Changed ${user?.name ?? 'member'} from ${ROLE_LABEL[m.role as Role]} to ${ROLE_LABEL[role]}`, data: { from: m.role, to: role } });
});

export const setMemberActive = locked(async function setMemberActive(db: DB, ctx: Ctx, userId: string, active: boolean): Promise<void> {
  assertCan(ctx, 'team:manage');
  if (userId === ctx.userId) throw new UserError('You cannot deactivate yourself.');
  const [m] = await db.select().from(memberships).where(and(eq(memberships.orgId, ctx.orgId), eq(memberships.userId, userId)));
  if (!m) throw new UserError('Member not found.');
  if (!active && m.role === 'owner') {
    if (ctx.role !== 'owner') throw new UserError('Only an owner can deactivate another owner.');
    if ((await ownerCount(db, ctx.orgId, userId)) === 0) throw new UserError('An organisation needs at least one owner.');
  }
  await db.update(memberships).set({ status: active ? 'active' : 'deactivated' }).where(eq(memberships.id, m.id));
  if (!active) {
    // Cut off access immediately and hand back anything assigned to them.
    await db.delete(sessions).where(and(eq(sessions.userId, userId), eq(sessions.orgId, ctx.orgId)));
    await db.update(payApplications).set({ version: nextVersion, assigneeId: null }).where(and(eq(payApplications.orgId, ctx.orgId), eq(payApplications.assigneeId, userId), inArray(payApplications.status, OPEN_STATUSES)));
  }
  const [user] = await db.select({ name: users.name }).from(users).where(eq(users.id, userId));
  await recordAudit(db, { orgId: ctx.orgId, actor: ctx, action: active ? 'team.reactivated' : 'team.deactivated', entityType: 'membership', entityId: userId, summary: `${active ? 'Reactivated' : 'Deactivated'} ${user?.name ?? 'member'}` });
});

// ── Account recovery by an administrator ────────────────────────────────────

/**
 * The checks every recovery action shares. The person must be an active member
 * of the administrator's own organisation: an id from anywhere else is "not
 * found". Nobody recovers their own account this way, and only an owner can do
 * it to an owner, because recovering an account is a way of becoming it.
 */
async function recoverableMember(db: DB, ctx: Ctx, userId: string, what: string): Promise<{ name: string; email: string }> {
  assertCan(ctx, 'team:manage');
  // The context is re-read rather than trusted: a session resolved a moment before the actor was deactivated or demoted must not get this far.
  const [actor] = await db.select({ role: memberships.role }).from(memberships).where(and(eq(memberships.orgId, ctx.orgId), eq(memberships.userId, ctx.userId), eq(memberships.status, 'active')));
  if (!actor || !can(actor.role as Role, 'team:manage')) throw new UserError('You no longer have permission to manage this team.');
  if (userId === ctx.userId) throw new UserError(`You cannot ${what} for yourself here. Use Settings → Profile, or ask another owner or admin.`);
  const [m] = await db
    .select({ role: memberships.role, status: memberships.status, name: users.name, email: users.email })
    .from(memberships)
    .innerJoin(users, eq(users.id, memberships.userId))
    .where(and(eq(memberships.orgId, ctx.orgId), eq(memberships.userId, userId)));
  if (!m) throw new UserError('Member not found.');
  if (m.status !== 'active') throw new UserError(`${m.name} is deactivated in this organisation. Reactivate them first.`);
  if (m.role === 'owner' && actor.role !== 'owner') throw new UserError(`Only an owner can ${what} for another owner.`);
  // Recovering an account hands over all of it, including its access to every other organisation it
  // belongs to. Anyone can become an owner by signing up, so an owner here must not be able to do that.
  // Demo workspaces hold sample data only and do not count. The other organisation is not named.
  const [elsewhere] = await db
    .select({ id: memberships.id })
    .from(memberships)
    .innerJoin(organizations, eq(organizations.id, memberships.orgId))
    .where(and(eq(memberships.userId, userId), ne(memberships.orgId, ctx.orgId), eq(organizations.isDemo, false)))
    .limit(1);
  if (elsewhere) {
    throw new UserError(
      `${m.name} also belongs to another organisation, so an owner or admin here cannot ${what} for them: it would give you their access there too. ` +
        'They can set a new password with “Forgot password?” on the sign-in page. For anything else, the person who runs this installation can help (docs/authentication.md, “Operator recovery”).',
    );
  }
  return { name: m.name, email: m.email };
}

/** How an administrator's action on someone's account reads in each organisation that person belongs to. */
const asAdminOf = (ctx: Ctx, sentence: string) => (org: { id: string }) => (org.id === ctx.orgId ? sentence : `${sentence}, acting as ${ROLE_LABEL[ctx.role]} of ${ctx.orgName}`);

/**
 * Create a one-time link with which a member can set a new password. The link
 * is returned once, for the administrator to pass on, and only its hash is
 * stored. It replaces any earlier unused link for that person.
 */
export const issueMemberPasswordReset = locked(async function issueMemberPasswordReset(db: DB, ctx: Ctx, userId: string): Promise<{ link: string; expiresAt: Date; name: string; email: string }> {
  const member = await recoverableMember(db, ctx, userId, 'create a password reset link');
  const { token, expiresAt } = await issueResetToken(db, userId, ctx.userId);
  await recordAccountEvent(db, userId, {
    action: 'team.password_reset_issued',
    actor: ctx,
    summary: asAdminOf(ctx, `Created a one-time password reset link for ${member.name}`),
    data: { userId, expiresAt: expiresAt.toISOString() },
  });
  await notifyUsers(db, ctx.orgId, [userId], {
    type: 'security',
    title: `${ctx.userName} created a password reset link for your account`,
    body: `It works once and expires in ${RESET_LINK_MINUTES} minutes. If you did not ask for it, tell an owner or admin of ${ctx.orgName} straight away.`,
    href: '/settings/profile',
  });
  return { link: resetLink(token), expiresAt, name: member.name, email: member.email };
});

/**
 * For a member who has lost their phone: turn their two-step verification off
 * so they can set it up again. Their key and recovery codes are deleted and
 * they are signed out everywhere. Their password is not changed.
 */
export const resetMemberMfa = locked(async function resetMemberMfa(db: DB, ctx: Ctx, userId: string): Promise<void> {
  const member = await recoverableMember(db, ctx, userId, 'reset two-step verification');
  const [user] = await db.select({ mfaSecret: users.mfaSecret, mfaEnabledAt: users.mfaEnabledAt }).from(users).where(eq(users.id, userId)).for('update');
  if (!user?.mfaEnabledAt && !user?.mfaSecret) throw new UserError(`${member.name} does not have two-step verification turned on.`);
  await db.update(users).set({ mfaSecret: null, mfaEnabledAt: null, mfaRecoveryCodes: null, mfaLastCounter: null }).where(eq(users.id, userId));
  await db.delete(sessions).where(eq(sessions.userId, userId));
  await db.delete(loginChallenges).where(eq(loginChallenges.userId, userId));
  await recordAccountEvent(db, userId, {
    action: 'team.mfa_reset',
    actor: ctx,
    summary: asAdminOf(ctx, `Reset two-step verification for ${member.name} and signed them out on every device`),
    data: { userId },
  });
  await notifyUsers(db, ctx.orgId, [userId], {
    type: 'security',
    title: `${ctx.userName} reset your two-step verification`,
    body: `Your authenticator app and recovery codes no longer work for this account, and you were signed out everywhere. Set it up again under Settings → Profile. If you did not ask for this, tell an owner or admin of ${ctx.orgName} straight away.`,
    href: '/settings/profile',
  });
});

// ── Organisation settings ───────────────────────────────────────────────────

export async function getOrganization(db: DB, ctx: Ctx) {
  const [org] = await db.select().from(organizations).where(eq(organizations.id, ctx.orgId));
  if (!org) throw new UserError('Organisation not found.');
  return org;
}

export const renameOrganization = locked(async function renameOrganization(db: DB, ctx: Ctx, name: string): Promise<void> {
  assertCan(ctx, 'org:manage');
  const clean = name.trim();
  if (clean.length < 2 || clean.length > 120) throw new UserError('Enter your company name.');
  await db.update(organizations).set({ name: clean }).where(eq(organizations.id, ctx.orgId));
  await recordAudit(db, { orgId: ctx.orgId, actor: ctx, action: 'organization.renamed', entityType: 'organization', entityId: ctx.orgId, summary: `Renamed the organisation from ${ctx.orgName} to ${clean}` });
});

/** Change review policy. Fields left out of `input` keep their current value. */
export const updatePolicy = locked(async function updatePolicy(db: DB, ctx: Ctx, input: Partial<OrgSettings>): Promise<void> {
  assertCan(ctx, 'policy:manage');
  const org = await getOrganization(db, ctx);
  const current = resolveSettings(org.settings);
  const merged = { ...current, ...input };
  if (!Number.isInteger(merged.toleranceCents) || merged.toleranceCents < 0 || merged.toleranceCents > 100_000) throw new UserError('Rounding tolerance must be between $0 and $1,000.');
  if (!(merged.lowConfidenceThreshold >= 0 && merged.lowConfidenceThreshold <= 1)) throw new UserError('The confidence threshold must be between 0 and 100%.');
  if (merged.unknownSenderPolicy !== 'flag' && merged.unknownSenderPolicy !== 'reject') throw new UserError('Choose what happens to email from an unknown sender.');
  if (!Number.isInteger(merged.portalDueDay) || merged.portalDueDay < 1 || merged.portalDueDay > 28) throw new UserError('The billing due day must be a day of the month from 1 to 28.');
  const next: OrgSettings = {
    toleranceCents: merged.toleranceCents,
    requireConditionalWaiver: !!merged.requireConditionalWaiver,
    requirePriorUnconditionalWaiver: !!merged.requirePriorUnconditionalWaiver,
    requireSignature: !!merged.requireSignature,
    requireNotarization: !!merged.requireNotarization,
    lowConfidenceThreshold: merged.lowConfidenceThreshold,
    requireMfa: !!merged.requireMfa,
    unknownSenderPolicy: merged.unknownSenderPolicy,
    portalDueDay: merged.portalDueDay,
    // Not policy, and not changed here: the company profile from the welcome step is carried over as it is.
    ...(current.profile ? { profile: current.profile } : {}),
  };
  const changed = (Object.keys(next) as Array<keyof OrgSettings>).filter((k) => next[k] !== current[k]);
  if (changed.length === 0) return;

  // Requiring two-step verification decides who can get into the organisation at all, so it is a
  // team decision (owners and admins), not a review-policy one (which controllers also hold).
  if (changed.includes('requireMfa')) {
    assertCan(ctx, 'team:manage');
    if (next.requireMfa) {
      const [me] = await db.select({ mfaEnabledAt: users.mfaEnabledAt }).from(users).where(eq(users.id, ctx.userId));
      // Otherwise the person turning it on would shut themselves out with the same click.
      if (!me?.mfaEnabledAt) throw new UserError(`Turn on two-step verification for your own account first (Settings → Profile). Requiring it now would lock you out of ${ctx.orgName} straight away.`);
    }
  }

  await db.update(organizations).set({ settings: next }).where(eq(organizations.id, ctx.orgId));
  // Neither who must use a second step nor when billing is due changes what counts as a finding.
  const review = changed.filter((k) => k !== 'requireMfa' && k !== 'portalDueDay');
  const sentences: string[] = [];
  if (review.length > 0) sentences.push(`Changed review policy: ${review.map((k) => `${k} ${String(current[k])} → ${String(next[k])}`).join('; ')}`);
  if (changed.includes('portalDueDay')) sentences.push(`Subcontractor billing is now due on day ${next.portalDueDay} of each month (was day ${current.portalDueDay})`);
  if (changed.includes('requireMfa')) sentences.push(next.requireMfa ? 'Two-step verification is now required for every member of the organisation' : 'Two-step verification is no longer required for members of the organisation');
  await recordAudit(db, { orgId: ctx.orgId, actor: ctx, action: 'policy.updated', entityType: 'organization', entityId: ctx.orgId, summary: sentences.join('. '), data: { before: current, after: next } });
  // Review policy changes what counts as a finding, so every undecided application is re-checked.
  if (review.length === 0) return;
  const open = await db.select({ id: payApplications.id }).from(payApplications).where(and(eq(payApplications.orgId, ctx.orgId), inArray(payApplications.status, OPEN_STATUSES), ne(payApplications.status, 'needs_matching')));
  for (const app of open) await runReconciliation(db, ctx.orgId, app.id, { actor: ctx });
});

export async function updateProfile(db: DB, userId: string, input: { name: string }): Promise<void> {
  const name = input.name.trim();
  if (name.length < 2 || name.length > 120) throw new UserError('Enter your name.');
  await db.update(users).set({ name }).where(eq(users.id, userId));
}

/**
 * Change your own password. The session making the request stays signed in
 * (`keepToken`); every other session, any sign-in waiting on its second step
 * and any unused reset link stop working.
 */
export async function changePassword(db: DB, userId: string, current: string, next: string, keepToken?: string): Promise<void> {
  const user = await confirmPassword(db, userId, current);
  const problem = passwordProblem(next, { email: user.email, name: user.name });
  if (problem) throw new UserError(problem);
  if (next === current) throw new UserError('Choose a password that is different from your current one.');
  const passwordHash = await hashPassword(next);
  const keep = keepToken ? sha256Hex(keepToken) : '';
  await inTransaction(db, async (tx) => {
    const now = new Date();
    await tx.update(users).set({ passwordHash, passwordChangedAt: now }).where(eq(users.id, userId));
    const gone = await tx.delete(sessions).where(and(eq(sessions.userId, userId), ne(sessions.id, keep))).returning({ id: sessions.id });
    await tx.delete(loginChallenges).where(eq(loginChallenges.userId, userId));
    await tx.delete(passwordResets).where(and(eq(passwordResets.userId, userId), isNull(passwordResets.usedAt)));
    await recordAccountEvent(tx, userId, {
      action: 'team.password_changed',
      actor: 'self',
      summary: gone.length > 0 ? `Changed their password. Their other sessions (${gone.length}) were signed out` : 'Changed their password',
    });
  });
}
