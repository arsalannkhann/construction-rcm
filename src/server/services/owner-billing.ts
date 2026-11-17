/**
 * Owner billing: the main contractor's contract with the owner, its schedule
 * of values and change orders, and the main contractor's own applications for
 * payment, built from the approved subcontractor billing.
 *
 * A draft application is worked out afresh every time it is read (see
 * owner-calc.ts), so it always reflects the latest approvals, except for the
 * lines someone typed over. Submitting it freezes the figures, the checks and
 * the sources into an immutable record, which the PDF is rendered from.
 * Submitting carries a fingerprint of the figures the person was looking at;
 * if anything moved since (a subcontract approval, an edit), it is refused.
 *
 * Who does what: anyone in the organisation can read it; people who keep the
 * records (records:write) set up the contract and prepare drafts; approvers
 * (application:approve) submit, reopen and record the owner's certification;
 * downloading the PDF is an export (export:run). Always scoped to ctx.orgId.
 */
import { createHash } from 'node:crypto';
import { and, asc, desc, eq, inArray, lt, ne } from 'drizzle-orm';
import type { DB } from '@/db';
import { locked } from '@/db/tx';
import { changeOrders, contracts, ownerApplications, payApplications, primeChangeOrders, primeContracts, primeLines, projects, subcontractors } from '@/db/schema';
import { formatBps, formatMoney, sum } from '@/lib/money';
import { formatMonth } from '@/lib/utils';
import { recordAudit } from '@/server/audit';
import { assertCan, ConflictError, UserError, type Ctx } from '@/server/auth/permissions';
import { newId } from '@/server/ids';
import { PRIME_LINE_BASES, type OwnerApplicationRecord, type OwnerAppStatus, type OwnerCheck, type OwnerEntry, type OwnerHeader, type OwnerLine, type OwnerSource, type PrimeLineBasis } from '@/server/types';
import { ownerChecks, ownerHeader, ownerLines, type PrimeLineInput } from './owner-calc';

