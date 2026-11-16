/**
 * What the Zephric mobile app reads and does.
 *
 * Thin shapes over the services the website uses, with the same organisation
 * scoping, the same permissions and the same approval rules. Nothing here
 * computes a financial figure: every amount is a stored result of the
 * reconciliation engine (src/server/services/reconcile.ts), in cents, and the
 * app only formats it.
 *
 * The phone is for capture, triage and the simple decisions. Anything that
 * needs judgement (a blocking finding, a warning to acknowledge, a line to
 * correct) is handed to the desktop, where the whole application can be seen.
 */
import { and, eq } from 'drizzle-orm';
import { PDFDocument } from 'pdf-lib';
import { z } from 'zod';
import type { DB } from '@/db';
import { payApplications } from '@/db/schema';
import { assertCan, can, ROLE_LABEL, UserError, type Ctx } from '@/server/auth/permissions';
import { APP_STATUS_LABEL, OPEN_STATUSES, type AppStatus, type Role, type StatedParties } from '@/server/types';
import { CLIENT_REF, createApplication, findByClientRef, MAX_FILE_BYTES, MAX_FILES, sniffMime, type IncomingFile } from './intake';
import { listNotifications, unreadCount } from './notify';
import { getReviewData, listApplications, listContractOptions, queueCounts, type ApplicationRow } from './queries';
import { getProjectDetail, listProjects } from './records-queries';
import { approveApplication } from './review';
import { listMyOrganizations, type SessionInfo } from './team';
import { discardStaged, readStaged, stagedSchema } from './uploads';

// ── Who is signed in ────────────────────────────────────────────────────────

export type MobilePermissions = { upload: boolean; review: boolean; approve: boolean };

export function mobilePermissions(role: Role): MobilePermissions {
  return { upload: can(role, 'application:upload'), review: can(role, 'application:review'), approve: can(role, 'application:approve') };
}

export async function mobileMe(db: DB, session: SessionInfo) {
  const organizations = await listMyOrganizations(db, session.user.id);
  const ctx = session.ctx;
  return {
    user: { id: session.user.id, name: session.user.name, email: session.user.email, mfaEnabled: session.user.mfaEnabled },
    organization: ctx ? { id: ctx.orgId, name: ctx.orgName, isDemo: ctx.isDemo, role: ctx.role, roleLabel: ROLE_LABEL[ctx.role] } : null,
    permissions: ctx ? mobilePermissions(ctx.role) : { upload: false, review: false, approve: false },
    organizations: organizations.map((o) => ({ id: o.id, name: o.name, isDemo: o.isDemo, role: o.role, roleLabel: ROLE_LABEL[o.role as Role] ?? o.role, requiresMfa: o.requiresMfa })),
  };
}

// ── Applications ────────────────────────────────────────────────────────────

/** One application in a list. Amounts in cents, as stored. */
export function mobileRow(a: ApplicationRow) {
  const stated = a.stated as StatedParties | null;
  return {
    id: a.id,
    status: a.status as AppStatus,
    statusLabel: APP_STATUS_LABEL[a.status as AppStatus] ?? a.status,
    number: a.applicationNumber,
    periodTo: a.periodTo,
    receivedAt: a.receivedAt,
    receivedVia: a.receivedVia,
    project: a.projectName ?? stated?.projectName ?? null,
    subcontractor: a.subcontractorName ?? stated?.contractorName ?? null,
    contractNumber: a.contractNumber,
    claimed: a.claimedAmount,
    verified: a.verifiedAmount,
    approved: a.approvedAmount,
    openBlocking: a.openBlocking,
    openWarnings: a.openWarnings,
    failed: !!a.processingError,
  };
}
export type MobileRow = ReturnType<typeof mobileRow>;

export const MOBILE_VIEWS = ['attention', 'open', 'decided', 'mine', 'all'] as const;
export type MobileView = (typeof MOBILE_VIEWS)[number];

/** The statuses that ask something of this person, most urgent first. */
function attentionStatuses(ctx: Ctx): AppStatus[] {
  const p = mobilePermissions(ctx.role);
  return [...(p.approve ? (['pending_approval'] as const) : []), ...(p.review ? (['needs_matching', 'needs_review'] as const) : [])];
}

function byUrgency(order: AppStatus[]) {
  return (a: MobileRow, b: MobileRow) => order.indexOf(a.status) - order.indexOf(b.status) || +new Date(a.receivedAt) - +new Date(b.receivedAt);
}

