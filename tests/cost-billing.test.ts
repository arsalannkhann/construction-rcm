/**
 * Cost control and billing periods: a project's budget against what is
 * committed and pending, which subcontracts owe an application for which
 * period, the roll-up of approved billing for the owner invoice, and the risk
 * list on the overview. The board rules are tested on their own; the rest runs
 * against a real (in-memory) Postgres.
 */
import { eq } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import { auditEvents, projects } from '@/db/schema';
import { buildBoard, billingRollup, getBillingBoard, monthsEnding, shiftMonth, type BoardApplication, type BoardContract, type BoardProject } from '@/server/services/billing';
import { budgetStanding, costPosition } from '@/server/services/cost';
import { getDashboard } from '@/server/services/dashboard';
import { createChangeOrder, createProject, updateProject } from '@/server/services/records';
import { getProjectDetail } from '@/server/services/records-queries';
import { approveApplication } from '@/server/services/review';
import { createWorld, dollars as D, packageFor, stateAfter, submit, type World } from './helpers/world';

describe('months', () => {
  it('steps across year ends and lists a window oldest first', () => {
    expect(shiftMonth('2026-01', -1)).toBe('2025-12');
    expect(shiftMonth('2026-12', 1)).toBe('2027-01');
    expect(monthsEnding('2027-02', 4)).toEqual(['2026-11', '2026-12', '2027-01', '2027-02']);
  });
});

describe('cost position', () => {
  it('compares committed plus pending changes with the budget', () => {
    expect(costPosition(D(1_000_000), D(800_000), D(50_000))).toEqual({ budget: D(1_000_000), committed: D(800_000), pendingChanges: D(50_000), projected: D(850_000), remaining: D(150_000), percentOfBudget: 85, forecast: null });
    expect(budgetStanding(costPosition(D(1_000_000), D(800_000), D(50_000)))).toBe('within');
    expect(budgetStanding(costPosition(D(1_000_000), D(900_000), D(60_000)))).toBe('near');
    expect(budgetStanding(costPosition(D(1_000_000), D(980_000), D(40_000)))).toBe('over');
    expect(costPosition(D(1_000_000), D(980_000), D(40_000)).remaining).toBe(-D(20_000));
  });

  it('has no standing without a budget, and lets a deduct reduce the projection', () => {
    const p = costPosition(null, D(500_000), -D(10_000));
    expect(p).toMatchObject({ projected: D(490_000), remaining: null, percentOfBudget: null });
    expect(budgetStanding(p)).toBe('none');
  });
});

