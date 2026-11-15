'use server';

import { getDb } from '@/db';
import { run, type ActionResult } from '@/lib/action';
import { UserError } from '@/server/auth/permissions';
import { getSession, requireCtx, sessionToken } from '@/server/auth/session';
import { createDemoWorkspace, deleteDemoWorkspace, findDemoOrganization } from '@/server/services/demo';
import { switchOrganization } from '@/server/services/team';

/** Build the demo workspace (if the user does not have one) and switch to it. */
export async function openDemoWorkspaceAction(): Promise<ActionResult<{ created: boolean }>> {
  return run(async () => {
    const session = await getSession();
    const token = await sessionToken();
    if (!session || !token) throw new UserError('Your session has expired. Sign in again.');
    const db = await getDb();
    const { orgId, created } = await createDemoWorkspace(db, session.user.id);
    await switchOrganization(db, token, session.user.id, orgId);
    return { created };
  });
}

export async function deleteDemoWorkspaceAction(): Promise<ActionResult> {
  return run(async () => {
    const ctx = await requireCtx();
    await deleteDemoWorkspace(await getDb(), ctx);
    return undefined;
  });
}

export async function hasDemoWorkspaceAction(): Promise<ActionResult<boolean>> {
  return run(async () => {
    const session = await getSession();
    if (!session) return false;
    return (await findDemoOrganization(await getDb(), session.user.id)) !== null;
  });
}
