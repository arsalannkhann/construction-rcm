/**
 * Onboarding: the welcome step, the setup guide worked out from an
 * organisation's records, tour progress, and the overview's "needs you" list.
 * Service level, against a real (in-memory) Postgres.
 */
import { and, eq } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import { auditEvents, memberships, organizations } from '@/db/schema';
import { nextActions, type ActionFacts } from '@/lib/next-actions';
import { defaultFocus, focusesFor } from '@/lib/onboarding';
import { setupFollowUps, setupSteps, summarizeSetup, type SetupProgress } from '@/lib/setup-guide';
import { PermissionError } from '@/server/auth/permissions';
import { createDemoWorkspace } from '@/server/services/demo';
import {
  completeWelcome,
  finishTour,
  getOnboardingState,
  getSetupProgress,
  needsWelcome,
  noteOpenedReview,
  noteSetupDone,
  prepareExample,
  saveTourStep,
  setGuideHidden,
  setOrgProfile,
  skipWelcome,
  startTour,
} from '@/server/services/onboarding';
import { approveApplication, submitForApproval } from '@/server/services/review';
import { signUp, updatePolicy } from '@/server/services/team';
import { resolveSettings, type Role } from '@/server/types';
import { addMember, createWorld, packageFor, submit, type World } from './helpers/world';

const EMPTY: SetupProgress = {
  projects: 0,
  subcontractors: 0,
  contracts: 0,
  contractsWithSchedule: 0,
  applications: 0,
  actedOn: 0,
  decided: 0,
  members: 1,
  requireMfa: false,
  openedReview: false,
  firstContractId: null,
  contractWithoutScheduleId: null,
  openApplicationId: null,
};

const progressFor = async (w: World, who = w.owner) => getSetupProgress(w.db, who, await getOnboardingState(w.db, who));
const stepsFor = async (w: World, who = w.owner) => setupSteps(await progressFor(w, who), who.role);
const done = (steps: Array<{ id: string; done: boolean }>) => steps.filter((s) => s.done).map((s) => s.id);

describe('the welcome step', () => {
  let w: World;
  beforeAll(async () => {
    w = await createWorld();
  });

  it('is shown to a new member once, and never in the example workspace', async () => {
    const before = await getOnboardingState(w.db, w.owner);
    expect(before.member).toBeNull();
    expect(needsWelcome(w.owner, before)).toBe(true);
    expect(needsWelcome({ ...w.owner, isDemo: true }, before)).toBe(false);

    await skipWelcome(w.db, w.owner);
    const after = await getOnboardingState(w.db, w.owner);
    expect(after.member?.welcomedAt).toBeTruthy();
    expect(needsWelcome(w.owner, after)).toBe(false);
  });

  it('does not interrupt a member whose record is empty rather than missing', async () => {
    // What the migration gives everyone who was a member before onboarding existed.
    await w.db.update(memberships).set({ onboarding: {} }).where(and(eq(memberships.orgId, w.orgId), eq(memberships.userId, w.viewer.userId)));
    expect(needsWelcome(w.viewer, await getOnboardingState(w.db, w.viewer))).toBe(false);
  });

  it('records the focus and the company profile, and audits the profile', async () => {
    await completeWelcome(w.db, w.owner, { focus: 'oversee', path: 'real', kind: 'general_contractor', region: 'us' });
    const state = await getOnboardingState(w.db, w.owner);
    expect(state.member).toMatchObject({ focus: 'oversee', path: 'real' });
    expect(state.profile).toEqual({ kind: 'general_contractor', region: 'us' });
    const events = await w.db.select().from(auditEvents).where(and(eq(auditEvents.orgId, w.orgId), eq(auditEvents.action, 'organization.profile_updated')));
    expect(events).toHaveLength(1);

    // The same answers again change nothing and are not logged again.
    await completeWelcome(w.db, w.owner, { focus: 'oversee', path: 'real', kind: 'general_contractor', region: 'us' });
    expect(await w.db.select().from(auditEvents).where(and(eq(auditEvents.orgId, w.orgId), eq(auditEvents.action, 'organization.profile_updated')))).toHaveLength(1);
  });

  it('offers a role only the work it can do, and refuses the rest', async () => {
    expect(focusesFor('accountant')).toEqual(['review', 'oversee', 'projects']);
    expect(focusesFor('controller')).toContain('approve');
    expect(focusesFor('viewer')).toEqual(['oversee', 'projects']);
    for (const role of ['owner', 'admin', 'controller', 'accountant', 'project_manager', 'viewer'] as Role[]) expect(focusesFor(role)).toContain(defaultFocus(role));
    await expect(completeWelcome(w.db, w.accountant, { focus: 'approve', path: null })).rejects.toThrow('Choose what you will mostly do here.');
    await expect(completeWelcome(w.db, w.accountant, { focus: 'review', path: null })).resolves.toBeUndefined();
  });

  it('takes the company profile only from someone who manages the organisation', async () => {
    await expect(setOrgProfile(w.db, w.controller, { kind: 'subcontractor', region: 'india' })).rejects.toBeInstanceOf(PermissionError);
    // A member who cannot manage the organisation, sending profile answers with their welcome, is refused and nothing of theirs is saved.
    await expect(completeWelcome(w.db, w.pm, { focus: 'projects', path: null, kind: 'subcontractor', region: 'india' })).rejects.toBeInstanceOf(PermissionError);
    expect((await getOnboardingState(w.db, w.pm)).member).toBeNull();
    expect((await getOnboardingState(w.db, w.owner)).profile).toEqual({ kind: 'general_contractor', region: 'us' });
  });

  it('keeps the profile when review policy is changed, and the policy when the profile is', async () => {
    await updatePolicy(w.db, w.owner, { toleranceCents: 250 });
    await setOrgProfile(w.db, w.owner, { kind: 'general_contractor', region: 'other' });
    const [org] = await w.db.select().from(organizations).where(eq(organizations.id, w.orgId));
    const settings = resolveSettings(org!.settings);
    expect(settings.toleranceCents).toBe(250);
    expect(settings.profile).toEqual({ kind: 'general_contractor', region: 'other' });
    await updatePolicy(w.db, w.owner, { toleranceCents: 100 });
    const [again] = await w.db.select().from(organizations).where(eq(organizations.id, w.orgId));
    expect(resolveSettings(again!.settings).profile).toEqual({ kind: 'general_contractor', region: 'other' });
  });

  it('is kept per organisation: another organisation sees none of it', async () => {
    const other = await createWorld();
    expect(await getOnboardingState(other.db, other.owner)).toEqual({ member: null, profile: null });
  });
});

