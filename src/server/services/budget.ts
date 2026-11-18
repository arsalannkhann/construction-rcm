/**
 * A project's budget by cost code: its lines, the subcontracts assigned to
 * each, budget changes between lines, the forecast of what is still to be
 * committed, and the lock that freezes the original budget.
 *
 * A project has either one budget figure (projects.budget) or budget lines,
 * never both: the first lines take over the single figure, and anything not
 * given to a line goes to a contingency line so the total does not change.
 *
 * Who does what: anyone in the organisation can read it; people who keep the
 * records (records:write) set up lines, assign subcontracts, set forecasts,
 * record budget changes and lock the budget; unlocking it, which lets the
 * original amounts change again, takes an approver (application:approve).
 * The CSV is an export (export:run). Always scoped to ctx.orgId.
 */
import { and, asc, desc, eq, inArray, ne, or } from 'drizzle-orm';
import type { DB } from '@/db';
import { locked } from '@/db/tx';
import { budgetChanges, budgetLines, contracts, projects, subcontractors, users } from '@/db/schema';
import { centsToDecimalString, formatMoney, sum } from '@/lib/money';
import { recordAudit } from '@/server/audit';
import { assertCan, can, UserError, type Ctx } from '@/server/auth/permissions';
import { newId } from '@/server/ids';
import {
  budgetFigures,
  CONTINGENCY,
  FORECAST_METHOD_LABEL,
  FORECAST_METHODS,
  lineBudgets,
  TRADE_CODES,
  tradeCode,
  type BudgetFigures,
  type BudgetSource,
  type ForecastMethod,
} from './budget-calc';
import { csvRow } from './exports';
import { lineInputs } from './budget-totals';
import { loadPositions } from './records-queries';

type LineRow = typeof budgetLines.$inferSelect;
type ProjectRow = typeof projects.$inferSelect;

const MAX_LINES = 300;
const normaliseCode = (s: string | null | undefined) => (s ?? '').trim().replace(/\s+/g, ' ');
const sameCode = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const label = (l: Pick<LineRow, 'costCode' | 'description'>) => `${l.costCode} ${l.description}`;
const asMethod = (m: string): ForecastMethod => ((FORECAST_METHODS as readonly string[]).includes(m) ? (m as ForecastMethod) : 'remaining');

function text(value: string | null | undefined, what: string, max: number): string {
  const v = value?.trim();
  if (!v) throw new UserError(`${what} is required.`);
  if (v.length > max) throw new UserError(`${what} is too long.`);
  return v;
}

function amount(value: unknown, what: string, opts: { positive?: boolean } = {}): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || (opts.positive && value === 0)) throw new UserError(`Enter ${what}${opts.positive ? ' above zero' : ''}.`);
  return value;
}

async function loadProject(db: DB, ctx: Ctx, projectId: string): Promise<ProjectRow> {
  const [project] = await db.select().from(projects).where(and(eq(projects.orgId, ctx.orgId), eq(projects.id, projectId)));
  if (!project) throw new UserError('Project not found.');
  return project;
}

async function loadLines(db: DB, ctx: Ctx, projectId: string): Promise<LineRow[]> {
  return db
    .select()
    .from(budgetLines)
    .where(and(eq(budgetLines.orgId, ctx.orgId), eq(budgetLines.projectId, projectId)))
    .orderBy(asc(budgetLines.costCode), asc(budgetLines.sortOrder));
}

async function loadChanges(db: DB, ctx: Ctx, projectId: string) {
  return db
    .select()
    .from(budgetChanges)
    .where(and(eq(budgetChanges.orgId, ctx.orgId), eq(budgetChanges.projectId, projectId)))
    .orderBy(desc(budgetChanges.createdAt));
}

async function loadLine(db: DB, ctx: Ctx, lineId: string): Promise<LineRow> {
  const [line] = await db.select().from(budgetLines).where(and(eq(budgetLines.orgId, ctx.orgId), eq(budgetLines.id, lineId)));
  if (!line) throw new UserError('Budget line not found.');
  return line;
}

