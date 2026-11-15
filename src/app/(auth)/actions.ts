'use server';

import { redirect } from 'next/navigation';
import { getDb } from '@/db';
import { run, type ActionResult } from '@/lib/action';
import { UserError } from '@/server/auth/permissions';
import { endSession, getSession, sessionToken, startSession } from '@/server/auth/session';
import { acceptInvitation, authenticate, createOrganization, signUp, switchOrganization } from '@/server/services/team';

export async function loginAction(input: { email: string; password: string }): Promise<ActionResult> {
  return run(async () => {
    const user = await authenticate(await getDb(), input.email, input.password);
    if (!user) throw new UserError('That email and password do not match an account.');
    await startSession(user.id);
    return undefined;
  });
}

export async function signupAction(input: { name: string; email: string; password: string; orgName: string }): Promise<ActionResult> {
  return run(async () => {
    const { userId, orgId } = await signUp(await getDb(), input);
    await startSession(userId, orgId);
    return undefined;
  });
}

export async function acceptInviteAction(token: string, input: { name?: string; password: string }): Promise<ActionResult> {
  return run(async () => {
    const { userId, orgId } = await acceptInvitation(await getDb(), token, input);
    await startSession(userId, orgId);
    return undefined;
  });
}

export async function logoutAction(): Promise<void> {
  await endSession();
  redirect('/login');
}

export async function switchOrgAction(orgId: string): Promise<ActionResult> {
  return run(async () => {
    const session = await getSession();
    const token = await sessionToken();
    if (!session || !token) throw new UserError('Your session has expired. Sign in again.');
    await switchOrganization(await getDb(), token, session.user.id, orgId);
    return undefined;
  });
}

export async function createOrgAction(name: string): Promise<ActionResult> {
  return run(async () => {
    const session = await getSession();
    const token = await sessionToken();
    if (!session || !token) throw new UserError('Your session has expired. Sign in again.');
    const db = await getDb();
    const orgId = await createOrganization(db, session.user.id, name);
    await switchOrganization(db, token, session.user.id, orgId);
    return undefined;
  });
}
