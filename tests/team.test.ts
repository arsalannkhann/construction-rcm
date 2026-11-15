/**
 * Team, roles, invitations, policy permissions and the activity log, at the
 * service layer against a real (in-memory) Postgres.
 */
import { eq } from 'drizzle-orm';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { auditEvents, invitations, memberships, organizations, users } from '@/db/schema';
import { PermissionError } from '@/server/auth/permissions';
import { appUrl } from '@/server/config';
import { newId } from '@/server/ids';
import { auditCsvRow, auditEventBatches, listAuditActors, listAuditEvents, SYSTEM_ACTOR, type AuditEventRow } from '@/server/services/audit-queries';
import { approveApplication, assignReviewer } from '@/server/services/review';
import {
  acceptInvitation,
  changeRole,
  createSession,
  findInvitation,
  inviteMember,
  listInvitations,
  listMembers,
  renameOrganization,
  resolveSession,
  revokeInvitation,
  setMemberActive,
  switchOrganization,
  updatePolicy,
} from '@/server/services/team';
import { inviteAndNotify } from '@/server/services/team-invite';
import { DEFAULT_ORG_SETTINGS } from '@/server/types';
import { addMember, createWorld, getApp, packageFor, stateAfter, submit, type World } from './helpers/world';

const PASSWORD = 'correct horse battery'; // what tests/helpers/world.ts gives every account
const roleOf = async (w: World, userId: string) => (await listMembers(w.db, w.owner)).find((m) => m.userId === userId)?.role;
const statusOf = async (w: World, userId: string) => (await listMembers(w.db, w.owner)).find((m) => m.userId === userId)?.status;
const accountsFor = (w: World, email: string) => w.db.select().from(users).where(eq(users.email, email));
const tokenIn = (link: string) => link.split('/invite/')[1]!;

