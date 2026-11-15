'use server';

import { redirect } from 'next/navigation';
import { after } from 'next/server';
import { getDb } from '@/db';
import { run, type ActionResult } from '@/lib/action';
import { completePasswordReset, requestPasswordReset, type ResetRequestOutcome } from '@/server/auth/password-reset';
import { UserError } from '@/server/auth/permissions';
import {
  clearLoginChallengeCookie,
  endSession,
  getSession,
  loginChallengeToken,
  requestMeta,
  sessionToken,
  setLoginChallengeCookie,
  setSessionCookie,
  startSession,
} from '@/server/auth/session';
import { completeSecondStep, createLoginChallenge, signIn } from '@/server/auth/sign-in';
import { acceptInvitation, createOrganization, signUp, switchOrganization } from '@/server/services/team';

/** Where the browser goes next: into the app, or to the page that asks for the second step. */
export type SignInNext = 'app' | 'verify';

export async function loginAction(input: { email: string; password: string }): Promise<ActionResult<SignInNext>> {
  return run(async () => {
    const meta = await requestMeta();
    const result = await signIn(await getDb(), input.email, input.password, meta);
    if (!result) throw new UserError('That email and password do not match an account.');
    if (result.step === 'second_factor') {
      await setLoginChallengeCookie(result.challenge.token, result.challenge.expiresAt);
      return 'verify';
    }
    await clearLoginChallengeCookie();
    await setSessionCookie(result.session.token, result.session.expiresAt);
    return 'app';
  });
}

export type VerifyOutcome =
  | { status: 'signed_in'; recoveryCodesLeft: number | null }
  | { status: 'wrong_code'; attemptsLeft: number }
  | { status: 'restart'; message: string };

export async function verifyLoginAction(code: string): Promise<ActionResult<VerifyOutcome>> {
  return run(async () => {
    const meta = await requestMeta();
    const result = await completeSecondStep(await getDb(), await loginChallengeToken(), code, meta);
    switch (result.status) {
      case 'signed_in':
        await clearLoginChallengeCookie();
        await setSessionCookie(result.session.token, result.session.expiresAt);
        return { status: 'signed_in', recoveryCodesLeft: result.recoveryCodesLeft };
      case 'wrong_code':
        return { status: 'wrong_code', attemptsLeft: result.attemptsLeft };
      case 'locked':
        throw new UserError('Too many wrong codes for this account. Wait 15 minutes, then try again.');
      case 'restart':
        await clearLoginChallengeCookie();
        return {
          status: 'restart',
          message: result.reason === 'too_many' ? 'Too many wrong codes. Sign in again to get another try.' : 'This sign-in has expired. Sign in again.',
        };
    }
  });
}

export async function requestResetAction(email: string): Promise<ActionResult<ResetRequestOutcome>> {
  return run(async () => requestPasswordReset(await getDb(), email, { defer: (work) => after(work) }));
}

/** Sets the new password. Does not sign in: the person signs in with it, and their second step if they have one. */
export async function completeResetAction(token: string, password: string): Promise<ActionResult> {
  return run(async () => {
    await completePasswordReset(await getDb(), token, password);
    // Whatever this browser was signed in as before is signed out too.
    await endSession();
    await clearLoginChallengeCookie();
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

export async function acceptInviteAction(token: string, input: { name?: string; password: string }): Promise<ActionResult<SignInNext>> {
  return run(async () => {
    const db = await getDb();
    const { userId, orgId, mfaEnabled } = await acceptInvitation(db, token, input);
    if (mfaEnabled) {
      // An existing account with two-step verification still owes its second step.
      const challenge = await createLoginChallenge(db, userId);
      await setLoginChallengeCookie(challenge.token, challenge.expiresAt);
      return 'verify';
    }
    await startSession(userId, orgId);
    return 'app';
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