/** The project's subcontracts with what each has committed, pending and billed, as the budget counts them. */
async function loadSources(db: DB, ctx: Ctx, projectId: string) {
  const rows = await db
    .select({
      id: contracts.id,
      number: contracts.number,
      title: contracts.title,
      status: contracts.status,
      originalAmount: contracts.originalAmount,
      budgetLineId: contracts.budgetLineId,
      subcontractorName: subcontractors.name,
      trade: subcontractors.trade,
    })
    .from(contracts)
    .innerJoin(subcontractors, eq(subcontractors.id, contracts.subcontractorId))
    .where(and(eq(contracts.orgId, ctx.orgId), eq(contracts.projectId, projectId)))
    .orderBy(asc(subcontractors.name), asc(contracts.number));
  const positions = await loadPositions(db, ctx, rows);
  return rows.map((r) => {
    const p = positions.get(r.id)!;
    return { ...r, contractSum: p.contractSum, pendingChanges: p.pendingChangeOrders, billedToDate: p.completedStored, latestApproved: p.latestApproved };
  });
}

const toSources = (rows: Awaited<ReturnType<typeof loadSources>>): BudgetSource[] =>
  rows.map((r) => ({ contractId: r.id, budgetLineId: r.budgetLineId, contractSum: r.contractSum, pendingChanges: r.pendingChanges, billedToDate: r.billedToDate }));

// ── Reading one project's budget ────────────────────────────────────────────

export type ProjectBudget = NonNullable<Awaited<ReturnType<typeof getProjectBudget>>>;

export async function getProjectBudget(db: DB, ctx: Ctx, projectId: string) {
  const [project] = await db.select().from(projects).where(and(eq(projects.orgId, ctx.orgId), eq(projects.id, projectId)));
  if (!project) return null;
  const [lines, changes, sources] = await Promise.all([loadLines(db, ctx, projectId), loadChanges(db, ctx, projectId), loadSources(db, ctx, projectId)]);
  const result = budgetFigures({ lines: lineInputs(lines), changes, sources: toSources(sources) });

  const userIds = [...new Set([project.budgetLockedBy, ...lines.map((l) => l.forecastBy), ...changes.flatMap((c) => [c.createdBy, c.voidedBy])].filter((x): x is string => !!x))];
  const people = userIds.length ? await db.select({ id: users.id, name: users.name }).from(users).where(inArray(users.id, userIds)) : [];
  const nameOf = (id: string | null) => (id ? (people.find((p) => p.id === id)?.name ?? 'Former member') : null);
  const byId = new Map(lines.map((l) => [l.id, l]));

  // Codes used on the organisation's other projects first, then the common trade codes.
  const elsewhere = await db
    .selectDistinct({ costCode: budgetLines.costCode, description: budgetLines.description })
    .from(budgetLines)
    .where(and(eq(budgetLines.orgId, ctx.orgId), ne(budgetLines.projectId, projectId)))
    .limit(500);
  const suggestions: Array<{ code: string; description: string }> = [];
  for (const s of [...elsewhere.map((e) => ({ code: e.costCode, description: e.description })), ...TRADE_CODES, CONTINGENCY]) {
    if (!suggestions.some((x) => sameCode(x.code, s.code))) suggestions.push({ code: s.code, description: s.description });
  }

  return {
    project: { id: project.id, name: project.name, number: project.number, status: project.status, singleBudget: lines.length ? null : project.budget },
    locked: project.budgetLockedAt ? { at: project.budgetLockedAt, by: nameOf(project.budgetLockedBy) } : null,
    lines: lines.map((l, i) => ({
      ...result.lines[i]!,
      costCode: l.costCode,
      description: l.description,
      forecastMethod: asMethod(l.forecastMethod),
      forecastAmount: l.forecastAmount,
      forecastNote: l.forecastNote,
      forecastBy: nameOf(l.forecastBy),
      forecastAt: l.forecastAt,
    })),
    unassigned: result.unassigned,
    totals: result.totals,
    changes: changes.map((c) => ({
      id: c.id,
      from: c.fromLineId ? (byId.get(c.fromLineId) ?? null) : null,
      to: c.toLineId ? (byId.get(c.toLineId) ?? null) : null,
      amount: c.amount,
      reason: c.reason,
      status: c.status,
      createdAt: c.createdAt,
      createdBy: nameOf(c.createdBy),
      voidedAt: c.voidedAt,
      voidedBy: nameOf(c.voidedBy),
    })),
    contracts: sources.map((s) => ({
      id: s.id,
      number: s.number,
      title: s.title,
      status: s.status,
      subcontractorName: s.subcontractorName,
      budgetLineId: s.budgetLineId && byId.has(s.budgetLineId) ? s.budgetLineId : null,
      // The line whose cost code matches the subcontract's trade, offered first when assigning it.
      suggestedLineId: lines.find((l) => sameCode(l.costCode, tradeCode(s.trade, s.title)?.code ?? ''))?.id ?? null,
      contractSum: s.contractSum,
      pendingChanges: s.pendingChanges,
      billedToDate: s.billedToDate,
    })),
    suggestions,
    canWrite: can(ctx.role, 'records:write'),
    canUnlock: can(ctx.role, 'application:approve'),
    canExport: can(ctx.role, 'export:run'),
  };
}