describe('the billing board', () => {
  const project: BoardProject = { id: 'p1', name: 'Riverside', number: '2301', status: 'active' };
  const contract = (id: string, over: Partial<BoardContract> = {}): BoardContract => ({ id, projectId: 'p1', number: `SC-${id}`, title: 'Work', subcontractorName: `Sub ${id}`, status: 'active', contractSum: D(100_000), ...over });
  let seq = 0;
  const app = (contractId: string, periodTo: string | null, over: Partial<BoardApplication> = {}): BoardApplication => ({
    id: `a${++seq}`,
    contractId,
    status: 'approved',
    applicationNumber: seq,
    periodTo,
    receivedAt: new Date(`${periodTo ?? '2026-10-01'}T12:00:00Z`),
    claimedAmount: D(10_000),
    approvedAmount: D(9_000),
    approvedCompletedStored: D(10_000),
    ...over,
  });
  const months = ['2026-09', '2026-10', '2026-11', '2026-12'];
  const states = (row: { cells: Array<{ state: string }> }) => row.cells.map((c) => c.state);

  it('marks a subcontract that had been billing and sent nothing as missing, and the current month as due', () => {
    const board = buildBoard({ projects: [project], contracts: [contract('c1')], applications: [app('c1', '2026-09-30'), app('c1', '2026-10-31', { status: 'needs_review', approvedAmount: null, approvedCompletedStored: null })], months, current: '2026-12' });
    expect(states(board.sections[0]!.rows[0]!)).toEqual(['approved', 'in_review', 'missing', 'due']);
    expect(board.periods.map((p) => [p.month, p.expected, p.received, p.missing, p.due])).toEqual([
      ['2026-09', 1, 1, 0, 0],
      ['2026-10', 1, 1, 0, 0],
      ['2026-11', 1, 0, 1, 0],
      ['2026-12', 1, 0, 0, 1],
    ]);
  });

  it('does not expect anything from a subcontract that has not started billing, is fully billed, or is closed', () => {
    const board = buildBoard({
      projects: [project],
      contracts: [contract('new'), contract('done'), contract('shut', { status: 'closed' })],
      applications: [app('done', '2026-09-30', { approvedCompletedStored: D(100_000) }), app('shut', '2026-10-31')],
      months,
      current: '2026-12',
    });
    expect(board.sections[0]!.rows.map((r) => r.id)).toEqual(['new', 'done', 'shut']);
    const [fresh, done, shut] = board.sections[0]!.rows;
    expect(states(fresh!)).toEqual(['not_started', 'not_started', 'not_started', 'not_started']);
    expect(states(done!)).toEqual(['approved', 'complete', 'complete', 'complete']);
    // A closed subcontract still shows the application it sent in the window, and nothing is expected after.
    expect(states(shut!)).toEqual(['closed', 'approved', 'closed', 'closed']);
    expect(board.periods.map((p) => p.expected)).toEqual([1, 1, 0, 0]);
    expect(board.periods.every((p) => p.missing === 0)).toBe(true);
  });

  it('a change order that raises the subcontract sum reopens a fully billed one', () => {
    const board = buildBoard({ projects: [project], contracts: [contract('c1', { contractSum: D(120_000) })], applications: [app('c1', '2026-09-30', { approvedCompletedStored: D(100_000) })], months, current: '2026-12' });
    expect(states(board.sections[0]!.rows[0]!)).toEqual(['approved', 'missing', 'missing', 'due']);
  });

  it('lets an approved resubmission speak for its period over the rejected original, and counts the extra', () => {
    const board = buildBoard({
      projects: [project],
      contracts: [contract('c1'), contract('c2')],
      applications: [
        app('c1', '2026-10-31', { status: 'rejected', approvedAmount: null, approvedCompletedStored: null, receivedAt: new Date('2026-11-02T00:00:00Z') }),
        app('c1', '2026-10-31', { receivedAt: new Date('2026-11-09T00:00:00Z') }),
        app('c2', '2026-10-31', { status: 'rejected', approvedAmount: null, approvedCompletedStored: null, claimedAmount: D(55_000) }),
        app('c2', '2026-09-30', { status: 'void' }),
      ],
      months: ['2026-10'],
      current: '2026-12',
    });
    const [c1, c2] = board.sections[0]!.rows;
    expect(c1!.cells[0]).toMatchObject({ state: 'approved', others: 1 });
    expect(c2!.cells[0]).toMatchObject({ state: 'rejected', others: 0 });
    // The rejected one is not "received", and its amount is not counted as requested.
    expect(board.periods[0]).toMatchObject({ expected: 2, received: 1, approved: 1, rejected: 1, requested: D(10_000), approvedAmount: D(9_000) });
  });

  it('ignores void applications, drops months after the current one, and lists applications with no period', () => {
    const board = buildBoard({ projects: [project], contracts: [contract('c1')], applications: [app('c1', '2026-09-30', { status: 'void' }), app('c1', null, { status: 'needs_review' })], months: [...months, '2027-01'], current: '2026-12' });
    expect(board.months).toEqual(months);
    expect(states(board.sections[0]!.rows[0]!)).toEqual(['not_started', 'not_started', 'not_started', 'not_started']);
    expect(board.sections[0]!.undated).toEqual([expect.objectContaining({ contractId: 'c1', status: 'needs_review' })]);
  });

  it('on a closed project shows only subcontracts with an application in the window', () => {
    const closed: BoardProject = { ...project, status: 'closed' };
    const board = buildBoard({ projects: [closed], contracts: [contract('quiet'), contract('late')], applications: [app('late', '2026-11-30')], months, current: '2026-12' });
    expect(board.sections[0]!.rows.map((r) => r.id)).toEqual(['late']);
    expect(states(board.sections[0]!.rows[0]!)).toEqual(['closed', 'closed', 'approved', 'closed']);
  });
});

