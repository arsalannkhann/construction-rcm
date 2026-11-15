'use server';

import { getDb } from '@/db';
import { run, type ActionResult } from '@/lib/action';
import { requireCtx } from '@/server/auth/session';
import { updatePolicy } from '@/server/services/team';
import type { OrgSettings } from '@/server/types';

export async function updatePolicyAction(input: OrgSettings): Promise<ActionResult> {
  return run(async () => {
    const ctx = await requireCtx();
    await updatePolicy(await getDb(), ctx, input);
    return undefined;
  });
}
