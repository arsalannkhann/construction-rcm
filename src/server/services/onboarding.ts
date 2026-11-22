/**
 * Onboarding: what a member has been shown and chosen, and how far the
 * organisation's setup has really got.
 *
 * Two kinds of state, kept apart on purpose. What a person answered or put
 * away (the welcome step, a tour) is theirs and is stored on their membership.
 * How far setup has got is never stored: it is counted from the organisation's
 * records each time, so it cannot say "done" about work that is not there.
 */
import { and, asc, eq, ne, sql } from 'drizzle-orm';
import type { DB } from '@/db';
import { contracts, memberships, organizations, payApplications, projects, sovLines, subcontractors } from '@/db/schema';
import { focusesFor, ORG_KIND_LABEL, ORG_REGION_LABEL } from '@/lib/onboarding';
import type { SetupProgress } from '@/lib/setup-guide';
import { recordAudit } from '@/server/audit';
import { assertCan, UserError, type Ctx } from '@/server/auth/permissions';
import { MEMBER_FOCUSES, ORG_KINDS, ORG_REGIONS, resolveSettings, TOUR_IDS, type MemberFocus, type MemberOnboarding, type OrgKind, type OrgProfile, type OrgRegion, type TourId } from '@/server/types';

export type OnboardingState = {
  /** Null for a membership nobody has recorded anything on yet: a new member, who is shown the welcome step. */
  member: MemberOnboarding | null;
  profile: OrgProfile | null;
};

export async function getOnboardingState(db: DB, ctx: Ctx): Promise<OnboardingState> {
  const [row] = await db
    .select({ onboarding: memberships.onboarding, settings: organizations.settings })
    .from(memberships)
    .innerJoin(organizations, eq(organizations.id, memberships.orgId))
    .where(and(eq(memberships.orgId, ctx.orgId), eq(memberships.userId, ctx.userId)));
  return { member: row?.onboarding ?? null, profile: row ? (resolveSettings(row.settings).profile ?? null) : null };
}

/**
 * A new member of their own organisation is welcomed once. Never in the demo
 * workspace (it has its own tour), and never someone whose membership already
 * carries a record: people who were here before onboarding existed are not
 * interrupted (their memberships were given an empty record when the column
 * was added).
 */
export function needsWelcome(ctx: Ctx, state: OnboardingState): boolean {
  return !ctx.isDemo && state.member === null;
}

async function patchMember(db: DB, orgId: string, userId: string, patch: (current: MemberOnboarding) => MemberOnboarding): Promise<MemberOnboarding> {
  const where = and(eq(memberships.orgId, orgId), eq(memberships.userId, userId));
  const [row] = await db.select({ onboarding: memberships.onboarding }).from(memberships).where(where);
  if (!row) throw new UserError('You are not a member of that organisation.');
  const next = patch(row.onboarding ?? {});
  await db.update(memberships).set({ onboarding: next }).where(where);
  return next;
}

export type WelcomeInput = { focus: MemberFocus; path: 'example' | 'real' | null; kind?: OrgKind | null; region?: OrgRegion | null };

/**
 * Records the welcome step. The organisation's profile is taken only from
 * someone who manages the organisation, and only changes wording.
 */
export async function completeWelcome(db: DB, ctx: Ctx, input: WelcomeInput, now: Date = new Date()): Promise<void> {
  if (!MEMBER_FOCUSES.includes(input.focus) || !focusesFor(ctx.role).includes(input.focus)) throw new UserError('Choose what you will mostly do here.');
  if (input.path !== null && input.path !== 'example' && input.path !== 'real') throw new UserError('Choose how you would like to start.');
  if (input.kind && input.region) await setOrgProfile(db, ctx, { kind: input.kind, region: input.region });
  await patchMember(db, ctx.orgId, ctx.userId, (m) => ({ ...m, welcomedAt: m.welcomedAt ?? now.toISOString(), focus: input.focus, ...(input.path ? { path: input.path } : {}) }));
}

/** The welcome step put aside without answering. It is not shown again unasked; Help reopens it. */
export async function skipWelcome(db: DB, ctx: Ctx, now: Date = new Date()): Promise<void> {
  await patchMember(db, ctx.orgId, ctx.userId, (m) => ({ ...m, welcomedAt: m.welcomedAt ?? now.toISOString() }));
}

export async function setOrgProfile(db: DB, ctx: Ctx, profile: OrgProfile): Promise<void> {
  assertCan(ctx, 'org:manage');
  if (!ORG_KINDS.includes(profile.kind) || !ORG_REGIONS.includes(profile.region)) throw new UserError('Choose your company type and where your projects are.');
  const [org] = await db.select({ settings: organizations.settings }).from(organizations).where(eq(organizations.id, ctx.orgId));
  if (!org) throw new UserError('Organisation not found.');
  const current = resolveSettings(org.settings).profile;
  if (current?.kind === profile.kind && current.region === profile.region) return;
  // One key of the settings object is replaced in the database, so a policy change saved at the same moment is not lost.
  await db
    .update(organizations)
    .set({ settings: sql`jsonb_set(${organizations.settings}, '{profile}', ${JSON.stringify({ kind: profile.kind, region: profile.region })}::jsonb, true)` })
    .where(eq(organizations.id, ctx.orgId));
  await recordAudit(db, { orgId: ctx.orgId, actor: ctx, action: 'organization.profile_updated', entityType: 'organization', entityId: ctx.orgId, summary: `Set the company profile: ${ORG_KIND_LABEL[profile.kind]}, projects in ${ORG_REGION_LABEL[profile.region]}` });
}

// ── Tours ───────────────────────────────────────────────────────────────────

const isTour = (id: string): id is TourId => (TOUR_IDS as readonly string[]).includes(id);

