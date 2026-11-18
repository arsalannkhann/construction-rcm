/**
 * The arithmetic of a budget by cost code. Pure: given the budget lines, the
 * budget changes and the project's subcontracts, it works out each line and
 * the totals.
 *
 * Two kinds of figure, kept apart on purpose:
 *
 * - From records: the budget (original plus budget changes), what is
 *   committed (subcontract sums with approved change orders), pending change
 *   orders, and what has been billed and approved to date.
 * - Forecast: what is still to be committed on a line, by the method chosen
 *   for it, and what follows from it (the estimate at completion, the cost to
 *   complete, and the projected over or under). A person chose the method;
 *   nothing here is predicted from billing patterns.
 *
 * Subcontracts not assigned to any line are gathered in a row of their own, so
 * the lines plus that row always add up to the project's totals.
 */

export const FORECAST_METHODS = ['remaining', 'entered', 'none'] as const;
export type ForecastMethod = (typeof FORECAST_METHODS)[number];

export const FORECAST_METHOD_LABEL: Record<ForecastMethod, string> = {
  remaining: 'The rest of the budget',
  entered: 'An amount we enter',
  none: 'Nothing more',
};

export const FORECAST_METHOD_HINT: Record<ForecastMethod, string> = {
  remaining: 'Assumes whatever is not yet committed on the line will still be spent.',
  entered: 'You enter what you still expect to commit: scope not yet bought out, and changes you expect.',
  none: 'The line is bought out. Whatever is left of its budget is a saving.',
};

export type BudgetLineInput = {
  id: string;
  costCode: string;
  description: string;
  originalAmount: number;
  forecastMethod: ForecastMethod;
  /** Only read when the method is `entered`. */
  forecastAmount: number | null;
};

export type BudgetChangeInput = { fromLineId: string | null; toLineId: string | null; amount: number; status: string };

export type BudgetSource = {
  contractId: string;
  budgetLineId: string | null;
  /** Original amount plus approved change orders. */
  contractSum: number;
  /** Change orders still pending; can be negative. */
  pendingChanges: number;
  /** Completed and stored to date, per the latest approved application. */
  billedToDate: number;
};

export type BudgetFigures = {
  original: number;
  /** Net of budget changes in and out. */
  changes: number;
  /** Original plus changes. */
  budget: number;
  committed: number;
  pending: number;
  /** Committed plus pending. */
  projected: number;
  billed: number;
  /** Forecast: cost still expected beyond what is committed and pending. Never negative. */
  stillToCommit: number;
  /** Forecast: projected plus still to commit. */
  atCompletion: number;
  /** Forecast: estimate at completion less billed to date. */
  toComplete: number;
  /** Forecast: budget less estimate at completion. Positive is under budget, negative over. */
  variance: number;
};

export type BudgetLineFigures = BudgetFigures & { id: string; contractIds: string[] };

export type BudgetResult = {
  lines: BudgetLineFigures[];
  /** Subcontracts that are on no line; null when every subcontract has one. */
  unassigned: (BudgetFigures & { contractIds: string[] }) | null;
  totals: BudgetFigures;
};

const total = (xs: number[]) => xs.reduce((t, x) => t + x, 0);

/** Revised budget for each line: its original amount plus changes in, less changes out. Void changes do not count. */
export function lineBudgets(lines: Pick<BudgetLineInput, 'id' | 'originalAmount'>[], changes: BudgetChangeInput[]): Map<string, { original: number; changes: number; budget: number }> {
  const out = new Map(lines.map((l) => [l.id, { original: l.originalAmount, changes: 0, budget: l.originalAmount }]));
  for (const c of changes) {
    if (c.status === 'void') continue;
    const from = c.fromLineId ? out.get(c.fromLineId) : undefined;
    const to = c.toLineId ? out.get(c.toLineId) : undefined;
    if (from) {
      from.changes -= c.amount;
      from.budget -= c.amount;
    }
    if (to) {
      to.changes += c.amount;
      to.budget += c.amount;
    }
  }
  return out;
}

/** What is still to be committed on a line, by its method. */
export function stillToCommit(method: ForecastMethod, budget: number, projected: number, entered: number | null): number {
  if (method === 'none') return 0;
  if (method === 'entered') return Math.max(entered ?? 0, 0);
  return Math.max(budget - projected, 0);
}

