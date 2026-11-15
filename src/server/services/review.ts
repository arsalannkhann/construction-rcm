/**
 * Review and decisions on a pay application.
 *
 * Every mutation here: checks permission, checks the application is still
 * open, writes an audit event describing exactly what changed, and re-runs
 * reconciliation so findings always reflect the current figures.
 */
import { and, asc, eq, inArray, ne } from 'drizzle-orm';
import { formatMoney } from '@/lib/money';
import { formatDate } from '@/lib/utils';
import type { DB } from '@/db';
import { locked } from '@/db/tx';
import {
  changeOrders,
  comments,
  communications,
  contracts,
  documents,
  findings,
  lienWaivers,
  memberships,
  organizations,
  payAppLines,
  payApplications,
  projects,
  sovLines,
  subcontractors,
  users,
  nextVersion,
} from '@/db/schema';
import { recordAudit } from '@/server/audit';
import { assertCan, can, PermissionError, UserError, type Ctx } from '@/server/auth/permissions';
import { sendEmail } from '@/server/email';
import { newId } from '@/server/ids';
import { mapLinesToSov } from '@/server/recon/matching';
import type { ApprovedRecord, ClaimedField, ContractBaseline, LineAmountField, Tri, WaiverType } from '@/server/types';
import { CLAIMED_FIELD_LABEL, CLAIMED_FIELDS, LINE_AMOUNT_FIELDS, OPEN_STATUSES, WAIVER_TYPES } from '@/server/types';
import { notifyPermission, notifyUsers } from './notify';
import { computeReconciliation, rereconcileContract, runReconciliation } from './reconcile';

type App = typeof payApplications.$inferSelect;

async function loadApp(db: DB, ctx: Ctx, id: string): Promise<App> {
  const [app] = await db.select().from(payApplications).where(and(eq(payApplications.orgId, ctx.orgId), eq(payApplications.id, id)));
  if (!app) throw new UserError('Application not found.');
  return app;
}

function assertOpen(app: App): void {
  if (app.status === 'processing') throw new UserError('This application is still being processed.');
  if (!(OPEN_STATUSES as string[]).includes(app.status)) throw new UserError('This application has been decided and can no longer be changed. Reopen it first.');
}

const LINE_FIELD_LABEL: Record<LineAmountField, string> = {
  scheduledValue: 'scheduled value',
  previous: 'previous',
  thisPeriod: 'this period',
  stored: 'stored materials',
  total: 'total',
  balance: 'balance',
  retainage: 'retainage',
};

const appLabel = (app: App) => `application #${app.applicationNumber ?? '?'}`;

// ── Corrections to the application summary ──────────────────────────────────

export type HeaderPatch = Partial<Record<ClaimedField, number | null>> & { applicationNumber?: number | null; periodTo?: string | null };

export const updateHeader = locked(async function updateHeader(db: DB, ctx: Ctx, appId: string, patch: HeaderPatch): Promise<void> {
  assertCan(ctx, 'application:review');
  const app = await loadApp(db, ctx, appId);
  assertOpen(app);

  const claimed = { ...app.claimed };
  const evidence = { ...app.evidence };
  const changes: Array<{ field: string; label: string; from: unknown; to: unknown }> = [];
  for (const field of CLAIMED_FIELDS) {
    if (!(field in patch)) continue;
    const next = patch[field] ?? null;
    if (next !== null && !Number.isSafeInteger(next)) throw new UserError('Enter a valid amount.');
    if (claimed[field] === next) continue;
    changes.push({ field, label: CLAIMED_FIELD_LABEL[field], from: claimed[field], to: next });
    claimed[field] = next;
    // A person has now vouched for this value; keep the original location for reference.
    if (evidence[field]) evidence[field] = { ...evidence[field]!, confidence: 1 };
  }
  const set: Partial<App> = { claimed, evidence, claimedAmount: claimed.currentPaymentDue };
  if ('applicationNumber' in patch && patch.applicationNumber !== app.applicationNumber) {
    const n = patch.applicationNumber ?? null;
    if (n !== null && (!Number.isInteger(n) || n < 1 || n > 9999)) throw new UserError('Application number must be a whole number.');
    changes.push({ field: 'applicationNumber', label: 'Application number', from: app.applicationNumber, to: n });
    set.applicationNumber = n;
    if (evidence.applicationNumber) evidence.applicationNumber = { ...evidence.applicationNumber, confidence: 1 };
  }
  if ('periodTo' in patch && patch.periodTo !== app.periodTo) {
    const d = patch.periodTo ?? null;
    if (d !== null && !/^\d{4}-\d{2}-\d{2}$/.test(d)) throw new UserError('Enter a valid date.');
    changes.push({ field: 'periodTo', label: 'Period to', from: app.periodTo, to: d });
    set.periodTo = d;
    if (evidence.periodTo) evidence.periodTo = { ...evidence.periodTo, confidence: 1 };
  }
  if (changes.length === 0) return;

  await db.update(payApplications).set({ version: nextVersion, ...set, updatedAt: new Date() }).where(eq(payApplications.id, appId));
  const show = (c: (typeof changes)[number], v: unknown) => (typeof v === 'number' && c.field !== 'applicationNumber' ? formatMoney(v) : v === null ? 'blank' : c.field === 'periodTo' ? formatDate(String(v)) : String(v));
  await recordAudit(db, {
    orgId: ctx.orgId,
    actor: ctx,
    action: 'application.corrected',
    entityType: 'pay_application',
    entityId: appId,
    payApplicationId: appId,
    summary: `Corrected ${changes.map((c) => `${c.label}: ${show(c, c.from)} → ${show(c, c.to)}`).join('; ')}`,
    data: { changes },
  });
  await runReconciliation(db, ctx.orgId, appId, { actor: ctx });
});

export const confirmSignature = locked(async function confirmSignature(db: DB, ctx: Ctx, appId: string, confirmed: boolean): Promise<void> {
  assertCan(ctx, 'application:review');
  const app = await loadApp(db, ctx, appId);
  assertOpen(app);
  await db
    .update(payApplications)
    .set({ version: nextVersion, signatureConfirmedAt: confirmed ? new Date() : null, signatureConfirmedBy: confirmed ? ctx.userId : null, updatedAt: new Date() })
    .where(eq(payApplications.id, appId));
  await recordAudit(db, {
    orgId: ctx.orgId,
    actor: ctx,
    action: confirmed ? 'application.signature_confirmed' : 'application.signature_unconfirmed',
    entityType: 'pay_application',
    entityId: appId,
    payApplicationId: appId,
    summary: confirmed ? 'Confirmed by looking at the document that the pay application is signed' : 'Withdrew the confirmation that the pay application is signed',
  });
  await runReconciliation(db, ctx.orgId, appId, { actor: ctx });
});

