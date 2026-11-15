/**
 * Accounts, organisations, sessions, invitations and roles.
 * Framework-free: the cookie handling lives in src/server/auth/session.ts.
 */
import { and, desc, eq, gt, isNull, ne } from 'drizzle-orm';
import type { DB } from '@/db';
import { locked } from '@/db/tx';
import { invitations, memberships, organizations, payApplications, sessions, users, nextVersion } from '@/db/schema';
import { recordAudit } from '@/server/audit';
import { hashPassword, passwordProblem, verifyPassword } from '@/server/auth/password';
import { assertCan, ROLE_LABEL, UserError, type Ctx } from '@/server/auth/permissions';
import { newId, randomToken, sha256Hex } from '@/server/ids';
import type { OrgSettings, Role } from '@/server/types';
import { DEFAULT_ORG_SETTINGS, OPEN_STATUSES, ROLES, resolveSettings } from '@/server/types';
import { inArray } from 'drizzle-orm';
import { runReconciliation } from './reconcile';

const SESSION_DAYS = 14;
const INVITE_DAYS = 7;
const normaliseEmail = (e: string) => e.trim().toLowerCase();
const validEmail = (e: string) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e) && e.length <= 254;

// ── Organisations ───────────────────────────────────────────────────────────

export async function createOrganization(db: DB, userId: string, name: string, opts: { isDemo?: boolean; at?: Date } = {}): Promise<string> {
  const clean = name.trim();
  if (clean.length < 2 || clean.length > 120) throw new UserError('Enter your company name.');
  const id = newId('org');
  await db.insert(organizations).values({ id, name: clean, isDemo: opts.isDemo ?? false, intakeToken: randomToken(18), settings: { ...DEFAULT_ORG_SETTINGS }, createdAt: opts.at ?? new Date() });
  await db.insert(memberships).values({ id: newId('mem'), orgId: id, userId, role: 'owner', createdAt: opts.at ?? new Date() });
  const [user] = await db.select().from(users).where(eq(users.id, userId));
  await recordAudit(db, {
    orgId: id,
    actor: { orgId: id, orgName: clean, isDemo: !!opts.isDemo, userId, userName: user?.name ?? 'Unknown', userEmail: user?.email ?? '', role: 'owner' },
    action: 'organization.created',
    entityType: 'organization',
    entityId: id,
    summary: `Created organisation ${clean}${opts.isDemo ? ' (demo workspace)' : ''}`,
    at: opts.at,
  });
  return id;
}

export async function signUp(db: DB, input: { name: string; email: string; password: string; orgName: string }): Promise<{ userId: string; orgId: string }> {
  const email = normaliseEmail(input.email);
  const name = input.name.trim();
  if (name.length < 2) throw new UserError('Enter your name.');
  if (!validEmail(email)) throw new UserError('Enter a valid work email.');
  const problem = passwordProblem(input.password);
  if (problem) throw new UserError(problem);
  if (input.orgName.trim().length < 2) throw new UserError('Enter your company name.');
  const [existing] = await db.select({ id: users.id }).from(users).where(eq(users.email, email));
  if (existing) throw new UserError('An account with that email already exists. Sign in instead.');
  const userId = newId('usr');
  await db.insert(users).values({ id: userId, email, name, passwordHash: await hashPassword(input.password) });
  const orgId = await createOrganization(db, userId, input.orgName);
  return { userId, orgId };
}

// ── Sign-in ─────────────────────────────────────────────────────────────────

const attempts = new Map<string, { count: number; first: number }>();
const WINDOW_MS = 15 * 60 * 1000;
const MAX_ATTEMPTS = 8;