describe('the setup guide', () => {
  it('starts with only the organisation done, and points at the project', () => {
    const steps = setupSteps(EMPTY, 'owner');
    expect(steps.map((s) => s.id)).toEqual(['organisation', 'project', 'subcontractor', 'subcontract', 'schedule', 'upload', 'review', 'decide']);
    expect(done(steps)).toEqual(['organisation']);
    expect(summarizeSetup(steps)).toMatchObject({ done: 1, total: 8, complete: false });
    expect(summarizeSetup(steps).next).toMatchObject({ id: 'project', href: '/projects/new', allowed: true });
    // The subcontract needs a project first.
    expect(steps.find((s) => s.id === 'subcontract')?.href).toBe('/projects/new');
  });

  it('says who can do a step the member’s role cannot, and offers them no way in', () => {
    const viewer = setupSteps(EMPTY, 'viewer');
    expect(viewer.find((s) => s.id === 'project')).toMatchObject({ allowed: false, who: 'An admin, controller or project accountant sets this up.' });
    expect(viewer.find((s) => s.id === 'upload')?.allowed).toBe(false);
    const pm = setupSteps(EMPTY, 'project_manager');
    expect(pm.find((s) => s.id === 'project')?.allowed).toBe(false);
    expect(pm.find((s) => s.id === 'upload')?.allowed).toBe(true);
    expect(setupFollowUps(EMPTY, 'accountant').every((f) => !f.allowed)).toBe(true);
    expect(setupFollowUps(EMPTY, 'admin').every((f) => f.allowed)).toBe(true);
  });

  it('asks an approver to decide and a reviewer to send for approval', () => {
    const acted = { ...EMPTY, projects: 1, subcontractors: 1, contracts: 1, contractsWithSchedule: 1, applications: 1, actedOn: 1, openedReview: true };
    expect(setupSteps(acted, 'accountant').find((s) => s.id === 'decide')).toMatchObject({ title: 'Send the first application for approval', done: true });
    expect(setupSteps(acted, 'controller').find((s) => s.id === 'decide')).toMatchObject({ title: 'Approve or reject the first application', done: false });
    expect(setupSteps({ ...acted, decided: 1 }, 'controller').every((s) => s.done)).toBe(true);
  });

  it('follows the organisation’s records from empty to a decided application', async () => {
    const { userId, orgId } = await signUp((await createWorld()).db, { name: 'Nell New', email: `nell.${Date.now()}@example.test`, password: 'correct horse battery', orgName: 'Brand New Builders' });
    const w = await createWorld({ withSchedule: false });
    const fresh = { ...w.owner, orgId, orgName: 'Brand New Builders', userId, userName: 'Nell New' };
    expect(done(setupSteps(await getSetupProgress(w.db, fresh, await getOnboardingState(w.db, fresh)), 'owner'))).toEqual(['organisation']);

    // A world with a project, a subcontractor and a subcontract but no schedule yet.
    let steps = await stepsFor(w);
    expect(done(steps)).toEqual(['organisation', 'project', 'subcontractor', 'subcontract']);
    expect(summarizeSetup(steps).next).toMatchObject({ id: 'schedule', href: `/contracts/${w.contractId}` });

    // A world with a schedule: upload is next, then the application itself.
    const full = await createWorld();
    expect(summarizeSetup(await stepsFor(full)).next?.id).toBe('upload');
    const app = await submit(full, packageFor(full, 0, null));
    steps = await stepsFor(full, full.accountant);
    expect(summarizeSetup(steps).next).toMatchObject({ id: 'review', href: `/applications/${app.id}` });

    // Opening it is noted for that member only.
    await noteOpenedReview(full.db, full.accountant, await getOnboardingState(full.db, full.accountant));
    expect(done(await stepsFor(full, full.accountant))).toContain('review');
    expect(done(await stepsFor(full, full.controller))).not.toContain('review');

    // Sent for approval: done for the reviewer, and "seen" for everyone because someone has acted on it.
    await submitForApproval(full.db, full.accountant, app.id);
    expect((await stepsFor(full, full.accountant)).every((s) => s.done)).toBe(true);
    const controller = await stepsFor(full, full.controller);
    expect(done(controller)).toContain('review');
    expect(summarizeSetup(controller).next?.id).toBe('decide');

    await approveApplication(full.db, full.controller, app.id);
    expect(summarizeSetup(await stepsFor(full, full.controller)).complete).toBe(true);
    expect(await progressFor(full)).toMatchObject({ applications: 1, actedOn: 1, decided: 1, members: 5 });
  });

  it('counts only its own organisation', async () => {
    const a = await createWorld();
    const b = await createWorld();
    await submit(a, packageFor(a, 0, null));
    expect((await progressFor(a)).applications).toBe(1);
    expect((await progressFor(b)).applications).toBe(0);
    expect((await progressFor(b)).openApplicationId).toBeNull();
  });

  it('can be put away and brought back, and stops being offered once finished', async () => {
    const w = await createWorld();
    await setGuideHidden(w.db, w.owner, true);
    expect((await getOnboardingState(w.db, w.owner)).member?.guideHiddenAt).toBeTruthy();
    await setGuideHidden(w.db, w.owner, false);
    expect((await getOnboardingState(w.db, w.owner)).member?.guideHiddenAt).toBeUndefined();
    await noteSetupDone(w.db, w.owner, await getOnboardingState(w.db, w.owner));
    const first = (await getOnboardingState(w.db, w.owner)).member?.setupDoneAt;
    expect(first).toBeTruthy();
    // Noted once.
    await noteSetupDone(w.db, w.owner, await getOnboardingState(w.db, w.owner));
    expect((await getOnboardingState(w.db, w.owner)).member?.setupDoneAt).toBe(first);
  });
});

