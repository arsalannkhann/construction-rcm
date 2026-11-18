/**
 * Budget by cost code: lines, the subcontracts assigned to them, budget
 * changes, the lock, and the forecast of what is still to be committed. The
 * arithmetic is tested on its own; the workflow runs against a real
 * (in-memory) Postgres, with an application going through the real intake and
 * approval so "billed to date" is what approval recorded.
 */
import { and, eq } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import { auditEvents, budgetLines, contracts, projects } from '@/db/schema';
import { budgetFigures, lineBudgets, stillToCommit, tradeCode, type BudgetLineInput, type BudgetSource } from '@/server/services/budget-calc';
import {
  assignBudgetLines,
  budgetCsv,
  deleteBudgetLine,
  getProjectBudget,
  lockBudget,
  recordBudgetChange,
  saveBudgetLine,
  setBudgetForecast,
  shareOut,
  startBudgetFromSubcontracts,
  unlockBudget,
  voidBudgetChange,
} from '@/server/services/budget';
import { getDashboard } from '@/server/services/dashboard';
import { getProjectDetail, listProjects } from '@/server/services/records-queries';
import { createChangeOrder, createContract, createProject, createSubcontractor, updateProject } from '@/server/services/records';
import { approveApplication } from '@/server/services/review';
import { createWorld, dollars as D, packageFor, submit, type World } from './helpers/world';

const line = (id: string, over: Partial<BudgetLineInput> = {}): BudgetLineInput => ({ id, costCode: id, description: `Line ${id}`, originalAmount: D(100_000), forecastMethod: 'remaining', forecastAmount: null, ...over });
const src = (contractId: string, budgetLineId: string | null, over: Partial<BudgetSource> = {}): BudgetSource => ({ contractId, budgetLineId, contractSum: D(80_000), pendingChanges: 0, billedToDate: 0, ...over });

