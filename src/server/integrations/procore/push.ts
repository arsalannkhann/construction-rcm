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
 * One invoice per application, even when an answer is lost:
 *
 *   1. Claim. A `transfers` row with status `sending` is written under the
 *      organisation lock. While it is fresh, no other request, on this server
 *      or another, can start a push of the same application.
 *   2. Look. The subcontract's invoices are listed from Procore. One that
 *      already carries the application's number stops the push, unless an
 *      earlier attempt from here sent exactly the same request and got no
 *      answer: then that invoice is taken to be the one it created, and it is
 *      recorded instead of creating a second.
 *   3. Create, once. The create request is never repeated automatically.
 *   4. Record what happened, literally: `completed` with the invoice id when
 *      Procore returned it or it was found; `failed` when nothing was created;
 *      `unknown` when the request went out and no usable answer came back. A
 *      claim whose server stopped before recording anything counts as
 *      `unknown` once it is older than any server function may run.
 *
 * The SHA-256 of each create request is stored on its row before the request
 * goes out. That is how step 2 knows "exactly the same request".
 */
import { and, eq } from 'drizzle-orm';
import { centsToDecimalString, formatMoney } from '@/lib/money';
import { formatDate, pluralize } from '@/lib/utils';
import type { DB } from '@/db';
import { contracts, payApplications, projects, sovLines, transfers, nextVersion } from '@/db/schema';
import { withOrgLock } from '@/db/tx';
import { recordAudit } from '@/server/audit';
import { assertCan, can, UserError, type Ctx } from '@/server/auth/permissions';
import { newId, sha256Hex } from '@/server/ids';
import { notifyPermission } from '@/server/services/notify';
import type { ApprovedRecord } from '@/server/types';
import { outcomeUnknown, ProcoreApiError, ProcoreRateLimitError, procoreBodyId, procoreId, type ProcoreClient } from './client';
import { describeProcoreError, openProcore, procoreStatus } from './connection';
import { NOT_CONFIGURED, NOT_CONNECTED, updateIntegration } from './oauth';

const SOURCE = 'procore';
const USE_FILE_EXPORT = 'use file export';
/** Longer than any server function may run (`maxDuration` is 300 seconds), so the server behind an older claim has stopped. */
const CLAIM_LEASE_MS = 6 * 60_000;

const BEING_SENT = 'This application is being sent to Procore right now. Wait a moment and look again.';
const MAY_EXIST = 'Procore may have created the invoice. Sending again checks Procore first and will not create a second one.';
const EARLIER_UNANSWERED = 'An earlier attempt to send this application got no answer from Procore, which may have created the invoice. Sending again checks Procore first and will not create a second one.';
const SERVER_STOPPED = `The server sending this stopped before it recorded Procore’s answer. ${MAY_EXIST}`;
const STOPPED_BEFORE_SENDING = 'Sending stopped because of an error in this app before anything was sent to Procore.';
const alreadySent = (invoiceId: string | null) => `This application was already sent to Procore${invoiceId ? ` (invoice ${invoiceId})` : ''}.`;

export type ProcorePushAvailability = {
  available: boolean;
  reason: string | null;
  /** Set when sending is possible but an earlier attempt's outcome is unknown. */
  warning: string | null;
};

export type ProcorePushResult = {
  transferId: string;
  /** `unknown`: the create request went out and no usable answer came back, so Procore may have the invoice. */
  status: 'completed' | 'failed' | 'unknown';
  externalRef: string | null;
  error: string | null;
  /** True when nothing was created because Procore already had the invoice an earlier, unanswered attempt sent. */
  adopted: boolean;
};

type Plan = {
  applicationId: string;
  record: ApprovedRecord;
  /** Procore project id. */
  projectId: string;
  /** Procore work order contract id. */
  commitmentId: string;
  items: Array<{ lineItemId: string; work: number; stored: number }>;
};

type Evaluation = { available: true; plan: Plan; warning: string | null } | { available: false; reason: string };

const no = (reason: string): Evaluation => ({ available: false, reason });

type TransferRow = typeof transfers.$inferSelect;

type Attempts = {
  completed: TransferRow | undefined;
  /** A claim another request holds right now. */
  sending: TransferRow | undefined;
  /** Attempts that sent the create request, or may have, and never learned what Procore did with it. */
  unanswered: TransferRow[];
};