describe('budgets, billing periods and the roll-up, end to end', () => {
  let w: World;
  let other: World;
  let app1Id: string;
  const now = new Date('2026-11-15T12:00:00Z'); // November is current; October has ended.
  // The world's project as created, so an edit changes only the budget.
  const riverside = { name: 'Riverside Medical Office Building', number: '2301', address: '880 Riverside Dr, Austin, TX 78704', city: 'Austin', state: 'TX', ownerName: 'Riverside Health Partners' };

  beforeAll(async () => {
    w = await createWorld();
    other = await createWorld();
  });

  it('keeps a budget on the project: set on create, kept by edits that leave it out, cleared with null', async () => {
    const id = await createProject(w.db, w.owner, { name: 'Budgeted job', budget: D(750_000) });
    const read = async () => (await w.db.select({ budget: projects.budget }).from(projects).where(eq(projects.id, id)))[0]!.budget;
    expect(await read()).toBe(D(750_000));
    await updateProject(w.db, w.owner, id, { name: 'Budgeted job, renamed' });
    expect(await read()).toBe(D(750_000));
    await updateProject(w.db, w.owner, id, { name: 'Budgeted job, renamed', budget: null });
    expect(await read()).toBeNull();
    for (const bad of [0, -D(1), 12.5]) await expect(updateProject(w.db, w.owner, id, { name: 'x', budget: bad })).rejects.toThrow(/budget above zero/);
    await expect(updateProject(w.db, w.viewer, id, { name: 'x', budget: D(1) })).rejects.toThrow(/permission/);
  });

  it('shows the project over budget once a pending change order is counted', async () => {
    await updateProject(w.db, w.owner, w.projectId, { ...riverside, budget: D(520_000) });
    let detail = (await getProjectDetail(w.db, w.viewer, w.projectId))!;
    expect(detail.cost).toMatchObject({ budget: D(520_000), committed: D(500_000), pendingChanges: 0, remaining: D(20_000) });
    expect(budgetStanding(detail.cost)).toBe('near'); // 96.2%

    await createChangeOrder(w.db, w.accountant, w.contractId, { number: 'CO-9', title: 'Generator pad', amount: D(40_000), status: 'pending' });
    detail = (await getProjectDetail(w.db, w.viewer, w.projectId))!;
    expect(detail.cost).toMatchObject({ pendingChanges: D(40_000), projected: D(540_000), remaining: -D(20_000) });
    expect(budgetStanding(detail.cost)).toBe('over');
  });

  it('tracks each period: approved, then missing once the next month has ended, and due in the current one', async () => {
    const app1 = await submit(w, packageFor(w, 0, null));
    app1Id = app1.id;
    await approveApplication(w.db, w.controller, app1.id);

    const board = await getBillingBoard(w.db, w.viewer, { months: ['2026-09', '2026-10', '2026-11'], current: '2026-11', projectId: w.projectId });
    expect(board.sections).toHaveLength(1);
    const row = board.sections[0]!.rows[0]!;
    expect(row.id).toBe(w.contractId);
    expect(row.cells.map((c) => c.state)).toEqual(['approved', 'missing', 'due']);
    expect(row.cells[0]!.application).toMatchObject({ id: app1.id, applicationNumber: 1, claimedAmount: D(99_000), approvedAmount: D(99_000) });

    // The October application arrives.
    const app2 = await submit(w, packageFor(w, 1, stateAfter(packageFor(w, 0, null))));
    const after = await getBillingBoard(w.db, w.viewer, { months: ['2026-09', '2026-10', '2026-11'], current: '2026-11', projectId: w.projectId });
    expect(after.sections[0]!.rows[0]!.cells.map((c) => c.state)).toEqual(['approved', 'in_review', 'due']);
    expect(after.sections[0]!.rows[0]!.cells[1]!.application?.id).toBe(app2.id);
  });

  it('never puts one organisation’s subcontracts on another’s board', async () => {
    const theirs = await getBillingBoard(other.db, other.owner, { months: ['2026-09', '2026-10'], current: '2026-11' });
    expect(theirs.sections.map((s) => s.project.id)).toEqual([other.projectId]);
    const asked = await getBillingBoard(other.db, other.owner, { months: ['2026-09'], current: '2026-11', projectId: w.projectId });
    expect(asked.sections).toEqual([]);
  });

  it('rolls up the approved billing for a period from the approved records, and logs the download', async () => {
    const file = await billingRollup(w.db, w.accountant, w.projectId, '2026-09');
    expect(file.count).toBe(1);
    expect(file.filename).toBe('approved-billing-2301-2026-09.csv');
    const [header, line, end] = file.csv.split('\r\n');
    expect(header).toBe(
      'Project,Project No,Billing Period,Subcontractor,Contract No,Application No,Period To,Approved On,Approved By,Contract Sum To Date,Work This Period,Materials Presently Stored,Total Completed And Stored,Retainage Held,Total Earned Less Retainage,Less Previous Certificates,Approved Payment,Record Id',
    );
    const cells = line!.split(',');
    expect(cells.slice(0, 7)).toEqual(['Riverside Medical Office Building', '2301', '2026-09', '"Lone Star Electric', ' LLC"', 'SC-2301-16', '1']);
    expect(cells.slice(-9)).toEqual(['500000.00', '110000.00', '0.00', '110000.00', '11000.00', '99000.00', '0.00', '99000.00', app1Id]);
    expect(end).toBe('');

    // October's application is not approved, so it is not in October's roll-up.
    expect((await billingRollup(w.db, w.accountant, w.projectId, '2026-10')).count).toBe(0);

    const logged = await w.db.select().from(auditEvents).where(eq(auditEvents.action, 'billing.rollup_exported'));
    expect(logged.filter((e) => e.orgId === w.orgId)).toHaveLength(2);
  });

  it('keeps the roll-up to people who can export, inside their own organisation', async () => {
    await expect(billingRollup(w.db, w.viewer, w.projectId, '2026-09')).rejects.toThrow(/permission/);
    await expect(billingRollup(w.db, w.pm, w.projectId, '2026-09')).rejects.toThrow(/permission/);
    await expect(billingRollup(other.db, other.owner, w.projectId, '2026-09')).rejects.toThrow(/Project not found/);
    await expect(billingRollup(w.db, w.accountant, w.projectId, '2026-13')).rejects.toThrow(/billing period/);
  });

  it('puts the budget overrun, the large pending change and the missed period on the overview', async () => {
    const fresh = await createWorld();
    await updateProject(fresh.db, fresh.owner, fresh.projectId, { ...riverside, budget: D(510_000) });
    await createChangeOrder(fresh.db, fresh.accountant, fresh.contractId, { number: 'CO-2', title: 'Generator pad', amount: D(60_000), status: 'pending' });
    const app1 = await submit(fresh, packageFor(fresh, 0, null));
    await approveApplication(fresh.db, fresh.controller, app1.id);

    const d = await getDashboard(fresh.db, fresh.viewer, now);
    expect(d.risks.map((r) => [r.tone, r.title])).toEqual([
      ['block', 'Riverside Medical Office Building is projected over budget'],
      ['block', 'No application from Lone Star Electric, LLC for Oct 2026'],
      ['warn', 'Large pending changes on SC-2301-16'],
    ]);
    expect(d.risks[0]!.detail).toContain('$50,000.00 over');
    expect(d.billing.last).toMatchObject({ month: '2026-10', expected: 1, received: 0, missing: 1 });
    expect(d.billing.current).toMatchObject({ month: '2026-11', expected: 1, due: 1 });
    expect(d.projects[0]!.cost).toMatchObject({ budget: D(510_000), pendingChanges: D(60_000), remaining: -D(50_000) });
  });
});
