'use server';

import { getDb } from '@/db';
import { run, type ActionResult } from '@/lib/action';
import { confirmMfaSetup, disableMfa, regenerateRecoveryCodes, startMfaSetup } from '@/server/auth/mfa';
import { UserError } from '@/server/auth/permissions';
import { qrSvgDataUri } from '@/server/auth/qr';
import { requireUser, sessionToken } from '@/server/auth/session';
import { changePassword, revokeOtherSessions, revokeSession, updateProfile } from '@/server/services/team';

export async function updateProfileAction(input: { name: string }): Promise<ActionResult> {
  return run(async () => {
    const user = await requireUser();
    await updateProfile(await getDb(), user.id, input);
    return undefined;
  });
}

export async function changePasswordAction(input: { current: string; next: string }): Promise<ActionResult> {
  return run(async () => {
    const user = await requireUser();
    // Keep the session making this request; every other session for the account is signed out.
    const keepToken = await sessionToken();
    await changePassword(await getDb(), user.id, input.current, input.next, keepToken ?? undefined);
    return undefined;
  });
}

// ── Two-step verification ───────────────────────────────────────────────────

/** The key and its QR code. This response is the only place the key is ever shown. */
export type MfaSetupStart = { formattedSecret: string; qrCode: string };

export async function startMfaSetupAction(): Promise<ActionResult<MfaSetupStart>> {
  return run(async () => {
    const user = await requireUser();
    const setup = await startMfaSetup(await getDb(), user.id);
    return { formattedSecret: setup.formattedSecret, qrCode: await qrSvgDataUri(setup.uri) };
  });
}

/** Returns the recovery codes. This response is the only place they are ever shown. */
export async function confirmMfaSetupAction(code: string): Promise<ActionResult<{ recoveryCodes: string[] }>> {
  return run(async () => {
    const user = await requireUser();
    return confirmMfaSetup(await getDb(), user.id, code, await sessionToken());
  });
}

export async function disableMfaAction(input: { password: string; code: string }): Promise<ActionResult> {
  return run(async () => {
    const user = await requireUser();
    await disableMfa(await getDb(), user.id, input.password, input.code);
    return undefined;
  });
}

export async function regenerateRecoveryCodesAction(input: { password: string; code: string }): Promise<ActionResult<{ recoveryCodes: string[] }>> {
  return run(async () => {
    const user = await requireUser();
    return { recoveryCodes: await regenerateRecoveryCodes(await getDb(), user.id, input.password, input.code) };
  });
}

// ── Signed-in devices ───────────────────────────────────────────────────────

export async function revokeSessionAction(id: string): Promise<ActionResult> {
  return run(async () => {
    const user = await requireUser();
    await revokeSession(await getDb(), user.id, id, await sessionToken());
    return undefined;
  });
}

export async function revokeOtherSessionsAction(): Promise<ActionResult<number>> {
  return run(async () => {
    const user = await requireUser();
    const token = await sessionToken();
    if (!token) throw new UserError('Your session has expired. Sign in again.');
    return revokeOtherSessions(await getDb(), user.id, token);
  });
}
