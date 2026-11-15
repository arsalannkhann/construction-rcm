'use server';

import { getDb } from '@/db';
import { run, type ActionResult } from '@/lib/action';
import { requireCtx } from '@/server/auth/session';
import { markRead } from '@/server/services/notify';

export async function markNotificationsReadAction(): Promise<ActionResult> {
  return run(async () => {
    const ctx = await requireCtx();
    await markRead(await getDb(), ctx);
    return undefined;
  });
}
