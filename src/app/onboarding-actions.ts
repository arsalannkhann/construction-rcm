'use server';

import { getDb } from '@/db';
import { run, type ActionResult } from '@/lib/action';
import { UserError } from '@/server/auth/permissions';
import { getSession, requireCtx, sessionToken } from '@/server/auth/session';
import { createDemoWorkspace } from '@/server/services/demo';
import { completeWelcome, finishTour, getOnboardingState, prepareExample, saveTourStep, setGuideHidden, skipWelcome, startTour, type WelcomeInput } from '@/server/services/onboarding';
import { listMyOrganizations, switchOrganization } from '@/server/services/team';
import type { MemberFocus } from '@/server/types';

/** Where the browser goes next, with a full page load (the organisation may have changed). */
type Next = { next: string };

/** Builds the example workspace if this person has none, gives them its tour, and moves their session into it. */
async function enterExample(userId: string, focus: MemberFocus | undefined): Promise<Next> {
  const token = await sessionToken();
  if (!token) throw new UserError('Your session has expired. Sign in again.');
  const db = await getDb();
  const { orgId } = await createDemoWorkspace(db, userId);
  await prepareExample(db, userId, orgId, focus);
  await switchOrganization(db, token, userId, orgId);
  return { next: '/applications' };
}

/** The welcome step: what the member will mostly do, the company profile (from someone who manages it), and where to start. */
export async function completeWelcomeAction(input: WelcomeInput): Promise<ActionResult<Next>> {
  return run(async () => {
    const ctx = await requireCtx();
    if (ctx.isDemo) throw new UserError('Switch to your own organisation first.');
    await completeWelcome(await getDb(), ctx, input);
    if (input.path === 'example') return enterExample(ctx.userId, input.focus);
    return { next: input.path === 'real' ? '/get-started' : '/overview' };
  });
}

export async function skipWelcomeAction(): Promise<ActionResult<Next>> {
  return run(async () => {
    const ctx = await requireCtx();
    await skipWelcome(await getDb(), ctx);
    return { next: '/overview' };
  });
}

/** Open the example from anywhere in the app (the overview, the setup guide, Help). */
export async function openExampleAction(): Promise<ActionResult<Next>> {
  return run(async () => {
    const session = await getSession();
    if (!session) throw new UserError('Your session has expired. Sign in again.');
    const focus = session.ctx ? (await getOnboardingState(await getDb(), session.ctx)).member?.focus : undefined;
    return enterExample(session.user.id, focus);
  });
}

/** From the example back to the member's own organisation, straight into setting it up. */
export async function startOwnSetupAction(): Promise<ActionResult<Next>> {
  return run(async () => {
    const session = await getSession();
    const token = await sessionToken();
    if (!session || !token) throw new UserError('Your session has expired. Sign in again.');
    const db = await getDb();
    const own = (await listMyOrganizations(db, session.user.id)).find((o) => !o.isDemo);
    if (!own) return { next: '/welcome' };
    await switchOrganization(db, token, session.user.id, own.id);
    return { next: '/get-started' };
  });
}

export async function startTourAction(id: string): Promise<ActionResult> {
  return run(async () => {
    await startTour(await getDb(), await requireCtx(), id);
    return undefined;
  });
}

export async function saveTourStepAction(id: string, step: number, paused = false): Promise<ActionResult> {
  return run(async () => {
    await saveTourStep(await getDb(), await requireCtx(), id, step, !!paused);
    return undefined;
  });
}

export async function finishTourAction(id: string, status: 'done' | 'skipped'): Promise<ActionResult> {
  return run(async () => {
    await finishTour(await getDb(), await requireCtx(), id, status === 'done' ? 'done' : 'skipped');
    return undefined;
  });
}

export async function setGuideHiddenAction(hidden: boolean): Promise<ActionResult> {
  return run(async () => {
    await setGuideHidden(await getDb(), await requireCtx(), !!hidden);
    return undefined;
  });
}