describe('budget arithmetic', () => {
  it('moves budget between lines with changes, and ignores void ones', () => {
    const budgets = lineBudgets(
      [line('a'), line('b'), line('c', { originalAmount: 0 })],
      [
        { fromLineId: 'a', toLineId: 'b', amount: D(10_000), status: 'approved' },
        { fromLineId: null, toLineId: 'c', amount: D(5_000), status: 'approved' },
        { fromLineId: 'b', toLineId: null, amount: D(2_000), status: 'approved' },
        { fromLineId: 'a', toLineId: 'c', amount: D(50_000), status: 'void' },
      ],
    );
    expect(budgets.get('a')).toEqual({ original: D(100_000), changes: -D(10_000), budget: D(90_000) });
    expect(budgets.get('b')).toEqual({ original: D(100_000), changes: D(8_000), budget: D(108_000) });
    expect(budgets.get('c')).toEqual({ original: 0, changes: D(5_000), budget: D(5_000) });
  });

  it('forecasts what is still to be committed by the method chosen for the line', () => {
    expect(stillToCommit('remaining', D(100_000), D(80_000), null)).toBe(D(20_000));
    expect(stillToCommit('remaining', D(100_000), D(120_000), null)).toBe(0);
    expect(stillToCommit('entered', D(100_000), D(80_000), D(35_000))).toBe(D(35_000));
    expect(stillToCommit('entered', D(100_000), D(80_000), null)).toBe(0);
    expect(stillToCommit('none', D(100_000), D(80_000), null)).toBe(0);
  });

  it('works out each line, keeps subcontracts on no line apart, and adds up to the totals', () => {
    const r = budgetFigures({
      lines: [line('a'), line('b', { forecastMethod: 'entered', forecastAmount: D(15_000) }), line('c', { forecastMethod: 'none' })],
      changes: [{ fromLineId: 'c', toLineId: 'a', amount: D(10_000), status: 'approved' }],
      sources: [
        src('x', 'a', { contractSum: D(90_000), pendingChanges: D(25_000), billedToDate: D(40_000) }),
        src('y', 'b', { billedToDate: D(10_000) }),
        src('z', 'c', { contractSum: D(60_000) }),
        src('w', null, { contractSum: D(30_000), pendingChanges: -D(1_000), billedToDate: D(5_000) }),
        src('v', 'gone', { contractSum: D(1_000) }),
      ],
    });
    const [a, b, c] = r.lines;
    // a: budget 110k, projected 115k, so nothing more is forecast and it is 5k over.
    expect(a).toMatchObject({ budget: D(110_000), committed: D(90_000), pending: D(25_000), projected: D(115_000), stillToCommit: 0, atCompletion: D(115_000), toComplete: D(75_000), variance: -D(5_000), contractIds: ['x'] });
    // b: 80k committed plus 15k entered against 100k.
    expect(b).toMatchObject({ budget: D(100_000), projected: D(80_000), stillToCommit: D(15_000), atCompletion: D(95_000), toComplete: D(85_000), variance: D(5_000) });
    // c: bought out at 60k of a 90k budget; the rest is a saving.
    expect(c).toMatchObject({ budget: D(90_000), stillToCommit: 0, atCompletion: D(60_000), variance: D(30_000) });
    // A subcontract on no line, or on a line that no longer exists, is counted apart with no budget.
    expect(r.unassigned).toMatchObject({ contractIds: ['w', 'v'], budget: 0, committed: D(31_000), pending: -D(1_000), stillToCommit: 0, atCompletion: D(30_000), variance: -D(30_000) });
    const sumOf = (k: 'budget' | 'committed' | 'pending' | 'billed' | 'atCompletion' | 'variance') => r.lines.reduce((t, l) => t + l[k], 0) + r.unassigned![k];
    for (const k of ['budget', 'committed', 'pending', 'billed', 'atCompletion', 'variance'] as const) expect(r.totals[k]).toBe(sumOf(k));
    expect(r.totals.original).toBe(D(300_000));
    expect(r.totals.changes).toBe(0);
  });

  it('suggests a cost code from the trade, then the subcontract title', () => {
    expect(tradeCode('Electrical')).toEqual({ code: '26 00 00', description: 'Electrical' });
    expect(tradeCode('HVAC')?.code).toBe('23 00 00');
    expect(tradeCode('Framing & drywall')?.code).toBe('09 00 00');
    expect(tradeCode('Fire sprinkler')?.code).toBe('21 00 00');
    expect(tradeCode('Fire alarm')?.code).toBe('28 00 00');
    expect(tradeCode('Structural steel')?.code).toBe('05 00 00');
    expect(tradeCode('Roofing')?.code).toBe('07 00 00');
    expect(tradeCode(null, 'Plumbing rough-in')?.code).toBe('22 00 00');
    expect(tradeCode('General', 'Owner allowance')).toBeNull();
  });

  it('shares an amount out in proportion, to the cent', () => {
    expect(shareOut(D(100), [1, 1, 1])).toEqual([3334, 3333, 3333]);
    expect(shareOut(1000, [300, 700])).toEqual([300, 700]);
    expect(shareOut(D(90_000), [D(50_000), D(50_000), D(20_000)]).reduce((t, x) => t + x, 0)).toBe(D(90_000));
    expect(shareOut(D(10), [0, 0])).toEqual([0, 0]);
  });
});

