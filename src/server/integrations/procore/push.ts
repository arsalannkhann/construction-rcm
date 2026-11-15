/**
 * Push an approved application to Procore as a DRAFT subcontractor invoice
 * ("requisition").
 *
 * What is sent: the approved work-this-period and materials-stored amount of
 * every schedule line that is mapped to a Procore line item. What is never
 * sent: `origin_id` (it would make the invoice immutable), retainage amounts
 * (they need Admin on Commitments; Procore computes its own), or any status
 * other than `draft`. Billing periods are looked up, never created.
 *
 * The outcome is recorded literally: a `transfers` row says completed or
 * failed, and the application is marked synced only when Procore returned the
 * id of the invoice it created.
 */
import { and, eq } from 'drizzle-orm';
import { centsToDecimalString, formatMoney } from '@/lib/money';
import { formatDate, pluralize } from '@/lib/utils';
import type { DB } from '@/db';
import { contracts, payApplications, projects, sovLines, transfers } from '@/db/schema';
import { recordAudit } from '@/server/audit';
import { assertCan, can, UserError, type Ctx } from '@/server/auth/permissions';
import { newId } from '@/server/ids';
import { notifyPermission } from '@/server/services/notify';
import type { ApprovedRecord } from '@/server/types';
import { procoreBodyId, procoreId } from './client';
import { describeProcoreError, openProcore, procoreStatus } from './connection';
import { NOT_CONFIGURED, NOT_CONNECTED, updateIntegration } from './oauth';

const SOURCE = 'procore';
const USE_FILE_EXPORT = 'use file export';

export type ProcorePushAvailability = { available: boolean; reason: string | null };
export type ProcorePushResult = { transferId: string; status: 'completed' | 'failed'; externalRef: string | null; error: string | null };

type Plan = {
  applicationId: string;
  record: ApprovedRecord;
  /** Procore project id. */
  projectId: string;
  /** Procore work order contract id. */
  commitmentId: string;
  items: Array<{ lineItemId: string; work: number; stored: number }>;
};

type Evaluation = { available: true; plan: Plan } | { available: false; reason: string };

const no = (reason: string): Evaluation => ({ available: false, reason });