// ── Lines ───────────────────────────────────────────────────────────────────

/**
 * When a project's first budget lines are made, they take over its single
 * budget figure. Whatever of that figure the new lines do not use goes to a
 * contingency line, so the project's budget does not change underneath anyone.
 */
async function takeOverSingleBudget(db: DB, ctx: Ctx, project: ProjectRow, newLinesTotal: number, sortOrder: number): Promise<{ contingency: number }> {
  if (project.budget === null) return { contingency: 0 };
  const left = project.budget - newLinesTotal;
  if (left > 0) {
    await db.insert(budgetLines).values({ id: newId('bl'), orgId: ctx.orgId, projectId: project.id, costCode: CONTINGENCY.code, description: CONTINGENCY.description, originalAmount: left, sortOrder, createdBy: ctx.userId });
  }
  await db.update(projects).set({ budget: null }).where(eq(projects.id, project.id));
  return { contingency: Math.max(left, 0) };
}

export type BudgetLineSave = { id?: string; costCode: string; description: string; originalAmount: number; contractIds?: string[] };

/** Add a budget line or change one, including which subcontracts are on it. Returns the line's id. */
export const saveBudgetLine = locked(async function saveBudgetLine(db: DB, ctx: Ctx, projectId: string, input: BudgetLineSave): Promise<string> {
  assertCan(ctx, 'records:write');
  const project = await loadProject(db, ctx, projectId);
  const lines = await loadLines(db, ctx, projectId);
  const current = input.id ? lines.find((l) => l.id === input.id) : undefined;
  if (input.id && !current) throw new UserError('This budget line was changed by someone else. Reload the page and try again.');
  if (!current && lines.length >= MAX_LINES) throw new UserError(`A budget can have up to ${MAX_LINES} lines.`);

  const costCode = text(normaliseCode(input.costCode), 'Cost code', 40);
  const description = text(input.description, 'Description', 200);
  const originalAmount = amount(input.originalAmount, 'the budget for this line, or 0');
  const clash = lines.find((l) => l.id !== current?.id && sameCode(l.costCode, costCode));
  if (clash) throw new UserError(`Cost code ${clash.costCode} is already on this budget (${clash.description}).`);
  if (project.budgetLockedAt) {
    if (current && originalAmount !== current.originalAmount)
      throw new UserError(`The budget is locked, so the original budget of ${current.costCode} stays ${formatMoney(current.originalAmount)}. Record a budget change to move money instead.`);
    if (!current && originalAmount !== 0) throw new UserError('The budget is locked, so a new line starts at $0. Record a budget change to give it a budget.');
  }

  // Which subcontracts are on the line: the whole set, as sent.
  const projectContracts = await db
    .select({ id: contracts.id, number: contracts.number, budgetLineId: contracts.budgetLineId })
    .from(contracts)
    .where(and(eq(contracts.orgId, ctx.orgId), eq(contracts.projectId, projectId)));
  const wanted = [...new Set(input.contractIds ?? (current ? projectContracts.filter((c) => c.budgetLineId === current.id).map((c) => c.id) : []))];
  if (wanted.some((id) => !projectContracts.some((c) => c.id === id))) throw new UserError('Assign only subcontracts on this project.');

  const id = current?.id ?? newId('bl');
  let contingency = 0;
  if (current) {
    await db.update(budgetLines).set({ costCode, description, originalAmount }).where(eq(budgetLines.id, id));
  } else {
    const sortOrder = lines.reduce((m, l) => Math.max(m, l.sortOrder), -1) + 1;
    await db.insert(budgetLines).values({ id, orgId: ctx.orgId, projectId, costCode, description, originalAmount, sortOrder, createdBy: ctx.userId });
    if (lines.length === 0) {
      if (sameCode(costCode, CONTINGENCY.code) && project.budget !== null && project.budget > originalAmount) throw new UserError(`Use a cost code other than ${CONTINGENCY.code}: the rest of the project’s budget goes to a contingency line with that code.`);
      contingency = (await takeOverSingleBudget(db, ctx, project, originalAmount, sortOrder + 1)).contingency;
    }
  }

  const before = projectContracts.filter((c) => c.budgetLineId === id).map((c) => c.id);
  const added = wanted.filter((c) => !before.includes(c));
  const removed = before.filter((c) => !wanted.includes(c));
  const moved = projectContracts.filter((c) => added.includes(c.id) && c.budgetLineId && c.budgetLineId !== id);
  if (added.length) await db.update(contracts).set({ budgetLineId: id }).where(and(eq(contracts.orgId, ctx.orgId), inArray(contracts.id, added)));
  if (removed.length) await db.update(contracts).set({ budgetLineId: null }).where(and(eq(contracts.orgId, ctx.orgId), inArray(contracts.id, removed)));

  const numberOf = (cid: string) => projectContracts.find((c) => c.id === cid)?.number ?? cid;
  const parts: string[] = [];
  if (!current) parts.push(`budget ${formatMoney(originalAmount)}`);
  else {
    if (current.costCode !== costCode || current.description !== description) parts.push(`was ${label(current)}`);
    if (current.originalAmount !== originalAmount) parts.push(`original budget ${formatMoney(originalAmount)} (was ${formatMoney(current.originalAmount)})`);
  }
  if (added.length) parts.push(`assigned ${added.map(numberOf).join(', ')}${moved.length ? ` (moved from ${moved.map((m) => label(lines.find((l) => l.id === m.budgetLineId) ?? { costCode: '?', description: 'another line' })).join(', ')})` : ''}`);
  if (removed.length) parts.push(`took off ${removed.map(numberOf).join(', ')}`);
  if (contingency > 0) parts.push(`the rest of the project’s ${formatMoney(project.budget)} budget, ${formatMoney(contingency)}, went to ${CONTINGENCY.code} ${CONTINGENCY.description}`);
  else if (!current && lines.length === 0 && project.budget !== null) parts.push(`it replaces the project’s single budget of ${formatMoney(project.budget)}`);

  await recordAudit(db, {
    orgId: ctx.orgId,
    actor: ctx,
    action: current ? 'budget.line_changed' : 'budget.line_added',
    entityType: 'project',
    entityId: projectId,
    summary: `${current ? 'Changed' : 'Added'} budget line ${costCode} ${description} on ${project.name}${parts.length ? `: ${parts.join('; ')}` : ''}`,
    data: { lineId: id, before: current ? { costCode: current.costCode, description: current.description, originalAmount: current.originalAmount, contracts: before } : null, after: { costCode, description, originalAmount, contracts: wanted }, contingency },
  });
  return id;
});