async function attemptsOf(db: DB, orgId: string, applicationId: string, now = new Date()): Promise<Attempts> {
  const rows = await db
    .select()
    .from(transfers)
    .where(and(eq(transfers.orgId, orgId), eq(transfers.payApplicationId, applicationId), eq(transfers.kind, SOURCE)));
  const fresh = (r: TransferRow) => now.getTime() - r.createdAt.getTime() < CLAIM_LEASE_MS;
  return {
    completed: rows.find((r) => r.status === 'completed'),
    sending: rows.find((r) => r.status === 'sending' && fresh(r)),
    unanswered: rows.filter((r) => r.status === 'unknown' || (r.status === 'sending' && !fresh(r))),
  };
}

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

  const attempts = await attemptsOf(db, ctx.orgId, app.id);
  if (attempts.completed || app.transferStatus === 'synced') return no(alreadySent(attempts.completed?.externalRef ?? null));
  if (attempts.sending) return no(BEING_SENT);

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

  return { available: true, plan: { applicationId: app.id, record, projectId, commitmentId, items }, warning: attempts.unanswered.length > 0 ? EARLIER_UNANSWERED : null };
}

/** Whether "Send to Procore" can be offered for this application, and if not, exactly why. */
export async function canPushToProcore(db: DB, ctx: Ctx, applicationId: string): Promise<ProcorePushAvailability> {
  const evaluation = await evaluate(db, ctx, applicationId);
  return evaluation.available ? { available: true, reason: null, warning: evaluation.warning } : { available: false, reason: evaluation.reason, warning: null };
}

// ── Sending ─────────────────────────────────────────────────────────────────

const day = (v: unknown): string | null => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v) ? v.slice(0, 10) : null);

type Period = { id: string; start: string; end: string };

type Outcome =
  | { kind: 'created'; invoiceId: string; period: Period }
  | { kind: 'adopted'; invoiceId: string; period: Period }
  | { kind: 'failed'; error: string }
  | { kind: 'unknown'; error: string };

type Ready = { client: ProcoreClient; body: unknown; period: Period };

/** Expected failures (Procore said no, or could not be reached) as text. Anything else is a defect and is rethrown. */
function failure(err: unknown): string {
  const error = err instanceof UserError ? err.message : describeProcoreError(err);
  if (!error) throw err;
  return error;
}

/** What to say when the create request went out and no usable answer came back. */
function unanswered(err: unknown): string {
  const what =
    err instanceof ProcoreApiError && err.status === 0
      ? `Procore did not answer the request that creates the invoice (${err.excerpt}).`
      : err instanceof ProcoreApiError && err.status < 300
        ? `Procore accepted the request that creates the invoice, but its answer could not be read (${err.excerpt}).`
        : err instanceof ProcoreApiError || err instanceof ProcoreRateLimitError
          ? `Procore answered the request that creates the invoice with a server error (${err.status}).`
          : 'Sending stopped unexpectedly after the request that creates the invoice went out.';
  return `${what} ${MAY_EXIST}`;
}

function alreadyInProcore(number: string, subcontract: string, ids: string[], earlier: 'none' | 'different' | 'ambiguous'): string {
  const one = ids.length === 1;
  const which = one ? `an invoice numbered ${number} on subcontract ${subcontract} (invoice ${ids[0]})` : `${ids.length} invoices numbered ${number} on subcontract ${subcontract} (invoices ${ids.join(', ')})`;
  if (earlier === 'different') {
    return `Procore already has ${which}. An earlier attempt from here got no answer, but what would be sent now differs from what it sent, so it cannot be told whether that attempt created this invoice. Nothing was sent. Check the invoice in Procore, and correct, renumber or remove it there before sending again.`;
  }
  if (earlier === 'ambiguous') {
    return `Procore already has ${which}. An earlier attempt from here got no answer, and it cannot be told which of them, if any, it created. Nothing was sent. Remove or renumber the extra invoices in Procore, then send again.`;
  }
  return one
    ? `Procore already has ${which}. Nothing was sent. If that invoice is this application, it is already in Procore; if not, change its number in Procore and send again.`
    : `Procore already has ${which}. Nothing was sent. If one of them is this application, it is already in Procore; if not, change their numbers in Procore and send again.`;
}