/** Start a tour (or start it again) from its first step. */
export async function startTour(db: DB, ctx: Ctx, id: string): Promise<void> {
  if (!isTour(id)) throw new UserError('That tour does not exist.');
  await patchMember(db, ctx.orgId, ctx.userId, (m) => ({ ...m, activeTour: { id, step: 0 } }));
}

/** Where the member has got to, so closing the tab or signing out does not lose their place. */
export async function saveTourStep(db: DB, ctx: Ctx, id: string, step: number, paused = false): Promise<void> {
  if (!isTour(id) || !Number.isInteger(step) || step < 0 || step > 50) return;
  await patchMember(db, ctx.orgId, ctx.userId, (m) => (m.activeTour?.id === id ? { ...m, activeTour: { id, step, ...(paused ? { paused: true } : {}) } } : m));
}

export async function finishTour(db: DB, ctx: Ctx, id: string, status: 'done' | 'skipped', now: Date = new Date()): Promise<void> {
  if (!isTour(id)) return;
  await patchMember(db, ctx.orgId, ctx.userId, (m) => ({ ...m, activeTour: null, tours: { ...(m.tours ?? {}), [id]: { status, at: now.toISOString() } } }));
}

// ── The setup guide ─────────────────────────────────────────────────────────

export async function setGuideHidden(db: DB, ctx: Ctx, hidden: boolean, now: Date = new Date()): Promise<void> {
  await patchMember(db, ctx.orgId, ctx.userId, (m) => {
    const { guideHiddenAt: _was, ...rest } = m;
    return hidden ? { ...rest, guideHiddenAt: now.toISOString() } : rest;
  });
}

/** Setup is finished: stop offering the guide to this member. Called where progress has just been counted and found complete. */
export async function noteSetupDone(db: DB, ctx: Ctx, state: OnboardingState): Promise<void> {
  if (ctx.isDemo || state.member?.setupDoneAt) return;
  await patchMember(db, ctx.orgId, ctx.userId, (m) => ({ ...m, setupDoneAt: m.setupDoneAt ?? new Date().toISOString() }));
}

/** Noted the first time a member opens an application, which is the one setup step no record shows. */
export async function noteOpenedReview(db: DB, ctx: Ctx, state: OnboardingState): Promise<void> {
  if (ctx.isDemo || state.member?.openedReviewAt) return;
  await patchMember(db, ctx.orgId, ctx.userId, (m) => ({ ...m, openedReviewAt: m.openedReviewAt ?? new Date().toISOString() }));
}

/**
 * Give a member of the demo workspace the review tour, carrying over the focus
 * they chose in their own organisation. A tour they already finished or
 * skipped there is not started again.
 */
export async function prepareExample(db: DB, userId: string, demoOrgId: string, focus: MemberFocus | undefined, now: Date = new Date()): Promise<void> {
  await patchMember(db, demoOrgId, userId, (m) => ({
    ...m,
    welcomedAt: m.welcomedAt ?? now.toISOString(),
    ...(focus ? { focus } : {}),
    path: 'example',
    activeTour: m.tours?.review ? (m.activeTour ?? null) : { id: 'review', step: m.activeTour?.id === 'review' ? m.activeTour.step : 0 },
  }));
}

/** How far the organisation's setup has got, counted from its records. */
export async function getSetupProgress(db: DB, ctx: Ctx, state: OnboardingState): Promise<SetupProgress> {
  const org = ctx.orgId;
  const count = sql<number>`count(*)::int`;
  const [[p], [s], contractRows, scheduled, apps, [m], [o]] = await Promise.all([
    db.select({ n: count }).from(projects).where(eq(projects.orgId, org)),
    db.select({ n: count }).from(subcontractors).where(eq(subcontractors.orgId, org)),
    db.select({ id: contracts.id }).from(contracts).where(eq(contracts.orgId, org)).orderBy(asc(contracts.createdAt)),
    db.selectDistinct({ contractId: sovLines.contractId }).from(sovLines).where(eq(sovLines.orgId, org)),
    db
      .select({ id: payApplications.id, status: payApplications.status })
      .from(payApplications)
      .where(and(eq(payApplications.orgId, org), ne(payApplications.status, 'void')))
      .orderBy(asc(payApplications.receivedAt)),
    db.select({ n: count }).from(memberships).where(and(eq(memberships.orgId, org), eq(memberships.status, 'active'))),
    db.select({ settings: organizations.settings }).from(organizations).where(eq(organizations.id, org)),
  ]);
  const withSchedule = new Set(scheduled.map((r) => r.contractId));
  const acted = (status: string) => status === 'pending_approval' || status === 'on_hold' || status === 'approved' || status === 'rejected';
  // The application to send someone to: one that is waiting on the team, else the first one received.
  const open = apps.find((a) => a.status === 'needs_review') ?? apps.find((a) => a.status === 'pending_approval' || a.status === 'needs_matching') ?? apps[0] ?? null;
  return {
    projects: p?.n ?? 0,
    subcontractors: s?.n ?? 0,
    contracts: contractRows.length,
    contractsWithSchedule: contractRows.filter((c) => withSchedule.has(c.id)).length,
    applications: apps.length,
    actedOn: apps.filter((a) => acted(a.status)).length,
    decided: apps.filter((a) => a.status === 'approved' || a.status === 'rejected').length,
    members: m?.n ?? 0,
    requireMfa: resolveSettings(o?.settings).requireMfa,
    openedReview: !!state.member?.openedReviewAt,
    firstContractId: contractRows[0]?.id ?? null,
    contractWithoutScheduleId: contractRows.find((c) => !withSchedule.has(c.id))?.id ?? null,
    openApplicationId: open?.id ?? null,
  };
}
