'use server';

import { getDb } from '@/db';
import { run, type ActionResult } from '@/lib/action';
import { requireCtx } from '@/server/auth/session';
import {
  assignBudgetLines,
  deleteBudgetLine,
  lockBudget,
  recordBudgetChange,
  saveBudgetLine,
  setBudgetForecast,
  startBudgetFromSubcontracts,
  unlockBudget,
  voidBudgetChange,
  type BudgetChangeSave,
  type BudgetLineSave,
  type ForecastInput,
} from '@/server/services/budget';

export async function saveBudgetLineAction(projectId: string, input: BudgetLineSave): Promise<ActionResult<{ id: string }>> {
  return run(async () => {
    const ctx = await requireCtx();
    return { id: await saveBudgetLine(await getDb(), ctx, projectId, input) };
  });
}

export async function deleteBudgetLineAction(lineId: string): Promise<ActionResult> {
  return run(async () => {
    const ctx = await requireCtx();
    await deleteBudgetLine(await getDb(), ctx, lineId);
    return undefined;
  });
}

export async function setBudgetForecastAction(lineId: string, input: ForecastInput): Promise<ActionResult> {
  return run(async () => {
    const ctx = await requireCtx();
    await setBudgetForecast(await getDb(), ctx, lineId, input);
    return undefined;
  });
}

export async function recordBudgetChangeAction(projectId: string, input: BudgetChangeSave): Promise<ActionResult<{ id: string }>> {
  return run(async () => {
    const ctx = await requireCtx();
    return { id: await recordBudgetChange(await getDb(), ctx, projectId, input) };
  });
}

export async function voidBudgetChangeAction(changeId: string): Promise<ActionResult> {
  return run(async () => {
    const ctx = await requireCtx();
    await voidBudgetChange(await getDb(), ctx, changeId);
    return undefined;
  });
}

export async function lockBudgetAction(projectId: string): Promise<ActionResult> {
  return run(async () => {
    const ctx = await requireCtx();
    await lockBudget(await getDb(), ctx, projectId);
    return undefined;
  });
}

export async function unlockBudgetAction(projectId: string): Promise<ActionResult> {
  return run(async () => {
    const ctx = await requireCtx();
    await unlockBudget(await getDb(), ctx, projectId);
    return undefined;
  });
}

export async function startBudgetFromSubcontractsAction(projectId: string): Promise<ActionResult<{ lines: number }>> {
  return run(async () => {
    const ctx = await requireCtx();
    return { lines: await startBudgetFromSubcontracts(await getDb(), ctx, projectId) };
  });
}

export async function assignBudgetLinesAction(projectId: string, assignments: Array<{ contractId: string; lineId: string | null }>): Promise<ActionResult> {
  return run(async () => {
    const ctx = await requireCtx();
    await assignBudgetLines(await getDb(), ctx, projectId, assignments);
    return undefined;
  });
}
