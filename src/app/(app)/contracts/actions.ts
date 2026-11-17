'use server';

import { getDb } from '@/db';
import { run, type ActionResult } from '@/lib/action';
import { UserError } from '@/server/auth/permissions';
import { requireCtx } from '@/server/auth/session';
import {
  createChangeOrder,
  createContract,
  createRetainageRelease,
  voidRetainageRelease,
  parseScheduleText,
  saveSchedule,
  updateChangeOrder,
  updateContract,
  type ChangeOrderInput,
  type ContractInput,
  type ContractPatch,
  type RetainageReleaseInput,
  type ScheduleLineInput,
} from '@/server/services/records';
import { createPortalLink, emailPortalLink, revokePortalLink, updatePortalLink } from '@/server/services/portal';

export async function createContractAction(input: ContractInput): Promise<ActionResult<{ id: string }>> {
  return run(async () => {
    const ctx = await requireCtx();
    return { id: await createContract(await getDb(), ctx, input) };
  });
}

export async function updateContractAction(id: string, patch: ContractPatch): Promise<ActionResult> {
  return run(async () => {
    const ctx = await requireCtx();
    await updateContract(await getDb(), ctx, id, patch);
    return undefined;
  });
}

/** Replace the contract's own schedule lines. Lines that come from change orders are not part of this. */
export async function saveScheduleAction(contractId: string, lines: ScheduleLineInput[]): Promise<ActionResult> {
  return run(async () => {
    const ctx = await requireCtx();
    await saveSchedule(await getDb(), ctx, contractId, lines);
    return undefined;
  });
}

/** Read rows pasted from a spreadsheet. Nothing is saved; the rows go back to the editor. */
export async function parseScheduleAction(text: string): Promise<ActionResult<{ lines: Array<{ itemNo: string; description: string; scheduledValue: number }>; problems: string[] }>> {
  return run(async () => {
    await requireCtx();
    if (typeof text !== 'string' || text.length > 500_000) throw new UserError('That is too much text to read at once. Paste only the schedule rows.');
    const { lines, problems } = parseScheduleText(text);
    return { lines: lines.map((l) => ({ itemNo: l.itemNo, description: l.description, scheduledValue: l.scheduledValue })), problems };
  });
}

export async function createChangeOrderAction(contractId: string, input: ChangeOrderInput): Promise<ActionResult<{ id: string }>> {
  return run(async () => {
    const ctx = await requireCtx();
    return { id: await createChangeOrder(await getDb(), ctx, contractId, input) };
  });
}

export async function updateChangeOrderAction(id: string, input: ChangeOrderInput): Promise<ActionResult> {
  return run(async () => {
    const ctx = await requireCtx();
    await updateChangeOrder(await getDb(), ctx, id, input);
    return undefined;
  });
}

/** Record that part of the retainage held on a contract is to be paid out. Approvers only. */
export async function createRetainageReleaseAction(contractId: string, input: RetainageReleaseInput): Promise<ActionResult<{ id: string }>> {
  return run(async () => {
    const ctx = await requireCtx();
    return { id: await createRetainageRelease(await getDb(), ctx, contractId, { amount: Number(input.amount), effectiveOn: String(input.effectiveOn ?? ''), note: String(input.note ?? '') }) };
  });
}

export async function voidRetainageReleaseAction(releaseId: string, reason: string): Promise<ActionResult> {
  return run(async () => {
    const ctx = await requireCtx();
    await voidRetainageRelease(await getDb(), ctx, releaseId, String(reason ?? ''));
    return undefined;
  });
}

// ── Subcontractor portal ────────────────────────────────────────────────────

export async function createPortalLinkAction(contractId: string, email: string): Promise<ActionResult<{ url: string }>> {
  return run(async () => {
    const ctx = await requireCtx();
    const { url } = await createPortalLink(await getDb(), ctx, contractId, { email });
    return { url };
  });
}

export async function updatePortalLinkAction(linkId: string, patch: { email?: string; reminders?: boolean }): Promise<ActionResult> {
  return run(async () => {
    const ctx = await requireCtx();
    await updatePortalLink(await getDb(), ctx, linkId, patch);
    return undefined;
  });
}

export async function revokePortalLinkAction(linkId: string): Promise<ActionResult> {
  return run(async () => {
    const ctx = await requireCtx();
    await revokePortalLink(await getDb(), ctx, linkId);
    return undefined;
  });
}

export async function emailPortalLinkAction(linkId: string): Promise<ActionResult<{ status: string; detail: string | null }>> {
  return run(async () => {
    const ctx = await requireCtx();
    return emailPortalLink(await getDb(), ctx, linkId);
  });
}