describe('tours', () => {
  let w: World;
  beforeAll(async () => {
    w = await createWorld();
  });
  const tour = async (who = w.owner) => (await getOnboardingState(w.db, who)).member;

  it('keep their place, can be paused, and are remembered once finished', async () => {
    await startTour(w.db, w.owner, 'review');
    expect((await tour())?.activeTour).toEqual({ id: 'review', step: 0 });
    await saveTourStep(w.db, w.owner, 'review', 4);
    expect((await tour())?.activeTour).toEqual({ id: 'review', step: 4 });
    await saveTourStep(w.db, w.owner, 'review', 4, true);
    expect((await tour())?.activeTour).toEqual({ id: 'review', step: 4, paused: true });
    // A step saved for a tour that is not the running one is ignored.
    await saveTourStep(w.db, w.owner, 'workspace', 2);
    expect((await tour())?.activeTour).toEqual({ id: 'review', step: 4, paused: true });

    await finishTour(w.db, w.owner, 'review', 'done');
    expect(await tour()).toMatchObject({ activeTour: null, tours: { review: { status: 'done' } } });
    // One member's tour is nobody else's.
    expect((await tour(w.controller))?.activeTour).toBeUndefined();
  });

  it('ignore tours and steps that do not exist', async () => {
    await expect(startTour(w.db, w.owner, 'nonsense')).rejects.toThrow('That tour does not exist.');
    await startTour(w.db, w.owner, 'workspace');
    await saveTourStep(w.db, w.owner, 'workspace', -1);
    await saveTourStep(w.db, w.owner, 'workspace', 1.5);
    await saveTourStep(w.db, w.owner, 'workspace', 9999);
    expect((await tour())?.activeTour).toEqual({ id: 'workspace', step: 0 });
  });

  it('start in the example workspace with the focus chosen at home, once', async () => {
    const { orgId } = await createDemoWorkspace(w.db, w.owner.userId);
    const demo = { ...w.owner, orgId, isDemo: true };
    await prepareExample(w.db, w.owner.userId, orgId, 'approve');
    expect((await getOnboardingState(w.db, demo)).member).toMatchObject({ focus: 'approve', path: 'example', activeTour: { id: 'review', step: 0 } });
    // The example never touches the member's own organisation's record.
    expect((await tour())?.path).not.toBe('example');

    // Finished there: opening the example again does not start the tour again.
    await finishTour(w.db, demo, 'review', 'skipped');
    await prepareExample(w.db, w.owner.userId, orgId, 'approve');
    expect((await getOnboardingState(w.db, demo)).member?.activeTour).toBeNull();

    // Someone who is not a member of the example cannot be given its tour.
    const stranger = await addMember(w.db, w.orgId, w.owner.orgName, 'viewer', 'Sid Stranger');
    await expect(prepareExample(w.db, stranger.userId, orgId, undefined)).rejects.toThrow('You are not a member of that organisation.');
  }, 120_000);
});

