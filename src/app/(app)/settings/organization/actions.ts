'use server';

import { getDb } from '@/db';
import { run, type ActionResult } from '@/lib/action';
import { requireCtx } from '@/server/auth/session';
import { renameOrganization } from '@/server/services/team';

export async function renameOrganizationAction(name: string): Promise<ActionResult> {
  return run(async () => {
    const ctx = await requireCtx();
    await renameOrganization(await getDb(), ctx, name);
    return undefined;
  });
}
