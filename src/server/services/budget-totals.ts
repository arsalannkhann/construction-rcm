/**
 * Budget-line totals for the pages that show a project's budget without its
 * lines: the project list, the project page and the overview. Kept apart from
 * budget.ts so the read models can use it without importing the services.
 */
import { and, asc, eq, ne } from 'drizzle-orm';
import type { DB } from '@/db';
import { budgetChanges, budgetLines } from '@/db/schema';
import { budgetFigures, FORECAST_METHODS, lineBudgets, type BudgetFigures, type BudgetLineInput, type BudgetSource, type ForecastMethod } from './budget-calc';

type LineRow = typeof budgetLines.$inferSelect;

const asMethod = (m: string): ForecastMethod => ((FORECAST_METHODS as readonly string[]).includes(m) ? (m as ForecastMethod) : 'remaining');

export const lineInputs = (lines: LineRow[]): BudgetLineInput[] =>
  lines.map((l) => ({ id: l.id, costCode: l.costCode, description: l.description, originalAmount: l.originalAmount, forecastMethod: asMethod(l.forecastMethod), forecastAmount: l.forecastAmount }));

/**
 * For each project in the organisation that has budget lines: how many, and
 * the budget they add up to (original amounts plus budget changes).
 */
export async function budgetTotals(db: DB, orgId: string): Promise<Map<string, { lines: number; budget: number }>> {
  const lines = await db.select({ id: budgetLines.id, projectId: budgetLines.projectId, originalAmount: budgetLines.originalAmount }).from(budgetLines).where(eq(budgetLines.orgId, orgId));
  const out = new Map<string, { lines: number; budget: number }>();
  if (lines.length === 0) return out;
  const changes = await db
    .select({ fromLineId: budgetChanges.fromLineId, toLineId: budgetChanges.toLineId, amount: budgetChanges.amount, status: budgetChanges.status })
    .from(budgetChanges)
    .where(and(eq(budgetChanges.orgId, orgId), ne(budgetChanges.status, 'void')));
  const budgets = lineBudgets(lines, changes);
  for (const l of lines) {
    const t = out.get(l.projectId) ?? { lines: 0, budget: 0 };
    t.lines += 1;
    t.budget += budgets.get(l.id)!.budget;
    out.set(l.projectId, t);
  }
  return out;
}

/** The project's budget as the rest of the product compares against: the total of its lines if it has any, else its single figure. */
export function effectiveBudget(project: { id: string; budget: number | null }, totals: Map<string, { lines: number; budget: number }>): number | null {
  const t = totals.get(project.id);
  return t && t.lines > 0 ? t.budget : project.budget;
}

/**
 * Budget figures for every project in the organisation that has lines: each
 * line, the subcontracts on no line, and the totals. Billed to date comes from
 * the caller, which already has each subcontract's latest approved figures.
 */
export async function budgetsByProject(db: DB, orgId: string, sources: Array<BudgetSource & { projectId: string }>) {
  const out = new Map<string, { lines: LineRow[]; result: ReturnType<typeof budgetFigures> }>();
  const lines = await db.select().from(budgetLines).where(eq(budgetLines.orgId, orgId)).orderBy(asc(budgetLines.costCode), asc(budgetLines.sortOrder));
  if (lines.length === 0) return out;
  const changes = await db.select().from(budgetChanges).where(and(eq(budgetChanges.orgId, orgId), ne(budgetChanges.status, 'void')));
  for (const projectId of new Set(lines.map((l) => l.projectId))) {
    const mine = lines.filter((l) => l.projectId === projectId);
    out.set(projectId, { lines: mine, result: budgetFigures({ lines: lineInputs(mine), changes: changes.filter((c) => c.projectId === projectId), sources: sources.filter((s) => s.projectId === projectId) }) });
  }
  return out;
}

/** One project's budget figures, or null when it has no budget lines. */
export async function projectBudgetFigures(db: DB, orgId: string, projectId: string, sources: BudgetSource[]) {
  const lines = await db
    .select()
    .from(budgetLines)
    .where(and(eq(budgetLines.orgId, orgId), eq(budgetLines.projectId, projectId)))
    .orderBy(asc(budgetLines.costCode), asc(budgetLines.sortOrder));
  if (lines.length === 0) return null;
  const changes = await db.select().from(budgetChanges).where(and(eq(budgetChanges.orgId, orgId), eq(budgetChanges.projectId, projectId), ne(budgetChanges.status, 'void')));
  return { lines, result: budgetFigures({ lines: lineInputs(lines), changes, sources }) };
}

/** The forecast part of a project's cost position, from its budget figures. */
export function costForecast(lines: number, totals: BudgetFigures) {
  return { lines, stillToCommit: totals.stillToCommit, atCompletion: totals.atCompletion, toComplete: totals.toComplete, variance: totals.variance };
}