// ── Line items ──────────────────────────────────────────────────────────────

export type LinePatch = Partial<Record<LineAmountField, number | null>> & { itemNo?: string | null; description?: string | null };
export type EditKind = 'correction' | 'adjustment';

export const updateLine = locked(async function updateLine(db: DB, ctx: Ctx, lineId: string, patch: LinePatch, kind: EditKind, note?: string | null): Promise<void> {
  assertCan(ctx, 'application:review');
  const [line] = await db.select().from(payAppLines).where(and(eq(payAppLines.orgId, ctx.orgId), eq(payAppLines.id, lineId)));
  if (!line) throw new UserError('Line not found.');
  const app = await loadApp(db, ctx, line.payApplicationId);
  assertOpen(app);
  if (kind === 'adjustment' && !note?.trim()) throw new UserError('Say why the approved amount differs from what was submitted.');

  const set: Partial<typeof payAppLines.$inferInsert> = {};
  const changes: string[] = [];
  for (const field of LINE_AMOUNT_FIELDS) {
    if (!(field in patch)) continue;
    const next = patch[field] ?? null;
    if (next !== null && !Number.isSafeInteger(next)) throw new UserError('Enter a valid amount.');
    if (line[field] === next) continue;
    set[field] = next;
    changes.push(`${LINE_FIELD_LABEL[field]} ${formatMoney(line[field])} → ${formatMoney(next)}`);
  }
  if ('itemNo' in patch && (patch.itemNo ?? null) !== line.itemNo) {
    set.itemNo = patch.itemNo?.trim() || null;
    changes.push(`item no. ${line.itemNo ?? 'blank'} → ${set.itemNo ?? 'blank'}`);
  }
  if ('description' in patch && (patch.description ?? null) !== line.description) {
    set.description = patch.description?.trim() || null;
    changes.push('description changed');
  }
  if (changes.length === 0) return;

  // When "this period" or "stored" changes and the row total was consistent before, keep it consistent.
  if (('thisPeriod' in set || 'stored' in set || 'previous' in set) && !('total' in set)) {
    const before = (line.previous ?? 0) + (line.thisPeriod ?? 0) + (line.stored ?? 0);
    if (line.total === null || line.total === before) {
      const total = (set.previous ?? line.previous ?? 0) + (set.thisPeriod ?? line.thisPeriod ?? 0) + (set.stored ?? line.stored ?? 0);
      set.total = total;
      if (line.scheduledValue !== null && (line.balance === null || line.balance === line.scheduledValue - (line.total ?? before))) {
        set.balance = line.scheduledValue - total;
      }
    }
  }

  await db
    .update(payAppLines)
    .set({ ...set, editKind: kind, editNote: note?.trim() || null, editedBy: ctx.userId, editedAt: new Date() })
    .where(eq(payAppLines.id, lineId));
  await recordAudit(db, {
    orgId: ctx.orgId,
    actor: ctx,
    action: kind === 'adjustment' ? 'line.adjusted' : 'line.corrected',
    entityType: 'pay_app_line',
    entityId: lineId,
    payApplicationId: app.id,
    summary: `${kind === 'adjustment' ? 'Adjusted' : 'Corrected'} line ${line.itemNo ?? ''} ${line.description ?? ''}`.trim() + `: ${changes.join('; ')}${note?.trim() ? ` — ${note.trim()}` : ''}`,
    data: { kind, note: note ?? null, patch },
  });
  await runReconciliation(db, ctx.orgId, app.id, { actor: ctx });
});

export const addLine = locked(async function addLine(db: DB, ctx: Ctx, appId: string, values: LinePatch): Promise<string> {
  assertCan(ctx, 'application:review');
  const app = await loadApp(db, ctx, appId);
  assertOpen(app);
  const existing = await db.select().from(payAppLines).where(eq(payAppLines.payApplicationId, appId)).orderBy(asc(payAppLines.sortOrder));
  const id = newId('pal');
  const row = {
    itemNo: values.itemNo?.trim() || null,
    description: values.description?.trim() || null,
    scheduledValue: values.scheduledValue ?? null,
    previous: values.previous ?? 0,
    thisPeriod: values.thisPeriod ?? 0,
    stored: values.stored ?? 0,
  };
  let sovLineId: string | null = null;
  if (app.contractId) {
    const sov = await db.select().from(sovLines).where(eq(sovLines.contractId, app.contractId));
    const taken = new Set(existing.map((l) => l.sovLineId).filter(Boolean));
    sovLineId = mapLinesToSov([row], sov.filter((s) => !taken.has(s.id)))[0] ?? null;
  }
  const total = row.previous + row.thisPeriod + row.stored;
  await db.insert(payAppLines).values({
    id,
    orgId: ctx.orgId,
    payApplicationId: appId,
    sovLineId,
    sortOrder: (existing[existing.length - 1]?.sortOrder ?? -1) + 1,
    ...row,
    total,
    balance: row.scheduledValue !== null ? row.scheduledValue - total : null,
    retainage: null,
    extracted: null,
    editKind: 'correction',
    editNote: 'Keyed by hand',
    editedBy: ctx.userId,
    editedAt: new Date(),
  });
  await recordAudit(db, {
    orgId: ctx.orgId,
    actor: ctx,
    action: 'line.added',
    entityType: 'pay_app_line',
    entityId: id,
    payApplicationId: appId,
    summary: `Keyed line ${row.itemNo ?? ''} ${row.description ?? ''} by hand`.replace(/\s+/g, ' ').trim(),
    data: row,
  });
  await runReconciliation(db, ctx.orgId, appId, { actor: ctx });
  return id;
});

export const deleteLine = locked(async function deleteLine(db: DB, ctx: Ctx, lineId: string): Promise<void> {
  assertCan(ctx, 'application:review');
  const [line] = await db.select().from(payAppLines).where(and(eq(payAppLines.orgId, ctx.orgId), eq(payAppLines.id, lineId)));
  if (!line) throw new UserError('Line not found.');
  const app = await loadApp(db, ctx, line.payApplicationId);
  assertOpen(app);
  await db.delete(payAppLines).where(eq(payAppLines.id, lineId));
  await recordAudit(db, {
    orgId: ctx.orgId,
    actor: ctx,
    action: 'line.removed',
    entityType: 'pay_app_line',
    entityId: lineId,
    payApplicationId: app.id,
    summary: `Removed line ${line.itemNo ?? ''} ${line.description ?? ''} (${formatMoney(line.total)} total)`.replace(/\s+/g, ' '),
    data: { line: { itemNo: line.itemNo, description: line.description, scheduledValue: line.scheduledValue, previous: line.previous, thisPeriod: line.thisPeriod, stored: line.stored, total: line.total } },
  });
  await runReconciliation(db, ctx.orgId, app.id, { actor: ctx });
});