/** Put subcontracts on budget lines (or take them off, with a null line). Only the ones that change are touched. */
export const assignBudgetLines = locked(async function assignBudgetLines(db: DB, ctx: Ctx, projectId: string, assignments: Array<{ contractId: string; lineId: string | null }>): Promise<void> {
  assertCan(ctx, 'records:write');
  const project = await loadProject(db, ctx, projectId);
  if (!Array.isArray(assignments) || assignments.length === 0 || assignments.length > 500) throw new UserError('Choose a budget line for at least one subcontract.');
  const lines = await loadLines(db, ctx, projectId);
  const projectContracts = await db
    .select({ id: contracts.id, number: contracts.number, budgetLineId: contracts.budgetLineId })
    .from(contracts)
    .where(and(eq(contracts.orgId, ctx.orgId), eq(contracts.projectId, projectId)));
  const changes: Array<{ contract: (typeof projectContracts)[number]; to: LineRow | null }> = [];
  for (const a of assignments) {
    const contract = projectContracts.find((c) => c.id === a.contractId);
    if (!contract) throw new UserError('Assign only subcontracts on this project.');
    const to = a.lineId ? lines.find((l) => l.id === a.lineId) : null;
    if (a.lineId && !to) throw new UserError('Choose a budget line on this project.');
    if ((contract.budgetLineId ?? null) !== (to?.id ?? null) && !changes.some((c) => c.contract.id === contract.id)) changes.push({ contract, to: to ?? null });
  }
  if (changes.length === 0) return;
  for (const c of changes) await db.update(contracts).set({ budgetLineId: c.to?.id ?? null }).where(eq(contracts.id, c.contract.id));
  await recordAudit(db, {
    orgId: ctx.orgId,
    actor: ctx,
    action: 'budget.subcontracts_assigned',
    entityType: 'project',
    entityId: projectId,
    summary: `Budget lines on ${project.name}: ${changes.map((c) => (c.to ? `${c.contract.number} to ${label(c.to)}` : `${c.contract.number} to no line`)).join('; ')}`,
    data: { changes: changes.map((c) => ({ contractId: c.contract.id, from: c.contract.budgetLineId, to: c.to?.id ?? null })) },
  });
});

