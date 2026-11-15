/**
 * Read models for pages. Everything here is scoped to ctx.orgId; nothing
 * returns a row from another organisation.
 */
import { and, asc, desc, eq, inArray, ne, or, sql } from 'drizzle-orm';
import type { DB } from '@/db';
import {
  auditEvents,
  changeOrders,
  comments,
  communications,
  contracts,
  documents,
  findings,
  lienWaivers,
  memberships,
  payAppLines,
  payApplications,
  projects,
  sovLines,
  subcontractors,
  transfers,
  users,
} from '@/db/schema';
import { UserError, type Ctx } from '@/server/auth/permissions';
import type { AppStatus } from '@/server/types';
import { APP_STATUSES } from '@/server/types';
import { computeReconciliation } from './reconcile';

// ── Applications ────────────────────────────────────────────────────────────

export async function queueCounts(db: DB, ctx: Ctx): Promise<Record<AppStatus, number>> {
  const rows = await db
    .select({ status: payApplications.status, n: sql<number>`count(*)::int` })
    .from(payApplications)
    .where(eq(payApplications.orgId, ctx.orgId))
    .groupBy(payApplications.status);
  const out = Object.fromEntries(APP_STATUSES.map((s) => [s, 0])) as Record<AppStatus, number>;
  for (const r of rows) if (r.status in out) out[r.status as AppStatus] = r.n;
  return out;
}

const applicationColumns = {
  id: payApplications.id,
  status: payApplications.status,
  applicationNumber: payApplications.applicationNumber,
  periodTo: payApplications.periodTo,
  receivedAt: payApplications.receivedAt,
  receivedVia: payApplications.receivedVia,
  claimedAmount: payApplications.claimedAmount,
  verifiedAmount: payApplications.verifiedAmount,
  approvedAmount: payApplications.approvedAmount,
  openBlocking: payApplications.openBlocking,
  openWarnings: payApplications.openWarnings,
  decidedAt: payApplications.decidedAt,
  holdSince: payApplications.holdSince,
  transferStatus: payApplications.transferStatus,
  processingError: payApplications.processingError,
  assigneeId: payApplications.assigneeId,
  assigneeName: users.name,
  stated: payApplications.stated,
  projectId: projects.id,
  projectName: projects.name,
  subcontractorId: subcontractors.id,
  subcontractorName: subcontractors.name,
  contractId: contracts.id,
  contractNumber: contracts.number,
};

export type ApplicationRow = Awaited<ReturnType<typeof listApplications>>[number];

export async function listApplications(
  db: DB,
  ctx: Ctx,
  filter: { statuses?: AppStatus[]; projectId?: string; contractId?: string; subcontractorId?: string; assigneeId?: string; limit?: number } = {},
) {
  const where = [eq(payApplications.orgId, ctx.orgId)];
  if (filter.statuses?.length) where.push(inArray(payApplications.status, filter.statuses));
  if (filter.projectId) where.push(eq(payApplications.projectId, filter.projectId));
  if (filter.contractId) where.push(eq(payApplications.contractId, filter.contractId));
  if (filter.subcontractorId) where.push(eq(payApplications.subcontractorId, filter.subcontractorId));
  if (filter.assigneeId) where.push(eq(payApplications.assigneeId, filter.assigneeId));
  return db
    .select(applicationColumns)
    .from(payApplications)
    .leftJoin(projects, eq(projects.id, payApplications.projectId))
    .leftJoin(subcontractors, eq(subcontractors.id, payApplications.subcontractorId))
    .leftJoin(contracts, eq(contracts.id, payApplications.contractId))
    .leftJoin(users, eq(users.id, payApplications.assigneeId))
    .where(and(...where))
    .orderBy(desc(payApplications.receivedAt))
    .limit(filter.limit ?? 500);
}

/** Lightweight status for the processing screen to poll. */
export async function applicationStatus(db: DB, ctx: Ctx, id: string) {
  const [row] = await db
    .select({ status: payApplications.status, processingError: payApplications.processingError, revision: payApplications.revision, updatedAt: payApplications.updatedAt })
    .from(payApplications)
    .where(and(eq(payApplications.orgId, ctx.orgId), eq(payApplications.id, id)));
  return row ?? null;
}