export async function mobileApplications(db: DB, ctx: Ctx, view: MobileView) {
  switch (view) {
    case 'attention': {
      const order = attentionStatuses(ctx);
      if (order.length === 0) return [];
      return (await listApplications(db, ctx, { statuses: order, limit: 100 })).map(mobileRow).sort(byUrgency(order));
    }
    case 'open':
      return (await listApplications(db, ctx, { statuses: ['processing', ...OPEN_STATUSES], limit: 100 })).map(mobileRow);
    case 'decided':
      return (await listApplications(db, ctx, { statuses: ['approved', 'rejected'], limit: 50 })).map(mobileRow);
    case 'mine':
      return (await listApplications(db, ctx, { submittedBy: ctx.userId, limit: 50 })).map(mobileRow);
    case 'all':
      return (await listApplications(db, ctx, { limit: 100 })).map(mobileRow);
  }
}

/** The home screen: what needs this person, what they sent recently, and the counts behind both. */
export async function mobileHome(db: DB, ctx: Ctx) {
  const p = mobilePermissions(ctx.role);
  const [counts, unread, attention, mine] = await Promise.all([
    queueCounts(db, ctx),
    unreadCount(db, ctx),
    mobileApplications(db, ctx, 'attention'),
    p.upload ? listApplications(db, ctx, { submittedBy: ctx.userId, limit: 5 }) : Promise.resolve([]),
  ]);
  return {
    counts: {
      pendingApproval: counts.pending_approval,
      needsReview: counts.needs_review + counts.needs_matching,
      onHold: counts.on_hold,
      processing: counts.processing,
    },
    unread,
    attention: attention.slice(0, 8),
    attentionTotal: attention.length,
    recentSubmissions: mine.map(mobileRow),
    permissions: p,
  };
}

// ── One application ─────────────────────────────────────────────────────────

/** Raised when a decision cannot be made on the phone. The app opens the desktop review instead. */
export class DesktopRequired extends UserError {
  constructor(message: string) {
    super(message);
    this.name = 'DesktopRequired';
  }
}

type GateInput = { status: string; openBlocking: number; openWarnings: number; verifiedAmount: number | null };

/**
 * Whether this person may approve this application from the phone.
 *
 * Only the simplest case: submitted for approval, nothing open, a verified
 * amount to approve. The server checks again, against freshly reconciled
 * figures, when the approval is sent (approveApplication).
 */
export function mobileApprovalGate(ctx: Ctx, app: GateInput): { allowed: true } | { allowed: false; reason: string } {
  if (!can(ctx.role, 'application:approve')) return { allowed: false, reason: 'Your role cannot approve applications.' };
  if (app.status === 'approved' || app.status === 'rejected' || app.status === 'void') return { allowed: false, reason: 'This application has already been decided.' };
  if (app.status !== 'pending_approval') return { allowed: false, reason: 'This application has not been submitted for approval. Finish the review on the desktop.' };
  if (app.openBlocking > 0) return { allowed: false, reason: `${app.openBlocking} blocking finding${app.openBlocking === 1 ? ' needs' : 's need'} a decision with a written reason. Decide on the desktop, where every figure can be checked.` };
  if (app.openWarnings > 0) return { allowed: false, reason: `${app.openWarnings} warning${app.openWarnings === 1 ? '' : 's'} must be acknowledged on the desktop before approval.` };
  if (app.verifiedAmount === null) return { allowed: false, reason: 'There is no verified amount to approve yet.' };
  return { allowed: true };
}