/** Remove a budget line. Its subcontracts go back to "not on a line". */
export const deleteBudgetLine = locked(async function deleteBudgetLine(db: DB, ctx: Ctx, lineId: string): Promise<void> {
  assertCan(ctx, 'records:write');
  const line = await loadLine(db, ctx, lineId);
  const project = await loadProject(db, ctx, line.projectId);
  if (project.budgetLockedAt && line.originalAmount !== 0) throw new UserError(`The budget is locked, so ${line.costCode}, which has an original budget, stays on it. Move its subcontracts off and set its forecast to “Nothing more” instead.`);
  const [referenced] = await db
    .select({ id: budgetChanges.id })
    .from(budgetChanges)
    .where(and(eq(budgetChanges.orgId, ctx.orgId), or(eq(budgetChanges.fromLineId, line.id), eq(budgetChanges.toLineId, line.id))))
    .limit(1);
  if (referenced) throw new UserError(`${line.costCode} has budget changes on record, so it stays on the budget. Move its subcontracts off and set its forecast to “Nothing more” instead.`);

  const on = await db.select({ id: contracts.id, number: contracts.number }).from(contracts).where(and(eq(contracts.orgId, ctx.orgId), eq(contracts.budgetLineId, line.id)));
  if (on.length) await db.update(contracts).set({ budgetLineId: null }).where(and(eq(contracts.orgId, ctx.orgId), eq(contracts.budgetLineId, line.id)));
  await db.delete(budgetLines).where(eq(budgetLines.id, line.id));
  const remaining = await loadLines(db, ctx, line.projectId);
  if (remaining.length === 0 && project.budgetLockedAt) await db.update(projects).set({ budgetLockedAt: null, budgetLockedBy: null }).where(eq(projects.id, project.id));
  await recordAudit(db, {
    orgId: ctx.orgId,
    actor: ctx,
    action: 'budget.line_removed',
    entityType: 'project',
    entityId: project.id,
    summary: `Removed budget line ${label(line)} (${formatMoney(line.originalAmount)}) from ${project.name}${on.length ? `; ${on.map((c) => c.number).join(', ')} no longer on a line` : ''}`,
    data: { lineId: line.id, costCode: line.costCode, description: line.description, originalAmount: line.originalAmount, contracts: on.map((c) => c.id) },
  });
});

export type ForecastInput = { method: ForecastMethod; amount?: number | null; note?: string | null };

/** Say how the cost still to be committed on a line is forecast. */
export const setBudgetForecast = locked(async function setBudgetForecast(db: DB, ctx: Ctx, lineId: string, input: ForecastInput): Promise<void> {
  assertCan(ctx, 'records:write');
  const line = await loadLine(db, ctx, lineId);
  const project = await loadProject(db, ctx, line.projectId);
  if (!(FORECAST_METHODS as readonly string[]).includes(input.method)) throw new UserError('Choose how to forecast this line.');
  const forecastAmount = input.method === 'entered' ? amount(input.amount, 'what you still expect to commit on this line, or 0') : null;
  const note = input.note?.trim() || null;
  if ((note?.length ?? 0) > 500) throw new UserError('Keep the note under 500 characters.');
  await db.update(budgetLines).set({ forecastMethod: input.method, forecastAmount, forecastNote: note, forecastBy: ctx.userId, forecastAt: new Date() }).where(eq(budgetLines.id, line.id));
  const what = input.method === 'entered' ? `${formatMoney(forecastAmount)} still to commit` : FORECAST_METHOD_LABEL[input.method].toLowerCase();
  await recordAudit(db, {
    orgId: ctx.orgId,
    actor: ctx,
    action: 'budget.forecast_set',
    entityType: 'project',
    entityId: project.id,
    summary: `Set the forecast for ${label(line)} on ${project.name}: ${what}${note ? ` (“${note}”)` : ''}`,
    data: { lineId: line.id, before: { method: line.forecastMethod, amount: line.forecastAmount, note: line.forecastNote }, after: { method: input.method, amount: forecastAmount, note } },
  });
});