/** Everything the review workspace shows for one application. */
export async function getReviewData(db: DB, ctx: Ctx, id: string) {
  const [app] = await db.select().from(payApplications).where(and(eq(payApplications.orgId, ctx.orgId), eq(payApplications.id, id)));
  if (!app) return null;

  const [contract] = app.contractId ? await db.select().from(contracts).where(eq(contracts.id, app.contractId)) : [];
  const [project] = app.projectId ? await db.select().from(projects).where(eq(projects.id, app.projectId)) : [];
  const [subcontractor] = app.subcontractorId ? await db.select().from(subcontractors).where(eq(subcontractors.id, app.subcontractorId)) : [];

  const docs = await db.select().from(documents).where(eq(documents.payApplicationId, id)).orderBy(asc(documents.createdAt), asc(documents.filename));
  const lines = await db.select().from(payAppLines).where(eq(payAppLines.payApplicationId, id)).orderBy(asc(payAppLines.sortOrder));
  const waivers = await db.select().from(lienWaivers).where(eq(lienWaivers.payApplicationId, id));
  const allFindings = await db.select().from(findings).where(eq(findings.payApplicationId, id)).orderBy(asc(findings.sortOrder));
  const sov = contract ? await db.select().from(sovLines).where(eq(sovLines.contractId, contract.id)).orderBy(asc(sovLines.sortOrder)) : [];
  const cos = contract ? await db.select().from(changeOrders).where(eq(changeOrders.contractId, contract.id)).orderBy(asc(changeOrders.number)) : [];
  const timeline = await db.select().from(auditEvents).where(and(eq(auditEvents.orgId, ctx.orgId), eq(auditEvents.payApplicationId, id))).orderBy(desc(auditEvents.seq));
  const thread = await db
    .select({ id: comments.id, body: comments.body, createdAt: comments.createdAt, userName: users.name })
    .from(comments)
    .innerJoin(users, eq(users.id, comments.userId))
    .where(eq(comments.payApplicationId, id))
    .orderBy(asc(comments.createdAt));
  const messages = await db.select().from(communications).where(eq(communications.payApplicationId, id)).orderBy(desc(communications.createdAt));
  const exports = await db
    .select({ id: transfers.id, kind: transfers.kind, status: transfers.status, filename: transfers.filename, externalRef: transfers.externalRef, error: transfers.error, createdAt: transfers.createdAt, userName: users.name })
    .from(transfers)
    .leftJoin(users, eq(users.id, transfers.createdBy))
    .where(eq(transfers.payApplicationId, id))
    .orderBy(desc(transfers.createdAt));
  const members = await db
    .select({ userId: users.id, name: users.name, role: memberships.role })
    .from(memberships)
    .innerJoin(users, eq(users.id, memberships.userId))
    .where(and(eq(memberships.orgId, ctx.orgId), eq(memberships.status, 'active')))
    .orderBy(users.name);

  const peopleIds = [...new Set([...allFindings.map((f) => f.resolvedBy), ...lines.map((l) => l.editedBy), app.decidedBy, app.signatureConfirmedBy, app.submittedForApprovalBy].filter((x): x is string => !!x))];
  const people = peopleIds.length ? await db.select({ id: users.id, name: users.name }).from(users).where(inArray(users.id, peopleIds)) : [];

  // Per-line verified figures, so the grid can show "ours" next to "theirs".
  const recon = contract && !['approved', 'rejected', 'void', 'processing'].includes(app.status) ? await computeReconciliation(db, ctx.orgId, id) : null;

  // For matching by hand.
  const candidates = !contract
    ? await db
        .select({ id: contracts.id, number: contracts.number, title: contracts.title, projectName: projects.name, subcontractorName: subcontractors.name, originalAmount: contracts.originalAmount })
        .from(contracts)
        .innerJoin(projects, eq(projects.id, contracts.projectId))
        .innerJoin(subcontractors, eq(subcontractors.id, contracts.subcontractorId))
        .where(and(eq(contracts.orgId, ctx.orgId), eq(contracts.status, 'active')))
        .orderBy(projects.name, subcontractors.name)
    : [];

  // Other submissions with this application number on this contract (a corrected resubmission, or a duplicate),
  // and any submission this one replaced or was replaced by.
  const related =
    contract && app.applicationNumber !== null
      ? await db
          .select({ id: payApplications.id, applicationNumber: payApplications.applicationNumber, status: payApplications.status, receivedAt: payApplications.receivedAt, claimedAmount: payApplications.claimedAmount, supersededById: payApplications.supersededById })
          .from(payApplications)
          .where(
            and(
              eq(payApplications.orgId, ctx.orgId),
              ne(payApplications.id, app.id),
              or(
                and(eq(payApplications.contractId, contract.id), eq(payApplications.applicationNumber, app.applicationNumber)),
                eq(payApplications.supersededById, app.id),
                app.supersededById ? eq(payApplications.id, app.supersededById) : sql`false`,
              ),
            ),
          )
          .orderBy(asc(payApplications.receivedAt))
      : [];
  const sameNumber = related.filter((r) => r.status !== 'void' && r.applicationNumber === app.applicationNumber);

  return {
    app,
    sameNumber,
    replaces: related.filter((r) => r.supersededById === app.id),
    replacedBy: related.find((r) => r.id === app.supersededById) ?? null,
    contract: contract ?? null,
    project: project ?? null,
    subcontractor: subcontractor ?? null,
    documents: docs,
    lines,
    waivers,
    findings: allFindings,
    sov,
    changeOrders: cos,
    timeline,
    comments: thread,
    messages,
    transfers: exports,
    members,
    people: Object.fromEntries(people.map((p) => [p.id, p.name])) as Record<string, string>,
    verifiedLines: recon?.lines ?? (app.approvedRecord ? app.approvedRecord.lines.map((l) => ({ ...l, lineId: null as string | null, itemNo: l.itemNo ?? '', description: l.description ?? '', sovLineId: l.sovLineId ?? '' })) : []),
    contractCandidates: candidates,
  };
}

export type ReviewData = NonNullable<Awaited<ReturnType<typeof getReviewData>>>;

export async function getDocumentForDownload(db: DB, ctx: Ctx, id: string) {
  const [doc] = await db.select().from(documents).where(and(eq(documents.orgId, ctx.orgId), eq(documents.id, id)));
  if (!doc) throw new UserError('Document not found.');
  return doc;
}

/** Active subcontracts for pickers, grouped by project. */
export async function listContractOptions(db: DB, ctx: Ctx): Promise<Array<{ id: string; label: string; group: string }>> {
  const rows = await db
    .select({ id: contracts.id, number: contracts.number, title: contracts.title, projectName: projects.name, subcontractorName: subcontractors.name })
    .from(contracts)
    .innerJoin(projects, eq(projects.id, contracts.projectId))
    .innerJoin(subcontractors, eq(subcontractors.id, contracts.subcontractorId))
    .where(and(eq(contracts.orgId, ctx.orgId), eq(contracts.status, 'active')))
    .orderBy(projects.name, subcontractors.name);
  return rows.map((r) => ({ id: r.id, label: `${r.subcontractorName} · ${r.number} ${r.title}`, group: r.projectName }));
}
