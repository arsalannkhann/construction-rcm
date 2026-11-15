'use server';

import { getDb } from '@/db';
import { run, type ActionResult } from '@/lib/action';
import { requireCtx } from '@/server/auth/session';
import { changeRole, issueMemberPasswordReset, resetMemberMfa, revokeInvitation, setMemberActive } from '@/server/services/team';
import { inviteAndNotify, type InviteOutcome } from '@/server/services/team-invite';

/** The link is in this response only; just its hash is stored. */
export async function issuePasswordResetAction(userId: string): Promise<ActionResult<{ link: string; expiresAt: string }>> {
  return run(async () => {
    const ctx = await requireCtx();
    const { link, expiresAt } = await issueMemberPasswordReset(await getDb(), ctx, userId);
    return { link, expiresAt: expiresAt.toISOString() };
  });
}

export async function resetMemberMfaAction(userId: string): Promise<ActionResult> {
  return run(async () => {
    const ctx = await requireCtx();
    await resetMemberMfa(await getDb(), ctx, userId);
    return undefined;
  });
}

export async function inviteAction(input: { email: string; role: string }): Promise<ActionResult<InviteOutcome>> {
  return run(async () => {
    const ctx = await requireCtx();
    return inviteAndNotify(await getDb(), ctx, input);
  });
}

export async function revokeInvitationAction(id: string): Promise<ActionResult> {
  return run(async () => {
    const ctx = await requireCtx();
    await revokeInvitation(await getDb(), ctx, id);
    return undefined;
  });
}

export async function changeRoleAction(userId: string, role: string): Promise<ActionResult> {
  return run(async () => {
    const ctx = await requireCtx();
    await changeRole(await getDb(), ctx, userId, role);
    return undefined;
  });
}

export async function setMemberActiveAction(userId: string, active: boolean): Promise<ActionResult> {
  return run(async () => {
    const ctx = await requireCtx();
    await setMemberActive(await getDb(), ctx, userId, active);
    return undefined;
  });
}