const clean = (s: string | null | undefined) => s?.trim() || null;
const isDate = (s: string | null | undefined): s is string => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`));
const required = (s: string | null | undefined, what: string) => {
  const v = s?.trim();
  if (!v) throw new UserError(`${what} is required.`);
  if (v.length > 200) throw new UserError(`${what} is too long.`);
  return v;
};
const monthOf = (date: string) => date.slice(0, 7);
const OPEN = ['processing', 'needs_matching', 'needs_review', 'pending_approval', 'on_hold'];

type PrimeRow = typeof primeContracts.$inferSelect;
type AppRow = typeof ownerApplications.$inferSelect;

// ── Reading ─────────────────────────────────────────────────────────────────

async function loadProject(db: DB, ctx: Ctx, projectId: string) {
  const [project] = await db.select().from(projects).where(and(eq(projects.orgId, ctx.orgId), eq(projects.id, projectId)));
  return project ?? null;
}

async function loadPrime(db: DB, ctx: Ctx, projectId: string): Promise<PrimeRow | null> {
  const [prime] = await db.select().from(primeContracts).where(and(eq(primeContracts.orgId, ctx.orgId), eq(primeContracts.projectId, projectId)));
  return prime ?? null;
}

async function loadLines(db: DB, primeId: string) {
  const rows = await db.select().from(primeLines).where(eq(primeLines.primeContractId, primeId)).orderBy(asc(primeLines.sortOrder), asc(primeLines.createdAt));
  const cos = await db.select().from(primeChangeOrders).where(eq(primeChangeOrders.primeContractId, primeId)).orderBy(asc(primeChangeOrders.createdAt));
  const coNumber = new Map(cos.map((c) => [c.id, c.number]));
  const lines: PrimeLineInput[] = rows.map((r) => ({
    id: r.id,
    itemNo: r.itemNo,
    description: r.description,
    scheduledValue: r.scheduledValue,
    basis: (PRIME_LINE_BASES as readonly string[]).includes(r.basis) ? (r.basis as PrimeLineBasis) : 'manual',
    contractIds: r.basis === 'subcontracts' ? r.contractIds : [],
    changeOrderNumber: r.changeOrderId ? (coNumber.get(r.changeOrderId) ?? null) : null,
  }));
  return { rows, lines, changeOrders: cos };
}

/** The project's subcontracts, each with the approved progress up to the end of `month`. */
async function loadSources(db: DB, ctx: Ctx, projectId: string, month: string, lines: PrimeLineInput[]): Promise<OwnerSource[]> {
  const rows = await db
    .select({ id: contracts.id, number: contracts.number, status: contracts.status, originalAmount: contracts.originalAmount, baseline: contracts.baseline, subcontractorName: subcontractors.name })
    .from(contracts)
    .innerJoin(subcontractors, eq(subcontractors.id, contracts.subcontractorId))
    .where(and(eq(contracts.orgId, ctx.orgId), eq(contracts.projectId, projectId)))
    .orderBy(asc(subcontractors.name), asc(contracts.number));
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.id);
  const [cos, apps] = await Promise.all([
    db.select({ contractId: changeOrders.contractId, amount: changeOrders.amount }).from(changeOrders).where(and(eq(changeOrders.orgId, ctx.orgId), inArray(changeOrders.contractId, ids), eq(changeOrders.status, 'approved'))),
    db
      .select({ id: payApplications.id, contractId: payApplications.contractId, status: payApplications.status, periodTo: payApplications.periodTo, applicationNumber: payApplications.applicationNumber, record: payApplications.approvedRecord })
      .from(payApplications)
      .where(and(eq(payApplications.orgId, ctx.orgId), inArray(payApplications.contractId, ids), ne(payApplications.status, 'void'))),
  ]);

  return rows.map((c) => {
    const mine = apps.filter((a) => a.contractId === c.id && a.periodTo !== null);
    const approved = mine
      .filter((a) => a.status === 'approved' && a.record && monthOf(a.periodTo!) <= month)
      .sort((a, b) => (a.periodTo! < b.periodTo! ? 1 : a.periodTo! > b.periodTo! ? -1 : (b.applicationNumber ?? 0) - (a.applicationNumber ?? 0)))[0];
    const record = approved?.record ?? null;
    const currentSum = c.originalAmount + sum(cos.filter((co) => co.contractId === c.id).map((co) => co.amount));
    return {
      contractId: c.id,
      contractNumber: c.number,
      subcontractorName: c.subcontractorName,
      contractSum: record ? record.approved.contractSumToDate : currentSum,
      workToDate: record ? sum(record.lines.map((l) => l.previous + l.thisPeriod)) : sum(Object.values(c.baseline?.workToDate ?? {})),
      stored: record ? sum(record.lines.map((l) => l.stored)) : 0,
      asOf: approved && record ? { applicationId: approved.id, applicationNumber: record.application.number, periodTo: record.application.periodTo } : null,
      openThisPeriod: mine.filter((a) => OPEN.includes(a.status) && monthOf(a.periodTo!) === month).length,
      primeLineIds: lines.filter((l) => l.basis === 'subcontracts' && l.contractIds.includes(c.id)).map((l) => l.id),
      status: c.status,
    };
  });
}

function fingerprintOf(periodTo: string, header: OwnerHeader, lines: OwnerLine[]): string {
  const facts = { periodTo, header, lines: lines.map((l) => [l.primeLineId, l.scheduledValue, l.previous, l.thisPeriod, l.stored, l.retainage]) };
  return createHash('sha256').update(JSON.stringify(facts)).digest('hex').slice(0, 32);
}

export type OwnerComputation = {
  lines: OwnerLine[];
  header: OwnerHeader;
  checks: OwnerCheck[];
  sources: OwnerSource[];
  changeOrders: { number: string; title: string; amount: number; approvedOn: string | null }[];
  fingerprint: string;
};

/** Work out an application's figures from the records as they stand now. */
async function compute(db: DB, ctx: Ctx, prime: PrimeRow, app: Pick<AppRow, 'id' | 'applicationNumber' | 'periodTo' | 'entries' | 'projectId'>): Promise<OwnerComputation> {
  const month = monthOf(app.periodTo);
  const { lines, changeOrders: cos } = await loadLines(db, prime.id);
  const sources = await loadSources(db, ctx, app.projectId, month, lines);
  const earlier = await db
    .select({ applicationNumber: ownerApplications.applicationNumber, status: ownerApplications.status, record: ownerApplications.record, amountDue: ownerApplications.amountDue, certifiedAmount: ownerApplications.certifiedAmount })
    .from(ownerApplications)
    .where(and(eq(ownerApplications.orgId, ctx.orgId), eq(ownerApplications.primeContractId, prime.id), lt(ownerApplications.applicationNumber, app.applicationNumber), inArray(ownerApplications.status, ['submitted', 'certified'])))
    .orderBy(desc(ownerApplications.applicationNumber));
  const last = earlier[0]?.record ?? null;
  const previous: Record<string, number> = {};
  for (const l of last?.lines ?? []) previous[l.primeLineId] = l.previous + l.thisPeriod;
  const previousCertificates = sum(earlier.map((e) => e.certifiedAmount ?? e.amountDue ?? 0));

  const approvedCos = cos.filter((c) => c.status === 'approved');
  const worked = ownerLines({ lines, sources, previous, entries: app.entries ?? {}, retainageWorkBps: prime.retainageWorkBps, retainageStoredBps: prime.retainageStoredBps });
  const header = ownerHeader({ originalAmount: prime.originalAmount, approvedChangeOrders: sum(approvedCos.map((c) => c.amount)), lines: worked, retainageWorkBps: prime.retainageWorkBps, retainageStoredBps: prime.retainageStoredBps, previousCertificates });
  const checks = ownerChecks({ month, header, lines: worked, sources, pendingChangeOrders: cos.filter((c) => c.status === 'pending').length });
  return {
    lines: worked,
    header,
    checks,
    sources,
    changeOrders: approvedCos.map((c) => ({ number: c.number, title: c.title, amount: c.amount, approvedOn: c.approvedOn })),
    fingerprint: fingerprintOf(app.periodTo, header, worked),
  };
}

function summary(app: AppRow, computed: { header: OwnerHeader } | null) {
  return {
    id: app.id,
    applicationNumber: app.applicationNumber,
    periodTo: app.periodTo,
    status: app.status as OwnerAppStatus,
    amountDue: app.status === 'draft' ? (computed?.header.currentPaymentDue ?? null) : app.amountDue,
    totalCompletedStored: computed?.header.totalCompletedStored ?? app.record?.header.totalCompletedStored ?? null,
    retainage: computed?.header.retainageTotal ?? app.record?.header.retainageTotal ?? null,
    certifiedAmount: app.certifiedAmount,
    certifiedOn: app.certifiedOn,
    submittedAt: app.submittedAt,
  };
}

/** Everything the owner billing page shows for one project. Null when the project is not in this organisation. */
export async function getOwnerBilling(db: DB, ctx: Ctx, projectId: string) {
  const project = await loadProject(db, ctx, projectId);
  if (!project) return null;
  const prime = await loadPrime(db, ctx, projectId);
  const subcontracts = await db
    .select({ id: contracts.id, number: contracts.number, title: contracts.title, status: contracts.status, originalAmount: contracts.originalAmount, subcontractorName: subcontractors.name })
    .from(contracts)
    .innerJoin(subcontractors, eq(subcontractors.id, contracts.subcontractorId))
    .where(and(eq(contracts.orgId, ctx.orgId), eq(contracts.projectId, projectId)))
    .orderBy(asc(subcontractors.name), asc(contracts.number));
  const approvedCos = subcontracts.length
    ? await db.select({ contractId: changeOrders.contractId, amount: changeOrders.amount }).from(changeOrders).where(and(eq(changeOrders.orgId, ctx.orgId), inArray(changeOrders.contractId, subcontracts.map((s) => s.id)), eq(changeOrders.status, 'approved')))
    : [];
  const subs = subcontracts.map((s) => ({ ...s, contractSum: s.originalAmount + sum(approvedCos.filter((c) => c.contractId === s.id).map((c) => c.amount)) }));
  if (!prime) return { project, prime: null, lines: [], changeOrders: [], subcontracts: subs, applications: [], billed: null };

  const { rows, lines, changeOrders: cos } = await loadLines(db, prime.id);
  const apps = await db.select().from(ownerApplications).where(and(eq(ownerApplications.orgId, ctx.orgId), eq(ownerApplications.primeContractId, prime.id))).orderBy(desc(ownerApplications.applicationNumber));
  const draft = apps.find((a) => a.status === 'draft');
  const draftComputed = draft ? await compute(db, ctx, prime, draft) : null;
  const latestFinal = apps.find((a) => a.status !== 'draft' && a.record);
  const contractSumToDate = prime.originalAmount + sum(cos.filter((c) => c.status === 'approved').map((c) => c.amount));
  return {
    project,
    prime: { ...prime, contractSumToDate, pendingChanges: sum(cos.filter((c) => c.status === 'pending').map((c) => c.amount)) },
    lines: lines.map((l) => ({ ...l, changeOrderId: rows.find((r) => r.id === l.id)?.changeOrderId ?? null })),
    changeOrders: cos.map((c) => ({ id: c.id, number: c.number, title: c.title, amount: c.amount, status: c.status, approvedOn: c.approvedOn })),
    subcontracts: subs,
    applications: apps.map((a) => summary(a, a.id === draft?.id ? draftComputed : null)),
    billed: latestFinal?.record
      ? {
          applicationNumber: latestFinal.applicationNumber,
          periodTo: latestFinal.periodTo,
          totalCompletedStored: latestFinal.record.header.totalCompletedStored,
          retainage: latestFinal.record.header.retainageTotal,
          earned: latestFinal.record.header.totalEarnedLessRetainage,
          certified: sum(apps.filter((a) => a.status === 'certified').map((a) => a.certifiedAmount ?? 0)),
          awaitingCertification: sum(apps.filter((a) => a.status === 'submitted').map((a) => a.amountDue ?? 0)),
        }
      : null,
  };
}

/** One owner application: frozen figures once submitted, worked out live while it is a draft. */
export async function getOwnerApplication(db: DB, ctx: Ctx, appId: string) {
  const [app] = await db.select().from(ownerApplications).where(and(eq(ownerApplications.orgId, ctx.orgId), eq(ownerApplications.id, appId)));
  if (!app) return null;
  const [prime] = await db.select().from(primeContracts).where(eq(primeContracts.id, app.primeContractId));
  const project = await loadProject(db, ctx, app.projectId);
  if (!prime || !project) return null;
  const computed: OwnerComputation = app.status === 'draft' || !app.record ? await compute(db, ctx, prime, app) : { lines: app.record.lines, header: app.record.header, checks: app.record.checks, sources: app.record.sources, changeOrders: app.record.changeOrders, fingerprint: app.record.fingerprint };
  const [newest] = await db
    .select({ n: ownerApplications.applicationNumber })
    .from(ownerApplications)
    .where(and(eq(ownerApplications.orgId, ctx.orgId), eq(ownerApplications.primeContractId, prime.id)))
    .orderBy(desc(ownerApplications.applicationNumber))
    .limit(1);
  const latest = !newest || newest.n === app.applicationNumber;
  return { app, prime, project, computed, isLatest: latest };
}

// ── The prime contract ──────────────────────────────────────────────────────

export type PrimeContractInput = { number?: string | null; architectName?: string | null; originalAmount: number; retainageWorkBps: number; retainageStoredBps: number; executedOn?: string | null };

function validatePrime(input: PrimeContractInput) {
  if (!Number.isSafeInteger(input.originalAmount) || input.originalAmount <= 0) throw new UserError('Enter the original contract sum.');
  for (const bps of [input.retainageWorkBps, input.retainageStoredBps]) {
    if (!Number.isInteger(bps) || bps < 0 || bps > 5000) throw new UserError('Retainage must be between 0% and 50%.');
  }
  if (input.executedOn && !isDate(input.executedOn)) throw new UserError('Enter a valid contract date.');
  const number = clean(input.number);
  const architectName = clean(input.architectName);
  if ((number?.length ?? 0) > 100 || (architectName?.length ?? 0) > 200) throw new UserError('That is too long.');
  return { number, architectName, originalAmount: input.originalAmount, retainageWorkBps: input.retainageWorkBps, retainageStoredBps: input.retainageStoredBps, executedOn: input.executedOn || null };
}

/** Set up the project's contract with the owner, or change its terms. Returns its id. */
export const savePrimeContract = locked(async function savePrimeContract(db: DB, ctx: Ctx, projectId: string, input: PrimeContractInput): Promise<string> {
  assertCan(ctx, 'records:write');
  const project = await loadProject(db, ctx, projectId);
  if (!project) throw new UserError('Project not found.');
  const values = validatePrime(input);
  const existing = await loadPrime(db, ctx, projectId);
  const terms = `${formatMoney(values.originalAmount)}, retainage ${formatBps(values.retainageWorkBps)} on work and ${formatBps(values.retainageStoredBps)} on stored materials`;
  if (!existing) {
    const id = newId('pc');
    await db.insert(primeContracts).values({ id, orgId: ctx.orgId, projectId, ...values, createdBy: ctx.userId });
    await recordAudit(db, { orgId: ctx.orgId, actor: ctx, action: 'owner_billing.contract_created', entityType: 'project', entityId: projectId, summary: `Set up the owner contract on ${project.name}: ${terms}`, data: values });
    return id;
  }
  await db.update(primeContracts).set(values).where(eq(primeContracts.id, existing.id));
  await recordAudit(db, {
    orgId: ctx.orgId,
    actor: ctx,
    action: 'owner_billing.contract_updated',
    entityType: 'project',
    entityId: projectId,
    summary: `Updated the owner contract on ${project.name}: ${terms}`,
    data: { before: { number: existing.number, originalAmount: existing.originalAmount, retainageWorkBps: existing.retainageWorkBps, retainageStoredBps: existing.retainageStoredBps }, after: values },
  });
  return existing.id;
});

/** Prime line ids that have been billed on a submitted or certified application. */
async function billedLineIds(db: DB, primeId: string): Promise<Set<string>> {
  const rows = await db.select({ record: ownerApplications.record }).from(ownerApplications).where(and(eq(ownerApplications.primeContractId, primeId), inArray(ownerApplications.status, ['submitted', 'certified'])));
  const out = new Set<string>();
  for (const r of rows) for (const l of r.record?.lines ?? []) if (l.total !== 0) out.add(l.primeLineId);
  return out;
}

export type PrimeLineSave = { id?: string; itemNo: string; description: string; scheduledValue: number; basis: PrimeLineBasis; contractIds?: string[] };

/**
 * Replace the owner schedule of values. Lines that come from owner change
 * orders keep their number, description and value (change those on the change
 * order); how they are billed can be changed here. A line already billed on a
 * submitted application cannot be removed.
 */
export const savePrimeSchedule = locked(async function savePrimeSchedule(db: DB, ctx: Ctx, projectId: string, input: PrimeLineSave[]): Promise<void> {
  assertCan(ctx, 'records:write');
  const project = await loadProject(db, ctx, projectId);
  if (!project) throw new UserError('Project not found.');
  const prime = await loadPrime(db, ctx, projectId);
  if (!prime) throw new UserError('Set up the owner contract first.');
  if (!Array.isArray(input) || input.length > 500) throw new UserError('A schedule can have up to 500 lines.');
  const projectContracts = new Set((await db.select({ id: contracts.id }).from(contracts).where(and(eq(contracts.orgId, ctx.orgId), eq(contracts.projectId, projectId)))).map((c) => c.id));
  const existing = await db.select().from(primeLines).where(eq(primeLines.primeContractId, prime.id));
  const byId = new Map(existing.map((l) => [l.id, l]));

  const seen = new Set<string>();
  const lines = input.map((l, i) => {
    const current = l.id ? byId.get(l.id) : undefined;
    if (l.id && !current) throw new UserError('A line on this schedule was changed by someone else. Reload the page and try again.');
    if (!(PRIME_LINE_BASES as readonly string[]).includes(l.basis)) throw new UserError('Choose how each line is billed.');
    const contractIds = l.basis === 'subcontracts' ? [...new Set(l.contractIds ?? [])] : [];
    if (contractIds.some((id) => !projectContracts.has(id))) throw new UserError('Link only subcontracts on this project.');
    const fromChange = current?.changeOrderId ? current : null;
    const itemNo = fromChange ? fromChange.itemNo : required(l.itemNo, `Line ${i + 1} item number`);
    const key = itemNo.toLowerCase();
    if (seen.has(key)) throw new UserError(`Item number ${itemNo} is used more than once.`);
    seen.add(key);
    const scheduledValue = fromChange ? fromChange.scheduledValue : l.scheduledValue;
    if (!Number.isSafeInteger(scheduledValue)) throw new UserError(`Line ${itemNo}: enter a valid scheduled value.`);
    return { id: current?.id, itemNo, description: fromChange ? fromChange.description : required(l.description, `Line ${itemNo} description`), scheduledValue, basis: l.basis, contractIds, changeOrderId: current?.changeOrderId ?? null };
  });

  const keep = new Set(lines.map((l) => l.id).filter(Boolean));
  const removed = existing.filter((l) => !keep.has(l.id));
  const fromChanges = removed.find((l) => l.changeOrderId);
  if (fromChanges) throw new UserError(`Line ${fromChanges.itemNo} comes from an approved owner change order. Change the change order instead.`);
  if (removed.length) {
    const billed = await billedLineIds(db, prime.id);
    const locked = removed.find((l) => billed.has(l.id));
    if (locked) throw new UserError(`Line ${locked.itemNo} “${locked.description}” has been billed to the owner and cannot be removed.`);
    await db.delete(primeLines).where(inArray(primeLines.id, removed.map((l) => l.id)));
  }
  for (const [index, l] of lines.entries()) {
    if (l.id) await db.update(primeLines).set({ itemNo: l.itemNo, description: l.description, scheduledValue: l.scheduledValue, basis: l.basis, contractIds: l.contractIds, sortOrder: index }).where(eq(primeLines.id, l.id));
    else await db.insert(primeLines).values({ id: newId('pl'), orgId: ctx.orgId, primeContractId: prime.id, itemNo: l.itemNo, description: l.description, scheduledValue: l.scheduledValue, basis: l.basis, contractIds: l.contractIds, sortOrder: index });
  }
  const total = sum(lines.map((l) => l.scheduledValue));
  await recordAudit(db, {
    orgId: ctx.orgId,
    actor: ctx,
    action: 'owner_billing.schedule_saved',
    entityType: 'project',
    entityId: projectId,
    summary: `Saved the owner schedule of values on ${project.name}: ${lines.length} lines totalling ${formatMoney(total)}${removed.length ? `, ${removed.length} removed` : ''}`,
    data: { lines: lines.length, total, removed: removed.map((l) => l.itemNo), linked: lines.filter((l) => l.basis === 'subcontracts').map((l) => ({ itemNo: l.itemNo, contractIds: l.contractIds })) },
  });
});

// ── Owner change orders ─────────────────────────────────────────────────────

export type PrimeChangeOrderInput = { number: string; title: string; amount: number; status: 'pending' | 'approved' | 'rejected' | 'void'; approvedOn?: string | null };

function validateChange(input: PrimeChangeOrderInput) {
  if (!Number.isSafeInteger(input.amount) || input.amount === 0) throw new UserError('Enter the change order amount (negative for a deduct).');
  if (!['pending', 'approved', 'rejected', 'void'].includes(input.status)) throw new UserError('Unknown status.');
  if (input.approvedOn && !isDate(input.approvedOn)) throw new UserError('Enter a valid approval date.');
  return { number: required(input.number, 'Change order number'), title: required(input.title, 'Description'), amount: input.amount, status: input.status, approvedOn: input.status === 'approved' ? input.approvedOn || new Date().toISOString().slice(0, 10) : null };
}

/** An approved owner change order has a line of its own on the schedule; anything else has none. */
async function syncChangeLine(db: DB, orgId: string, co: typeof primeChangeOrders.$inferSelect): Promise<void> {
  const [line] = await db.select().from(primeLines).where(eq(primeLines.changeOrderId, co.id));
  if (co.status === 'approved') {
    if (line) {
      await db.update(primeLines).set({ itemNo: co.number, description: co.title, scheduledValue: co.amount }).where(eq(primeLines.id, line.id));
      return;
    }
    const siblings = await db.select({ sortOrder: primeLines.sortOrder, itemNo: primeLines.itemNo }).from(primeLines).where(eq(primeLines.primeContractId, co.primeContractId));
    if (siblings.some((s) => s.itemNo.toLowerCase() === co.number.toLowerCase())) throw new UserError(`The schedule already has a line numbered ${co.number}. Give the change order a different number.`);
    await db.insert(primeLines).values({ id: newId('pl'), orgId, primeContractId: co.primeContractId, itemNo: co.number, description: co.title, scheduledValue: co.amount, basis: 'manual', contractIds: [], sortOrder: siblings.reduce((m, s) => Math.max(m, s.sortOrder), -1) + 1, changeOrderId: co.id });
    return;
  }
  if (!line) return;
  if ((await billedLineIds(db, co.primeContractId)).has(line.id)) throw new UserError(`Change order ${co.number} has been billed to the owner, so its approval cannot be withdrawn.`);
  await db.delete(primeLines).where(eq(primeLines.id, line.id));
}

export const createPrimeChangeOrder = locked(async function createPrimeChangeOrder(db: DB, ctx: Ctx, projectId: string, input: PrimeChangeOrderInput): Promise<string> {
  assertCan(ctx, 'records:write');
  const prime = await loadPrime(db, ctx, projectId);
  if (!prime) throw new UserError('Set up the owner contract first.');
  const values = validateChange(input);
  const [clash] = await db.select({ id: primeChangeOrders.id }).from(primeChangeOrders).where(and(eq(primeChangeOrders.primeContractId, prime.id), eq(primeChangeOrders.number, values.number)));
  if (clash) throw new UserError(`Owner change order ${values.number} already exists.`);
  const id = newId('pco');
  await db.insert(primeChangeOrders).values({ id, orgId: ctx.orgId, primeContractId: prime.id, ...values });
  const [co] = await db.select().from(primeChangeOrders).where(eq(primeChangeOrders.id, id));
  await syncChangeLine(db, ctx.orgId, co!);
  await recordAudit(db, { orgId: ctx.orgId, actor: ctx, action: 'owner_billing.change_order_created', entityType: 'project', entityId: projectId, summary: `Added owner change order ${values.number} “${values.title}”: ${formatMoney(values.amount)}, ${values.status}`, data: { changeOrderId: id, ...values } });
  return id;
});

export const updatePrimeChangeOrder = locked(async function updatePrimeChangeOrder(db: DB, ctx: Ctx, changeOrderId: string, input: PrimeChangeOrderInput): Promise<void> {
  assertCan(ctx, 'records:write');
  const [co] = await db.select().from(primeChangeOrders).where(and(eq(primeChangeOrders.orgId, ctx.orgId), eq(primeChangeOrders.id, changeOrderId)));
  if (!co) throw new UserError('Change order not found.');
  const values = validateChange(input);
  if (values.status === 'approved' && co.status === 'approved' && !input.approvedOn) values.approvedOn = co.approvedOn;
  if (values.number !== co.number) {
    const [clash] = await db.select({ id: primeChangeOrders.id }).from(primeChangeOrders).where(and(eq(primeChangeOrders.primeContractId, co.primeContractId), eq(primeChangeOrders.number, values.number)));
    if (clash) throw new UserError(`Owner change order ${values.number} already exists.`);
  }
  await syncChangeLine(db, ctx.orgId, { ...co, ...values });
  await db.update(primeChangeOrders).set(values).where(eq(primeChangeOrders.id, changeOrderId));
  const [prime] = await db.select({ projectId: primeContracts.projectId }).from(primeContracts).where(eq(primeContracts.id, co.primeContractId));
  const becameApproved = values.status === 'approved' && co.status !== 'approved';
  await recordAudit(db, {
    orgId: ctx.orgId,
    actor: ctx,
    action: becameApproved ? 'owner_billing.change_order_approved' : 'owner_billing.change_order_updated',
    entityType: 'project',
    entityId: prime?.projectId ?? null,
    summary: `${becameApproved ? 'Approved' : 'Updated'} owner change order ${values.number}: ${formatMoney(values.amount)}, ${values.status}`,
    data: { changeOrderId, before: { status: co.status, amount: co.amount }, after: values },
  });
});

// ── Owner applications ──────────────────────────────────────────────────────

const lastDayOf = (month: string) => {
  const [y, m] = month.split('-').map(Number);
  return new Date(Date.UTC(y!, m!, 0)).toISOString().slice(0, 10);
};

/** The period a new application would most likely cover: the month after the last one, or the current month. */
export function suggestedPeriod(lastPeriodTo: string | null, today: Date = new Date()): string {
  if (!lastPeriodTo) return lastDayOf(today.toISOString().slice(0, 7));
  const [y, m] = lastPeriodTo.split('-').map(Number);
  return lastDayOf(new Date(Date.UTC(y!, m!, 15)).toISOString().slice(0, 7));
}

/** Start the next application to the owner. Only one draft at a time, each for a later period than the last. */
export const startOwnerApplication = locked(async function startOwnerApplication(db: DB, ctx: Ctx, projectId: string, periodTo: string): Promise<string> {
  assertCan(ctx, 'records:write');
  const project = await loadProject(db, ctx, projectId);
  if (!project) throw new UserError('Project not found.');
  const prime = await loadPrime(db, ctx, projectId);
  if (!prime) throw new UserError('Set up the owner contract first.');
  if (!isDate(periodTo)) throw new UserError('Enter the date the period runs to.');
  const apps = await db.select().from(ownerApplications).where(eq(ownerApplications.primeContractId, prime.id)).orderBy(desc(ownerApplications.applicationNumber));
  const draft = apps.find((a) => a.status === 'draft');
  if (draft) throw new UserError(`Application #${draft.applicationNumber} is still a draft. Submit or delete it first.`);
  const last = apps[0];
  if (last && periodTo <= last.periodTo) throw new UserError(`Application #${last.applicationNumber} runs to ${last.periodTo}. The next one must cover a later period.`);
  const id = newId('oa');
  const applicationNumber = (last?.applicationNumber ?? 0) + 1;
  await db.insert(ownerApplications).values({ id, orgId: ctx.orgId, projectId, primeContractId: prime.id, applicationNumber, periodTo, preparedBy: ctx.userId });
  await recordAudit(db, { orgId: ctx.orgId, actor: ctx, action: 'owner_billing.application_started', entityType: 'owner_application', entityId: id, summary: `Started owner application #${applicationNumber} on ${project.name}, period to ${periodTo}`, data: { projectId, applicationNumber, periodTo } });
  return id;
});

