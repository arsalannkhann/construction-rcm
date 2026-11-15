'use server';

import { getDb } from '@/db';
import { run, type ActionResult } from '@/lib/action';
import { requireCtx } from '@/server/auth/session';
import { changeRole, revokeInvitation, setMemberActive } from '@/server/services/team';
import { inviteAndNotify, type InviteOutcome } from '@/server/services/team-invite';

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