describe('a project budget by cost code', () => {
  let w: World;
  let other: World;
  let electrical: string;
  let contingency: string;
  let hvacContract: string;

  beforeAll(async () => {
    w = await createWorld();
    other = await createWorld();
    // The project starts with one budget figure, as projects did before budget lines.
    await updateProject(w.db, w.owner, w.projectId, { name: w.parties.project.name, number: w.parties.project.number, address: w.parties.project.address, city: 'Austin', state: 'TX', ownerName: w.parties.owner, budget: D(700_000) });
    const app1 = await submit(w, packageFor(w, 0, null));
    await approveApplication(w.db, w.controller, app1.id);
    const sub = await createSubcontractor(w.db, w.owner, { name: 'Hill Country Mechanical, Inc.', trade: 'HVAC' });
    hvacContract = await createContract(w.db, w.owner, { projectId: w.projectId, subcontractorId: sub, number: 'SC-2301-23', title: 'HVAC', originalAmount: D(150_000), retainageWorkBps: 1000, retainageStoredBps: 1000 });
  });

  it('keeps budget lines to people who keep the records, inside their own organisation', async () => {
    const input = { costCode: '26 00 00', description: 'Electrical', originalAmount: D(520_000), contractIds: [w.contractId] };
    await expect(saveBudgetLine(w.db, w.viewer, w.projectId, input)).rejects.toThrow(/permission/);
    await expect(saveBudgetLine(w.db, w.pm, w.projectId, input)).rejects.toThrow(/permission/);
    await expect(saveBudgetLine(other.db, other.owner, w.projectId, input)).rejects.toThrow(/Project not found/);
    await expect(saveBudgetLine(other.db, other.owner, other.projectId, { ...input, contractIds: [w.contractId] })).rejects.toThrow(/only subcontracts on this project/);
    await expect(saveBudgetLine(w.db, w.accountant, w.projectId, { ...input, costCode: '  ' })).rejects.toThrow(/Cost code is required/);
    await expect(saveBudgetLine(w.db, w.accountant, w.projectId, { ...input, originalAmount: -1 })).rejects.toThrow(/Enter the budget/);
    expect(await getProjectBudget(other.db, other.owner, w.projectId)).toBeNull();
  });

  it('takes over the single budget figure: the first line, plus contingency for the rest', async () => {
    electrical = await saveBudgetLine(w.db, w.accountant, w.projectId, { costCode: '26  00 00 ', description: 'Electrical', originalAmount: D(520_000), contractIds: [w.contractId] });
    const b = (await getProjectBudget(w.db, w.accountant, w.projectId))!;
    expect(b.lines.map((l) => [l.costCode, l.description, l.original])).toEqual([
      ['26 00 00', 'Electrical', D(520_000)],
      ['99 00 00', 'Contingency', D(180_000)],
    ]);
    contingency = b.lines[1]!.id;
    expect(b.totals.budget).toBe(D(700_000));
    expect(b.project.singleBudget).toBeNull();
    const [project] = await w.db.select().from(projects).where(eq(projects.id, w.projectId));
    expect(project!.budget).toBeNull();

    // Billed to date is what approval recorded: application 1 billed $110,000 of work.
    expect(b.lines[0]).toMatchObject({ committed: D(500_000), billed: D(110_000), stillToCommit: D(20_000), atCompletion: D(520_000), toComplete: D(410_000), variance: 0, contractIds: [w.contractId] });
    // The HVAC subcontract is on no line yet.
    expect(b.unassigned).toMatchObject({ contractIds: [hvacContract], committed: D(150_000) });
    expect(b.contracts.find((c) => c.id === hvacContract)?.budgetLineId).toBeNull();

    const [event] = await w.db.select().from(auditEvents).where(and(eq(auditEvents.orgId, w.orgId), eq(auditEvents.action, 'budget.line_added')));
    expect(event!.summary).toBe('Added budget line 26 00 00 Electrical on Riverside Medical Office Building: budget $520,000.00; assigned SC-2301-16; the rest of the project’s $700,000.00 budget, $180,000.00, went to 99 00 00 Contingency');
  });

  it('refuses a cost code already on the budget, whatever its case', async () => {
    await expect(saveBudgetLine(w.db, w.accountant, w.projectId, { costCode: '99 00 00', description: 'More contingency', originalAmount: 0 })).rejects.toThrow(/99 00 00 is already on this budget/);
    await expect(saveBudgetLine(w.db, w.accountant, w.projectId, { id: electrical, costCode: '99 00 00', description: 'Electrical', originalAmount: D(520_000) })).rejects.toThrow(/already on this budget/);
  });

  it('assigns subcontracts to a line, and the project page and list use the lines', async () => {
    await saveBudgetLine(w.db, w.accountant, w.projectId, { costCode: '23 00 00', description: 'HVAC', originalAmount: D(140_000), contractIds: [hvacContract] });
    const b = (await getProjectBudget(w.db, w.accountant, w.projectId))!;
    expect(b.unassigned).toBeNull();
    expect(b.totals.budget).toBe(D(840_000));
    // HVAC is $10,000 over its line on commitment alone.
    expect(b.lines.find((l) => l.costCode === '23 00 00')).toMatchObject({ committed: D(150_000), variance: -D(10_000) });

    const detail = (await getProjectDetail(w.db, w.accountant, w.projectId))!;
    expect(detail.cost.budget).toBe(D(840_000));
    expect(detail.cost.committed).toBe(b.totals.committed);
    expect(detail.cost.forecast).toEqual({ lines: 3, stillToCommit: b.totals.stillToCommit, atCompletion: b.totals.atCompletion, toComplete: b.totals.toComplete, variance: b.totals.variance });
    expect(detail.unassigned).toBe(0);
    const listed = (await listProjects(w.db, w.accountant)).find((p) => p.id === w.projectId)!;
    expect(listed.cost.budget).toBe(D(840_000));
    // The projects list shows the lines' total, not the emptied single-budget column.
    expect(listed.budget).toBe(D(840_000));
    expect(listed.budgetLines).toBe(3);
  });

  it('records a forecast with who set it, and changes the estimate at completion', async () => {
    await expect(setBudgetForecast(w.db, w.pm, electrical, { method: 'none' })).rejects.toThrow(/permission/);
    await expect(setBudgetForecast(other.db, other.owner, electrical, { method: 'none' })).rejects.toThrow(/Budget line not found/);
    await expect(setBudgetForecast(w.db, w.accountant, electrical, { method: 'entered', amount: null })).rejects.toThrow(/still expect to commit/);
    await setBudgetForecast(w.db, w.accountant, electrical, { method: 'entered', amount: D(45_000), note: 'Lighting controls not bought out yet' });
    const l = (await getProjectBudget(w.db, w.accountant, w.projectId))!.lines.find((x) => x.id === electrical)!;
    expect(l).toMatchObject({ forecastMethod: 'entered', forecastAmount: D(45_000), forecastNote: 'Lighting controls not bought out yet', forecastBy: 'Ana Accountant', stillToCommit: D(45_000), atCompletion: D(545_000), variance: -D(25_000) });
    const [event] = await w.db.select().from(auditEvents).where(and(eq(auditEvents.orgId, w.orgId), eq(auditEvents.action, 'budget.forecast_set')));
    expect(event!.summary).toBe('Set the forecast for 26 00 00 Electrical on Riverside Medical Office Building: $45,000.00 still to commit (“Lighting controls not bought out yet”)');
  });

  it('moves money between lines with budget changes, never below zero, and voids them on record', async () => {
    await expect(recordBudgetChange(w.db, w.accountant, w.projectId, { fromLineId: contingency, toLineId: contingency, amount: D(1), reason: 'x' })).rejects.toThrow(/two different lines/);
    await expect(recordBudgetChange(w.db, w.accountant, w.projectId, { fromLineId: null, toLineId: null, amount: D(1), reason: 'x' })).rejects.toThrow(/comes from/);
    await expect(recordBudgetChange(w.db, w.accountant, w.projectId, { fromLineId: contingency, toLineId: electrical, amount: 0, reason: 'x' })).rejects.toThrow(/above zero/);
    await expect(recordBudgetChange(w.db, w.accountant, w.projectId, { fromLineId: contingency, toLineId: electrical, amount: D(1), reason: ' ' })).rejects.toThrow(/reason is required/);
    await expect(recordBudgetChange(w.db, w.accountant, w.projectId, { fromLineId: contingency, toLineId: electrical, amount: D(180_001), reason: 'Too much' })).rejects.toThrow(/has \$180,000.00 of budget/);
    await expect(recordBudgetChange(other.db, other.owner, w.projectId, { fromLineId: contingency, toLineId: electrical, amount: D(1), reason: 'x' })).rejects.toThrow(/Project not found/);

    const moved = await recordBudgetChange(w.db, w.accountant, w.projectId, { fromLineId: contingency, toLineId: electrical, amount: D(25_000), reason: 'Lighting controls' });
    let b = (await getProjectBudget(w.db, w.accountant, w.projectId))!;
    expect(b.lines.find((l) => l.id === electrical)).toMatchObject({ original: D(520_000), changes: D(25_000), budget: D(545_000), variance: 0 });
    expect(b.lines.find((l) => l.id === contingency)).toMatchObject({ budget: D(155_000) });
    expect(b.totals.budget).toBe(D(840_000));
    expect(b.changes[0]).toMatchObject({ amount: D(25_000), reason: 'Lighting controls', status: 'approved', createdBy: 'Ana Accountant' });
    expect(b.changes[0]!.from?.costCode).toBe('99 00 00');

    // Money out of electrical to nowhere, then voiding the money in would leave it below zero.
    const out = await recordBudgetChange(w.db, w.accountant, w.projectId, { fromLineId: electrical, toLineId: null, amount: D(530_000), reason: 'Scope moved to owner' });
    await expect(voidBudgetChange(other.db, other.owner, moved)).rejects.toThrow(/Budget change not found/);
    await expect(voidBudgetChange(w.db, w.pm, moved)).rejects.toThrow(/permission/);
    await expect(voidBudgetChange(w.db, w.accountant, moved)).rejects.toThrow(/below zero/);
    await voidBudgetChange(w.db, w.accountant, out);
    await expect(voidBudgetChange(w.db, w.accountant, out)).rejects.toThrow(/already void/);
    b = (await getProjectBudget(w.db, w.accountant, w.projectId))!;
    expect(b.lines.find((l) => l.id === electrical)!.budget).toBe(D(545_000));
    expect(b.changes.find((c) => c.id === out)).toMatchObject({ status: 'void', voidedBy: 'Ana Accountant' });

    const events = await w.db.select().from(auditEvents).where(and(eq(auditEvents.orgId, w.orgId), eq(auditEvents.action, 'budget.change_recorded')));
    expect(events.map((e) => e.summary)).toContain('Budget change on Riverside Medical Office Building: moved $25,000.00 from 99 00 00 Contingency to 26 00 00 Electrical (“Lighting controls”)');
    const voided = await w.db.select().from(auditEvents).where(and(eq(auditEvents.orgId, w.orgId), eq(auditEvents.action, 'budget.change_voided')));
    expect(voided).toHaveLength(1);
    expect(voided[0]!.summary).toContain('$530,000.00');
  });

  it('locks the original budget; only an approver unlocks it', async () => {
    await expect(lockBudget(w.db, w.pm, w.projectId)).rejects.toThrow(/permission/);
    await lockBudget(w.db, w.accountant, w.projectId);
    await expect(lockBudget(w.db, w.accountant, w.projectId)).rejects.toThrow(/already locked/);
    expect((await getProjectBudget(w.db, w.accountant, w.projectId))!.locked).toMatchObject({ by: 'Ana Accountant' });

    await expect(saveBudgetLine(w.db, w.accountant, w.projectId, { id: electrical, costCode: '26 00 00', description: 'Electrical', originalAmount: D(600_000) })).rejects.toThrow(/locked, so the original budget of 26 00 00 stays \$520,000.00/);
    // Renaming, and moving subcontracts, are still fine.
    await saveBudgetLine(w.db, w.accountant, w.projectId, { id: electrical, costCode: '26 00 00', description: 'Electrical and lighting', originalAmount: D(520_000), contractIds: [w.contractId] });
    await expect(saveBudgetLine(w.db, w.accountant, w.projectId, { costCode: '27 00 00', description: 'Communications', originalAmount: D(10_000) })).rejects.toThrow(/new line starts at \$0/);
    const comms = await saveBudgetLine(w.db, w.accountant, w.projectId, { costCode: '27 00 00', description: 'Communications', originalAmount: 0 });
    await expect(deleteBudgetLine(w.db, w.accountant, contingency)).rejects.toThrow(/locked/);

    await expect(unlockBudget(w.db, w.accountant, w.projectId)).rejects.toThrow(/permission/);
    await unlockBudget(w.db, w.controller, w.projectId);
    expect((await getProjectBudget(w.db, w.accountant, w.projectId))!.locked).toBeNull();
    await deleteBudgetLine(w.db, w.accountant, comms);

    const logged = await w.db.select().from(auditEvents).where(eq(auditEvents.orgId, w.orgId));
    const by = (action: string) => logged.filter((e) => e.action === action);
    expect(by('budget.locked').map((e) => e.actorName)).toEqual(['Ana Accountant']);
    expect(by('budget.unlocked').map((e) => e.actorName)).toEqual(['Carlos Controller']);
    expect(by('budget.line_changed').map((e) => e.summary).join(' ')).toContain('Electrical and lighting');
  });

  it('moves subcontracts between lines in one go, inside the project', async () => {
    await expect(assignBudgetLines(w.db, w.pm, w.projectId, [{ contractId: hvacContract, lineId: contingency }])).rejects.toThrow(/permission/);
    await expect(assignBudgetLines(other.db, other.owner, other.projectId, [{ contractId: hvacContract, lineId: null }])).rejects.toThrow(/only subcontracts on this project/);
    await expect(assignBudgetLines(w.db, w.accountant, w.projectId, [{ contractId: hvacContract, lineId: 'bl_nope' }])).rejects.toThrow(/budget line on this project/);
    const hvac = (await getProjectBudget(w.db, w.accountant, w.projectId))!.lines.find((l) => l.costCode === '23 00 00')!;
    await assignBudgetLines(w.db, w.accountant, w.projectId, [{ contractId: hvacContract, lineId: contingency }, { contractId: w.contractId, lineId: electrical }]);
    let b = (await getProjectBudget(w.db, w.accountant, w.projectId))!;
    expect(b.lines.find((l) => l.id === contingency)!.contractIds).toEqual([hvacContract]);
    expect(b.lines.find((l) => l.id === hvac.id)!.contractIds).toEqual([]);
    const events = await w.db.select().from(auditEvents).where(and(eq(auditEvents.orgId, w.orgId), eq(auditEvents.action, 'budget.subcontracts_assigned')));
    // Only the subcontract that moved is in the record.
    expect(events.map((e) => e.summary)).toEqual(['Budget lines on Riverside Medical Office Building: SC-2301-23 to 99 00 00 Contingency']);
    await assignBudgetLines(w.db, w.accountant, w.projectId, [{ contractId: hvacContract, lineId: hvac.id }]);
    b = (await getProjectBudget(w.db, w.accountant, w.projectId))!;
    expect(b.lines.find((l) => l.id === hvac.id)!.contractIds).toEqual([hvacContract]);
  });

  it('removes a line only without budget changes on record, and its subcontracts go back to no line', async () => {
    await expect(deleteBudgetLine(w.db, w.accountant, contingency)).rejects.toThrow(/budget changes on record/);
    const hvac = (await getProjectBudget(w.db, w.accountant, w.projectId))!.lines.find((l) => l.costCode === '23 00 00')!;
    await expect(deleteBudgetLine(other.db, other.owner, hvac.id)).rejects.toThrow(/Budget line not found/);
    await deleteBudgetLine(w.db, w.accountant, hvac.id);
    const [c] = await w.db.select({ budgetLineId: contracts.budgetLineId }).from(contracts).where(eq(contracts.id, hvacContract));
    expect(c!.budgetLineId).toBeNull();
    const b = (await getProjectBudget(w.db, w.accountant, w.projectId))!;
    expect(b.unassigned?.contractIds).toEqual([hvacContract]);
    const [event] = await w.db.select().from(auditEvents).where(and(eq(auditEvents.orgId, w.orgId), eq(auditEvents.action, 'budget.line_removed'), eq(auditEvents.entityId, w.projectId)));
    expect(event).toBeDefined();
  });

  it('flags lines over budget, subcontracts on no line, and a forecast overrun on the overview', async () => {
    // A pending change order pushes electrical over its line.
    await createChangeOrder(w.db, w.owner, w.contractId, { number: 'CO-7', title: 'Generator feed', amount: D(60_000), status: 'pending' });
    const dash = await getDashboard(w.db, w.accountant);
    const keys = dash.risks.map((r) => r.key);
    expect(keys).toContain(`lines:${w.projectId}`);
    expect(keys).toContain(`unassigned:${w.projectId}`);
    const lines = dash.risks.find((r) => r.key === `lines:${w.projectId}`)!;
    expect(lines.detail).toContain('26 00 00 Electrical and lighting by $15,000.00');
    expect(lines.href).toBe(`/projects/${w.projectId}/budget`);
    const project = dash.projects.find((p) => p.id === w.projectId)!;
    expect(project.cost.budget).toBe(D(700_000));
    expect(project.cost.forecast?.lines).toBe(2);
  });

  it('downloads the budget as CSV for people who run exports, with negative amounts as numbers', async () => {
    await expect(budgetCsv(w.db, w.pm, w.projectId)).rejects.toThrow(/permission/);
    await expect(budgetCsv(other.db, other.owner, w.projectId)).rejects.toThrow(/Project not found/);
    const { filename, csv } = await budgetCsv(w.db, w.accountant, w.projectId);
    expect(filename).toMatch(/^budget-2301-\d{4}-\d{2}-\d{2}\.csv$/);
    const rows = csv.trim().split('\r\n');
    expect(rows[0]).toContain('Cost Code,Description,Original Budget,Budget Changes,Budget,Committed');
    expect(rows[1]).toMatch(/^Riverside Medical Office Building,2301,26 00 00,Electrical and lighting,520000\.00,25000\.00,545000\.00,500000\.00,60000\.00,560000\.00,110000\.00,Entered: Lighting controls not bought out yet,45000\.00,605000\.00,495000\.00,-60000\.00,SC-2301-16$/);
    expect(rows.some((r) => r.includes(',Not on a budget line,') && r.endsWith(',SC-2301-23'))).toBe(true);
    expect(rows.at(-1)).toMatch(/,Total,/);
    const [event] = await w.db.select().from(auditEvents).where(and(eq(auditEvents.orgId, w.orgId), eq(auditEvents.action, 'budget.exported')));
    expect(event!.summary).toBe('Downloaded the budget by cost code for Riverside Medical Office Building (2 lines)');
  });
});