// ── Budget changes ──────────────────────────────────────────────────────────

export type BudgetChangeSave = { fromLineId: string | null; toLineId: string | null; amount: number; reason: string };

/** Move budget between lines, add to the budget (no `from`) or take from it (no `to`). Returns the change's id. */
export const recordBudgetChange = locked(async function recordBudgetChange(db: DB, ctx: Ctx, projectId: string, input: BudgetChangeSave): Promise<string> {
  assertCan(ctx, 'records:write');
  const project = await loadProject(db, ctx, projectId);
  const lines = await loadLines(db, ctx, projectId);
  const from = input.fromLineId ? lines.find((l) => l.id === input.fromLineId) : null;
  const to = input.toLineId ? lines.find((l) => l.id === input.toLineId) : null;
  if ((input.fromLineId && !from) || (input.toLineId && !to)) throw new UserError('Choose budget lines on this project.');
  if (!from && !to) throw new UserError('Choose the line the money comes from, the line it goes to, or both.');
  if (from && to && from.id === to.id) throw new UserError('Choose two different lines.');
  const value = amount(input.amount, 'the amount', { positive: true });
  const reason = text(input.reason, 'The reason', 300);

  if (from) {
    const budgets = lineBudgets(lines, (await loadChanges(db, ctx, projectId)).filter((c) => c.status !== 'void'));
    const available = budgets.get(from.id)!.budget;
    if (value > available) throw new UserError(`${from.costCode} has ${formatMoney(available)} of budget, so it cannot give ${formatMoney(value)}.`);
  }
  const id = newId('bc');
  await db.insert(budgetChanges).values({ id, orgId: ctx.orgId, projectId, fromLineId: from?.id ?? null, toLineId: to?.id ?? null, amount: value, reason, createdBy: ctx.userId });
  const movement = from && to ? `moved ${formatMoney(value)} from ${label(from)} to ${label(to)}` : to ? `added ${formatMoney(value)} to ${label(to)}` : `took ${formatMoney(value)} out of ${label(from!)}`;
  await recordAudit(db, {
    orgId: ctx.orgId,
    actor: ctx,
    action: 'budget.change_recorded',
    entityType: 'project',
    entityId: projectId,
    summary: `Budget change on ${project.name}: ${movement} (“${reason}”)`,
    data: { changeId: id, fromLineId: from?.id ?? null, toLineId: to?.id ?? null, amount: value, reason },
  });
  return id;
});

/** Cancel a budget change. It stays on record, marked void, and stops counting. */
export const voidBudgetChange = locked(async function voidBudgetChange(db: DB, ctx: Ctx, changeId: string): Promise<void> {
  assertCan(ctx, 'records:write');
  const [change] = await db.select().from(budgetChanges).where(and(eq(budgetChanges.orgId, ctx.orgId), eq(budgetChanges.id, changeId)));
  if (!change) throw new UserError('Budget change not found.');
  if (change.status === 'void') throw new UserError('That budget change is already void.');
  const project = await loadProject(db, ctx, change.projectId);
  const lines = await loadLines(db, ctx, change.projectId);
  if (change.toLineId) {
    const others = (await loadChanges(db, ctx, change.projectId)).filter((c) => c.status !== 'void' && c.id !== change.id);
    const after = lineBudgets(lines, others).get(change.toLineId)?.budget ?? 0;
    const to = lines.find((l) => l.id === change.toLineId)!;
    if (after < 0) throw new UserError(`Voiding this would leave ${to.costCode} with a budget below zero. Move budget back into it first.`);
  }
  await db.update(budgetChanges).set({ status: 'void', voidedBy: ctx.userId, voidedAt: new Date() }).where(eq(budgetChanges.id, change.id));
  const name = (id: string | null) => {
    const l = id ? lines.find((x) => x.id === id) : undefined;
    return l ? label(l) : null;
  };
  const movement = [name(change.fromLineId) ? `from ${name(change.fromLineId)}` : null, name(change.toLineId) ? `to ${name(change.toLineId)}` : null].filter(Boolean).join(' ');
  await recordAudit(db, {
    orgId: ctx.orgId,
    actor: ctx,
    action: 'budget.change_voided',
    entityType: 'project',
    entityId: project.id,
    summary: `Voided a budget change on ${project.name}: ${formatMoney(change.amount)} ${movement} (“${change.reason}”)`,
    data: { changeId: change.id },
  });
});