async function loadApp(db: DB, ctx: Ctx, appId: string): Promise<AppRow> {
  const [app] = await db.select().from(ownerApplications).where(and(eq(ownerApplications.orgId, ctx.orgId), eq(ownerApplications.id, appId)));
  if (!app) throw new UserError('Owner application not found.');
  return app;
}

const stale = () => new ConflictError('This owner application changed while you had it open. The page has been updated: check the figures again.');

export type OwnerEntryChange = { primeLineId: string; thisPeriod: number | null; stored: number | null; note?: string | null };

/**
 * Type over the worked-out figures on some lines of a draft, or (with both
 * amounts null) go back to the worked-out figures. `version` is the one the
 * person was looking at.
 */
export const saveOwnerEntries = locked(async function saveOwnerEntries(db: DB, ctx: Ctx, appId: string, version: number, changes: OwnerEntryChange[]): Promise<void> {
  assertCan(ctx, 'records:write');
  const app = await loadApp(db, ctx, appId);
  if (app.status !== 'draft') throw new UserError('Only a draft can be changed. Reopen it first.');
  if (app.version !== version) throw stale();
  if (!Array.isArray(changes) || changes.length === 0) return;
  const lineIds = new Set((await db.select({ id: primeLines.id }).from(primeLines).where(eq(primeLines.primeContractId, app.primeContractId))).map((l) => l.id));
  const entries: Record<string, OwnerEntry> = { ...(app.entries ?? {}) };
  const at = new Date().toISOString();
  const described: string[] = [];
  for (const c of changes) {
    if (!lineIds.has(c.primeLineId)) throw stale();
    if (c.thisPeriod === null && c.stored === null) {
      if (entries[c.primeLineId]) described.push(`${c.primeLineId}: back to worked-out figures`);
      delete entries[c.primeLineId];
      continue;
    }
    const thisPeriod = c.thisPeriod ?? 0;
    const stored = c.stored ?? 0;
    if (!Number.isSafeInteger(thisPeriod) || !Number.isSafeInteger(stored)) throw new UserError('Enter amounts in dollars and cents.');
    const note = clean(c.note);
    if ((note?.length ?? 0) > 500) throw new UserError('Keep the note under 500 characters.');
    entries[c.primeLineId] = { thisPeriod, stored, note, by: ctx.userName, at };
    described.push(`${c.primeLineId}: this period ${formatMoney(thisPeriod)}, stored ${formatMoney(stored)}`);
  }
  await db.update(ownerApplications).set({ entries, version: app.version + 1, updatedAt: new Date() }).where(eq(ownerApplications.id, app.id));
  await recordAudit(db, { orgId: ctx.orgId, actor: ctx, action: 'owner_billing.application_edited', entityType: 'owner_application', entityId: app.id, summary: `Changed ${changes.length} line${changes.length === 1 ? '' : 's'} on owner application #${app.applicationNumber}`, data: { changes: described } });
});