describe('needs you', () => {
  const facts: ActionFacts = {
    kpis: { pendingApproval: { count: 2, amount: 50_000_00 }, onHold: { count: 1, amount: 1 }, awaitingTransfer: { count: 3, amount: 90_000_00 }, failedTransfers: 1 },
    pipeline: [
      { status: 'needs_review', count: 4, amount: 120_000_00 },
      { status: 'needs_matching', count: 1, amount: 10_000_00 },
    ],
    workload: [
      { userId: 'me', count: 2, blocking: 3, oldestDays: 6 },
      { userId: null, count: 2, blocking: 0, oldestDays: 1 },
    ],
    billing: { last: { month: '2026-10', missing: 2 }, current: { month: '2026-11', due: 1 } },
    risks: [
      { key: 'missing:c1', tone: 'block', title: 'Missed billing', detail: '', href: '/billing' },
      { key: 'budget:p1', tone: 'block', title: 'Harbor Point is projected over budget', detail: 'd', href: '/projects/p1' },
    ],
  };
  const keys = (role: Role, focus: Parameters<typeof nextActions>[1]['focus']) => nextActions(facts, { role, focus, userId: 'me' }).map((a) => a.key);

  it('puts each focus’s own work first', () => {
    expect(keys('accountant', 'review').slice(0, 3)).toEqual(['mine', 'review', 'matching']);
    expect(keys('controller', 'approve')[0]).toBe('approve');
    expect(keys('owner', 'oversee').slice(0, 2)).toEqual(['failed', 'risk']);
    expect(keys('project_manager', 'projects').slice(0, 2)).toEqual(['missing', 'risk']);
  });

  it('never offers a role work it cannot do', () => {
    const accountant = keys('accountant', 'review');
    expect(accountant).not.toContain('approve');
    expect(accountant).toContain('export');
    const pm = keys('project_manager', 'projects');
    expect(pm).not.toContain('approve');
    expect(pm).not.toContain('mine');
    expect(pm).not.toContain('export');
    expect(pm).not.toContain('failed');
    const viewer = nextActions(facts, { role: 'viewer', focus: 'projects', userId: 'me' });
    expect(viewer.map((a) => a.key)).not.toContain('matching');
    // A viewer still sees that reviews are in hand, as information and not as their task.
    expect(viewer.find((a) => a.key === 'review')).toMatchObject({ tone: 'neutral', cta: 'See the queue' });
  });

  it('does not list a missed billing period twice, and is empty when nothing is waiting', () => {
    const owner = nextActions(facts, { role: 'owner', focus: 'oversee', userId: 'me' });
    expect(owner.filter((a) => a.key === 'risk')).toMatchObject([{ title: 'Harbor Point is projected over budget' }]);
    expect(owner.filter((a) => a.key === 'missing')).toHaveLength(1);
    const quiet: ActionFacts = {
      kpis: { pendingApproval: { count: 0, amount: 0 }, onHold: { count: 0, amount: 0 }, awaitingTransfer: { count: 0, amount: 0 }, failedTransfers: 0 },
      pipeline: [],
      workload: [],
      billing: { last: { month: '2026-10', missing: 0 }, current: { month: '2026-11', due: 0 } },
      risks: [],
    };
    expect(nextActions(quiet, { role: 'owner', focus: 'oversee', userId: 'me' })).toEqual([]);
  });
});