describe('invitations', () => {
  let w: World;
  beforeAll(async () => {
    w = await createWorld();
  });

  it('turn into an account and a membership when accepted', async () => {
    const { token } = await inviteMember(w.db, w.owner, { email: '  Nia.Newhire@Example.Test ', role: 'accountant' });
    expect(await findInvitation(w.db, token)).toMatchObject({ orgId: w.orgId, email: 'nia.newhire@example.test', role: 'accountant', hasAccount: false });
    // Nothing exists for them until they accept.
    expect(await accountsFor(w, 'nia.newhire@example.test')).toEqual([]);

    const joined = await acceptInvitation(w.db, token, { name: 'Nia Newhire', password: 'a long enough password' });
    expect(joined.orgId).toBe(w.orgId);
    expect(await accountsFor(w, 'nia.newhire@example.test')).toMatchObject([{ id: joined.userId, name: 'Nia Newhire' }]);
    expect((await listMembers(w.db, w.owner)).find((m) => m.userId === joined.userId)).toMatchObject({ role: 'accountant', status: 'active' });

    expect((await listMembers(w.db, w.owner)).find((m) => m.userId === joined.userId)?.lastLoginAt).toBeNull();

    // They can sign in to the organisation they were invited to, with the role they were given.
    const session = await createSession(w.db, joined.userId);
    expect((await resolveSession(w.db, session.token))?.ctx).toMatchObject({ orgId: w.orgId, userId: joined.userId, role: 'accountant' });
    // Starting that session counts as signing in, so the team list does not say they never have.
    expect((await listMembers(w.db, w.owner)).find((m) => m.userId === joined.userId)?.lastLoginAt).toBeInstanceOf(Date);
    expect(await listInvitations(w.db, w.owner)).toEqual([]);
  });

  it('are not used up by a failed attempt to accept', async () => {
    const { token } = await inviteMember(w.db, w.owner, { email: 'retry@example.test', role: 'viewer' });
    await expect(acceptInvitation(w.db, token, { name: ' ', password: 'a long enough password' })).rejects.toThrow('Enter your name.');
    await expect(acceptInvitation(w.db, token, { name: 'Rae Retry', password: 'short' })).rejects.toThrow(/at least 10 characters/);
    expect(await accountsFor(w, 'retry@example.test')).toEqual([]);
    await acceptInvitation(w.db, token, { name: 'Rae Retry', password: 'a long enough password' });
    expect(await accountsFor(w, 'retry@example.test')).toHaveLength(1);
  });

  it('ask someone who already has an account for their real password', async () => {
    const elsewhere = await createWorld();
    const existing = elsewhere.accountant; // has an account, but not in this organisation
    const { token } = await inviteMember(w.db, w.owner, { email: existing.userEmail, role: 'viewer' });
    expect(await findInvitation(w.db, token)).toMatchObject({ hasAccount: true });

    // Holding the link is not enough to join as them.
    await expect(acceptInvitation(w.db, token, { name: 'Someone Else', password: 'not their password' })).rejects.toThrow(/password is not correct/);
    expect(await roleOf(w, existing.userId)).toBeUndefined();

    const joined = await acceptInvitation(w.db, token, { name: 'Someone Else', password: PASSWORD });
    expect(joined.userId).toBe(existing.userId);
    // The existing account is reused as it is: no second account, no renaming.
    expect(await accountsFor(w, existing.userEmail)).toMatchObject([{ id: existing.userId, name: existing.userName }]);
    expect(await roleOf(w, existing.userId)).toBe('viewer');
    expect(await roleOf(elsewhere, existing.userId)).toBe('accountant');
  });

  it('are rejected once used, revoked or expired', async () => {
    const used = await inviteMember(w.db, w.owner, { email: 'used@example.test', role: 'viewer' });
    await acceptInvitation(w.db, used.token, { name: 'Una Used', password: 'a long enough password' });
    expect(await findInvitation(w.db, used.token)).toBeNull();
    await expect(acceptInvitation(w.db, used.token, { name: 'Una Again', password: 'a long enough password' })).rejects.toThrow(/no longer valid/);

    const revoked = await inviteMember(w.db, w.owner, { email: 'revoked@example.test', role: 'viewer' });
    await revokeInvitation(w.db, w.owner, revoked.id);
    expect(await findInvitation(w.db, revoked.token)).toBeNull();
    await expect(acceptInvitation(w.db, revoked.token, { name: 'Rex Revoked', password: 'a long enough password' })).rejects.toThrow(/no longer valid/);

    const expired = await inviteMember(w.db, w.owner, { email: 'expired@example.test', role: 'viewer' });
    await w.db.update(invitations).set({ expiresAt: new Date(Date.now() - 60_000) }).where(eq(invitations.id, expired.id));
    expect(await findInvitation(w.db, expired.token)).toBeNull();
    await expect(acceptInvitation(w.db, expired.token, { name: 'Eve Expired', password: 'a long enough password' })).rejects.toThrow(/no longer valid/);

    expect(await findInvitation(w.db, 'not-a-real-token')).toBeNull();
    await expect(acceptInvitation(w.db, 'not-a-real-token', { name: 'Nobody', password: 'a long enough password' })).rejects.toThrow(/no longer valid/);

    // None of the refused attempts created an account or a membership.
    expect(await accountsFor(w, 'revoked@example.test')).toEqual([]);
    expect(await accountsFor(w, 'expired@example.test')).toEqual([]);
    expect((await accountsFor(w, 'used@example.test')).map((u) => u.name)).toEqual(['Una Used']);
  });

  it('keep one live link per address', async () => {
    const first = await inviteMember(w.db, w.owner, { email: 'twice@example.test', role: 'viewer' });
    const second = await inviteMember(w.db, w.owner, { email: 'TWICE@example.test', role: 'accountant' });
    expect(await findInvitation(w.db, first.token)).toBeNull();
    expect(await findInvitation(w.db, second.token)).toMatchObject({ role: 'accountant' });
    expect((await listInvitations(w.db, w.owner)).filter((i) => i.email === 'twice@example.test')).toHaveLength(1);
  });

  it('can only be sent by people who manage the team, to people who are not members yet', async () => {
    for (const ctx of [w.controller, w.accountant, w.pm, w.viewer]) {
      await expect(inviteMember(w.db, ctx, { email: 'nope@example.test', role: 'viewer' })).rejects.toBeInstanceOf(PermissionError);
    }
    await expect(inviteMember(w.db, w.owner, { email: w.controller.userEmail, role: 'viewer' })).rejects.toThrow(/already a member/);
    await expect(inviteMember(w.db, w.owner, { email: 'not an address', role: 'viewer' })).rejects.toThrow(/valid email/);
  });

  it('cannot be revoked from another organisation', async () => {
    const other = await createWorld();
    const { id, token } = await inviteMember(w.db, w.owner, { email: 'kept@example.test', role: 'viewer' });
    await revokeInvitation(other.db, other.owner, id);
    expect(await findInvitation(w.db, token)).not.toBeNull();
  });
});