/**
 * Submit the application to the owner: freeze the figures. Refused if there
 * is a blocking check, or if the figures moved since the person looked at
 * them (`fingerprint`).
 */
export const submitOwnerApplication = locked(async function submitOwnerApplication(db: DB, ctx: Ctx, appId: string, fingerprint: string): Promise<void> {
  assertCan(ctx, 'application:approve');
  const app = await loadApp(db, ctx, appId);
  if (app.status !== 'draft') throw new UserError('This application has already been submitted.');
  const [prime] = await db.select().from(primeContracts).where(eq(primeContracts.id, app.primeContractId));
  const project = await loadProject(db, ctx, app.projectId);
  if (!prime || !project) throw new UserError('Owner application not found.');
  const computed = await compute(db, ctx, prime, app);
  if (computed.fingerprint !== fingerprint) throw stale();
  const blocking = computed.checks.find((c) => c.severity === 'blocking');
  if (blocking) throw new UserError(`It cannot be submitted yet: ${blocking.title.charAt(0).toLowerCase()}${blocking.title.slice(1)}.`);

  const now = new Date();
  const record: OwnerApplicationRecord = {
    schemaVersion: 1,
    submittedAt: now.toISOString(),
    submittedBy: { id: ctx.userId, name: ctx.userName, role: ctx.role },
    organization: { id: ctx.orgId, name: ctx.orgName },
    project: { id: project.id, name: project.name, number: project.number, address: project.address, city: project.city, state: project.state, ownerName: project.ownerName },
    primeContract: { id: prime.id, number: prime.number, architectName: prime.architectName, executedOn: prime.executedOn, originalAmount: prime.originalAmount, retainageWorkBps: prime.retainageWorkBps, retainageStoredBps: prime.retainageStoredBps },
    application: { id: app.id, number: app.applicationNumber, periodTo: app.periodTo },
    header: computed.header,
    lines: computed.lines,
    changeOrders: computed.changeOrders,
    checks: computed.checks,
    sources: computed.sources,
    fingerprint: computed.fingerprint,
  };
  await db.update(ownerApplications).set({ status: 'submitted', record, amountDue: computed.header.currentPaymentDue, submittedAt: now, submittedBy: ctx.userId, version: app.version + 1, updatedAt: now }).where(eq(ownerApplications.id, app.id));
  await recordAudit(db, {
    orgId: ctx.orgId,
    actor: ctx,
    action: 'owner_billing.application_submitted',
    entityType: 'owner_application',
    entityId: app.id,
    summary: `Submitted owner application #${app.applicationNumber} on ${project.name} for ${formatMonth(app.periodTo)}: ${formatMoney(computed.header.currentPaymentDue)} due`,
    data: { header: computed.header, warnings: computed.checks.filter((c) => c.severity === 'warning').map((c) => c.title), sources: computed.sources.filter((s) => s.asOf).map((s) => s.asOf!.applicationId) },
    at: now,
  });
});