/** Returns the user on success; null on any failure, without saying which part was wrong. */
export async function authenticate(db: DB, emailInput: string, password: string): Promise<{ id: string } | null> {
  const email = normaliseEmail(emailInput);
  const record = attempts.get(email);
  const now = Date.now();
  if (record && now - record.first < WINDOW_MS && record.count >= MAX_ATTEMPTS) {
    throw new UserError('Too many sign-in attempts. Try again in a few minutes.');
  }
  const [user] = await db.select().from(users).where(eq(users.email, email));
  // Always run the hash so the response time does not reveal whether the account exists.
  const ok = await verifyPassword(password, user?.passwordHash ?? 'scrypt$16384$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA');
  if (!user || !ok) {
    if (!record || now - record.first >= WINDOW_MS) attempts.set(email, { count: 1, first: now });
    else record.count++;
    return null;
  }
  attempts.delete(email);
  await db.update(users).set({ lastLoginAt: new Date() }).where(eq(users.id, user.id));
  return { id: user.id };
}

export async function createSession(db: DB, userId: string, orgId?: string | null): Promise<{ token: string; expiresAt: Date }> {
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
  const expiresAt = new Date(Date.now() + SESSION_DAYS * 86_400_000);
  await db.insert(sessions).values({ id: sha256Hex(token), userId, orgId: org, expiresAt });
  // Signing up and accepting an invitation start a session without going through authenticate().
  await db.update(users).set({ lastLoginAt: new Date() }).where(eq(users.id, userId));
  return { token, expiresAt };
}

export type SessionInfo = { ctx: Ctx | null; user: { id: string; name: string; email: string } };

/** Resolve a cookie token to the acting user and their active organisation. */
export async function resolveSession(db: DB, token: string | undefined | null): Promise<SessionInfo | null> {
  if (!token) return null;
  const [row] = await db
    .select({ session: sessions, user: users })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(and(eq(sessions.id, sha256Hex(token)), gt(sessions.expiresAt, new Date())));
  if (!row) return null;
  const user = { id: row.user.id, name: row.user.name, email: row.user.email };
  if (!row.session.orgId) return { ctx: null, user };
  const [m] = await db
    .select({ role: memberships.role, org: organizations })
    .from(memberships)
    .innerJoin(organizations, eq(organizations.id, memberships.orgId))
    .where(and(eq(memberships.userId, user.id), eq(memberships.orgId, row.session.orgId), eq(memberships.status, 'active')));
  if (!m) return { ctx: null, user };
  return {
    user,
    ctx: { orgId: m.org.id, orgName: m.org.name, isDemo: m.org.isDemo, userId: user.id, userName: user.name, userEmail: user.email, role: m.role as Role },
  };
}

export async function destroySession(db: DB, token: string | undefined | null): Promise<void> {
  if (token) await db.delete(sessions).where(eq(sessions.id, sha256Hex(token)));
}

export async function listMyOrganizations(db: DB, userId: string) {
  return db
    .select({ id: organizations.id, name: organizations.name, isDemo: organizations.isDemo, role: memberships.role })
    .from(memberships)
    .innerJoin(organizations, eq(organizations.id, memberships.orgId))
    .where(and(eq(memberships.userId, userId), eq(memberships.status, 'active')))
    .orderBy(organizations.isDemo, organizations.name);
}

export async function switchOrganization(db: DB, token: string, userId: string, orgId: string): Promise<void> {
  const [m] = await db.select({ id: memberships.id }).from(memberships).where(and(eq(memberships.userId, userId), eq(memberships.orgId, orgId), eq(memberships.status, 'active')));
  if (!m) throw new UserError('You are not a member of that organisation.');
  await db.update(sessions).set({ orgId }).where(eq(sessions.id, sha256Hex(token)));
}

// ── Team ────────────────────────────────────────────────────────────────────