/** Point a submitted row at a contract line (or at nothing). */
export const setLineMatch = locked(async function setLineMatch(db: DB, ctx: Ctx, lineId: string, sovLineId: string | null): Promise<void> {
  assertCan(ctx, 'application:review');
  const [line] = await db.select().from(payAppLines).where(and(eq(payAppLines.orgId, ctx.orgId), eq(payAppLines.id, lineId)));
  if (!line) throw new UserError('Line not found.');
  const app = await loadApp(db, ctx, line.payApplicationId);
  assertOpen(app);
  let label = 'no contract line';
  if (sovLineId) {
    const [sov] = await db.select().from(sovLines).where(and(eq(sovLines.orgId, ctx.orgId), eq(sovLines.id, sovLineId)));
    if (!sov || sov.contractId !== app.contractId) throw new UserError('That line is not on this application’s contract.');
    const [taken] = await db.select({ id: payAppLines.id }).from(payAppLines).where(and(eq(payAppLines.payApplicationId, app.id), eq(payAppLines.sovLineId, sovLineId), ne(payAppLines.id, lineId)));
    if (taken) throw new UserError('Another row is already matched to that contract line.');
    label = `contract line ${sov.itemNo} ${sov.description}`;
  }
  await db.update(payAppLines).set({ sovLineId }).where(eq(payAppLines.id, lineId));
  await recordAudit(db, {
    orgId: ctx.orgId,
    actor: ctx,
    action: 'line.matched',
    entityType: 'pay_app_line',
    entityId: lineId,
    payApplicationId: app.id,
    summary: `Matched line ${line.itemNo ?? ''} ${line.description ?? ''} to ${label}`.replace(/\s+/g, ' '),
  });
  await runReconciliation(db, ctx.orgId, app.id, { actor: ctx });
});

// ── Lien waivers ────────────────────────────────────────────────────────────

export type WaiverPatch = {
  waiverType?: WaiverType;
  claimant?: string | null;
  throughDate?: string | null;
  amount?: number | null;
  exceptions?: string | null;
  signed?: Tri | null;
};

export const updateWaiver = locked(async function updateWaiver(db: DB, ctx: Ctx, waiverId: string, patch: WaiverPatch): Promise<void> {
  assertCan(ctx, 'application:review');
  const [w] = await db.select().from(lienWaivers).where(and(eq(lienWaivers.orgId, ctx.orgId), eq(lienWaivers.id, waiverId)));
  if (!w) throw new UserError('Waiver not found.');
  const app = await loadApp(db, ctx, w.payApplicationId);
  assertOpen(app);
  if (patch.waiverType && !(WAIVER_TYPES as readonly string[]).includes(patch.waiverType)) throw new UserError('Unknown waiver type.');
  if (patch.throughDate && !/^\d{4}-\d{2}-\d{2}$/.test(patch.throughDate)) throw new UserError('Enter a valid date.');
  const changed = (Object.keys(patch) as Array<keyof WaiverPatch>).filter((k) => patch[k] !== undefined && patch[k] !== w[k]);
  if (changed.length === 0) return;
  await db
    .update(lienWaivers)
    .set({ ...Object.fromEntries(changed.map((k) => [k, patch[k]])), editedBy: ctx.userId, editedAt: new Date() })
    .where(eq(lienWaivers.id, waiverId));
  await recordAudit(db, {
    orgId: ctx.orgId,
    actor: ctx,
    action: 'waiver.corrected',
    entityType: 'lien_waiver',
    entityId: waiverId,
    payApplicationId: app.id,
    summary: `Corrected lien waiver: ${changed.map((k) => `${k} ${k === 'amount' ? formatMoney(w.amount) : (w[k] ?? 'blank')} → ${k === 'amount' ? formatMoney(patch.amount) : (patch[k] ?? 'blank')}`).join('; ')}`,
    data: { patch },
  });
  await runReconciliation(db, ctx.orgId, app.id, { actor: ctx });
});

/** Record a waiver by hand, for a document that could not be read. */
export const addWaiver = locked(async function addWaiver(db: DB, ctx: Ctx, appId: string, documentId: string, values: Required<Pick<WaiverPatch, 'waiverType'>> & WaiverPatch): Promise<string> {
  assertCan(ctx, 'application:review');
  const app = await loadApp(db, ctx, appId);
  assertOpen(app);
  const [doc] = await db.select().from(documents).where(and(eq(documents.orgId, ctx.orgId), eq(documents.id, documentId), eq(documents.payApplicationId, appId)));
  if (!doc) throw new UserError('Choose the document that contains the waiver.');
  const id = newId('lw');
  await db.insert(lienWaivers).values({
    id,
    orgId: ctx.orgId,
    payApplicationId: appId,
    documentId,
    page: 1,
    waiverType: values.waiverType,
    claimant: values.claimant ?? null,
    throughDate: values.throughDate ?? null,
    amount: values.amount ?? null,
    exceptions: values.exceptions ?? null,
    signed: values.signed ?? null,
    editedBy: ctx.userId,
    editedAt: new Date(),
  });
  // The document now contains a waiver as far as completeness checks are concerned.
  if (!doc.segments.some((s) => s.type === 'lien_waiver')) {
    await db.update(documents).set({ segments: [...doc.segments, { type: 'lien_waiver', pageStart: 1, pageEnd: doc.pageCount ?? 1, confidence: 1 }] }).where(eq(documents.id, documentId));
  }
  await recordAudit(db, {
    orgId: ctx.orgId,
    actor: ctx,
    action: 'waiver.added',
    entityType: 'lien_waiver',
    entityId: id,
    payApplicationId: appId,
    summary: `Recorded a lien waiver by hand from “${doc.filename}” (${formatMoney(values.amount ?? null)})`,
    data: values,
  });
  await runReconciliation(db, ctx.orgId, appId, { actor: ctx });
  return id;
});

// ── Findings ────────────────────────────────────────────────────────────────