// ── Lock ────────────────────────────────────────────────────────────────────

/** Freeze the original budget of every line. From now on money moves by budget changes. */
export const lockBudget = locked(async function lockBudget(db: DB, ctx: Ctx, projectId: string): Promise<void> {
  assertCan(ctx, 'records:write');
  const project = await loadProject(db, ctx, projectId);
  if (project.budgetLockedAt) throw new UserError('The budget is already locked.');
  const lines = await loadLines(db, ctx, projectId);
  if (lines.length === 0) throw new UserError('Add budget lines before locking the budget.');
  await db.update(projects).set({ budgetLockedAt: new Date(), budgetLockedBy: ctx.userId }).where(eq(projects.id, projectId));
  const original = sum(lines.map((l) => l.originalAmount));
  await recordAudit(db, { orgId: ctx.orgId, actor: ctx, action: 'budget.locked', entityType: 'project', entityId: projectId, summary: `Locked the budget on ${project.name}: ${lines.length} lines, original budget ${formatMoney(original)}`, data: { lines: lines.length, original } });
});

/** Let the original amounts change again. Takes an approver. */
export const unlockBudget = locked(async function unlockBudget(db: DB, ctx: Ctx, projectId: string): Promise<void> {
  assertCan(ctx, 'application:approve');
  const project = await loadProject(db, ctx, projectId);
  if (!project.budgetLockedAt) throw new UserError('The budget is not locked.');
  await db.update(projects).set({ budgetLockedAt: null, budgetLockedBy: null }).where(eq(projects.id, projectId));
  await recordAudit(db, { orgId: ctx.orgId, actor: ctx, action: 'budget.unlocked', entityType: 'project', entityId: projectId, summary: `Unlocked the budget on ${project.name}: original budgets can be changed again`, data: { lockedAt: project.budgetLockedAt.toISOString() } });
});

// ── Starting from the subcontracts ──────────────────────────────────────────

/** Split `total` across `weights` in proportion, in whole cents, adding up exactly (largest remainder). */
export function shareOut(total: number, weights: number[]): number[] {
  const whole = sum(weights);
  if (whole <= 0) return weights.map(() => 0);
  const raw = weights.map((w) => (total * w) / whole);
  const out = raw.map(Math.floor);
  let left = total - sum(out);
  const order = raw.map((r, i) => ({ i, frac: r - Math.floor(r) })).sort((a, b) => b.frac - a.frac || a.i - b.i);
  for (const { i } of order) {
    if (left <= 0) break;
    out[i]! += 1;
    left -= 1;
  }
  return out;
}

/**
 * Make a first budget from the subcontracts already on the project: one line
 * per trade, each starting at what is committed on it, with its subcontracts
 * assigned. If the project had a single budget, the rest of it goes to a
 * contingency line; if that budget is less than what is committed, the lines
 * share it in proportion, so the project stays over by the same amount.
 */
