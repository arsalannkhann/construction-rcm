'use server';

import { getDb } from '@/db';
import { run, type ActionResult } from '@/lib/action';
import { requireCtx } from '@/server/auth/session';
import { pushToProcore, type ProcorePushResult } from '@/server/integrations/procore';

export async function pushToProcoreAction(appId: string): Promise<ActionResult<Omit<ProcorePushResult, 'transferId'>>> {
  return run(async () => {
    const ctx = await requireCtx();
    const result = await pushToProcore(await getDb(), ctx, appId);
    return { status: result.status, externalRef: result.externalRef, error: result.error, adopted: result.adopted };
  });
}