/** Who may sign off on a finding as-is depends on what kind of finding it is. */
export function canAcceptFinding(ctx: Ctx, f: { severity: string; needsQualifiedReview: boolean }): boolean {
  if (f.needsQualifiedReview) return can(ctx.role, 'compliance:signoff');
  if (f.severity === 'blocking') return can(ctx.role, 'application:approve');
  return can(ctx.role, 'application:review');
}

export const acceptFinding = locked(async function acceptFinding(db: DB, ctx: Ctx, findingId: string, note: string, opts: { now?: Date } = {}): Promise<void> {
  const [f] = await db.select().from(findings).where(and(eq(findings.orgId, ctx.orgId), eq(findings.id, findingId)));
  if (!f) throw new UserError('Finding not found.');
  const app = await loadApp(db, ctx, f.payApplicationId);
  assertOpen(app);
  if (f.status !== 'open') throw new UserError('This finding is no longer open.');
  if (!canAcceptFinding(ctx, f)) throw new PermissionError(f.needsQualifiedReview ? 'compliance:signoff' : f.severity === 'blocking' ? 'application:approve' : 'application:review');
  if ((f.severity === 'blocking' || f.needsQualifiedReview) && note.trim().length < 5) throw new UserError('Explain why this is acceptable. The explanation is kept with the approval record.');

  const now = opts.now ?? new Date();
  await db.update(findings).set({ status: 'accepted', resolvedBy: ctx.userId, resolvedAt: now, resolutionNote: note.trim() || null, updatedAt: now }).where(eq(findings.id, findingId));
  await recordAudit(db, {
    orgId: ctx.orgId,
    actor: ctx,
    action: f.severity === 'blocking' ? 'finding.overridden' : 'finding.accepted',
    entityType: 'finding',
    entityId: findingId,
    payApplicationId: app.id,
    summary: `${f.severity === 'blocking' ? 'Overrode blocking finding' : f.needsQualifiedReview ? 'Signed off' : 'Accepted'} “${f.title}”${note.trim() ? ` — ${note.trim()}` : ''}`,
    data: { code: f.code, severity: f.severity, needsQualifiedReview: f.needsQualifiedReview, note: note.trim(), data: f.data },
    at: now,
  });
  await refreshCounts(db, app.id);
});

export const reopenFinding = locked(async function reopenFinding(db: DB, ctx: Ctx, findingId: string): Promise<void> {
  assertCan(ctx, 'application:review');
  const [f] = await db.select().from(findings).where(and(eq(findings.orgId, ctx.orgId), eq(findings.id, findingId)));
  if (!f) throw new UserError('Finding not found.');
  const app = await loadApp(db, ctx, f.payApplicationId);
  assertOpen(app);
  if (f.status !== 'accepted') return;
  await db.update(findings).set({ status: 'open', resolvedBy: null, resolvedAt: null, resolutionNote: null, updatedAt: new Date() }).where(eq(findings.id, findingId));
  await recordAudit(db, {
    orgId: ctx.orgId,
    actor: ctx,
    action: 'finding.reopened',
    entityType: 'finding',
    entityId: findingId,
    payApplicationId: app.id,
    summary: `Reopened “${f.title}”`,
  });
  await refreshCounts(db, app.id);
});

async function refreshCounts(db: DB, appId: string): Promise<void> {
  const rows = await db.select({ status: findings.status, severity: findings.severity }).from(findings).where(eq(findings.payApplicationId, appId));
  await db
    .update(payApplications)
    .set({ version: nextVersion,
      openBlocking: rows.filter((r) => r.status === 'open' && r.severity === 'blocking').length,
      openWarnings: rows.filter((r) => r.status === 'open' && r.severity === 'warning').length,
      updatedAt: new Date(),
    })
    .where(eq(payApplications.id, appId));
}

// ── Matching and contract-level resolutions ─────────────────────────────────

export const assignContract = locked(async function assignContract(db: DB, ctx: Ctx, appId: string, contractId: string): Promise<void> {
  assertCan(ctx, 'application:review');
  const app = await loadApp(db, ctx, appId);
  assertOpen(app);
  const [contract] = await db.select().from(contracts).where(and(eq(contracts.orgId, ctx.orgId), eq(contracts.id, contractId)));
  if (!contract) throw new UserError('Contract not found.');
  const lines = await db.select().from(payAppLines).where(eq(payAppLines.payApplicationId, appId)).orderBy(asc(payAppLines.sortOrder));
  const sov = await db.select().from(sovLines).where(eq(sovLines.contractId, contractId)).orderBy(asc(sovLines.sortOrder));
  const mapping = mapLinesToSov(lines, sov);
  for (const [i, line] of lines.entries()) {
    await db.update(payAppLines).set({ sovLineId: mapping[i] ?? null }).where(eq(payAppLines.id, line.id));
  }
  await db
    .update(payApplications)
    .set({ version: nextVersion, contractId, projectId: contract.projectId, subcontractorId: contract.subcontractorId, status: app.status === 'needs_matching' ? 'needs_review' : app.status, updatedAt: new Date() })
    .where(eq(payApplications.id, appId));
  await recordAudit(db, {
    orgId: ctx.orgId,
    actor: ctx,
    action: 'application.matched',
    entityType: 'pay_application',
    entityId: appId,
    payApplicationId: appId,
    summary: `Matched to contract ${contract.number} – ${contract.title}`,
    data: { contractId, previousContractId: app.contractId },
  });
  await runReconciliation(db, ctx.orgId, appId, { actor: ctx });
});

/**
 * For a contract that was already being billed before it was set up here:
 * take this application's "previous" figures as the opening balances.
 */