/** Take a submitted application back to a draft, for a correction the owner asked for. Only the latest, and not once certified. */
export const reopenOwnerApplication = locked(async function reopenOwnerApplication(db: DB, ctx: Ctx, appId: string, reason: string): Promise<void> {
  assertCan(ctx, 'application:approve');
  const app = await loadApp(db, ctx, appId);
  if (app.status === 'draft') return;
  if (app.status === 'certified') throw new UserError('A certified application cannot be reopened. Correct it on the next application.');
  const why = reason?.trim() ?? '';
  if (why.length < 5) throw new UserError('Say why it is being reopened. It is kept with the record.');
  const [later] = await db.select({ n: ownerApplications.applicationNumber }).from(ownerApplications).where(and(eq(ownerApplications.primeContractId, app.primeContractId), eq(ownerApplications.orgId, ctx.orgId))).orderBy(desc(ownerApplications.applicationNumber)).limit(1);
  if (later && later.n > app.applicationNumber) throw new UserError(`Application #${later.n} comes after this one. Only the latest application can be reopened.`);
  await db.update(ownerApplications).set({ status: 'draft', record: null, amountDue: null, submittedAt: null, submittedBy: null, version: app.version + 1, updatedAt: new Date() }).where(eq(ownerApplications.id, app.id));
  await recordAudit(db, {
    orgId: ctx.orgId,
    actor: ctx,
    action: 'owner_billing.application_reopened',
    entityType: 'owner_application',
    entityId: app.id,
    summary: `Reopened owner application #${app.applicationNumber} (${formatMoney(app.amountDue)} as submitted) — ${why}`,
    data: { reason: why, submitted: app.record },
  });
});

