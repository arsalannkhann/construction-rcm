'use server';

import { getDb } from '@/db';
import { run, type ActionResult } from '@/lib/action';
import { getSession, requireCtx } from '@/server/auth/session';
import { deleteDemoWorkspace, findDemoOrganization } from '@/server/services/demo';

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