export const setOpeningBalances = locked(async function setOpeningBalances(db: DB, ctx: Ctx, appId: string): Promise<void> {
  assertCan(ctx, 'application:approve');
  const app = await loadApp(db, ctx, appId);
  assertOpen(app);
  if (!app.contractId) throw new UserError('Match the application to a contract first.');
  if (app.applicationNumber === null || app.applicationNumber < 2) throw new UserError('Opening balances only make sense from application #2 onward.');
  const [contract] = await db.select().from(contracts).where(eq(contracts.id, app.contractId));
  const approved = await db.select({ id: payApplications.id }).from(payApplications).where(and(eq(payApplications.contractId, app.contractId), eq(payApplications.status, 'approved')));
  if (approved.length > 0) throw new UserError('This contract already has approved billing history, so opening balances cannot be set.');
  const lines = await db.select().from(payAppLines).where(eq(payAppLines.payApplicationId, appId));
  const unmatched = lines.filter((l) => !l.sovLineId && (l.previous ?? 0) !== 0);
  if (unmatched.length > 0) throw new UserError('Some lines with previous billing are not matched to the contract’s schedule of values. Match them first.');

  const workToDate: Record<string, number> = {};
  for (const l of lines) if (l.sovLineId) workToDate[l.sovLineId] = l.previous ?? 0;
  const baseline: ContractBaseline = {
    asOfApplicationNumber: app.applicationNumber - 1,
    previousCertificates: app.claimed.lessPreviousCertificates ?? 0,
    retainageHeld: null,
    workToDate,
    sourceApplicationId: appId,
    setBy: ctx.userId,
    setAt: new Date().toISOString(),
  };
  await db.update(contracts).set({ baseline }).where(eq(contracts.id, app.contractId));
  const total = Object.values(workToDate).reduce((a, b) => a + b, 0);
  await recordAudit(db, {
    orgId: ctx.orgId,
    actor: ctx,
    action: 'contract.opening_balances_set',
    entityType: 'contract',
    entityId: app.contractId,
    payApplicationId: appId,
    summary: `Set opening balances for contract ${contract?.number ?? ''} from ${appLabel(app)}: ${formatMoney(total)} of work previously completed, ${formatMoney(baseline.previousCertificates)} previously certified`,
    data: { baseline },
  });
  await rereconcileContract(db, ctx.orgId, app.contractId, { actor: ctx });
});

/** For a contract with no schedule of values yet: adopt the one on this application. */
export const adoptSchedule = locked(async function adoptSchedule(db: DB, ctx: Ctx, appId: string): Promise<void> {
  assertCan(ctx, 'records:write');
  const app = await loadApp(db, ctx, appId);
  assertOpen(app);
  if (!app.contractId) throw new UserError('Match the application to a contract first.');
  const existing = await db.select({ id: sovLines.id }).from(sovLines).where(eq(sovLines.contractId, app.contractId));
  if (existing.length > 0) throw new UserError('This contract already has a schedule of values.');
  const lines = await db.select().from(payAppLines).where(eq(payAppLines.payApplicationId, appId)).orderBy(asc(payAppLines.sortOrder));
  const usable = lines.filter((l) => l.scheduledValue !== null);
  if (usable.length === 0) throw new UserError('This application has no line items with scheduled values to adopt.');
  for (const [i, l] of usable.entries()) {
    const id = newId('sov');
    await db.insert(sovLines).values({ id, orgId: ctx.orgId, contractId: app.contractId, itemNo: l.itemNo ?? String(i + 1), description: l.description ?? `Line ${i + 1}`, scheduledValue: l.scheduledValue!, sortOrder: i });
    await db.update(payAppLines).set({ sovLineId: id }).where(eq(payAppLines.id, l.id));
  }
  await recordAudit(db, {
    orgId: ctx.orgId,
    actor: ctx,
    action: 'contract.schedule_adopted',
    entityType: 'contract',
    entityId: app.contractId,
    payApplicationId: appId,
    summary: `Adopted the schedule of values from ${appLabel(app)} as the contract’s schedule (${usable.length} lines, ${formatMoney(usable.reduce((a, l) => a + l.scheduledValue!, 0))})`,
  });
  await rereconcileContract(db, ctx.orgId, app.contractId, { actor: ctx });
});

// ── Workflow ────────────────────────────────────────────────────────────────

export const assignReviewer = locked(async function assignReviewer(db: DB, ctx: Ctx, appId: string, userId: string | null, opts: { now?: Date } = {}): Promise<void> {
  assertCan(ctx, 'application:review');
  const app = await loadApp(db, ctx, appId);
  let name = 'nobody';
  if (userId) {
    const [m] = await db
      .select({ name: users.name })
      .from(memberships)
      .innerJoin(users, eq(users.id, memberships.userId))
      .where(and(eq(memberships.orgId, ctx.orgId), eq(memberships.userId, userId), eq(memberships.status, 'active')));
    if (!m) throw new UserError('That person is not an active member of this organisation.');
    name = m.name;
  }
  const now = opts.now ?? new Date();
  await db.update(payApplications).set({ version: nextVersion, assigneeId: userId, updatedAt: now }).where(eq(payApplications.id, appId));
  await recordAudit(db, { orgId: ctx.orgId, actor: ctx, action: 'application.assigned', entityType: 'pay_application', entityId: appId, payApplicationId: appId, summary: `Assigned to ${name}`, data: { assigneeId: userId }, at: now });
  if (userId && userId !== ctx.userId) {
    await notifyUsers(db, ctx.orgId, [userId], { type: 'application.assigned', title: `${ctx.userName} assigned you ${appLabel(app)}`, href: `/applications/${appId}` }, now);
  }
});

export const submitForApproval = locked(async function submitForApproval(db: DB, ctx: Ctx, appId: string, note?: string | null, opts: { now?: Date } = {}): Promise<void> {
  assertCan(ctx, 'application:review');
  const app = await loadApp(db, ctx, appId);
  if (app.status !== 'needs_review') throw new UserError('Only applications in review can be submitted for approval.');
  if (!app.contractId) throw new UserError('Match the application to a contract first.');
  const now = opts.now ?? new Date();
  await db.update(payApplications).set({ version: nextVersion, status: 'pending_approval', submittedForApprovalAt: now, submittedForApprovalBy: ctx.userId, updatedAt: now }).where(eq(payApplications.id, appId));
  await recordAudit(db, {
    orgId: ctx.orgId,
    actor: ctx,
    action: 'application.submitted_for_approval',
    entityType: 'pay_application',
    entityId: appId,
    payApplicationId: appId,
    summary: `Submitted for approval at ${formatMoney(app.verifiedAmount)}${app.openBlocking ? ` with ${app.openBlocking} blocking finding${app.openBlocking === 1 ? '' : 's'} for the approver to decide` : ''}${note?.trim() ? ` — ${note.trim()}` : ''}`,
    data: { note: note ?? null, openBlocking: app.openBlocking, openWarnings: app.openWarnings },
    at: now,
  });
  await notifyPermission(db, ctx.orgId, 'application:approve', { type: 'application.pending_approval', title: `${appLabel(app)} is waiting for your approval`, body: `Submitted by ${ctx.userName} at ${formatMoney(app.verifiedAmount)}`, href: `/applications/${appId}` }, { except: ctx.userId, at: now });
});

export type ApproveInput = { note?: string | null; acknowledgeWarnings?: boolean; now?: Date };

