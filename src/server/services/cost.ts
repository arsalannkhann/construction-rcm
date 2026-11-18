/**
 * A project's cost position: what is budgeted for its subcontracted work, what
 * is committed, what pending changes could add, and what that leaves.
 *
 * These figures come from records (the project's budget, its subcontracts and
 * their change orders): "projected" is committed plus the pending change
 * orders, not an estimate of future changes. A project with budget lines also
 * carries `forecast`, worked out from the forecast method chosen for each line
 * (budget-calc.ts), and always labelled as a forecast where it is shown.
 */
import { percentOf } from '@/lib/money';

export type CostPosition = {
  budget: number | null;
  /** Subcontract sums to date: original amounts plus approved change orders. */
  committed: number;
  /** Change orders still pending on the project's subcontracts. Can be negative (deducts). */
  pendingChanges: number;
  /** Committed plus pending changes. */
  projected: number;
  /** Budget less projected: positive is under budget, negative over. Null without a budget. */
  remaining: number | null;
  /** Projected as a percentage of the budget, one decimal. Null without a budget. */
  percentOfBudget: number | null;
  /** Only for a project with budget lines. */
  forecast: CostForecast | null;
};

export type CostForecast = {
  /** Budget lines on the project. */
  lines: number;
  /** Cost still expected beyond committed and pending, by each line's method. */
  stillToCommit: number;
  /** Projected plus still to commit. */
  atCompletion: number;
  /** Estimate at completion less completed and stored to date. */
  toComplete: number;
  /** Budget less the estimate at completion: positive is under, negative over. */
  variance: number;
};

/** Projected cost at or above this share of the budget is flagged as close to it. */
export const NEAR_BUDGET_PERCENT = 95;
/** Pending change orders at or above this share of a subcontract's sum are flagged. */
export const LARGE_PENDING_PERCENT = 10;

export function costPosition(budget: number | null, committed: number, pendingChanges: number, forecast: CostForecast | null = null): CostPosition {
  const projected = committed + pendingChanges;
  return {
    forecast,
    budget,
    committed,
    pendingChanges,
    projected,
    remaining: budget === null ? null : budget - projected,
    percentOfBudget: budget === null || budget <= 0 ? null : percentOf(projected, budget),
  };
}

export type BudgetStanding = 'none' | 'over' | 'near' | 'within';

export function budgetStanding(p: Pick<CostPosition, 'remaining' | 'percentOfBudget'>): BudgetStanding {
  if (p.remaining === null) return 'none';
  if (p.remaining < 0) return 'over';
  if (p.percentOfBudget !== null && p.percentOfBudget >= NEAR_BUDGET_PERCENT) return 'near';
  return 'within';
}