describe('starting a budget from the subcontracts', () => {
  async function project(w: World, budget: number | null) {
    const projectId = await createProject(w.db, w.owner, { name: `Project ${Math.random()}`, state: 'TX', budget });
    const elec = await createSubcontractor(w.db, w.owner, { name: 'Volt Co', trade: 'Electrical' });
    const roof = await createSubcontractor(w.db, w.owner, { name: 'Top Roofing', trade: 'Roofing' });
    const other = await createSubcontractor(w.db, w.owner, { name: 'Misc LLC', trade: 'General' });
    const base = { projectId, retainageWorkBps: 1000, retainageStoredBps: 1000 };
    await createContract(w.db, w.owner, { ...base, subcontractorId: elec, number: 'E-1', title: 'Electrical', originalAmount: D(300_000) });
    await createContract(w.db, w.owner, { ...base, subcontractorId: elec, number: 'E-2', title: 'Site lighting', originalAmount: D(100_000) });
    await createContract(w.db, w.owner, { ...base, subcontractorId: roof, number: 'R-1', title: 'Roofing', originalAmount: D(150_000) });
    await createContract(w.db, w.owner, { ...base, subcontractorId: other, number: 'M-1', title: 'Owner allowance work', originalAmount: D(50_000) });
    return projectId;
  }

  let w: World;
  beforeAll(async () => {
    w = await createWorld();
  });

  it('makes one line per trade at what is committed, with the rest of the budget as contingency', async () => {
    const projectId = await project(w, D(700_000));
    await expect(startBudgetFromSubcontracts(w.db, w.pm, projectId)).rejects.toThrow(/permission/);
    expect(await startBudgetFromSubcontracts(w.db, w.accountant, projectId)).toBe(4);
    await expect(startBudgetFromSubcontracts(w.db, w.accountant, projectId)).rejects.toThrow(/already has budget lines/);
    const b = (await getProjectBudget(w.db, w.accountant, projectId))!;
    expect(b.lines.map((l) => [l.costCode, l.description, l.original, l.contractIds.length])).toEqual([
      ['07 00 00', 'Thermal and moisture protection', D(150_000), 1],
      ['26 00 00', 'Electrical', D(400_000), 2],
      ['99 00 00', 'Contingency', D(100_000), 0],
      ['M-1', 'Owner allowance work', D(50_000), 1],
    ]);
    expect(b.totals.budget).toBe(D(700_000));
    expect(b.unassigned).toBeNull();
  });

  it('shares a budget smaller than what is committed in proportion, so the project stays over by the same amount', async () => {
    const projectId = await project(w, D(540_000));
    await startBudgetFromSubcontracts(w.db, w.accountant, projectId);
    const b = (await getProjectBudget(w.db, w.accountant, projectId))!;
    expect(b.lines.map((l) => l.original)).toEqual([D(135_000), D(360_000), D(45_000)]);
    expect(b.totals.budget).toBe(D(540_000));
    expect(b.totals.committed - b.totals.budget).toBe(D(60_000));
    const [event] = await w.db.select().from(auditEvents).where(and(eq(auditEvents.orgId, w.orgId), eq(auditEvents.action, 'budget.started_from_subcontracts'), eq(auditEvents.entityId, projectId)));
    expect(event!.summary).toContain('sharing the project’s $540,000.00 budget in proportion to what is committed, which is $600,000.00');
  });

  it('needs subcontracts to start from', async () => {
    const projectId = await createProject(w.db, w.owner, { name: 'Empty project', state: 'TX' });
    await expect(startBudgetFromSubcontracts(w.db, w.accountant, projectId)).rejects.toThrow(/no subcontracts yet/);
    const lines = await w.db.select().from(budgetLines).where(eq(budgetLines.projectId, projectId));
    expect(lines).toEqual([]);
  });
});