export const approveApplication = locked(async function approveApplication(db: DB, ctx: Ctx, appId: string, input: ApproveInput = {}): Promise<ApprovedRecord> {
  assertCan(ctx, 'application:approve');
  const now = input.now ?? new Date();
  let app = await loadApp(db, ctx, appId);
  if (app.status !== 'needs_review' && app.status !== 'pending_approval') throw new UserError('This application is not in a state that can be approved.');
  if (!app.contractId) throw new UserError('Match the application to a contract first.');
  if (app.applicationNumber === null || !app.periodTo) throw new UserError('The application number and period are required before approval.');

  // Decide on the current facts, not on whatever was last displayed.
  await runReconciliation(db, ctx.orgId, appId, { actor: ctx, now });
  app = await loadApp(db, ctx, appId);
  const all = await db.select().from(findings).where(eq(findings.payApplicationId, appId)).orderBy(asc(findings.sortOrder));
  const blocking = all.filter((f) => f.status === 'open' && f.severity === 'blocking');
  if (blocking.length > 0) {
    throw new UserError(`${blocking.length} blocking finding${blocking.length === 1 ? ' is' : 's are'} still open: ${blocking.slice(0, 3).map((f) => f.title).join('; ')}${blocking.length > 3 ? '…' : ''}`);
  }
  const warnings = all.filter((f) => f.status === 'open' && f.severity === 'warning');
  if (warnings.length > 0 && !input.acknowledgeWarnings) throw new UserError(`Acknowledge the ${warnings.length} open warning${warnings.length === 1 ? '' : 's'} to approve.`);

  const out = await computeReconciliation(db, ctx.orgId, appId, now);
  if (!out) throw new UserError('The application could not be verified.');
  if (out.lines.length === 0) throw new UserError('The contract has no schedule of values, so there is nothing to approve against.');

  const [org] = await db.select().from(organizations).where(eq(organizations.id, ctx.orgId));
  const [contract] = await db.select().from(contracts).where(eq(contracts.id, app.contractId!));
  const [project] = await db.select().from(projects).where(eq(projects.id, contract!.projectId));
  const [sub] = await db.select().from(subcontractors).where(eq(subcontractors.id, contract!.subcontractorId));
  const cos = await db.select().from(changeOrders).where(and(eq(changeOrders.contractId, contract!.id), eq(changeOrders.status, 'approved')));
  const lines = await db.select().from(payAppLines).where(eq(payAppLines.payApplicationId, appId));
  const waivers = await db.select().from(lienWaivers).where(eq(lienWaivers.payApplicationId, appId));
  const docs = await db.select().from(documents).where(eq(documents.payApplicationId, appId)).orderBy(asc(documents.createdAt));
  const resolvers = new Map((await db.select({ id: users.id, name: users.name }).from(users).where(inArray(users.id, [...new Set(all.map((f) => f.resolvedBy).filter((x): x is string => !!x)), ctx.userId]))).map((u) => [u.id, u.name]));
  const lineById = new Map(lines.map((l) => [l.id, l]));

  const record: ApprovedRecord = {
    schemaVersion: 1,
    approvedAt: now.toISOString(),
    approvedBy: { id: ctx.userId, name: ctx.userName, role: ctx.role },
    note: input.note?.trim() || null,
    organization: { id: org!.id, name: org!.name },
    project: { id: project!.id, name: project!.name, number: project!.number, state: project!.state, externalId: project!.externalId },
    subcontractor: { id: sub!.id, name: sub!.name, externalId: sub!.externalId },
    contract: {
      id: contract!.id,
      number: contract!.number,
      title: contract!.title,
      originalAmount: contract!.originalAmount,
      retainageWorkBps: contract!.retainageWorkBps,
      retainageStoredBps: contract!.retainageStoredBps,
      externalId: contract!.externalId,
    },
    application: { id: app.id, number: app.applicationNumber!, periodTo: app.periodTo!, receivedAt: app.receivedAt.toISOString() },
    claimed: app.claimed,
    approved: out.verified,
    varianceFromClaimed: app.claimed.currentPaymentDue === null ? null : out.verified.currentPaymentDue - app.claimed.currentPaymentDue,
    lines: out.lines.map((l) => {
      const src = l.lineId ? lineById.get(l.lineId) : undefined;
      return {
        itemNo: l.itemNo,
        description: l.description,
        sovLineId: l.sovLineId,
        scheduledValue: l.scheduledValue,
        previous: l.previous,
        thisPeriod: l.thisPeriod,
        stored: l.stored,
        total: l.total,
        balance: l.balance,
        retainage: l.retainage,
        adjusted: src?.editKind === 'adjustment',
        adjustmentNote: src?.editKind === 'adjustment' ? src.editNote : null,
      };
    }),
    changeOrders: cos.map((c) => ({ number: c.number, title: c.title, amount: c.amount, approvedOn: c.approvedOn })),
    acceptedFindings: [
      ...all.filter((f) => f.status === 'accepted').map((f) => ({ code: f.code, severity: f.severity as 'blocking' | 'warning' | 'info', title: f.title, note: f.resolutionNote, by: f.resolvedBy ? (resolvers.get(f.resolvedBy) ?? null) : null, at: f.resolvedAt?.toISOString() ?? null })),
      ...warnings.map((f) => ({ code: f.code, severity: 'warning' as const, title: f.title, note: 'Acknowledged at approval', by: ctx.userName, at: now.toISOString() })),
    ],
    waivers: waivers.map((w) => ({ type: w.waiverType as WaiverType, amount: w.amount, throughDate: w.throughDate, signed: (w.signed as Tri | null) ?? null })),
    documents: docs.map((d) => ({ id: d.id, filename: d.filename, sha256: d.sha256, pages: d.pageCount })),
  };

  await db
    .update(payApplications)
    .set({ version: nextVersion,
      status: 'approved',
      decidedAt: now,
      decidedBy: ctx.userId,
      decisionNote: record.note,
      verified: out.verified,
      verifiedAmount: out.verified.currentPaymentDue,
      approvedAmount: out.verified.currentPaymentDue,
      approvedRetainage: out.verified.retainageTotal,
      approvedRecord: record,
      holdSince: null,
      updatedAt: now,
    })
    .where(eq(payApplications.id, appId));

  const variance = record.varianceFromClaimed;
  await recordAudit(db, {
    orgId: ctx.orgId,
    actor: ctx,
    action: 'application.approved',
    entityType: 'pay_application',
    entityId: appId,
    payApplicationId: appId,
    summary:
      `Approved ${appLabel(app)} for ${formatMoney(out.verified.currentPaymentDue)}` +
      (variance ? ` (${formatMoney(Math.abs(variance))} ${variance < 0 ? 'less' : 'more'} than the ${formatMoney(app.claimed.currentPaymentDue)} requested)` : '') +
      (record.acceptedFindings.length ? `, with ${record.acceptedFindings.length} finding${record.acceptedFindings.length === 1 ? '' : 's'} accepted` : '') +
      (record.note ? ` — ${record.note}` : ''),
    data: { approvedAmount: out.verified.currentPaymentDue, claimedAmount: app.claimed.currentPaymentDue, retainage: out.verified.retainageTotal, acceptedFindings: record.acceptedFindings.length, note: record.note },
    at: now,
  });
  await notifyUsers(db, ctx.orgId, [app.assigneeId, app.submittedForApprovalBy, app.submittedBy].filter((u) => u !== ctx.userId), { type: 'application.approved', title: `${sub!.name} ${appLabel(app)} approved`, body: `${formatMoney(out.verified.currentPaymentDue)} approved by ${ctx.userName}`, href: `/applications/${appId}` }, now);

  // Later applications on this contract now have a new "previous" basis.
  await rereconcileContract(db, ctx.orgId, contract!.id, { actor: ctx, now, except: appId });
  return record;
});