async function evaluate(db: DB, ctx: Ctx, applicationId: string): Promise<Evaluation> {
  const [app] = await db.select().from(payApplications).where(and(eq(payApplications.orgId, ctx.orgId), eq(payApplications.id, applicationId)));
  if (!app) throw new UserError('Application not found.');
  if (!can(ctx.role, 'export:run')) return no('Your role cannot send applications to Procore.');

  const status = await procoreStatus(db, ctx);
  if (!status.configured) return no(NOT_CONFIGURED);
  if (!status.connected) return no(status.lastError ? `Procore is not connected. ${status.lastError}` : NOT_CONNECTED);
  if (status.needsCompany) return no('Procore is connected, but no company has been chosen. Choose one in Settings → Integrations.');

  const record = app.approvedRecord;
  if (app.status !== 'approved' || !record) return no('Only approved applications can be sent to Procore.');

  const [sent] = await db
    .select({ externalRef: transfers.externalRef })
    .from(transfers)
    .where(and(eq(transfers.orgId, ctx.orgId), eq(transfers.payApplicationId, app.id), eq(transfers.kind, SOURCE), eq(transfers.status, 'completed')));
  if (sent || app.transferStatus === 'synced') return no(`This application was already sent to Procore${sent?.externalRef ? ` (invoice ${sent.externalRef})` : ''}.`);

  const [contract] = app.contractId ? await db.select().from(contracts).where(and(eq(contracts.orgId, ctx.orgId), eq(contracts.id, app.contractId))) : [];
  const [project] = contract ? await db.select().from(projects).where(and(eq(projects.orgId, ctx.orgId), eq(projects.id, contract.projectId))) : [];
  const commitmentId = contract?.externalSource === SOURCE ? contract.externalId : null;
  const projectId = project?.externalSource === SOURCE ? project.externalId : null;
  if (!contract || !commitmentId || !projectId) {
    return no(`This application’s ${!projectId ? 'project' : 'subcontract'} was not imported from Procore, so there is nothing in Procore to attach an invoice to. Create or import the subcontract from Procore to enable this, or ${USE_FILE_EXPORT}.`);
  }

  const schedule = new Map((await db.select().from(sovLines).where(and(eq(sovLines.orgId, ctx.orgId), eq(sovLines.contractId, contract.id)))).map((s) => [s.id, s]));
  const lineOf = (sovLineId: string | null) => (sovLineId ? schedule.get(sovLineId) : undefined);
  const billed = record.lines.filter((l) => l.thisPeriod !== 0 || l.stored !== 0);
  const name = (l: ApprovedRecord['lines'][number]) => `${l.itemNo ?? '—'} “${l.description ?? ''}”`;

  const onChangeOrder = billed.filter((l) => lineOf(l.sovLineId)?.changeOrderId);
  if (onChangeOrder.length > 0) {
    return no(`This application bills against change-order ${onChangeOrder.length === 1 ? 'line' : 'lines'} ${onChangeOrder.map(name).join(', ')} this period. Pushing change-order billing is not supported yet; ${USE_FILE_EXPORT}.`);
  }
  const unmapped = billed.find((l) => !lineOf(l.sovLineId)?.externalId);
  if (unmapped) {
    return no(`Line ${name(unmapped)} has billing this period but no Procore line id, so Procore would not know where to put it. Re-import the project from Procore to link it, or ${USE_FILE_EXPORT}.`);
  }

  const items: Plan['items'] = [];
  for (const l of record.lines) {
    const line = lineOf(l.sovLineId);
    if (line?.externalId && !line.changeOrderId) items.push({ lineItemId: line.externalId, work: l.thisPeriod, stored: l.stored });
  }
  if (items.length === 0) return no(`None of this application’s lines are linked to a Procore schedule line. Re-import the project from Procore, or ${USE_FILE_EXPORT}.`);

  return { available: true, plan: { applicationId: app.id, record, projectId, commitmentId, items } };
}

/** Whether "Send to Procore" can be offered for this application, and if not, exactly why. */
export async function canPushToProcore(db: DB, ctx: Ctx, applicationId: string): Promise<ProcorePushAvailability> {
  const evaluation = await evaluate(db, ctx, applicationId);
  return evaluation.available ? { available: true, reason: null } : { available: false, reason: evaluation.reason };
}

const day = (v: unknown): string | null => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v) ? v.slice(0, 10) : null);

type Sent = { invoiceId: string; period: { id: string; start: string; end: string } };

async function send(db: DB, ctx: Ctx, plan: Plan): Promise<Sent> {
  const { client } = await openProcore(db, ctx.orgId);
  const { application } = plan.record;

  const periods = await client.getAll<Record<string, unknown>>(`/rest/v1.0/projects/${plan.projectId}/billing_periods`);
  let period: Sent['period'] | null = null;
  for (const p of periods) {
    const id = procoreId(p.id);
    const start = day(p.start_date);
    const end = day(p.end_date);
    if (id && start && end && start <= application.periodTo && application.periodTo <= end) {
      period = { id, start, end };
      break;
    }
  }
  // We do not create billing periods: they belong to the project team in Procore.
  if (!period) throw new UserError(`No billing period in Procore covers ${formatDate(application.periodTo)}. Create it in Procore and try again.`);

  const created = await client.post<Record<string, unknown> | null>('/rest/v1.1/requisitions', {
    project_id: procoreBodyId(plan.projectId),
    commitment_id: procoreBodyId(plan.commitmentId),
    requisition: {
      period_id: procoreBodyId(period.id),
      requisition_start: period.start,
      requisition_end: period.end,
      billing_date: application.periodTo,
      invoice_number: String(application.number),
      status: 'draft',
      final: false,
      items: plan.items.map((item) => ({
        item_type: 'contract_item',
        line_item_id: procoreBodyId(item.lineItemId),
        work_completed_this_period: centsToDecimalString(item.work),
        materials_presently_stored: centsToDecimalString(item.stored),
      })),
    },
  });
  const invoiceId = procoreId(created?.id);
  if (!invoiceId) throw new UserError('Procore accepted the request but did not return the id of the invoice. Look at the subcontract’s invoices in Procore before sending again, so it is not created twice.');
  return { invoiceId, period };
}