export const deleteOwnerDraft = locked(async function deleteOwnerDraft(db: DB, ctx: Ctx, appId: string): Promise<void> {
  assertCan(ctx, 'records:write');
  const app = await loadApp(db, ctx, appId);
  if (app.status !== 'draft') throw new UserError('Only a draft can be deleted.');
  await db.delete(ownerApplications).where(eq(ownerApplications.id, app.id));
  await recordAudit(db, { orgId: ctx.orgId, actor: ctx, action: 'owner_billing.application_deleted', entityType: 'owner_application', entityId: app.id, summary: `Deleted the draft of owner application #${app.applicationNumber}, period to ${app.periodTo}`, data: { entries: app.entries } });
});

export type CertificationInput = { amount: number; certifiedOn: string; note?: string | null };

/** Record what the owner or architect certified for payment. It becomes part of "previous certificates" on the next application. */
export const certifyOwnerApplication = locked(async function certifyOwnerApplication(db: DB, ctx: Ctx, appId: string, input: CertificationInput): Promise<void> {
  assertCan(ctx, 'application:approve');
  const app = await loadApp(db, ctx, appId);
  if (app.status === 'draft') throw new UserError('Submit the application before recording its certification.');
  if (!Number.isSafeInteger(input.amount) || input.amount < 0) throw new UserError('Enter the amount certified.');
  if (app.amountDue !== null && input.amount > app.amountDue) throw new UserError(`The owner cannot certify more than the ${formatMoney(app.amountDue)} applied for.`);
  if (!isDate(input.certifiedOn)) throw new UserError('Enter the date it was certified.');
  const note = clean(input.note);
  if (app.amountDue !== null && input.amount < app.amountDue && (!note || note.length < 5)) throw new UserError('The certified amount is less than applied for. Say what the owner held back and why.');
  const [later] = await db.select({ n: ownerApplications.applicationNumber }).from(ownerApplications).where(and(eq(ownerApplications.primeContractId, app.primeContractId), eq(ownerApplications.orgId, ctx.orgId), ne(ownerApplications.status, 'draft'))).orderBy(desc(ownerApplications.applicationNumber)).limit(1);
  if (app.status === 'certified' && later && later.n > app.applicationNumber) throw new UserError('A later application has been submitted on the basis of this certification, so it can no longer be changed.');
  await db.update(ownerApplications).set({ status: 'certified', certifiedAmount: input.amount, certifiedOn: input.certifiedOn, certificationNote: note, certifiedBy: ctx.userId, certifiedAt: new Date(), version: app.version + 1, updatedAt: new Date() }).where(eq(ownerApplications.id, app.id));
  await recordAudit(db, {
    orgId: ctx.orgId,
    actor: ctx,
    action: 'owner_billing.application_certified',
    entityType: 'owner_application',
    entityId: app.id,
    summary: `Recorded the owner's certification of application #${app.applicationNumber}: ${formatMoney(input.amount)} on ${input.certifiedOn}${app.amountDue !== null && input.amount !== app.amountDue ? ` (${formatMoney(app.amountDue)} applied for)` : ''}${note ? ` — ${note}` : ''}`,
    data: { amount: input.amount, certifiedOn: input.certifiedOn, note, applied: app.amountDue, before: app.status === 'certified' ? { amount: app.certifiedAmount, certifiedOn: app.certifiedOn } : null },
  });
});