/** Everything up to the create request: read Procore, build the request, and decide whether it may be sent. */
async function prepare(db: DB, ctx: Ctx, plan: Plan, claim: Claim): Promise<Ready | Outcome> {
  const { client } = await openProcore(db, ctx.orgId);
  const { application, contract } = plan.record;
  const number = String(application.number);

  // What the subcontract already has. A create request that went unanswered may have made one of these.
  const invoices = await client.getAll<Record<string, unknown>>('/rest/v1.1/requisitions', { project_id: plan.projectId, 'filters[commitment_id]': plan.commitmentId }, { perPage: 100 });
  const same = invoices.filter((i) => {
    const commitment = procoreId(i.commitment_id);
    return (commitment === null || commitment === plan.commitmentId) && String(i.invoice_number ?? '').trim() === number;
  });

  const periods = await client.getAll<Record<string, unknown>>(`/rest/v1.0/projects/${plan.projectId}/billing_periods`);
  let period: Period | null = null;
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
  if (!period) return { kind: 'failed', error: `No billing period in Procore covers ${formatDate(application.periodTo)}. Create it in Procore and try again.` };

  const body = {
    project_id: procoreBodyId(plan.projectId),
    commitment_id: procoreBodyId(plan.commitmentId),
    requisition: {
      period_id: procoreBodyId(period.id),
      requisition_start: period.start,
      requisition_end: period.end,
      billing_date: application.periodTo,
      invoice_number: number,
      status: 'draft',
      final: false,
      items: plan.items.map((item) => ({
        item_type: 'contract_item',
        line_item_id: procoreBodyId(item.lineItemId),
        work_completed_this_period: centsToDecimalString(item.work),
        materials_presently_stored: centsToDecimalString(item.stored),
      })),
    },
  };
  const hash = sha256Hex(JSON.stringify(body));

  if (same.length > 0) {
    const ids = same.map((i) => procoreId(i.id) ?? String(i.id));
    const sentBefore = claim.unanswered.includes(hash);
    if (same.length === 1 && sentBefore && procoreId(same[0]!.id)) return { kind: 'adopted', invoiceId: ids[0]!, period };
    const earlier = claim.unanswered.length === 0 ? 'none' : same.length === 1 ? 'different' : 'ambiguous';
    return { kind: 'failed', error: alreadyInProcore(number, contract.number, ids, earlier) };
  }

  // Stored before the request goes out, so a server that stops mid-request leaves enough behind to find the invoice later.
  await withOrgLock(db, ctx.orgId, (tx) => tx.update(transfers).set({ sha256: hash }).where(eq(transfers.id, claim.transferId)));
  return { client, body, period };
}

/** The create request, sent once. */
async function create({ client, body, period }: Ready): Promise<Outcome> {
  let created: Record<string, unknown> | null;
  try {
    created = await client.post<Record<string, unknown> | null>('/rest/v1.1/requisitions', body);
  } catch (err) {
    if (outcomeUnknown(err)) return { kind: 'unknown', error: unanswered(err) };
    const error = err instanceof UserError ? err.message : describeProcoreError(err);
    if (error) return { kind: 'failed', error };
    // A defect, but the request may already have gone out: leave the outcome open rather than say nothing was created.
    console.error('[procore] unexpected error while creating an invoice:', err);
    return { kind: 'unknown', error: unanswered(err) };
  }
  const invoiceId = procoreId(created?.id);
  if (!invoiceId) return { kind: 'unknown', error: `Procore accepted the request that creates the invoice but did not return its id. ${MAY_EXIST}` };
  return { kind: 'created', invoiceId, period };
}

type Claim = { transferId: string; unanswered: string[] };

/** Step 1: take this application's push, or refuse because it is done or someone else is doing it. */
async function claim(db: DB, ctx: Ctx, plan: Plan): Promise<Claim> {
  return withOrgLock(db, ctx.orgId, async (tx) => {
    const now = new Date();
    const [app] = await tx.select().from(payApplications).where(and(eq(payApplications.orgId, ctx.orgId), eq(payApplications.id, plan.applicationId)));
    if (!app || app.status !== 'approved') throw new UserError('Only approved applications can be sent to Procore.');
    const attempts = await attemptsOf(tx, ctx.orgId, plan.applicationId, now);
    if (attempts.completed || app.transferStatus === 'synced') throw new UserError(alreadySent(attempts.completed?.externalRef ?? null));
    if (attempts.sending) throw new UserError(BEING_SENT);
    for (const stale of attempts.unanswered) {
      if (stale.status === 'sending') await tx.update(transfers).set({ status: 'unknown', error: SERVER_STOPPED }).where(eq(transfers.id, stale.id));
    }
    const transferId = newId('trf');
    await tx.insert(transfers).values({ id: transferId, orgId: ctx.orgId, payApplicationId: plan.applicationId, kind: SOURCE, status: 'sending', createdBy: ctx.userId, createdAt: now });
    return { transferId, unanswered: attempts.unanswered.flatMap((a) => (a.sha256 ? [a.sha256] : [])) };
  });
}