/** One push per application at a time in this process, so a double click cannot create two invoices. */
const inFlight = new Set<string>();

export async function pushToProcore(db: DB, ctx: Ctx, applicationId: string): Promise<ProcorePushResult> {
  assertCan(ctx, 'export:run');
  if (inFlight.has(applicationId)) throw new UserError('This application is already being sent to Procore.');
  inFlight.add(applicationId);
  try {
    const evaluation = await evaluate(db, ctx, applicationId);
    if (!evaluation.available) throw new UserError(evaluation.reason);
    const { plan } = evaluation;
    const { record } = plan;
    const label = `${record.subcontractor.name} application #${record.application.number}`;
    const transferId = newId('trf');
    const mine = and(eq(payApplications.orgId, ctx.orgId), eq(payApplications.id, plan.applicationId));

    let sent: Sent;
    try {
      sent = await send(db, ctx, plan);
    } catch (err) {
      // Expected failures (Procore said no, or could not be reached) are recorded and returned. Anything else is a bug.
      const error = err instanceof UserError ? err.message : describeProcoreError(err);
      if (!error) throw err;
      const at = new Date();
      await db.insert(transfers).values({ id: transferId, orgId: ctx.orgId, payApplicationId: plan.applicationId, kind: SOURCE, status: 'failed', error, createdBy: ctx.userId, createdAt: at });
      // An application that was already exported to a file keeps that status.
      await db.update(payApplications).set({ transferStatus: 'failed', updatedAt: at }).where(and(mine, eq(payApplications.transferStatus, 'none')));
      await recordAudit(db, {
        orgId: ctx.orgId,
        actor: ctx,
        action: 'transfer.procore_failed',
        entityType: 'pay_application',
        entityId: plan.applicationId,
        payApplicationId: plan.applicationId,
        summary: `Sending ${label} to Procore failed. Nothing was created in Procore. ${error}`,
        data: { transferId, error, procoreProjectId: plan.projectId, procoreCommitmentId: plan.commitmentId },
        at,
      });
      await notifyPermission(db, ctx.orgId, 'integrations:manage', { type: 'integration.failed', title: `Procore push failed: ${label}`, body: error, href: `/applications/${plan.applicationId}` }, { at });
      return { transferId, status: 'failed', externalRef: null, error };
    }

    const at = new Date();
    await db.insert(transfers).values({ id: transferId, orgId: ctx.orgId, payApplicationId: plan.applicationId, kind: SOURCE, status: 'completed', externalRef: sent.invoiceId, createdBy: ctx.userId, createdAt: at });
    await db.update(payApplications).set({ transferStatus: 'synced', updatedAt: at }).where(mine);
    await updateIntegration(db, ctx.orgId, { lastSyncAt: at });
    const work = plan.items.reduce((total, i) => total + i.work, 0);
    const stored = plan.items.reduce((total, i) => total + i.stored, 0);
    await recordAudit(db, {
      orgId: ctx.orgId,
      actor: ctx,
      action: 'transfer.procore_pushed',
      entityType: 'pay_application',
      entityId: plan.applicationId,
      payApplicationId: plan.applicationId,
      summary:
        `Sent ${label} to Procore as draft invoice ${sent.invoiceId} on subcontract ${record.contract.number}, billing period ${formatDate(sent.period.start)} – ${formatDate(sent.period.end)}: ` +
        `${pluralize(plan.items.length, 'line')}, ${formatMoney(work)} work this period and ${formatMoney(stored)} materials stored. Retainage and approval status were left to Procore.`,
      data: { transferId, procoreInvoiceId: sent.invoiceId, procoreProjectId: plan.projectId, procoreCommitmentId: plan.commitmentId, procorePeriodId: sent.period.id, lines: plan.items.length, workThisPeriod: work, materialsStored: stored },
      at,
    });
    return { transferId, status: 'completed', externalRef: sent.invoiceId, error: null };
  } finally {
    inFlight.delete(applicationId);
  }
}
