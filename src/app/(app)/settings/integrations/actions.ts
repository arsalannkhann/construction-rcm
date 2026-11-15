'use server';

import { getDb } from '@/db';
import { run, type ActionResult } from '@/lib/action';
import { requireCtx } from '@/server/auth/session';
import { disconnect, importProject, listProcoreProjects, selectCompany, type ProcoreImportResult, type ProcoreProjectListing } from '@/server/integrations/procore';

export async function selectCompanyAction(companyId: string): Promise<ActionResult> {
  return run(async () => {
    const ctx = await requireCtx();
    await selectCompany(await getDb(), ctx, companyId);
    return undefined;
  });
}

export async function listProcoreProjectsAction(): Promise<ActionResult<ProcoreProjectListing[]>> {
  return run(async () => {
    const ctx = await requireCtx();
    return listProcoreProjects(await getDb(), ctx);
  });
}

export async function importProjectAction(procoreProjectId: string): Promise<ActionResult<ProcoreImportResult>> {
  return run(async () => {
    const ctx = await requireCtx();
    return importProject(await getDb(), ctx, procoreProjectId);
  });
}

export async function disconnectAction(): Promise<ActionResult> {
  return run(async () => {
    const ctx = await requireCtx();
    await disconnect(await getDb(), ctx);
    return undefined;
  });
}