export const startBudgetFromSubcontracts = locked(async function startBudgetFromSubcontracts(db: DB, ctx: Ctx, projectId: string): Promise<number> {
  assertCan(ctx, 'records:write');
  const project = await loadProject(db, ctx, projectId);
  if ((await loadLines(db, ctx, projectId)).length) throw new UserError('This project already has budget lines.');
  const sources = await loadSources(db, ctx, projectId);
  if (sources.length === 0) throw new UserError('This project has no subcontracts yet. Add budget lines one by one instead.');

  const groups: Array<{ code: string; description: string; contracts: typeof sources }> = [];
  for (const s of sources) {
    const hit = tradeCode(s.trade, s.title) ?? { code: normaliseCode(s.number).slice(0, 40), description: s.title.slice(0, 200) };
    const group = groups.find((g) => sameCode(g.code, hit.code));
    if (group) group.contracts.push(s);
    else groups.push({ code: hit.code, description: hit.description, contracts: [s] });
  }
  groups.sort((a, b) => a.code.localeCompare(b.code, undefined, { numeric: true }));
  const committed = groups.map((g) => Math.max(sum(g.contracts.map((c) => c.contractSum)), 0));
  const totalCommitted = sum(committed);
  const shared = project.budget !== null && project.budget < totalCommitted;
  const amounts = shared ? shareOut(project.budget!, committed) : committed;

  for (const [i, g] of groups.entries()) {
    const id = newId('bl');
    await db.insert(budgetLines).values({ id, orgId: ctx.orgId, projectId, costCode: g.code, description: g.description, originalAmount: amounts[i]!, sortOrder: i, createdBy: ctx.userId });
    await db.update(contracts).set({ budgetLineId: id }).where(and(eq(contracts.orgId, ctx.orgId), inArray(contracts.id, g.contracts.map((c) => c.id))));
  }
  const { contingency } = await takeOverSingleBudget(db, ctx, project, sum(amounts), groups.length);
  const how =
    project.budget === null
      ? 'each at what is committed on it'
      : shared
        ? `sharing the project’s ${formatMoney(project.budget)} budget in proportion to what is committed, which is ${formatMoney(totalCommitted)}`
        : `each at what is committed on it; the rest of the project’s ${formatMoney(project.budget)} budget, ${formatMoney(contingency)}, went to ${CONTINGENCY.code} ${CONTINGENCY.description}`;
  await recordAudit(db, {
    orgId: ctx.orgId,
    actor: ctx,
    action: 'budget.started_from_subcontracts',
    entityType: 'project',
    entityId: projectId,
    summary: `Started the budget on ${project.name} from its subcontracts: ${groups.length} line${groups.length === 1 ? '' : 's'}, ${how}`,
    data: { lines: groups.map((g, i) => ({ costCode: g.code, description: g.description, originalAmount: amounts[i], contracts: g.contracts.map((c) => c.id) })), singleBudget: project.budget, contingency },
  });
  return groups.length + (contingency > 0 ? 1 : 0);
});

// ── CSV ─────────────────────────────────────────────────────────────────────

const CSV_COLUMNS = [
  'Project', 'Project No', 'Cost Code', 'Description', 'Original Budget', 'Budget Changes', 'Budget', 'Committed', 'Pending Changes', 'Projected',
  'Billed To Date', 'Forecast Method', 'Still To Commit (Forecast)', 'Estimate At Completion (Forecast)', 'Cost To Complete (Forecast)', 'Over (-) / Under (Forecast)', 'Subcontracts',
];

function csvLine(project: { name: string; number: string | null }, code: string, description: string, f: BudgetFigures, method: string, subcontracts: string): string {
  const money = [f.original, f.changes, f.budget, f.committed, f.pending, f.projected, f.billed].map(centsToDecimalString).join(',');
  const forecast = [f.stillToCommit, f.atCompletion, f.toComplete, f.variance].map(centsToDecimalString).join(',');
  return `${csvRow([project.name, project.number, code, description])},${money},${csvRow([method])},${forecast},${csvRow([subcontracts])}`;
}

export function renderBudgetCsv(budget: ProjectBudget): string {
  const numbers = (ids: string[]) => ids.map((id) => budget.contracts.find((c) => c.id === id)?.number ?? '').filter(Boolean).join('; ');
  const out = [CSV_COLUMNS.join(',')];
  for (const l of budget.lines) out.push(csvLine(budget.project, l.costCode, l.description, l, l.forecastMethod === 'entered' ? `Entered: ${l.forecastNote ?? ''}`.trim().replace(/:$/, '') : FORECAST_METHOD_LABEL[l.forecastMethod], numbers(l.contractIds)));
  if (budget.unassigned) out.push(csvLine(budget.project, '', 'Not on a budget line', budget.unassigned, '', numbers(budget.unassigned.contractIds)));
  out.push(csvLine(budget.project, '', 'Total', budget.totals, '', ''));
  return `${out.join('\r\n')}\r\n`;
}

export async function budgetCsv(db: DB, ctx: Ctx, projectId: string): Promise<{ filename: string; csv: string }> {
  assertCan(ctx, 'export:run');
  const budget = await getProjectBudget(db, ctx, projectId);
  if (!budget) throw new UserError('Project not found.');
  if (budget.lines.length === 0) throw new UserError('This project has no budget lines to download.');
  await recordAudit(db, {
    orgId: ctx.orgId,
    actor: ctx,
    action: 'budget.exported',
    entityType: 'project',
    entityId: projectId,
    summary: `Downloaded the budget by cost code for ${budget.project.name} (${budget.lines.length} lines)`,
    data: { lines: budget.lines.length },
  });
  const slug = (budget.project.number ?? budget.project.name).replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '').toLowerCase() || 'project';
  return { filename: `budget-${slug}-${new Date().toISOString().slice(0, 10)}.csv`, csv: renderBudgetCsv(budget) };
}
