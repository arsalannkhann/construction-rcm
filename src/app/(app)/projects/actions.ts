'use server';

import { getDb } from '@/db';
import { run, type ActionResult } from '@/lib/action';
import { requireCtx } from '@/server/auth/session';
import { createProject, updateProject, type ProjectInput } from '@/server/services/records';

export async function createProjectAction(input: ProjectInput): Promise<ActionResult<{ id: string }>> {
  return run(async () => {
    const ctx = await requireCtx();
    return { id: await createProject(await getDb(), ctx, input) };
  });
}

export async function updateProjectAction(id: string, input: ProjectInput & { status?: 'active' | 'closed' }): Promise<ActionResult> {
  return run(async () => {
    const ctx = await requireCtx();
    await updateProject(await getDb(), ctx, id, input);
    return undefined;
  });
}
