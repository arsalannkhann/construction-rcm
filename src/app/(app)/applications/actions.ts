'use server';

import { getDb } from '@/db';
import { run, type ActionResult } from '@/lib/action';
import { requireCtx } from '@/server/auth/session';
import { createBatchExport, createExport, type ExportKind } from '@/server/services/exports';
import { removeDocument, retryProcessing } from '@/server/services/intake';
import * as review from '@/server/services/review';
import type { Tri, WaiverType } from '@/server/types';

const act = <T,>(fn: (db: Awaited<ReturnType<typeof getDb>>, ctx: Awaited<ReturnType<typeof requireCtx>>) => Promise<T>): Promise<ActionResult<T>> =>
  run(async () => fn(await getDb(), await requireCtx()));
const done = async (p: Promise<unknown>) => {
  await p;
  return undefined;
};

export const updateHeaderAction = async (appId: string, patch: review.HeaderPatch) => act((db, ctx) => done(review.updateHeader(db, ctx, appId, patch)));
export const confirmSignatureAction = async (appId: string, confirmed: boolean) => act((db, ctx) => done(review.confirmSignature(db, ctx, appId, confirmed)));

export const updateLineAction = async (lineId: string, patch: review.LinePatch, kind: review.EditKind, note: string | null) => act((db, ctx) => done(review.updateLine(db, ctx, lineId, patch, kind, note)));
export const addLineAction = async (appId: string, values: review.LinePatch) => act((db, ctx) => done(review.addLine(db, ctx, appId, values)));
export const deleteLineAction = async (lineId: string) => act((db, ctx) => done(review.deleteLine(db, ctx, lineId)));
export const setLineMatchAction = async (lineId: string, sovLineId: string | null) => act((db, ctx) => done(review.setLineMatch(db, ctx, lineId, sovLineId)));

export const updateWaiverAction = async (waiverId: string, patch: review.WaiverPatch) => act((db, ctx) => done(review.updateWaiver(db, ctx, waiverId, patch)));
export const addWaiverAction = async (appId: string, documentId: string, values: { waiverType: WaiverType; claimant: string | null; throughDate: string | null; amount: number | null; signed: Tri | null }) =>
  act((db, ctx) => done(review.addWaiver(db, ctx, appId, documentId, values)));

export const acceptFindingAction = async (findingId: string, note: string) => act((db, ctx) => done(review.acceptFinding(db, ctx, findingId, note)));
export const reopenFindingAction = async (findingId: string) => act((db, ctx) => done(review.reopenFinding(db, ctx, findingId)));

export const assignContractAction = async (appId: string, contractId: string) => act((db, ctx) => done(review.assignContract(db, ctx, appId, contractId)));
export const setOpeningBalancesAction = async (appId: string) => act((db, ctx) => done(review.setOpeningBalances(db, ctx, appId)));
export const adoptScheduleAction = async (appId: string) => act((db, ctx) => done(review.adoptSchedule(db, ctx, appId)));

export const assignReviewerAction = async (appId: string, userId: string | null) => act((db, ctx) => done(review.assignReviewer(db, ctx, appId, userId)));
export const submitForApprovalAction = async (appId: string, note: string | null) => act((db, ctx) => done(review.submitForApproval(db, ctx, appId, note)));
export const approveAction = async (appId: string, input: { note: string | null; acknowledgeWarnings: boolean }) => act((db, ctx) => done(review.approveApplication(db, ctx, appId, input)));
export const rejectAction = async (appId: string, reason: string) => act((db, ctx) => done(review.rejectApplication(db, ctx, appId, reason)));
export const voidAction = async (appId: string, reason: string) => act((db, ctx) => done(review.voidApplication(db, ctx, appId, reason)));
export const reopenAction = async (appId: string, reason: string) => act((db, ctx) => done(review.reopenApplication(db, ctx, appId, reason)));
export const resumeReviewAction = async (appId: string) => act((db, ctx) => done(review.resumeReview(db, ctx, appId)));

export const draftCorrectionAction = async (appId: string) => act((db, ctx) => review.draftCorrectionRequest(db, ctx, appId));
export const sendMessageAction = async (appId: string, input: { to: string; subject: string; body: string; hold: boolean }) => act((db, ctx) => review.sendSubcontractorMessage(db, ctx, appId, input));
export const addCommentAction = async (appId: string, body: string) => act((db, ctx) => done(review.addComment(db, ctx, appId, body)));

export const retryProcessingAction = async (appId: string) => act((db, ctx) => done(retryProcessing(db, ctx, appId)));
export const removeDocumentAction = async (documentId: string) => act((db, ctx) => done(removeDocument(db, ctx, documentId)));

export const exportAction = async (appId: string, kind: ExportKind) => act((db, ctx) => createExport(db, ctx, appId, kind));
export const batchExportAction = async (appIds: string[]) => act((db, ctx) => createBatchExport(db, ctx, appIds));
