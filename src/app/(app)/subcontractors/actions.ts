'use server';

import { getDb } from '@/db';
import { run, type ActionResult } from '@/lib/action';
import { requireCtx } from '@/server/auth/session';
import { createSubcontractor, updateSubcontractor, type SubcontractorInput } from '@/server/services/records';

export async function createSubcontractorAction(input: SubcontractorInput): Promise<ActionResult<{ id: string }>> {
  return run(async () => {
    const ctx = await requireCtx();
    return { id: await createSubcontractor(await getDb(), ctx, input) };
  });
}

export async function updateSubcontractorAction(id: string, input: SubcontractorInput): Promise<ActionResult> {
  return run(async () => {
    const ctx = await requireCtx();
    await updateSubcontractor(await getDb(), ctx, id, input);
    return undefined;
  });
}