function figures(original: number, changes: number, sources: BudgetSource[], forecast: (budget: number, projected: number) => number): BudgetFigures {
  const budget = original + changes;
  const committed = total(sources.map((s) => s.contractSum));
  const pending = total(sources.map((s) => s.pendingChanges));
  const projected = committed + pending;
  const billed = total(sources.map((s) => s.billedToDate));
  const still = forecast(budget, projected);
  const atCompletion = projected + still;
  return { original, changes, budget, committed, pending, projected, billed, stillToCommit: still, atCompletion, toComplete: atCompletion - billed, variance: budget - atCompletion };
}

const KEYS = ['original', 'changes', 'budget', 'committed', 'pending', 'projected', 'billed', 'stillToCommit', 'atCompletion', 'toComplete', 'variance'] as const;

function add(rows: BudgetFigures[]): BudgetFigures {
  const out = Object.fromEntries(KEYS.map((k) => [k, 0])) as BudgetFigures;
  for (const r of rows) for (const k of KEYS) out[k] += r[k];
  return out;
}

export function budgetFigures(input: { lines: BudgetLineInput[]; changes: BudgetChangeInput[]; sources: BudgetSource[] }): BudgetResult {
  const budgets = lineBudgets(input.lines, input.changes);
  const known = new Set(input.lines.map((l) => l.id));
  const lines = input.lines.map((l): BudgetLineFigures => {
    const mine = input.sources.filter((s) => s.budgetLineId === l.id);
    const b = budgets.get(l.id)!;
    return { id: l.id, contractIds: mine.map((s) => s.contractId), ...figures(b.original, b.changes, mine, (budget, projected) => stillToCommit(l.forecastMethod, budget, projected, l.forecastAmount)) };
  });
  const loose = input.sources.filter((s) => s.budgetLineId === null || !known.has(s.budgetLineId));
  const unassigned = loose.length ? { contractIds: loose.map((s) => s.contractId), ...figures(0, 0, loose, () => 0) } : null;
  return { lines, unassigned, totals: add([...lines, ...(unassigned ? [unassigned] : [])]) };
}

// ── Starting a budget from the subcontracts already on a project ────────────

/**
 * Cost codes for common subcontracted trades, numbered by the construction
 * divisions most US contractors already use. Matched on the subcontractor's
 * trade, then the subcontract's title.
 */
export const TRADE_CODES: Array<{ code: string; description: string; match: RegExp }> = [
  { code: '03 00 00', description: 'Concrete', match: /concrete|rebar|reinforc|formwork/i },
  { code: '04 00 00', description: 'Masonry', match: /masonry|brick|cmu|stone/i },
  { code: '05 00 00', description: 'Metals', match: /steel|metal|iron|welding/i },
  { code: '06 00 00', description: 'Wood and plastics', match: /carpent|wood|millwork|casework|cabinet/i },
  { code: '07 00 00', description: 'Thermal and moisture protection', match: /roof|waterproof|insulat|sealant|siding/i },
  { code: '08 00 00', description: 'Openings', match: /door|window|glaz|glass|storefront|curtain ?wall/i },
  { code: '09 00 00', description: 'Finishes', match: /drywall|framing|plaster|paint|floor|tile|ceiling|carpet|finish/i },
  { code: '14 00 00', description: 'Conveying equipment', match: /elevator|escalator|lift/i },
  { code: '21 00 00', description: 'Fire suppression', match: /sprinkler|fire (protection|suppression)/i },
  { code: '22 00 00', description: 'Plumbing', match: /plumb/i },
  { code: '23 00 00', description: 'HVAC', match: /hvac|mechanical|heating|air condition|ventilat/i },
  { code: '26 00 00', description: 'Electrical', match: /electric/i },
  { code: '27 00 00', description: 'Communications', match: /low ?voltage|communicat|data|telecom/i },
  { code: '28 00 00', description: 'Electronic safety and security', match: /fire alarm|security|access control/i },
  { code: '31 00 00', description: 'Earthwork', match: /earthwork|excavat|grading|demolition|sitework/i },
  { code: '32 00 00', description: 'Exterior improvements', match: /paving|asphalt|landscap|fenc/i },
  { code: '33 00 00', description: 'Utilities', match: /utilit|sewer|storm ?drain|water line/i },
];

export function tradeCode(...hints: Array<string | null | undefined>): { code: string; description: string } | null {
  for (const hint of hints) {
    if (!hint) continue;
    const hit = TRADE_CODES.find((t) => t.match.test(hint));
    if (hit) return { code: hit.code, description: hit.description };
  }
  return null;
}

export const CONTINGENCY = { code: '99 00 00', description: 'Contingency' };