/** The record a PDF is rendered from: the frozen one, or for a draft the figures as they stand. */
export async function ownerApplicationForPdf(db: DB, ctx: Ctx, appId: string): Promise<{ record: OwnerApplicationRecord; draft: boolean; filename: string }> {
  assertCan(ctx, 'export:run');
  const found = await getOwnerApplication(db, ctx, appId);
  if (!found) throw new UserError('Owner application not found.');
  const { app, prime, project, computed } = found;
  const draft = app.status === 'draft' || !app.record;
  const record: OwnerApplicationRecord = draft
    ? {
        schemaVersion: 1,
        submittedAt: new Date().toISOString(),
        submittedBy: { id: ctx.userId, name: ctx.userName, role: ctx.role },
        organization: { id: ctx.orgId, name: ctx.orgName },
        project: { id: project.id, name: project.name, number: project.number, address: project.address, city: project.city, state: project.state, ownerName: project.ownerName },
        primeContract: { id: prime.id, number: prime.number, architectName: prime.architectName, executedOn: prime.executedOn, originalAmount: prime.originalAmount, retainageWorkBps: prime.retainageWorkBps, retainageStoredBps: prime.retainageStoredBps },
        application: { id: app.id, number: app.applicationNumber, periodTo: app.periodTo },
        header: computed.header,
        lines: computed.lines,
        changeOrders: computed.changeOrders,
        checks: computed.checks,
        sources: computed.sources,
        fingerprint: computed.fingerprint,
      }
    : app.record!;
  await recordAudit(db, {
    orgId: ctx.orgId,
    actor: ctx,
    action: 'owner_billing.pdf_downloaded',
    entityType: 'owner_application',
    entityId: app.id,
    summary: `Downloaded ${draft ? 'a draft of ' : ''}owner application #${app.applicationNumber} as PDF (${formatMoney(record.header.currentPaymentDue)} due)`,
    data: { draft, fingerprint: record.fingerprint },
  });
  const slug = (project.number ?? project.name).replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '').toLowerCase() || 'project';
  return { record, draft, filename: `owner-application-${slug}-${app.applicationNumber}-${app.periodTo}${draft ? '-draft' : ''}.pdf` };
}
