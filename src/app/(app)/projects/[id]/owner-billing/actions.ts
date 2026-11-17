'use server';

import { getDb } from '@/db';
import { run, type ActionResult } from '@/lib/action';
import { requireCtx } from '@/server/auth/session';
import {
  certifyOwnerApplication,
  createPrimeChangeOrder,
  deleteOwnerDraft,
  reopenOwnerApplication,
  savePrimeContract,
  savePrimeSchedule,
  saveOwnerEntries,
  startOwnerApplication,
  submitOwnerApplication,
  updatePrimeChangeOrder,
  type CertificationInput,
  type OwnerEntryChange,
  type PrimeChangeOrderInput,
  type PrimeContractInput,
  type PrimeLineSave,
} from '@/server/services/owner-billing';

export async function savePrimeContractAction(projectId: string, input: PrimeContractInput): Promise<ActionResult<{ id: string }>> {
  return run(async () => {
    const ctx = await requireCtx();
    return { id: await savePrimeContract(await getDb(), ctx, projectId, input) };
  });
}

export async function savePrimeScheduleAction(projectId: string, lines: PrimeLineSave[]): Promise<ActionResult> {
  return run(async () => {
    const ctx = await requireCtx();
    await savePrimeSchedule(await getDb(), ctx, projectId, lines);
    return undefined;
  });
}

export async function createPrimeChangeOrderAction(projectId: string, input: PrimeChangeOrderInput): Promise<ActionResult<{ id: string }>> {
  return run(async () => {
    const ctx = await requireCtx();
    return { id: await createPrimeChangeOrder(await getDb(), ctx, projectId, input) };
  });
}

export async function updatePrimeChangeOrderAction(changeOrderId: string, input: PrimeChangeOrderInput): Promise<ActionResult> {
  return run(async () => {
    const ctx = await requireCtx();
    await updatePrimeChangeOrder(await getDb(), ctx, changeOrderId, input);
    return undefined;
  });
}

export async function startOwnerApplicationAction(projectId: string, periodTo: string): Promise<ActionResult<{ id: string }>> {
  return run(async () => {
    const ctx = await requireCtx();
    return { id: await startOwnerApplication(await getDb(), ctx, projectId, String(periodTo ?? '')) };
  });
}

export async function saveOwnerEntriesAction(appId: string, version: number, changes: OwnerEntryChange[]): Promise<ActionResult> {
  return run(async () => {
    const ctx = await requireCtx();
    await saveOwnerEntries(await getDb(), ctx, appId, Number(version), changes);
    return undefined;
  });
}

export async function submitOwnerApplicationAction(appId: string, fingerprint: string): Promise<ActionResult> {
  return run(async () => {
    const ctx = await requireCtx();
    await submitOwnerApplication(await getDb(), ctx, appId, String(fingerprint ?? ''));
    return undefined;
  });
}

export async function reopenOwnerApplicationAction(appId: string, reason: string): Promise<ActionResult> {
  return run(async () => {
    const ctx = await requireCtx();
    await reopenOwnerApplication(await getDb(), ctx, appId, String(reason ?? ''));
    return undefined;
  });
}

export async function deleteOwnerDraftAction(appId: string): Promise<ActionResult> {
  return run(async () => {
    const ctx = await requireCtx();
    await deleteOwnerDraft(await getDb(), ctx, appId);
    return undefined;
  });
}

export async function certifyOwnerApplicationAction(appId: string, input: CertificationInput): Promise<ActionResult> {
  return run(async () => {
    const ctx = await requireCtx();
    await certifyOwnerApplication(await getDb(), ctx, appId, { amount: Number(input.amount), certifiedOn: String(input.certifiedOn ?? ''), note: input.note ? String(input.note) : null });
    return undefined;
  });
}