export async function listMembers(db: DB, ctx: Ctx) {
  return db
    .select({ userId: users.id, name: users.name, email: users.email, role: memberships.role, status: memberships.status, joinedAt: memberships.createdAt, lastLoginAt: users.lastLoginAt })
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

/** Accept an invitation, creating the account if the invitee does not have one. */
export async function acceptInvitation(db: DB, token: string, input: { name?: string; password: string }): Promise<{ userId: string; orgId: string }> {
  const inv = await findInvitation(db, token);
  if (!inv) throw new UserError('This invitation is no longer valid. Ask for a new one.');
  let [user] = await db.select().from(users).where(eq(users.email, inv.email));
  if (user) {
    if (!(await verifyPassword(input.password, user.passwordHash))) throw new UserError('That password is not correct for this account.');
  } else {
    const name = input.name?.trim() ?? '';
    if (name.length < 2) throw new UserError('Enter your name.');
    const problem = passwordProblem(input.password);
    if (problem) throw new UserError(problem);
    const id = newId('usr');
    await db.insert(users).values({ id, email: inv.email, name, passwordHash: await hashPassword(input.password) });
    [user] = await db.select().from(users).where(eq(users.id, id));
  }
  const [already] = await db.select({ id: memberships.id }).from(memberships).where(and(eq(memberships.orgId, inv.orgId), eq(memberships.userId, user!.id)));
  if (!already) await db.insert(memberships).values({ id: newId('mem'), orgId: inv.orgId, userId: user!.id, role: inv.role });
  await db.update(invitations).set({ acceptedAt: new Date() }).where(eq(invitations.id, inv.id));
  await recordAudit(db, {
    orgId: inv.orgId,
    actor: { orgId: inv.orgId, orgName: inv.orgName, isDemo: false, userId: user!.id, userName: user!.name, userEmail: user!.email, role: inv.role },
    action: 'team.joined',
    entityType: 'membership',
    entityId: user!.id,
    summary: `${user!.name} joined as ${ROLE_LABEL[inv.role]}`,
  });
  return { userId: user!.id, orgId: inv.orgId };
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
  const next: OrgSettings = {
    toleranceCents: merged.toleranceCents,
    requireConditionalWaiver: !!merged.requireConditionalWaiver,
    requirePriorUnconditionalWaiver: !!merged.requirePriorUnconditionalWaiver,
    requireSignature: !!merged.requireSignature,
    requireNotarization: !!merged.requireNotarization,
    lowConfidenceThreshold: merged.lowConfidenceThreshold,
    requireMfa: !!merged.requireMfa,
    unknownSenderPolicy: merged.unknownSenderPolicy,
  };
  const changed = (Object.keys(next) as Array<keyof OrgSettings>).filter((k) => next[k] !== current[k]);
  if (changed.length === 0) return;
  await db.update(organizations).set({ settings: next }).where(eq(organizations.id, ctx.orgId));
  await recordAudit(db, { orgId: ctx.orgId, actor: ctx, action: 'policy.updated', entityType: 'organization', entityId: ctx.orgId, summary: `Changed review policy: ${changed.map((k) => `${k} ${String(current[k])} → ${String(next[k])}`).join('; ')}`, data: { before: current, after: next } });
  // Policy changes what counts as a finding, so every undecided application is re-checked.
  const open = await db.select({ id: payApplications.id }).from(payApplications).where(and(eq(payApplications.orgId, ctx.orgId), inArray(payApplications.status, OPEN_STATUSES), ne(payApplications.status, 'needs_matching')));
  for (const app of open) await runReconciliation(db, ctx.orgId, app.id, { actor: ctx });
});

export async function updateProfile(db: DB, userId: string, input: { name: string }): Promise<void> {
  const name = input.name.trim();
  if (name.length < 2 || name.length > 120) throw new UserError('Enter your name.');
  await db.update(users).set({ name }).where(eq(users.id, userId));
}

export async function changePassword(db: DB, userId: string, current: string, next: string, keepToken?: string): Promise<void> {
  const [user] = await db.select().from(users).where(eq(users.id, userId));
  if (!user || !(await verifyPassword(current, user.passwordHash))) throw new UserError('Your current password is not correct.');
  const problem = passwordProblem(next);
  if (problem) throw new UserError(problem);
  await db.update(users).set({ passwordHash: await hashPassword(next) }).where(eq(users.id, userId));
  // Sign out every other session.
  const keep = keepToken ? sha256Hex(keepToken) : '';
  await db.delete(sessions).where(and(eq(sessions.userId, userId), ne(sessions.id, keep)));
}
