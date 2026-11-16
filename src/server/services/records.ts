/**
 * Projects, subcontractors, subcontracts, schedules of values and change orders.
 *
 * Changing anything that feeds verification (contract value, retainage terms,
 * the schedule, change-order status) re-checks every undecided application on
 * that contract, so findings never go stale.
 */
import { and, asc, desc, eq, gt, inArray } from 'drizzle-orm';
import { formatBps, formatMoney, parseMoney } from '@/lib/money';
import { US_STATES } from '@/lib/utils';
import type { DB } from '@/db';
import { locked } from '@/db/tx';
import { changeOrders, contracts, payAppLines, payApplications, projects, retainageReleases, sovLines, subcontractors } from '@/db/schema';
import { recordAudit } from '@/server/audit';
import { assertCan, UserError, type Ctx } from '@/server/auth/permissions';
import { newId } from '@/server/ids';
import { describeRetainageTerms } from '@/lib/retainage';
import type { RetainageTerms } from '@/server/types';
import { rereconcileContract } from './reconcile';

const STATE_CODES = new Set(US_STATES.map(([code]) => code));
const clean = (s: string | null | undefined) => s?.trim() || null;
const required = (s: string | null | undefined, what: string) => {
  const v = s?.trim();
  if (!v) throw new UserError(`${what} is required.`);
  if (v.length > 200) throw new UserError(`${what} is too long.`);
  return v;
};
const isDate = (s: string | null | undefined) => !s || /^\d{4}-\d{2}-\d{2}$/.test(s);

// ── Projects ────────────────────────────────────────────────────────────────

/** `budget` is in cents; leave it out to keep what is on file, or pass null to clear it. */
export type ProjectInput = { name: string; number?: string | null; address?: string | null; city?: string | null; state?: string | null; ownerName?: string | null; budget?: number | null };

function validateBudget(budget: number | null | undefined): number | null | undefined {
  if (budget === undefined || budget === null) return budget;
  if (!Number.isSafeInteger(budget) || budget <= 0) throw new UserError('Enter a budget above zero, or leave it blank.');
  return budget;
}

function validateProject(input: ProjectInput) {
  const state = clean(input.state)?.toUpperCase() ?? null;
  if (state && !STATE_CODES.has(state)) throw new UserError('Choose a US state.');
  return { name: required(input.name, 'Project name'), number: clean(input.number), address: clean(input.address), city: clean(input.city), state, ownerName: clean(input.ownerName), budget: validateBudget(input.budget) };
}

export const createProject = locked(async function createProject(db: DB, ctx: Ctx, input: ProjectInput, external?: { source: string; id: string }): Promise<string> {
  assertCan(ctx, 'records:write');
  const values = { ...validateProject(input), budget: validateBudget(input.budget) ?? null };
  const id = newId('prj');
  await db.insert(projects).values({ id, orgId: ctx.orgId, ...values, externalSource: external?.source ?? null, externalId: external?.id ?? null, createdBy: ctx.userId });
  await recordAudit(db, { orgId: ctx.orgId, actor: ctx, action: 'project.created', entityType: 'project', entityId: id, summary: `Created project ${values.name}${external ? ` (imported from ${external.source})` : ''}`, data: values });
  return id;
});

export const updateProject = locked(async function updateProject(db: DB, ctx: Ctx, id: string, input: ProjectInput & { status?: 'active' | 'closed' }): Promise<void> {
  assertCan(ctx, 'records:write');
  const [project] = await db.select().from(projects).where(and(eq(projects.orgId, ctx.orgId), eq(projects.id, id)));
  if (!project) throw new UserError('Project not found.');
  const checked = validateProject(input);
  // Callers that do not know about the budget (imports, older forms) leave it as it is.
  const values = { ...checked, budget: checked.budget === undefined ? project.budget : checked.budget };
  await db.update(projects).set({ ...values, status: input.status ?? project.status }).where(eq(projects.id, id));
  await recordAudit(db, { orgId: ctx.orgId, actor: ctx, action: 'project.updated', entityType: 'project', entityId: id, summary: `Updated project ${values.name}`, data: { before: { name: project.name, state: project.state, status: project.status, budget: project.budget }, after: { ...values, status: input.status ?? project.status } } });
  // The project's state drives which statutory waiver form is expected.
  if (values.state !== project.state) {
    const rows = await db.select({ id: contracts.id }).from(contracts).where(eq(contracts.projectId, id));
    for (const c of rows) await rereconcileContract(db, ctx.orgId, c.id, { actor: ctx });
  }
});