export async function mobileApplicationDetail(db: DB, ctx: Ctx, id: string) {
  const r = await getReviewData(db, ctx, id);
  if (!r) return null;
  const { app } = r;
  const person = (userId: string | null) => (userId ? (r.people[userId] ?? null) : null);
  const gate = mobileApprovalGate(ctx, app);
  const p = mobilePermissions(ctx.role);
  const passed = r.findings.filter((f) => f.status === 'passed').length;

  return {
    id: app.id,
    version: app.version,
    status: app.status as AppStatus,
    statusLabel: APP_STATUS_LABEL[app.status as AppStatus] ?? app.status,
    number: app.applicationNumber,
    periodTo: app.periodTo,
    receivedAt: app.receivedAt,
    receivedVia: app.receivedVia,
    processingError: app.processingError,
    project: r.project ? { id: r.project.id, name: r.project.name } : app.stated?.projectName ? { id: null, name: app.stated.projectName } : null,
    subcontractor: r.subcontractor?.name ?? app.stated?.contractorName ?? null,
    contract: r.contract ? { id: r.contract.id, number: r.contract.number, title: r.contract.title } : null,
    /** As submitted, as verified by the engine, and as approved. Cents; null when not known. */
    amounts: {
      claimed: app.claimed.currentPaymentDue ?? app.claimedAmount,
      verified: app.verifiedAmount,
      approved: app.approvedAmount,
      contractSumToDate: app.verified?.contractSumToDate ?? app.claimed.contractSumToDate,
      retainage: app.verified?.retainageTotal ?? app.claimed.retainageTotal,
      balanceToFinish: app.verified?.balanceToFinish ?? app.claimed.balanceToFinish,
    },
    findings: {
      open: r.findings
        .filter((f) => f.status === 'open')
        .map((f) => ({ id: f.id, severity: f.severity, category: f.category, title: f.title, detail: f.detail, action: f.action, needsQualifiedReview: f.needsQualifiedReview })),
      accepted: r.findings
        .filter((f) => f.status === 'accepted')
        .map((f) => ({ id: f.id, severity: f.severity, title: f.title, note: f.resolutionNote, by: person(f.resolvedBy), at: f.resolvedAt })),
      passed,
    },
    documents: r.documents.map((d) => ({ id: d.id, filename: d.filename, mimeType: d.mimeType, size: d.size, pageCount: d.pageCount, status: d.status })),
    comments: r.comments.map((c) => ({ id: c.id, body: c.body, at: c.createdAt, by: c.userName })),
    messages: r.messages.slice(0, 10).map((m) => ({ id: m.id, kind: m.kind, to: m.toEmail, subject: m.subject, status: m.status, at: m.createdAt })),
    timeline: r.timeline.slice(0, 40).map((e) => ({ id: e.id, action: e.action, summary: e.summary, by: e.actorName, at: e.createdAt })),
    assignee: person(app.assigneeId) ?? r.members.find((m) => m.userId === app.assigneeId)?.name ?? null,
    decision: app.decidedAt ? { at: app.decidedAt, by: person(app.decidedBy), note: app.decisionNote } : null,
    can: {
      comment: ctx.role !== 'viewer',
      requestInfo: p.review && app.status !== 'processing' && app.status !== 'void',
      approve: gate.allowed,
    },
    /** Why the phone will not approve this one, when the person could approve on the desktop. */
    desktopReason: !gate.allowed && p.approve && app.status !== 'approved' && app.status !== 'rejected' && app.status !== 'void' ? gate.reason : null,
  };
}

export const approveSchema = z.object({
  expectedVersion: z.number().int().nonnegative(),
  expectedAmount: z.number().int(),
});

/** Approve from the phone: only past the gate, at the version and amount the person was shown. */
export async function approveFromPhone(db: DB, ctx: Ctx, id: string, input: z.infer<typeof approveSchema>) {
  assertCan(ctx, 'application:approve');
  const [app] = await db
    .select({ status: payApplications.status, openBlocking: payApplications.openBlocking, openWarnings: payApplications.openWarnings, verifiedAmount: payApplications.verifiedAmount })
    .from(payApplications)
    .where(and(eq(payApplications.orgId, ctx.orgId), eq(payApplications.id, id)));
  if (!app) throw new UserError('Application not found.');
  const gate = mobileApprovalGate(ctx, app);
  if (!gate.allowed) throw new DesktopRequired(gate.reason);
  // approveApplication re-reconciles and refuses on any open blocking finding or unacknowledged warning, or a changed amount.
  const record = await approveApplication(db, ctx, id, {
    note: 'Approved in the Zephric mobile app.',
    acknowledgeWarnings: false,
    expectedVersion: input.expectedVersion,
    expectedAmount: input.expectedAmount,
  });
  return { approvedAmount: record.approved.currentPaymentDue, approvedAt: record.approvedAt };
}

// ── Capture ─────────────────────────────────────────────────────────────────

export const submitSchema = z.object({
  clientRef: z.string().regex(CLIENT_REF),
  contractId: z.string().trim().min(1).max(64).nullable().optional(),
  staged: z.array(stagedSchema).min(1).max(MAX_FILES),
  /** Join the photos into one PDF, in the order sent: the pages of one paper document. */
  combinePhotos: z.boolean().optional().default(true),
  photosName: z.string().trim().max(120).optional(),
});
export type SubmitInput = z.input<typeof submitSchema>;