/** Step 4: write down what happened, on the claim, the application, the audit log and, when it went wrong, for the people who manage integrations. */
async function settle(db: DB, ctx: Ctx, plan: Plan, transferId: string, outcome: Outcome): Promise<ProcorePushResult> {
  const { record } = plan;
  const label = `${record.subcontractor.name} application #${record.application.number}`;
  return withOrgLock(db, ctx.orgId, async (tx) => {
    const at = new Date();
    const mine = and(eq(payApplications.orgId, ctx.orgId), eq(payApplications.id, plan.applicationId));
    const event = { orgId: ctx.orgId, actor: ctx, entityType: 'pay_application', entityId: plan.applicationId, payApplicationId: plan.applicationId, at };
    const where = { procoreProjectId: plan.projectId, procoreCommitmentId: plan.commitmentId };

    if (outcome.kind === 'created' || outcome.kind === 'adopted') {
      await tx.update(transfers).set({ status: 'completed', externalRef: outcome.invoiceId, error: null }).where(eq(transfers.id, transferId));
      await tx.update(payApplications).set({ version: nextVersion, transferStatus: 'synced', updatedAt: at }).where(mine);
      await updateIntegration(tx, ctx.orgId, { lastSyncAt: at });
      const { period } = outcome;
      if (outcome.kind === 'adopted') {
        await recordAudit(tx, {
          ...event,
          action: 'transfer.procore_adopted',
          summary:
            `An earlier attempt to send ${label} got no answer from Procore. Procore has one invoice numbered ${record.application.number} on subcontract ${record.contract.number} (invoice ${outcome.invoiceId}), ` +
            'so it was recorded as this application’s invoice and no second one was created. Check its lines in Procore.',
          data: { transferId, procoreInvoiceId: outcome.invoiceId, ...where, procorePeriodId: period.id, adopted: true },
        });
      } else {
        const work = plan.items.reduce((total, i) => total + i.work, 0);
        const stored = plan.items.reduce((total, i) => total + i.stored, 0);
        await recordAudit(tx, {
          ...event,
          action: 'transfer.procore_pushed',
          summary:
            `Sent ${label} to Procore as draft invoice ${outcome.invoiceId} on subcontract ${record.contract.number}, billing period ${formatDate(period.start)} – ${formatDate(period.end)}: ` +
            `${pluralize(plan.items.length, 'line')}, ${formatMoney(work)} work this period and ${formatMoney(stored)} materials stored. Retainage and approval status were left to Procore.`,
          data: { transferId, procoreInvoiceId: outcome.invoiceId, ...where, procorePeriodId: period.id, lines: plan.items.length, workThisPeriod: work, materialsStored: stored },
        });
      }
      return { transferId, status: 'completed', externalRef: outcome.invoiceId, error: null, adopted: outcome.kind === 'adopted' };
    }

    const { error } = outcome;
    const unknown = outcome.kind === 'unknown';
    await tx.update(transfers).set({ status: outcome.kind, error }).where(eq(transfers.id, transferId));
    // An application that was already exported to a file keeps that status.
    await tx.update(payApplications).set({ version: nextVersion, transferStatus: 'failed', updatedAt: at }).where(and(mine, eq(payApplications.transferStatus, 'none')));
    await recordAudit(tx, {
      ...event,
      action: unknown ? 'transfer.procore_unanswered' : 'transfer.procore_failed',
      summary: unknown ? `Sent ${label} to Procore and got no usable answer. ${error}` : `Sending ${label} to Procore failed. Nothing was created in Procore. ${error}`,
      data: { transferId, error, ...where },
    });
    await notifyPermission(tx, ctx.orgId, 'integrations:manage', { type: 'integration.failed', title: `${unknown ? 'Procore did not answer' : 'Procore push failed'}: ${label}`, body: error, href: `/applications/${plan.applicationId}` }, { at });
    return { transferId, status: outcome.kind, externalRef: null, error, adopted: false };
  });
}

/** One push per application at a time in this process; the claim covers other processes. */
const inFlight = new Set<string>();

export async function pushToProcore(db: DB, ctx: Ctx, applicationId: string): Promise<ProcorePushResult> {
  assertCan(ctx, 'export:run');
  if (inFlight.has(applicationId)) throw new UserError(BEING_SENT);
  inFlight.add(applicationId);
  try {
    const evaluation = await evaluate(db, ctx, applicationId);
    if (!evaluation.available) throw new UserError(evaluation.reason);
    const { plan } = evaluation;
    const taken = await claim(db, ctx, plan);

    let outcome: Outcome;
    try {
      const ready = await prepare(db, ctx, plan, taken);
      outcome = 'kind' in ready ? ready : await create(ready);
    } catch (err) {
      let error: string;
      try {
        error = failure(err);
      } catch {
        // A defect before the create request went out. Release the claim truthfully, then let the error surface.
        await settle(db, ctx, plan, taken.transferId, { kind: 'failed', error: STOPPED_BEFORE_SENDING });
        throw err;
      }
      outcome = { kind: 'failed', error };
    }
    return await settle(db, ctx, plan, taken.transferId, outcome);
  } finally {
    inFlight.delete(applicationId);
  }
}