export const rejectApplication = locked(async function rejectApplication(db: DB, ctx: Ctx, appId: string, reason: string, opts: { now?: Date } = {}): Promise<void> {
  assertCan(ctx, 'application:approve');
  const app = await loadApp(db, ctx, appId);
  if (!['needs_review', 'pending_approval', 'on_hold', 'needs_matching'].includes(app.status)) throw new UserError('This application cannot be rejected in its current state.');
  if (reason.trim().length < 5) throw new UserError('Give the reason for rejecting. It is kept with the record and can be sent to the subcontractor.');
  const now = opts.now ?? new Date();
  await db.update(payApplications).set({ version: nextVersion, status: 'rejected', decidedAt: now, decidedBy: ctx.userId, decisionNote: reason.trim(), holdSince: null, updatedAt: now }).where(eq(payApplications.id, appId));
  await recordAudit(db, { orgId: ctx.orgId, actor: ctx, action: 'application.rejected', entityType: 'pay_application', entityId: appId, payApplicationId: appId, summary: `Rejected ${appLabel(app)} — ${reason.trim()}`, data: { reason: reason.trim() }, at: now });
  await notifyUsers(db, ctx.orgId, [app.assigneeId, app.submittedForApprovalBy, app.submittedBy].filter((u) => u !== ctx.userId), { type: 'application.rejected', title: `${appLabel(app)} rejected`, body: reason.trim(), href: `/applications/${appId}` }, now);
  if (app.contractId) await rereconcileContract(db, ctx.orgId, app.contractId, { actor: ctx, now, except: appId });
});

export const voidApplication = locked(async function voidApplication(db: DB, ctx: Ctx, appId: string, reason: string): Promise<void> {
  assertCan(ctx, 'application:approve');
  const app = await loadApp(db, ctx, appId);
  if (app.status === 'approved') throw new UserError('An approved application cannot be voided. Reopen it first.');
  if (app.status === 'void') return;
  if (reason.trim().length < 5) throw new UserError('Give the reason for voiding.');
  const now = new Date();
  await db.update(payApplications).set({ version: nextVersion, status: 'void', decidedAt: now, decidedBy: ctx.userId, decisionNote: reason.trim(), updatedAt: now }).where(eq(payApplications.id, appId));
  await recordAudit(db, { orgId: ctx.orgId, actor: ctx, action: 'application.voided', entityType: 'pay_application', entityId: appId, payApplicationId: appId, summary: `Voided ${appLabel(app)} — ${reason.trim()}`, data: { reason: reason.trim() }, at: now });
  if (app.contractId) await rereconcileContract(db, ctx.orgId, app.contractId, { actor: ctx, now, except: appId });
});

/** Undo a decision. Not allowed once later billing depends on it or it has been pushed to another system. */
export const reopenApplication = locked(async function reopenApplication(db: DB, ctx: Ctx, appId: string, reason: string): Promise<void> {
  assertCan(ctx, 'application:approve');
  const app = await loadApp(db, ctx, appId);
  if (!['approved', 'rejected', 'void'].includes(app.status)) throw new UserError('Only a decided application can be reopened.');
  if (reason.trim().length < 5) throw new UserError('Give the reason for reopening.');
  if (app.transferStatus === 'synced') throw new UserError('This application has already been sent to a connected system. Correct it there, or contact an administrator.');
  if (app.status === 'approved' && app.contractId && app.applicationNumber !== null) {
    const later = await db.select({ n: payApplications.applicationNumber }).from(payApplications).where(and(eq(payApplications.contractId, app.contractId), eq(payApplications.status, 'approved'), ne(payApplications.id, appId)));
    const blocker = later.find((l) => l.n !== null && l.n > app.applicationNumber!);
    if (blocker) throw new UserError(`Application #${blocker.n} was approved after this one and builds on it. Reopen that one first.`);
  }
  const now = new Date();
  await db
    .update(payApplications)
    .set({ version: nextVersion, status: app.contractId ? 'needs_review' : 'needs_matching', decidedAt: null, decidedBy: null, decisionNote: null, approvedAmount: null, approvedRetainage: null, approvedRecord: null, transferStatus: 'none', submittedForApprovalAt: null, submittedForApprovalBy: null, updatedAt: now })
    .where(eq(payApplications.id, appId));
  await recordAudit(db, {
    orgId: ctx.orgId,
    actor: ctx,
    action: 'application.reopened',
    entityType: 'pay_application',
    entityId: appId,
    payApplicationId: appId,
    summary: `Reopened ${appLabel(app)} (was ${app.status}${app.approvedAmount !== null ? ` at ${formatMoney(app.approvedAmount)}` : ''}) — ${reason.trim()}${app.transferStatus === 'exported' ? '. Files exported earlier are now out of date.' : ''}`,
    data: { reason: reason.trim(), previousStatus: app.status, previousApprovedAmount: app.approvedAmount, hadExports: app.transferStatus === 'exported' },
    at: now,
  });
  if (app.contractId) {
    await runReconciliation(db, ctx.orgId, appId, { actor: ctx, now });
    await rereconcileContract(db, ctx.orgId, app.contractId, { actor: ctx, now, except: appId });
  }
});

// ── Messages to the subcontractor ───────────────────────────────────────────