function pdfName(name: string | undefined): string {
  const base = (name ?? '').replace(/[\\/:*?"<>|\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim().replace(/\.pdf$/i, '');
  return `${base || 'Phone capture'}.pdf`;
}

/**
 * The photos (JPEG or PNG, by their bytes) joined into one PDF, a page each,
 * ahead of the other files. The photos themselves are not altered. Left as
 * they are when there are fewer than two, or the PDF would be over the size limit.
 */
export async function combinePhotos(files: IncomingFile[], name?: string): Promise<IncomingFile[]> {
  const photos = files.filter((f) => ['image/jpeg', 'image/png'].includes(sniffMime(f)));
  if (photos.length < 2) return files;
  const pdf = await PDFDocument.create();
  for (const photo of photos) {
    const image = sniffMime(photo) === 'image/png' ? await pdf.embedPng(photo.bytes) : await pdf.embedJpg(photo.bytes);
    // A Letter-width page in the photo's own proportions.
    const scale = 612 / image.width;
    const page = pdf.addPage([612, Math.round(image.height * scale)]);
    page.drawImage(image, { x: 0, y: 0, width: 612, height: image.height * scale });
  }
  pdf.setTitle(pdfName(name).replace(/\.pdf$/, ''));
  pdf.setProducer('Zephric mobile capture');
  const bytes = await pdf.save();
  if (bytes.byteLength > MAX_FILE_BYTES) return files;
  return [{ filename: pdfName(name), mimeType: 'application/pdf', bytes }, ...files.filter((f) => !photos.includes(f))];
}

/**
 * Create an application from files the phone staged in parts beforehand
 * (src/server/services/uploads.ts). Sending the same draft again, after a
 * dropped connection, returns the application the first attempt created.
 */
export async function submitFromPhone(db: DB, ctx: Ctx, input: z.output<typeof submitSchema>): Promise<{ id: string; duplicate: boolean }> {
  assertCan(ctx, 'application:upload');
  if (new Set(input.staged.map((f) => f.uploadId)).size !== input.staged.length) throw new UserError('The same file was named twice. Try again.');
  const existing = await findByClientRef(db, ctx.orgId, ctx.userId, input.clientRef);
  if (existing) return { id: existing, duplicate: true };

  let files: IncomingFile[];
  try {
    files = await readStaged(db, ctx, input.staged);
  } catch (err) {
    // An earlier attempt may have finished, and cleared the parts, while this one was on its way.
    const created = await findByClientRef(db, ctx.orgId, ctx.userId, input.clientRef);
    if (created) return { id: created, duplicate: true };
    throw err;
  }
  if (input.combinePhotos) files = await combinePhotos(files, input.photosName);
  const { id, duplicate } = await createApplication(db, ctx, { files, contractId: input.contractId ?? null, clientRef: input.clientRef });
  await discardStaged(db, ctx, input.staged.map((f) => f.uploadId));
  return { id, duplicate: !!duplicate };
}

/** Subcontracts to file a capture against, grouped by project. */
export async function mobileContracts(db: DB, ctx: Ctx) {
  return listContractOptions(db, ctx);
}

// ── Projects ────────────────────────────────────────────────────────────────

export async function mobileProjects(db: DB, ctx: Ctx) {
  return (await listProjects(db, ctx)).map((p) => ({
    id: p.id,
    name: p.name,
    number: p.number,
    city: p.city,
    state: p.state,
    status: p.status,
    contracts: p.contracts,
    committed: p.committed,
    approvedToDate: p.approvedToDate,
    inReview: p.inReview,
  }));
}

export async function mobileProject(db: DB, ctx: Ctx, id: string) {
  const d = await getProjectDetail(db, ctx, id);
  if (!d) return null;
  return {
    project: { id: d.project.id, name: d.project.name, number: d.project.number, city: d.project.city, state: d.project.state, status: d.project.status },
    totals: d.totals,
    contracts: d.contracts.map((c) => ({
      id: c.id,
      number: c.number,
      title: c.title,
      status: c.status,
      subcontractor: c.subcontractorName,
      contractSum: c.contractSum,
      approvedToDate: c.approvedToDate,
      retainageHeld: c.retainageHeld,
      balanceToFinish: c.balanceToFinish,
      latestApplication: c.latestApplication ? { ...c.latestApplication, statusLabel: APP_STATUS_LABEL[c.latestApplication.status as AppStatus] ?? c.latestApplication.status } : null,
    })),
    applications: d.applications.map((a) => ({
      id: a.id,
      status: a.status,
      statusLabel: APP_STATUS_LABEL[a.status as AppStatus] ?? a.status,
      number: a.applicationNumber,
      periodTo: a.periodTo,
      receivedAt: a.receivedAt,
      claimed: a.claimedAmount,
      approved: a.approvedAmount,
      subcontractor: a.subcontractorName,
      contractNumber: a.contractNumber,
    })),
  };
}

// ── Activity ────────────────────────────────────────────────────────────────

/** This person's notifications. An application link becomes its id, so the app can open it. */
export async function mobileNotifications(db: DB, ctx: Ctx) {
  const [rows, unread] = await Promise.all([listNotifications(db, ctx, 50), unreadCount(db, ctx)]);
  return {
    unread,
    items: rows.map((n) => ({
      id: n.id,
      type: n.type,
      title: n.title,
      body: n.body,
      at: n.createdAt,
      read: !!n.readAt,
      applicationId: n.href?.match(/^\/applications\/([A-Za-z0-9_-]+)$/)?.[1] ?? null,
    })),
  };
}