// ── Subcontractors ──────────────────────────────────────────────────────────

export type SubcontractorInput = { name: string; trade?: string | null; contactName?: string | null; contactEmail?: string | null; phone?: string | null; address?: string | null };

function validateSub(input: SubcontractorInput) {
  const email = clean(input.contactEmail);
  if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new UserError('Enter a valid contact email.');
  return { name: required(input.name, 'Subcontractor name'), trade: clean(input.trade), contactName: clean(input.contactName), contactEmail: email, phone: clean(input.phone), address: clean(input.address) };
}

export const createSubcontractor = locked(async function createSubcontractor(db: DB, ctx: Ctx, input: SubcontractorInput, external?: { source: string; id: string }): Promise<string> {
  assertCan(ctx, 'records:write');
  const values = validateSub(input);
  const id = newId('sub');
  await db.insert(subcontractors).values({ id, orgId: ctx.orgId, ...values, externalSource: external?.source ?? null, externalId: external?.id ?? null });
  await recordAudit(db, { orgId: ctx.orgId, actor: ctx, action: 'subcontractor.created', entityType: 'subcontractor', entityId: id, summary: `Added subcontractor ${values.name}`, data: values });
  return id;
});

export const updateSubcontractor = locked(async function updateSubcontractor(db: DB, ctx: Ctx, id: string, input: SubcontractorInput): Promise<void> {
  assertCan(ctx, 'records:write');
  const [sub] = await db.select().from(subcontractors).where(and(eq(subcontractors.orgId, ctx.orgId), eq(subcontractors.id, id)));
  if (!sub) throw new UserError('Subcontractor not found.');
  const values = validateSub(input);
  await db.update(subcontractors).set(values).where(eq(subcontractors.id, id));
  await recordAudit(db, { orgId: ctx.orgId, actor: ctx, action: 'subcontractor.updated', entityType: 'subcontractor', entityId: id, summary: `Updated subcontractor ${values.name}` });
  // The name feeds waiver checks; the contact address decides whether an emailed package came from a known sender.
  if (values.name !== sub.name || values.contactEmail !== sub.contactEmail) {
    const rows = await db.select({ id: contracts.id }).from(contracts).where(eq(contracts.subcontractorId, id));
    for (const c of rows) await rereconcileContract(db, ctx.orgId, c.id, { actor: ctx });
  }
});

// ── Schedule of values ──────────────────────────────────────────────────────

export type ScheduleLineInput = { id?: string; itemNo: string; description: string; scheduledValue: number; externalId?: string | null };

/**
 * Parse a pasted or uploaded schedule: one line per row, columns separated by
 * tabs or commas, in the order item number, description, scheduled value. A
 * header row is skipped, and so are total and subtotal rows (a total that does
 * not match the lines above it is reported). Rows that cannot be read are
 * reported, not dropped.
 */
/** "Total", "Grand total:", "Subtotal", "Total contract sum", "Contract sum": a label on its own, not "Total station layout". */
const TOTAL_ROW = /^(?:(?:grand|contract)\s+)?(?:sub[\s-]?)?totals?(?:\s+(?:contract|schedule|scheduled|value|values|amount|sum|of))*\s*:?$|^contract\s+(?:sum|total|amount|value)\s*:?$/i;