describe('inviting by email', () => {
  let w: World;
  beforeAll(async () => {
    w = await createWorld();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.RESEND_API_KEY;
    delete process.env.EMAIL_FROM;
  });

  it('reports "not_sent" and still hands back a working link when no email provider is configured', async () => {
    const outcome = await inviteAndNotify(w.db, w.owner, { email: 'Sam.Site@Example.Test', role: 'project_manager' });
    expect(outcome.email).toBe('not_sent');
    expect(outcome.detail).toMatch(/not configured/);
    expect(outcome.link.startsWith(`${appUrl()}/invite/`)).toBe(true);
    expect(await findInvitation(w.db, tokenIn(outcome.link))).toMatchObject({ orgId: w.orgId, email: 'sam.site@example.test', role: 'project_manager' });
  });

  it('reports "sent" only when the provider accepted the message, and "failed" with the reason when it did not', async () => {
    process.env.RESEND_API_KEY = 're_test_key';
    process.env.EMAIL_FROM = 'billing@northline.example';
    const accepted = vi.fn(async (_url: string, _init: RequestInit) => new Response(JSON.stringify({ id: 'em_123' }), { status: 200 }));
    vi.stubGlobal('fetch', accepted);

    const sent = await inviteAndNotify(w.db, w.owner, { email: ' Pat.Prospect@Example.Test', role: 'viewer' });
    expect(sent).toMatchObject({ email: 'sent', detail: null });
    expect(accepted).toHaveBeenCalledTimes(1);
    const message = JSON.parse(String(accepted.mock.calls[0]![1].body)) as { to: string[]; subject: string; text: string; reply_to: string };
    expect(message.to).toEqual(['pat.prospect@example.test']);
    expect(message.reply_to).toBe(w.owner.userEmail);
    expect(message.subject).toContain(w.owner.orgName);
    expect(message.text).toContain(sent.link);
    expect(message.text).toContain('as Viewer');

    vi.stubGlobal('fetch', vi.fn(async () => new Response('domain is not verified', { status: 422 })));
    const failed = await inviteAndNotify(w.db, w.owner, { email: 'bounce@example.test', role: 'viewer' });
    expect(failed.email).toBe('failed');
    expect(failed.detail).toMatch(/HTTP 422/);
    // The invitation exists either way, so the link can be passed on by hand.
    expect(await findInvitation(w.db, tokenIn(failed.link))).toMatchObject({ email: 'bounce@example.test' });
  });

  it('sends nothing for someone who may not invite', async () => {
    process.env.RESEND_API_KEY = 're_test_key';
    process.env.EMAIL_FROM = 'billing@northline.example';
    const provider = vi.fn(async () => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', provider);
    await expect(inviteAndNotify(w.db, w.accountant, { email: 'nobody@example.test', role: 'viewer' })).rejects.toBeInstanceOf(PermissionError);
    expect(provider).not.toHaveBeenCalled();
    expect((await listInvitations(w.db, w.owner)).some((i) => i.email === 'nobody@example.test')).toBe(false);
  });
});

describe('roles', () => {
  let w: World;
  beforeAll(async () => {
    w = await createWorld();
  });

  it('only an owner can make someone an owner', async () => {
    const admin = await addMember(w.db, w.orgId, w.owner.orgName, 'admin', 'Adam Admin');
    await expect(changeRole(w.db, admin, w.viewer.userId, 'owner')).rejects.toThrow(/Only an owner can make someone an owner/);
    await expect(inviteMember(w.db, admin, { email: 'would-be-owner@example.test', role: 'owner' })).rejects.toThrow(/Only an owner can make someone an owner/);
    expect(await roleOf(w, w.viewer.userId)).toBe('viewer');

    // An admin can grant everything short of ownership…
    await changeRole(w.db, admin, w.viewer.userId, 'admin');
    expect(await roleOf(w, w.viewer.userId)).toBe('admin');
    // …and an owner can grant ownership.
    await changeRole(w.db, w.owner, w.pm.userId, 'owner');
    expect(await roleOf(w, w.pm.userId)).toBe('owner');

    await expect(changeRole(w.db, w.owner, w.accountant.userId, 'superuser')).rejects.toThrow('Unknown role.');
    for (const ctx of [w.controller, w.accountant]) {
      await expect(changeRole(w.db, ctx, w.viewer.userId, 'viewer')).rejects.toBeInstanceOf(PermissionError);
    }
  });

  it('nobody can change their own role', async () => {
    const admin = await addMember(w.db, w.orgId, w.owner.orgName, 'admin', 'Ada Admin');
    await expect(changeRole(w.db, w.owner, w.owner.userId, 'admin')).rejects.toThrow(/cannot change your own role/);
    await expect(changeRole(w.db, admin, admin.userId, 'controller')).rejects.toThrow(/cannot change your own role/);
    expect(await roleOf(w, w.owner.userId)).toBe('owner');
    expect(await roleOf(w, admin.userId)).toBe('admin');
  });

  it('the last owner cannot be demoted or deactivated, by anyone', async () => {
    const solo = await createWorld();
    const admin = await addMember(solo.db, solo.orgId, solo.owner.orgName, 'admin', 'Adam Admin');

    // Not by themselves…
    await expect(changeRole(solo.db, solo.owner, solo.owner.userId, 'admin')).rejects.toThrow(/own role/);
    await expect(setMemberActive(solo.db, solo.owner, solo.owner.userId, false)).rejects.toThrow(/cannot deactivate yourself/);
    // …not by an admin…
    await expect(changeRole(solo.db, admin, solo.owner.userId, 'admin')).rejects.toThrow(/Only an owner can change another owner/);
    await expect(setMemberActive(solo.db, admin, solo.owner.userId, false)).rejects.toThrow(/Only an owner can deactivate another owner/);
    // …and not by a second owner who has since been deactivated and is acting on a stale session.
    const former = await addMember(solo.db, solo.orgId, solo.owner.orgName, 'owner', 'Otto Owner');
    await setMemberActive(solo.db, solo.owner, former.userId, false);
    await expect(changeRole(solo.db, former, solo.owner.userId, 'admin')).rejects.toThrow(/at least one owner/);
    await expect(setMemberActive(solo.db, former, solo.owner.userId, false)).rejects.toThrow(/at least one owner/);

    expect(await roleOf(solo, solo.owner.userId)).toBe('owner');
    expect(await statusOf(solo, solo.owner.userId)).toBe('active');

    // With a second active owner, either can step the other down.
    await setMemberActive(solo.db, solo.owner, former.userId, true);
    await changeRole(solo.db, former, solo.owner.userId, 'admin');
    expect(await roleOf(solo, solo.owner.userId)).toBe('admin');
  });

  it('cannot be changed from another organisation', async () => {
    const other = await createWorld();
    await expect(changeRole(other.db, other.owner, w.accountant.userId, 'viewer')).rejects.toThrow('Member not found.');
    await expect(setMemberActive(other.db, other.owner, w.accountant.userId, false)).rejects.toThrow('Member not found.');
    expect(await roleOf(w, w.accountant.userId)).toBe('accountant');
    expect(await statusOf(w, w.accountant.userId)).toBe('active');
  });
});

describe('deactivating a member', () => {
  it('signs them out of that organisation only, and hands back their open applications', async () => {
    const w = await createWorld();
    const other = await createWorld();
    const ana = w.accountant;
    // Ana also belongs to a second organisation.
    await w.db.insert(memberships).values({ id: newId('mem'), orgId: other.orgId, userId: ana.userId, role: 'viewer' });
    const here = await createSession(w.db, ana.userId, w.orgId);
    const elsewhere = await createSession(w.db, ana.userId, other.orgId);
    expect((await resolveSession(w.db, here.token))?.ctx).toMatchObject({ orgId: w.orgId, role: 'accountant' });

    // One application she reviewed that is already approved, one still open.
    const decided = await submit(w, packageFor(w, 0, null));
    await assignReviewer(w.db, ana, decided.id, ana.userId);
    await approveApplication(w.db, w.controller, decided.id);
    const open = await submit(w, packageFor(w, 1, stateAfter(packageFor(w, 0, null))));
    await assignReviewer(w.db, ana, open.id, ana.userId);

    await expect(setMemberActive(w.db, w.controller, ana.userId, false)).rejects.toBeInstanceOf(PermissionError);
    await setMemberActive(w.db, w.owner, ana.userId, false);
    expect(await statusOf(w, ana.userId)).toBe('deactivated');

    // Her session here is gone, and a session pointed at this organisation gets no access to it.
    expect(await resolveSession(w.db, here.token)).toBeNull();
    const retry = await createSession(w.db, ana.userId, w.orgId);
    expect(await resolveSession(w.db, retry.token)).toMatchObject({ ctx: null, user: { id: ana.userId } });
    await expect(switchOrganization(w.db, elsewhere.token, ana.userId, w.orgId)).rejects.toThrow(/not a member/);
    // Her access to the other organisation is untouched.
    expect((await resolveSession(w.db, elsewhere.token))?.ctx).toMatchObject({ orgId: other.orgId, role: 'viewer' });

    // Open work goes back to the pool; the decided application keeps its history.
    expect((await getApp(w, open.id)).assigneeId).toBeNull();
    expect((await getApp(w, decided.id)).assigneeId).toBe(ana.userId);
    await expect(assignReviewer(w.db, w.controller, open.id, ana.userId)).rejects.toThrow(/not an active member/);

    // Reactivating gives the same role back.
    await setMemberActive(w.db, w.owner, ana.userId, true);
    const back = await createSession(w.db, ana.userId, w.orgId);
    expect((await resolveSession(w.db, back.token))?.ctx).toMatchObject({ orgId: w.orgId, role: 'accountant' });
  });
});

describe('review policy', () => {
  it('can only be changed by roles that manage policy', async () => {
    const w = await createWorld();
    const stored = async () => (await w.db.select({ settings: organizations.settings }).from(organizations).where(eq(organizations.id, w.orgId)))[0]!.settings;
    const stricter = { ...DEFAULT_ORG_SETTINGS, requireNotarization: true, toleranceCents: 500 };

    for (const ctx of [w.accountant, w.pm, w.viewer]) {
      await expect(updatePolicy(w.db, ctx, stricter)).rejects.toBeInstanceOf(PermissionError);
    }
    expect(await stored()).toEqual(DEFAULT_ORG_SETTINGS);

    await updatePolicy(w.db, w.controller, stricter);
    expect(await stored()).toEqual(stricter);
    await updatePolicy(w.db, w.owner, DEFAULT_ORG_SETTINGS);
    expect(await stored()).toEqual(DEFAULT_ORG_SETTINGS);

    await expect(updatePolicy(w.db, w.owner, { ...DEFAULT_ORG_SETTINGS, toleranceCents: -1 })).rejects.toThrow(/Rounding tolerance/);
    await expect(updatePolicy(w.db, w.owner, { ...DEFAULT_ORG_SETTINGS, lowConfidenceThreshold: 1.5 })).rejects.toThrow(/confidence threshold/);
    expect(await stored()).toEqual(DEFAULT_ORG_SETTINGS);

    // Each change is on the record with who made it; refused attempts leave no trace of a change.
    const changes = await listAuditEvents(w.db, w.owner, { area: 'policy' });
    expect(changes.events.map((e) => e.actorName)).toEqual(['Olivia Owner', 'Carlos Controller']);
    expect(changes.events[1]!.summary).toContain('toleranceCents 100 → 500');
  });
});

describe('the activity log', () => {
  let a: World;
  let b: World;
  let appId: string;
  beforeAll(async () => {
    a = await createWorld();
    b = await createWorld();
    appId = (await submit(a, packageFor(a, 0, null))).id;
    await submit(b, packageFor(b, 0, null));
    await changeRole(a.db, a.owner, a.viewer.userId, 'accountant');
    await renameOrganization(a.db, a.owner, '100% Concrete_Co');
    await changeRole(b.db, b.owner, b.viewer.userId, 'accountant');
  });

  const idsOf = async (w: World) => (await w.db.select({ id: auditEvents.id }).from(auditEvents).where(eq(auditEvents.orgId, w.orgId))).map((e) => e.id).sort();

  it('never returns another organisation’s events', async () => {
    const mine = await idsOf(a);
    const theirs = await idsOf(b);
    expect(mine.length).toBeGreaterThan(5);
    expect(theirs.length).toBeGreaterThan(5);

    const forA = await listAuditEvents(a.db, a.viewer, {}, { limit: 500 });
    const forB = await listAuditEvents(b.db, b.viewer, {}, { limit: 500 });
    expect(forA.total).toBe(mine.length);
    expect(forA.events.map((e) => e.id).sort()).toEqual(mine);
    expect(forB.total).toBe(theirs.length);
    expect(forB.events.map((e) => e.id).sort()).toEqual(theirs);

    // No filter value reaches across: B asking for A's people or A's words finds nothing.
    expect(await listAuditEvents(b.db, b.owner, { actor: a.owner.userId })).toEqual({ events: [], total: 0 });
    expect(await listAuditEvents(b.db, b.owner, { q: 'Concrete_Co' })).toEqual({ events: [], total: 0 });
    for (const filter of [{ area: 'team' }, { actor: SYSTEM_ACTOR }, { q: 'accountant' }, { from: new Date(0) }]) {
      const page = await listAuditEvents(b.db, b.owner, filter, { limit: 500 });
      expect(page.events.length).toBeGreaterThan(0);
      expect(page.events.every((e) => theirs.includes(e.id))).toBe(true);
    }

    // The same holds for the "who" filter and for the export.
    const people = await listAuditActors(b.db, b.owner);
    expect(people.map((p) => p.id)).not.toContain(a.owner.userId);
    expect(people.map((p) => p.id)).toContain(b.owner.userId);
    const exported: string[] = [];
    for await (const batch of auditEventBatches(b.db, b.owner, {}, 3)) exported.push(...batch.map((e) => e.id));
    expect(exported.sort()).toEqual(theirs);
  });

  it('filters by person, area, text and date, newest first, a page at a time', async () => {
    const all = await listAuditEvents(a.db, a.owner, {}, { limit: 500 });
    expect(all.events.map((e) => e.seq)).toEqual([...all.events.map((e) => e.seq)].sort((x, y) => y - x));

    const team = await listAuditEvents(a.db, a.owner, { area: 'team' });
    expect(team.events.map((e) => e.action)).toEqual(['team.role_changed']);
    expect(team.events[0]).toMatchObject({ actorName: 'Olivia Owner', summary: 'Changed Vic Viewer from Viewer to Project accountant', payApplicationId: null });

    const application = await listAuditEvents(a.db, a.owner, { area: 'application' });
    expect(application.total).toBeGreaterThan(0);
    expect(application.events.every((e) => e.action.startsWith('application.') && e.payApplicationId === appId)).toBe(true);

    const system = await listAuditEvents(a.db, a.owner, { actor: SYSTEM_ACTOR });
    expect(system.total).toBeGreaterThan(0);
    expect(system.events.every((e) => e.actorType === 'system' && e.actorId === null)).toBe(true);
    const owner = await listAuditEvents(a.db, a.owner, { actor: a.owner.userId });
    expect(owner.total).toBeGreaterThan(0);
    expect(owner.events.every((e) => e.actorId === a.owner.userId)).toBe(true);
    expect(system.total + owner.total).toBeLessThanOrEqual(all.total);

    // Text is matched as typed, ignoring case; % and _ are not wildcards.
    expect((await listAuditEvents(a.db, a.owner, { q: 'concrete_co' })).events.map((e) => e.action)).toEqual(['organization.renamed']);
    expect((await listAuditEvents(a.db, a.owner, { q: '100%' })).total).toBe(1);
    expect((await listAuditEvents(a.db, a.owner, { q: 'Concrete%Co' })).total).toBe(0);
    expect((await listAuditEvents(a.db, a.owner, { q: 'Concrete.Co' })).total).toBe(0);
    expect((await listAuditEvents(a.db, a.owner, { q: '   ' })).total).toBe(all.total);

    // Filters combine.
    expect((await listAuditEvents(a.db, a.owner, { area: 'team', actor: SYSTEM_ACTOR })).total).toBe(0);
    expect((await listAuditEvents(a.db, a.owner, { area: 'organization', actor: a.owner.userId, q: 'renamed' })).total).toBe(1);

    const tomorrow = new Date(Date.now() + 86_400_000);
    const yesterday = new Date(Date.now() - 86_400_000);
    expect((await listAuditEvents(a.db, a.owner, { from: yesterday, to: tomorrow })).total).toBe(all.total);
    expect((await listAuditEvents(a.db, a.owner, { from: tomorrow })).total).toBe(0);
    expect((await listAuditEvents(a.db, a.owner, { to: yesterday })).total).toBe(0);

    const first = await listAuditEvents(a.db, a.owner, {}, { limit: 3 });
    const second = await listAuditEvents(a.db, a.owner, {}, { limit: 3, offset: 3 });
    expect(first.total).toBe(all.total);
    expect([...first.events, ...second.events].map((e) => e.id)).toEqual(all.events.slice(0, 6).map((e) => e.id));
    expect((await listAuditEvents(a.db, a.owner, {}, { limit: 3, offset: all.total })).events).toEqual([]);
  });

  it('lists who has acted: people by name, then the system', async () => {
    expect(await listAuditActors(a.db, a.viewer)).toEqual([
      { id: a.accountant.userId, name: 'Ana Accountant' },
      { id: a.owner.userId, name: 'Olivia Owner' },
      { id: SYSTEM_ACTOR, name: 'System' },
    ]);
  });

  it('exports in the order written, as text a spreadsheet will not run', async () => {
    const seqs: number[] = [];
    for await (const batch of auditEventBatches(a.db, a.owner, {}, 2)) {
      expect(batch.length).toBeLessThanOrEqual(2);
      seqs.push(...batch.map((e) => e.seq));
    }
    expect(seqs).toEqual(seqs.map((_, i) => i + 1));
    const teamOnly: string[] = [];
    for await (const batch of auditEventBatches(a.db, a.owner, { area: 'team' })) teamOnly.push(...batch.map((e) => e.action));
    expect(teamOnly).toEqual(['team.role_changed']);

    const event: AuditEventRow = {
      id: 'evt_1',
      seq: 7,
      createdAt: new Date('2026-11-02T15:04:05.000Z'),
      actorType: 'user',
      actorId: 'usr_1',
      actorName: '=cmd|calc',
      action: 'comment.added',
      summary: 'Commented: "pay net 30", then\nleft',
      payApplicationId: null,
      hash: 'abc123',
    };
    expect(auditCsvRow(event)).toBe(`7,2026-11-02T15:04:05.000Z,'=cmd|calc,user,comment.added,"Commented: ""pay net 30"", then\nleft",,abc123\r\n`);
    expect(auditCsvRow({ ...event, actorName: 'Ana Accountant', summary: '-$10.00 adjustment', payApplicationId: 'pa_9' })).toBe(`7,2026-11-02T15:04:05.000Z,Ana Accountant,user,comment.added,'-$10.00 adjustment,pa_9,abc123\r\n`);
  });
});