export async function draftCorrectionRequest(db: DB, ctx: Ctx, appId: string): Promise<{ to: string; subject: string; body: string }> {
  const app = await loadApp(db, ctx, appId);
  const [sub] = app.subcontractorId ? await db.select().from(subcontractors).where(eq(subcontractors.id, app.subcontractorId)) : [];
  const [project] = app.projectId ? await db.select().from(projects).where(eq(projects.id, app.projectId)) : [];
  const open = await db.select().from(findings).where(and(eq(findings.payApplicationId, appId), eq(findings.status, 'open'))).orderBy(asc(findings.sortOrder));
  // Only what the subcontractor can act on: not our own record problems or reading issues.
  const theirs = open.filter((f) => f.severity !== 'info' && f.category !== 'extraction' && f.code !== 'sov.contract_total' && f.code !== 'sov.none_on_contract' && f.code !== 'seq.prior_pending');
  const items = theirs.map((f, i) => `${i + 1}. ${f.title}\n   ${f.detail}`).join('\n\n');
  const who = sub?.contactName?.split(' ')[0] ?? sub?.name ?? 'there';
  return {
    to: app.senderEmail ?? sub?.contactEmail ?? '',
    subject: `Pay application #${app.applicationNumber ?? ''}${project ? ` – ${project.name}` : ''}: corrections needed`,
    body:
      `Hi ${who},\n\n` +
      `We have reviewed pay application #${app.applicationNumber ?? ''}${app.periodTo ? ` for the period to ${formatDate(app.periodTo)}` : ''}${project ? ` on ${project.name}` : ''} and cannot approve it as submitted. ` +
      `Please correct the following and resubmit:\n\n${items || '(describe what needs to be corrected)'}\n\n` +
      `Reply to this email with the revised documents and we will pick it up from there.\n\nThank you,\n${ctx.userName}\n${ctx.orgName}`,
  };
}

export type MessageInput = { to: string; subject: string; body: string; hold?: boolean; kind?: 'correction_request' | 'decision_notice' | 'general'; now?: Date };

/** Record a message to the subcontractor, send it if email delivery is configured, and optionally put the application on hold. */
export async function sendSubcontractorMessage(db: DB, ctx: Ctx, appId: string, input: MessageInput): Promise<{ status: 'sent' | 'not_sent' | 'failed'; detail: string | null }> {
  assertCan(ctx, 'application:review');
  const app = await loadApp(db, ctx, appId);
  if (app.status === 'processing' || app.status === 'void') throw new UserError('Messages cannot be sent for this application right now.');
  const to = input.to.trim();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(to)) throw new UserError('Enter the recipient’s email address.');
  if (!input.subject.trim() || input.body.trim().length < 10) throw new UserError('Write a subject and a message.');

  const result = await sendEmail({ to, subject: input.subject.trim(), text: input.body, replyTo: ctx.userEmail });
  const now = input.now ?? new Date();
  await db.insert(communications).values({
    id: newId('msg'),
    orgId: ctx.orgId,
    payApplicationId: appId,
    kind: input.kind ?? 'correction_request',
    toEmail: to,
    subject: input.subject.trim(),
    body: input.body,
    status: result.status,
    provider: result.provider,
    providerRef: result.status === 'sent' ? result.providerRef : null,
    error: result.status === 'failed' ? result.error : result.status === 'not_sent' ? result.reason : null,
    createdBy: ctx.userId,
    createdAt: now,
  });

  const hold = input.hold && (OPEN_STATUSES as string[]).includes(app.status) && app.status !== 'needs_matching';
  if (hold) await db.update(payApplications).set({ version: nextVersion, status: 'on_hold', holdSince: now, updatedAt: now }).where(eq(payApplications.id, appId));

  const delivery = result.status === 'sent' ? `Emailed ${to}` : result.status === 'failed' ? `Email to ${to} FAILED to send` : `Drafted a message to ${to} (not sent: email delivery is not configured)`;
  await recordAudit(db, {
    orgId: ctx.orgId,
    actor: ctx,
    action: result.status === 'sent' ? 'message.sent' : result.status === 'failed' ? 'message.failed' : 'message.drafted',
    entityType: 'pay_application',
    entityId: appId,
    payApplicationId: appId,
    summary: `${delivery}: “${input.subject.trim()}”${hold ? '. Application placed on hold awaiting the subcontractor.' : ''}`,
    data: { to, subject: input.subject.trim(), status: result.status, hold: !!hold },
    at: now,
  });
  if (result.status === 'failed') {
    await notifyUsers(db, ctx.orgId, [ctx.userId], { type: 'message.failed', title: 'A message to a subcontractor failed to send', body: result.error, href: `/applications/${appId}` }, now);
  }
  return { status: result.status, detail: result.status === 'failed' ? result.error : result.status === 'not_sent' ? result.reason : null };
}

export const resumeReview = locked(async function resumeReview(db: DB, ctx: Ctx, appId: string): Promise<void> {
  assertCan(ctx, 'application:review');
  const app = await loadApp(db, ctx, appId);
  if (app.status !== 'on_hold' && app.status !== 'pending_approval') throw new UserError('This application is not on hold or pending approval.');
  const now = new Date();
  await db.update(payApplications).set({ version: nextVersion, status: 'needs_review', holdSince: null, submittedForApprovalAt: null, submittedForApprovalBy: null, updatedAt: now }).where(eq(payApplications.id, appId));
  await recordAudit(db, { orgId: ctx.orgId, actor: ctx, action: 'application.resumed', entityType: 'pay_application', entityId: appId, payApplicationId: appId, summary: app.status === 'on_hold' ? 'Took the application off hold and resumed review' : 'Returned the application to review', at: now });
});

export const addComment = locked(async function addComment(db: DB, ctx: Ctx, appId: string, body: string): Promise<void> {
  if (ctx.role === 'viewer') throw new PermissionError('application:upload');
  const app = await loadApp(db, ctx, appId);
  const text = body.trim();
  if (!text) throw new UserError('Write a comment.');
  if (text.length > 4000) throw new UserError('That comment is too long.');
  const now = new Date();
  await db.insert(comments).values({ id: newId('cmt'), orgId: ctx.orgId, payApplicationId: appId, userId: ctx.userId, body: text, createdAt: now });
  await recordAudit(db, { orgId: ctx.orgId, actor: ctx, action: 'comment.added', entityType: 'pay_application', entityId: appId, payApplicationId: appId, summary: `Commented: ${text.length > 140 ? `${text.slice(0, 140)}…` : text}`, at: now });
  await notifyUsers(db, ctx.orgId, [app.assigneeId, app.submittedForApprovalBy].filter((u) => u !== ctx.userId), { type: 'comment.added', title: `${ctx.userName} commented on ${appLabel(app)}`, body: text.slice(0, 200), href: `/applications/${appId}` }, now);
});
