'use server';

import { getDb } from '@/db';
import { run, type ActionResult } from '@/lib/action';
import { requireCtx } from '@/server/auth/session';
import { retryFailedJob } from '@/server/services/system';

export async function retryJobAction(jobId: string): Promise<ActionResult> {
  return run(async () => {
    const ctx = await requireCtx();
    await retryFailedJob(await getDb(), ctx, String(jobId));
    return undefined;
  });
}