export function parseScheduleText(text: string): { lines: ScheduleLineInput[]; problems: string[] } {
  const lines: ScheduleLineInput[] = [];
  const problems: string[] = [];
  const rows = text.split(/\r?\n/).map((r) => r.trim()).filter(Boolean);
  rows.forEach((row, index) => {
    const cells = row.includes('\t') ? row.split('\t') : splitCsv(row);
    const trimmed = cells.map((c) => c.trim()).filter((c, i, all) => c !== '' || i < all.length - 1);
    if (trimmed.length < 2) {
      problems.push(`Row ${index + 1}: expected an item number, a description and a value.`);
      return;
    }
    // The amount is the last cell that parses as money.
    let amountIdx = -1;
    for (let i = trimmed.length - 1; i >= 1; i--) {
      if (parseMoney(trimmed[i]!) !== null) {
        amountIdx = i;
        break;
      }
    }
    if (amountIdx < 0) {
      if (index === 0) return; // header row
      problems.push(`Row ${index + 1}: “${trimmed[trimmed.length - 1]}” is not an amount.`);
      return;
    }
    const value = parseMoney(trimmed[amountIdx]!)!;
    // A spreadsheet's total or subtotal row is not a line of work. A total is checked against the lines above it.
    const labels = trimmed.slice(0, amountIdx).filter(Boolean);
    if (labels.length === 1 && TOTAL_ROW.test(labels[0]!)) {
      const sum = lines.reduce((acc, l) => acc + l.scheduledValue, 0);
      if (!/sub/i.test(labels[0]!) && value !== sum) {
        problems.push(`Row ${index + 1}: the total row says ${formatMoney(value)}, but the rows above add up to ${formatMoney(sum)}. It was left out; check the rows.`);
      }
      return;
    }
    const itemNo = amountIdx >= 2 ? trimmed[0]! : String(lines.length + 1);
    const description = (amountIdx >= 2 ? trimmed.slice(1, amountIdx) : trimmed.slice(0, amountIdx)).filter(Boolean).join(', ').trim();
    if (!description) {
      problems.push(`Row ${index + 1}: missing a description.`);
      return;
    }
    lines.push({ itemNo: itemNo || String(lines.length + 1), description, scheduledValue: value });
  });
  return { lines, problems };
}

function splitCsv(row: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < row.length; i++) {
    const ch = row[i]!;
    if (quoted) {
      if (ch === '"' && row[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else cur += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') {
      // A comma inside a number like 1,250.00 is not a separator. The cell so far must itself be the
      // start of a number, and the three digits must end one: "Level 3,300,000.00" is a description
      // followed by an amount, and "4,200A panel" is an item number followed by a description.
      if (/^[\s$(+-]*\d{1,3}(,\d{3})*$/.test(cur) && /^\d{3}(?:[.)]|\s*(?:,|$|CR\b))/i.test(row.slice(i + 1))) cur += ch;
      else {
        out.push(cur);
        cur = '';
      }
    } else cur += ch;
  }
  out.push(cur);
  return out;
}

function validateSchedule(lines: ScheduleLineInput[]) {
  const seen = new Set<string>();
  return lines.map((l, i) => {
    const itemNo = required(l.itemNo, `Line ${i + 1} item number`);
    const key = itemNo.toLowerCase();
    if (seen.has(key)) throw new UserError(`Item number ${itemNo} is used more than once.`);
    seen.add(key);
    if (!Number.isSafeInteger(l.scheduledValue)) throw new UserError(`Line ${itemNo}: enter a valid scheduled value.`);
    return { id: l.id, itemNo, description: required(l.description, `Line ${itemNo} description`), scheduledValue: l.scheduledValue, externalId: l.externalId ?? null };
  });
}

/** Replace the base (non-change-order) schedule of a contract. */
export const saveSchedule = locked(async function saveSchedule(db: DB, ctx: Ctx, contractId: string, input: ScheduleLineInput[]): Promise<void> {
  assertCan(ctx, 'records:write');
  const [contract] = await db.select().from(contracts).where(and(eq(contracts.orgId, ctx.orgId), eq(contracts.id, contractId)));
  if (!contract) throw new UserError('Contract not found.');
  const lines = validateSchedule(input);
  const existing = (await db.select().from(sovLines).where(eq(sovLines.contractId, contractId))).filter((s) => !s.changeOrderId);
  const keep = new Set(lines.map((l) => l.id).filter(Boolean));
  const removed = existing.filter((s) => !keep.has(s.id));

  if (removed.length > 0) {
    // A line with approved billing against it is part of the financial record.
    const billed = await db
      .select({ sovLineId: payAppLines.sovLineId })
      .from(payAppLines)
      .innerJoin(payApplications, eq(payApplications.id, payAppLines.payApplicationId))
      .where(and(inArray(payAppLines.sovLineId, removed.map((r) => r.id)), eq(payApplications.status, 'approved')));
    const baselineIds = new Set(Object.keys(contract.baseline?.workToDate ?? {}));
    const locked = removed.find((r) => billed.some((b) => b.sovLineId === r.id) || baselineIds.has(r.id));
    if (locked) throw new UserError(`Line ${locked.itemNo} “${locked.description}” has approved billing against it and cannot be removed.`);
    await db.delete(sovLines).where(inArray(sovLines.id, removed.map((r) => r.id)));
  }
  for (const [index, l] of lines.entries()) {
    const current = l.id ? existing.find((e) => e.id === l.id) : undefined;
    if (current) {
      await db.update(sovLines).set({ itemNo: l.itemNo, description: l.description, scheduledValue: l.scheduledValue, sortOrder: index }).where(eq(sovLines.id, current.id));
    } else {
      await db.insert(sovLines).values({ id: newId('sov'), orgId: ctx.orgId, contractId, itemNo: l.itemNo, description: l.description, scheduledValue: l.scheduledValue, sortOrder: index, externalId: l.externalId });
    }
  }
  const total = lines.reduce((a, l) => a + l.scheduledValue, 0);
  await recordAudit(db, {
    orgId: ctx.orgId,
    actor: ctx,
    action: 'contract.schedule_saved',
    entityType: 'contract',
    entityId: contractId,
    summary: `Saved schedule of values for contract ${contract.number}: ${lines.length} lines totalling ${formatMoney(total)}${removed.length ? `, ${removed.length} removed` : ''}`,
    data: { lines: lines.length, total, removed: removed.map((r) => r.itemNo) },
  });
  await rereconcileContract(db, ctx.orgId, contractId, { actor: ctx });
});

// ── Contracts ───────────────────────────────────────────────────────────────

export type ContractInput = {
  projectId: string;
  subcontractorId: string;
  number: string;
  title: string;
  originalAmount: number;
  retainageWorkBps: number;
  retainageStoredBps: number;
  /** A change of rate part-way through the contract. Null for a flat rate. */
  retainageReduction?: RetainageTerms['reduction'];
  executedOn?: string | null;
  schedule?: ScheduleLineInput[];
};

function validateReduction(reduction: RetainageTerms['reduction'] | undefined, workBps: number): RetainageTerms['reduction'] {
  if (!reduction) return null;
  const { atPercentBps, toBps, appliesTo } = reduction;
  if (!Number.isInteger(atPercentBps) || atPercentBps < 100 || atPercentBps > 9900) throw new UserError('The rate must change somewhere between 1% and 99% complete.');
  if (!Number.isInteger(toBps) || toBps < 0 || toBps >= workBps) throw new UserError('The reduced retainage rate must be lower than the starting rate.');
  if (appliesTo !== 'future_work' && appliesTo !== 'all_work') throw new UserError('Choose whether the reduced rate applies to further work only or to all work.');
  return { atPercentBps, toBps, appliesTo };
}

function validateTerms(input: Pick<ContractInput, 'originalAmount' | 'retainageWorkBps' | 'retainageStoredBps' | 'executedOn'>) {
  if (!Number.isSafeInteger(input.originalAmount) || input.originalAmount <= 0) throw new UserError('Enter the original contract amount.');
  for (const bps of [input.retainageWorkBps, input.retainageStoredBps]) {
    if (!Number.isInteger(bps) || bps < 0 || bps > 5000) throw new UserError('Retainage must be between 0% and 50%.');
  }
  if (!isDate(input.executedOn)) throw new UserError('Enter a valid contract date.');
}

export const createContract = locked(async function createContract(db: DB, ctx: Ctx, input: ContractInput, external?: { source: string; id: string }): Promise<string> {
  assertCan(ctx, 'records:write');
  validateTerms(input);
  const [project] = await db.select().from(projects).where(and(eq(projects.orgId, ctx.orgId), eq(projects.id, input.projectId)));
  const [sub] = await db.select().from(subcontractors).where(and(eq(subcontractors.orgId, ctx.orgId), eq(subcontractors.id, input.subcontractorId)));
  if (!project) throw new UserError('Choose a project.');
  if (!sub) throw new UserError('Choose a subcontractor.');
  const number = required(input.number, 'Contract number');
  const title = required(input.title, 'Scope / title');
  const [clash] = await db.select({ id: contracts.id }).from(contracts).where(and(eq(contracts.orgId, ctx.orgId), eq(contracts.projectId, project.id), eq(contracts.number, number)));
  if (clash) throw new UserError(`Contract ${number} already exists on this project.`);
  const schedule = input.schedule ? validateSchedule(input.schedule) : [];
  const reduction = validateReduction(input.retainageReduction, input.retainageWorkBps);
  const terms: RetainageTerms | null = reduction ? { reduction } : null;

  const id = newId('con');
  await db.insert(contracts).values({
    id,
    orgId: ctx.orgId,
    projectId: project.id,
    subcontractorId: sub.id,
    number,
    title,
    originalAmount: input.originalAmount,
    retainageWorkBps: input.retainageWorkBps,
    retainageStoredBps: input.retainageStoredBps,
    retainageTerms: terms,
    executedOn: input.executedOn || null,
    externalSource: external?.source ?? null,
    externalId: external?.id ?? null,
  });
  if (schedule.length > 0) {
    await db.insert(sovLines).values(schedule.map((l, index) => ({ id: newId('sov'), orgId: ctx.orgId, contractId: id, itemNo: l.itemNo, description: l.description, scheduledValue: l.scheduledValue, sortOrder: index, externalId: l.externalId })));
  }
  await recordAudit(db, {
    orgId: ctx.orgId,
    actor: ctx,
    action: 'contract.created',
    entityType: 'contract',
    entityId: id,
    summary: `Created subcontract ${number} with ${sub.name} on ${project.name}: ${formatMoney(input.originalAmount)}, retainage ${describeRetainageTerms(input.retainageWorkBps, terms)}${external ? ` (imported from ${external.source})` : ''}`,
    data: { number, title, originalAmount: input.originalAmount, retainageWorkBps: input.retainageWorkBps, retainageStoredBps: input.retainageStoredBps, retainageTerms: terms, scheduleLines: schedule.length },
  });
  return id;
});

export type ContractPatch = {
  number: string;
  title: string;
  originalAmount: number;
  retainageWorkBps: number;
  retainageStoredBps: number;
  /** Leave out to keep the current terms; null for a flat rate. */
  retainageReduction?: RetainageTerms['reduction'];
  executedOn?: string | null;
  status?: 'active' | 'closed';
};

export const updateContract = locked(async function updateContract(db: DB, ctx: Ctx, id: string, patch: ContractPatch): Promise<void> {
  assertCan(ctx, 'records:write');
  const [contract] = await db.select().from(contracts).where(and(eq(contracts.orgId, ctx.orgId), eq(contracts.id, id)));
  if (!contract) throw new UserError('Contract not found.');
  validateTerms(patch);
  const reduction = validateReduction(patch.retainageReduction === undefined ? (contract.retainageTerms?.reduction ?? null) : patch.retainageReduction, patch.retainageWorkBps);
  const retainageTerms: RetainageTerms | null = reduction ? { reduction } : null;
  const next = { number: required(patch.number, 'Contract number'), title: required(patch.title, 'Scope / title'), originalAmount: patch.originalAmount, retainageWorkBps: patch.retainageWorkBps, retainageStoredBps: patch.retainageStoredBps, retainageTerms, executedOn: patch.executedOn || null, status: patch.status ?? contract.status };
  const changes: string[] = [];
  const before = describeRetainageTerms(contract.retainageWorkBps, contract.retainageTerms);
  const after = describeRetainageTerms(next.retainageWorkBps, retainageTerms);
  if (next.originalAmount !== contract.originalAmount) changes.push(`original amount ${formatMoney(contract.originalAmount)} → ${formatMoney(next.originalAmount)}`);
  if (before !== after) changes.push(`retainage on work ${before} → ${after}`);
  if (next.retainageStoredBps !== contract.retainageStoredBps) changes.push(`retainage on stored material ${formatBps(contract.retainageStoredBps)} → ${formatBps(next.retainageStoredBps)}`);
  if (next.number !== contract.number) changes.push(`number ${contract.number} → ${next.number}`);
  if (next.title !== contract.title) changes.push('title changed');
  if (next.status !== contract.status) changes.push(`status ${contract.status} → ${next.status}`);
  if (changes.length === 0 && next.executedOn === contract.executedOn) return;
  await db.update(contracts).set(next).where(eq(contracts.id, id));
  await recordAudit(db, { orgId: ctx.orgId, actor: ctx, action: 'contract.updated', entityType: 'contract', entityId: id, summary: `Updated contract ${next.number}${changes.length ? `: ${changes.join('; ')}` : ''}`, data: { changes } });
  await rereconcileContract(db, ctx.orgId, id, { actor: ctx });
});

// ── Retainage releases ──────────────────────────────────────────────────────

export type RetainageReleaseInput = { amount: number; effectiveOn: string; note: string };

/** Retainage held on a contract as of its last approved application, less releases that have not been billed yet. */
async function retainageAvailable(db: DB, orgId: string, contract: typeof contracts.$inferSelect): Promise<{ held: number | null; pending: number }> {
  const [last] = await db
    .select({ retainage: payApplications.approvedRetainage, periodTo: payApplications.periodTo })
    .from(payApplications)
    .where(and(eq(payApplications.orgId, orgId), eq(payApplications.contractId, contract.id), eq(payApplications.status, 'approved')))
    .orderBy(desc(payApplications.applicationNumber))
    .limit(1);
  const held = last ? (last.retainage ?? 0) : (contract.baseline?.retainageHeld ?? null);
  // Releases already counted in that approval are inside `held`; later ones are still to come off it.
  const later = await db
    .select({ amount: retainageReleases.amount })
    .from(retainageReleases)
    .where(and(eq(retainageReleases.contractId, contract.id), eq(retainageReleases.status, 'approved'), ...(last?.periodTo ? [gt(retainageReleases.effectiveOn, last.periodTo)] : [])));
  return { held, pending: later.reduce((a, r) => a + r.amount, 0) };
}

/**
 * Record that some of the retainage held on a contract is to be paid out.
 * From the period it takes effect in, verified retainage is lower by this
 * amount, so the next application that bills it passes instead of being
 * flagged for under-withholding.
 */
export const createRetainageRelease = locked(async function createRetainageRelease(db: DB, ctx: Ctx, contractId: string, input: RetainageReleaseInput): Promise<string> {
  // Paying out withheld money is an approver's decision, not a record-keeping edit.
  assertCan(ctx, 'application:approve');
  const [contract] = await db.select().from(contracts).where(and(eq(contracts.orgId, ctx.orgId), eq(contracts.id, contractId)));
  if (!contract) throw new UserError('Contract not found.');
  if (!Number.isSafeInteger(input.amount) || input.amount <= 0) throw new UserError('Enter the amount of retainage to release.');
  if (!input.effectiveOn || !isDate(input.effectiveOn)) throw new UserError('Enter the date the release takes effect.');
  const note = input.note?.trim() ?? '';
  if (note.length < 5) throw new UserError('Say who authorised the release and why. It is kept with the contract’s record.');

  const { held, pending } = await retainageAvailable(db, ctx.orgId, contract);
  if (held !== null && input.amount > held - pending) {
    throw new UserError(
      `Only ${formatMoney(Math.max(held - pending, 0))} of retainage is available to release: ${formatMoney(held)} was held after the last approved application` +
        (pending ? `, and ${formatMoney(pending)} is already recorded for release.` : '.'),
    );
  }

  const id = newId('rel');
  await db.insert(retainageReleases).values({ id, orgId: ctx.orgId, contractId, amount: input.amount, effectiveOn: input.effectiveOn, note, createdBy: ctx.userId });
  await recordAudit(db, {
    orgId: ctx.orgId,
    actor: ctx,
    action: 'retainage.release_recorded',
    entityType: 'contract',
    entityId: contractId,
    summary: `Recorded a retainage release of ${formatMoney(input.amount)} on contract ${contract.number}, effective ${input.effectiveOn} — ${note}`,
    data: { releaseId: id, amount: input.amount, effectiveOn: input.effectiveOn, note, heldBefore: held },
  });
  await rereconcileContract(db, ctx.orgId, contractId, { actor: ctx });
  return id;
});

export const voidRetainageRelease = locked(async function voidRetainageRelease(db: DB, ctx: Ctx, releaseId: string, reason: string): Promise<void> {
  assertCan(ctx, 'application:approve');
  const [release] = await db.select().from(retainageReleases).where(and(eq(retainageReleases.orgId, ctx.orgId), eq(retainageReleases.id, releaseId)));
  if (!release) throw new UserError('Release not found.');
  if (release.status === 'void') return;
  if (reason.trim().length < 5) throw new UserError('Give the reason for cancelling the release.');
  const [contract] = await db.select().from(contracts).where(eq(contracts.id, release.contractId));
  // Once an approval has paid it out, cancelling the release would silently contradict that approval.
  const approved = await db
    .select({ n: payApplications.applicationNumber, periodTo: payApplications.periodTo, decidedAt: payApplications.decidedAt })
    .from(payApplications)
    .where(and(eq(payApplications.orgId, ctx.orgId), eq(payApplications.contractId, release.contractId), eq(payApplications.status, 'approved')));
  const counted = approved.find((a) => a.periodTo !== null && a.periodTo >= release.effectiveOn && a.decidedAt !== null && a.decidedAt >= release.createdAt);
  if (counted) throw new UserError(`Application #${counted.n} was approved with this release counted. Reopen that application first.`);
  await db.update(retainageReleases).set({ status: 'void', voidedBy: ctx.userId, voidedAt: new Date() }).where(eq(retainageReleases.id, releaseId));
  await recordAudit(db, {
    orgId: ctx.orgId,
    actor: ctx,
    action: 'retainage.release_cancelled',
    entityType: 'contract',
    entityId: release.contractId,
    summary: `Cancelled the retainage release of ${formatMoney(release.amount)} (effective ${release.effectiveOn}) on contract ${contract?.number ?? ''} — ${reason.trim()}`,
    data: { releaseId, amount: release.amount, reason: reason.trim() },
  });
  await rereconcileContract(db, ctx.orgId, release.contractId, { actor: ctx });
});

// ── Change orders ───────────────────────────────────────────────────────────

export type ChangeOrderInput = { number: string; title: string; amount: number; status: 'pending' | 'approved' | 'rejected' | 'void'; approvedOn?: string | null };

function validateChangeOrder(input: ChangeOrderInput) {
  if (!Number.isSafeInteger(input.amount) || input.amount === 0) throw new UserError('Enter the change order amount (negative for a deduct).');
  if (!['pending', 'approved', 'rejected', 'void'].includes(input.status)) throw new UserError('Unknown status.');
  if (!isDate(input.approvedOn)) throw new UserError('Enter a valid approval date.');
  return { number: required(input.number, 'Change order number'), title: required(input.title, 'Description'), amount: input.amount, status: input.status, approvedOn: input.status === 'approved' ? input.approvedOn || new Date().toISOString().slice(0, 10) : null };
}

/** Keep the schedule in step with a change order: an approved one has a line; anything else does not. */
async function syncChangeOrderLine(db: DB, orgId: string, co: typeof changeOrders.$inferSelect): Promise<void> {
  const [line] = await db.select().from(sovLines).where(eq(sovLines.changeOrderId, co.id));
  if (co.status === 'approved') {
    if (line) {
      await db.update(sovLines).set({ itemNo: co.number, description: co.title, scheduledValue: co.amount }).where(eq(sovLines.id, line.id));
    } else {
      const siblings = await db.select({ sortOrder: sovLines.sortOrder }).from(sovLines).where(eq(sovLines.contractId, co.contractId));
      const sortOrder = siblings.reduce((m, s) => Math.max(m, s.sortOrder), -1) + 1;
      await db.insert(sovLines).values({ id: newId('sov'), orgId, contractId: co.contractId, itemNo: co.number, description: co.title, scheduledValue: co.amount, sortOrder, changeOrderId: co.id });
    }
    return;
  }
  if (!line) return;
  const billed = await db
    .select({ id: payAppLines.id })
    .from(payAppLines)
    .innerJoin(payApplications, eq(payApplications.id, payAppLines.payApplicationId))
    .where(and(eq(payAppLines.sovLineId, line.id), eq(payApplications.status, 'approved')));
  if (billed.length > 0) throw new UserError(`Change order ${co.number} has approved billing against it, so its approval cannot be withdrawn.`);
  await db.delete(sovLines).where(eq(sovLines.id, line.id));
}

/** After the schedule changes shape, let undecided applications pick up newly matching lines. */
async function rematchOpenApplications(db: DB, orgId: string, contractId: string): Promise<void> {
  const { mapLinesToSov } = await import('@/server/recon/matching');
  const open = await db.select({ id: payApplications.id }).from(payApplications).where(and(eq(payApplications.orgId, orgId), eq(payApplications.contractId, contractId), inArray(payApplications.status, ['needs_review', 'pending_approval', 'on_hold'])));
  const sov = await db.select().from(sovLines).where(eq(sovLines.contractId, contractId)).orderBy(asc(sovLines.sortOrder));
  for (const app of open) {
    const lines = await db.select().from(payAppLines).where(eq(payAppLines.payApplicationId, app.id)).orderBy(asc(payAppLines.sortOrder));
    const taken = new Set(lines.map((l) => l.sovLineId).filter(Boolean));
    const unmatched = lines.filter((l) => !l.sovLineId);
    if (unmatched.length === 0) continue;
    const mapping = mapLinesToSov(unmatched, sov.filter((s) => !taken.has(s.id)));
    for (const [i, line] of unmatched.entries()) {
      if (mapping[i]) await db.update(payAppLines).set({ sovLineId: mapping[i] }).where(eq(payAppLines.id, line.id));
    }
  }
}

export const createChangeOrder = locked(async function createChangeOrder(db: DB, ctx: Ctx, contractId: string, input: ChangeOrderInput, external?: { id: string }): Promise<string> {
  assertCan(ctx, 'records:write');
  const [contract] = await db.select().from(contracts).where(and(eq(contracts.orgId, ctx.orgId), eq(contracts.id, contractId)));
  if (!contract) throw new UserError('Contract not found.');
  const values = validateChangeOrder(input);
  const [clash] = await db.select({ id: changeOrders.id }).from(changeOrders).where(and(eq(changeOrders.contractId, contractId), eq(changeOrders.number, values.number)));
  if (clash) throw new UserError(`Change order ${values.number} already exists on this contract.`);
  const id = newId('co');
  await db.insert(changeOrders).values({ id, orgId: ctx.orgId, contractId, ...values, externalId: external?.id ?? null });
  const [co] = await db.select().from(changeOrders).where(eq(changeOrders.id, id));
  await syncChangeOrderLine(db, ctx.orgId, co!);
  await recordAudit(db, { orgId: ctx.orgId, actor: ctx, action: 'change_order.created', entityType: 'change_order', entityId: id, summary: `Added change order ${values.number} “${values.title}” to contract ${contract.number}: ${formatMoney(values.amount)}, ${values.status}`, data: { contractId, ...values } });
  await rematchOpenApplications(db, ctx.orgId, contractId);
  await rereconcileContract(db, ctx.orgId, contractId, { actor: ctx });
  return id;
});

export const updateChangeOrder = locked(async function updateChangeOrder(db: DB, ctx: Ctx, id: string, input: ChangeOrderInput): Promise<void> {
  assertCan(ctx, 'records:write');
  const [co] = await db.select().from(changeOrders).where(and(eq(changeOrders.orgId, ctx.orgId), eq(changeOrders.id, id)));
  if (!co) throw new UserError('Change order not found.');
  const values = validateChangeOrder(input);
  if (values.status === 'approved' && co.status === 'approved' && !input.approvedOn) values.approvedOn = co.approvedOn;
  const [contract] = await db.select().from(contracts).where(eq(contracts.id, co.contractId));
  await syncChangeOrderLine(db, ctx.orgId, { ...co, ...values });
  await db.update(changeOrders).set(values).where(eq(changeOrders.id, id));
  const changes: string[] = [];
  if (values.status !== co.status) changes.push(`status ${co.status} → ${values.status}`);
  if (values.amount !== co.amount) changes.push(`amount ${formatMoney(co.amount)} → ${formatMoney(values.amount)}`);
  if (values.title !== co.title) changes.push('description changed');
  await recordAudit(db, {
    orgId: ctx.orgId,
    actor: ctx,
    action: values.status === 'approved' && co.status !== 'approved' ? 'change_order.approved' : 'change_order.updated',
    entityType: 'change_order',
    entityId: id,
    summary: `${values.status === 'approved' && co.status !== 'approved' ? 'Approved' : 'Updated'} change order ${values.number} on contract ${contract?.number ?? ''}${changes.length ? `: ${changes.join('; ')}` : ''}`,
    data: { before: { status: co.status, amount: co.amount }, after: values },
  });
  await rematchOpenApplications(db, ctx.orgId, co.contractId);
  await rereconcileContract(db, ctx.orgId, co.contractId, { actor: ctx });
});
