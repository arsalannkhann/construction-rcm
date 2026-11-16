/**
 * Projects and contracts: reading a pasted schedule of values, and the
 * figures the project and contract screens show before and after billing is
 * approved. Runs against a real (in-memory) Postgres.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { createChangeOrder, createSubcontractor, parseScheduleText, saveSchedule } from '@/server/services/records';
import { getContractDetail, getMatchingDraft, getProjectDetail, listProjectOptions, listProjects, listSubcontractorOptions } from '@/server/services/records-queries';
import { approveApplication, setOpeningBalances } from '@/server/services/review';
import { createWorld, dollars as D, packageFor, stateAfter, submit, type World } from './helpers/world';

describe('reading a pasted schedule of values', () => {
  it('reads rows copied from a spreadsheet (tab-separated)', () => {
    const text = ['1\tMobilization\t50,000.00', '2\tRough-in, levels 1-3\t$300,000.00', '3\tFixtures and trim\t150000'].join('\n');
    expect(parseScheduleText(text)).toEqual({
      lines: [
        { itemNo: '1', description: 'Mobilization', scheduledValue: D(50000) },
        { itemNo: '2', description: 'Rough-in, levels 1-3', scheduledValue: D(300000) },
        { itemNo: '3', description: 'Fixtures and trim', scheduledValue: D(150000) },
      ],
      problems: [],
    });
  });

  it('tolerates Windows line endings, blank rows, an empty column and a trailing tab', () => {
    const text = '1\tMobilization\t\t50,000.00\t\r\n\r\n2\tRough-in\t\t300,000.00\t\r\n';
    expect(parseScheduleText(text)).toEqual({
      lines: [
        { itemNo: '1', description: 'Mobilization', scheduledValue: D(50000) },
        { itemNo: '2', description: 'Rough-in', scheduledValue: D(300000) },
      ],
      problems: [],
    });
  });

  it('reads comma-separated rows with thousands separators inside the amounts', () => {
    const text = ['1,Mobilization,50,000.00', '2,Site utilities,1,250,000.00', '3,Fixtures and trim,"150,000.00"', '4,Closeout,(2,500.00)', '5, Punch list , $7,500'].join('\n');
    expect(parseScheduleText(text)).toEqual({
      lines: [
        { itemNo: '1', description: 'Mobilization', scheduledValue: D(50000) },
        { itemNo: '2', description: 'Site utilities', scheduledValue: D(1250000) },
        { itemNo: '3', description: 'Fixtures and trim', scheduledValue: D(150000) },
        { itemNo: '4', description: 'Closeout', scheduledValue: -D(2500) },
        { itemNo: '5', description: 'Punch list', scheduledValue: D(7500) },
      ],
      problems: [],
    });
  });

  it('does not mistake a description that ends or starts with a number for part of an amount', () => {
    const text = ['2,"Rough-in, levels 1-3",300,000.00', '3,Drywall - Level 2,85,000.00', '4,200A panel upgrade,12,500.00', '5,480 V switchgear,45,000'].join('\n');
    expect(parseScheduleText(text)).toEqual({
      lines: [
        { itemNo: '2', description: 'Rough-in, levels 1-3', scheduledValue: D(300000) },
        { itemNo: '3', description: 'Drywall - Level 2', scheduledValue: D(85000) },
        { itemNo: '4', description: '200A panel upgrade', scheduledValue: D(12500) },
        { itemNo: '5', description: '480 V switchgear', scheduledValue: D(45000) },
      ],
      problems: [],
    });
  });

  it('skips a header row and numbers the lines itself when there is no item column', () => {
    expect(parseScheduleText('Item\tDescription of work\tScheduled value\n1\tMobilization\t50,000.00')).toEqual({
      lines: [{ itemNo: '1', description: 'Mobilization', scheduledValue: D(50000) }],
      problems: [],
    });
    expect(parseScheduleText('Item,Description,Scheduled Value\nA-1,Mobilization,50000\nA-2,Rough-in,300000.5')).toEqual({
      lines: [
        { itemNo: 'A-1', description: 'Mobilization', scheduledValue: D(50000) },
        { itemNo: 'A-2', description: 'Rough-in', scheduledValue: D(300000.5) },
      ],
      problems: [],
    });
    expect(parseScheduleText('Mobilization\t50,000.00\nRough-in\t300,000.00').lines).toEqual([
      { itemNo: '1', description: 'Mobilization', scheduledValue: D(50000) },
      { itemNo: '2', description: 'Rough-in', scheduledValue: D(300000) },
    ]);
  });

  it('reports the rows it cannot read, by row number, and keeps the rest', () => {
    const text = ['1\tMobilization\t50,000.00', '2\tRough-in\tTBD', 'see attached breakdown', '4\t\t10,000.00', '5\tFixtures and trim\t150,000.00'].join('\n');
    const { lines, problems } = parseScheduleText(text);
    expect(lines).toEqual([
      { itemNo: '1', description: 'Mobilization', scheduledValue: D(50000) },
      { itemNo: '5', description: 'Fixtures and trim', scheduledValue: D(150000) },
    ]);
    expect(problems).toEqual(['Row 2: “TBD” is not an amount.', 'Row 3: expected an item number, a description and a value.', 'Row 4: missing a description.']);
  });

  it('leaves out a total row that matches the lines, and says so when it does not', () => {
    const lines = [
      { itemNo: '1', description: 'Mobilization', scheduledValue: D(24000) },
      { itemNo: '2', description: 'Ductwork - Level 1', scheduledValue: D(156000) },
      { itemNo: '3', description: 'Rooftop units', scheduledValue: D(300000) },
    ];
    const rows = ['Item\tDescription\tScheduled Value', '1\tMobilization\t$24,000.00', '2\tDuctwork - Level 1\t$156,000.00', '3\tRooftop units\t$300,000.00'];
    // The ways a spreadsheet's last row is usually laid out.
    for (const total of ['\tTOTAL\t$480,000.00', 'Total\t\t480,000.00', 'Grand Total:\t480000', '\tTotal contract sum\t$480,000.00', ',Total,"480,000.00"']) {
      expect(parseScheduleText([...rows, total].join('\n')), total).toEqual({ lines, problems: [] });
    }
    // Subtotals between sections are left out too; the grand total still checks.
    expect(parseScheduleText(['1\tMobilization\t24,000', '2\tDuctwork - Level 1\t156,000', '\tSubtotal\t180,000', '3\tRooftop units\t300,000', '\tSub-total\t300,000', '\tGrand total\t480,000'].join('\n'))).toEqual({ lines, problems: [] });

    const wrong = parseScheduleText([...rows, '\tTOTAL\t$500,000.00'].join('\n'));
    expect(wrong.lines).toEqual(lines);
    expect(wrong.problems).toEqual(['Row 5: the total row says $500,000.00, but the rows above add up to $480,000.00. It was left out; check the rows.']);

    // A line of work whose name only starts with the word is a line.
    expect(parseScheduleText('7\tTotal station layout\t4,500.00').lines).toEqual([{ itemNo: '7', description: 'Total station layout', scheduledValue: D(4500) }]);
  });

  it('returns nothing, and no complaint, for empty text', () => {
    expect(parseScheduleText('  \n\n')).toEqual({ lines: [], problems: [] });
  });
});

describe('project and contract figures', () => {
  let w: World;
  let app1Id: string;
  beforeAll(async () => {
    w = await createWorld();
  });

  it('shows a new subcontract as committed and entirely unbilled', async () => {
    const [row] = await listProjects(w.db, w.viewer);
    expect(row).toMatchObject({ id: w.projectId, name: 'Riverside Medical Office Building', state: 'TX', status: 'active', contracts: 1, committed: D(500000), approvedToDate: 0, inReview: 0 });

    const project = (await getProjectDetail(w.db, w.viewer, w.projectId))!;
    expect(project.totals).toEqual({ committed: D(500000), approvedToDate: 0, retainageHeld: 0, balanceToFinish: D(500000) });
    expect(project.contracts).toHaveLength(1);
    expect(project.contracts[0]).toMatchObject({
      id: w.contractId,
      number: 'SC-2301-16',
      subcontractorName: 'Lone Star Electric, LLC',
      contractSum: D(500000),
      completedStored: 0,
      retainageHeld: 0,
      balanceToFinish: D(500000),
      latestApproved: null,
      latestApplication: null,
    });
    expect(project.applications).toEqual([]);

    const contract = (await getContractDetail(w.db, w.viewer, w.contractId))!;
    expect(contract.position).toEqual({
      originalAmount: D(500000),
      approvedChangeOrders: 0,
      contractSum: D(500000),
      approvedToDate: 0,
      completedStored: 0,
      retainageHeld: 0,
      earnedLessRetainage: 0,
      balanceToFinish: D(500000),
      latestApproved: null,
    });
    expect(contract.project).toMatchObject({ id: w.projectId, name: 'Riverside Medical Office Building' });
    expect(contract.subcontractor).toMatchObject({ id: w.subcontractorId, name: 'Lone Star Electric, LLC' });
    expect(contract.schedule.map((l) => [l.itemNo, l.scheduledValue, l.changeOrderId])).toEqual([
      ['1', D(50000), null],
      ['2', D(300000), null],
      ['3', D(150000), null],
    ]);
    expect(contract.scheduleTotal).toBe(D(500000));
    expect(contract.changeOrders).toEqual([]);
    expect(contract.baseline).toBeNull();
    expect(contract.applications).toEqual([]);
  });

  it('counts an application under review, but none of its money, until it is approved', async () => {
    const app = await submit(w, packageFor(w, 0, null));
    app1Id = app.id;
    expect(app.status).toBe('needs_review');

    const [row] = await listProjects(w.db, w.viewer);
    expect(row).toMatchObject({ inReview: 1, approvedToDate: 0, committed: D(500000) });

    const project = (await getProjectDetail(w.db, w.viewer, w.projectId))!;
    expect(project.totals).toEqual({ committed: D(500000), approvedToDate: 0, retainageHeld: 0, balanceToFinish: D(500000) });
    expect(project.contracts[0]).toMatchObject({ completedStored: 0, latestApproved: null, latestApplication: { id: app.id, status: 'needs_review', applicationNumber: 1 } });
    expect(project.applications).toEqual([expect.objectContaining({ id: app.id, status: 'needs_review', applicationNumber: 1, periodTo: '2026-09-30', claimedAmount: D(99000), approvedAmount: null, subcontractorName: 'Lone Star Electric, LLC', contractNumber: 'SC-2301-16' })]);

    const contract = (await getContractDetail(w.db, w.viewer, w.contractId))!;
    expect(contract.position).toMatchObject({ approvedToDate: 0, completedStored: 0, retainageHeld: 0, balanceToFinish: D(500000), latestApproved: null });
    expect(contract.applications).toEqual([expect.objectContaining({ id: app.id, status: 'needs_review', applicationNumber: 1, claimedAmount: D(99000), approvedAmount: null, approvedRetainage: null })]);
  });

  it('moves the figures when the application is approved', async () => {
    await approveApplication(w.db, w.controller, app1Id);

    const [row] = await listProjects(w.db, w.viewer);
    expect(row).toMatchObject({ inReview: 0, approvedToDate: D(99000), committed: D(500000) });

    const project = (await getProjectDetail(w.db, w.viewer, w.projectId))!;
    expect(project.totals).toEqual({ committed: D(500000), approvedToDate: D(99000), retainageHeld: D(11000), balanceToFinish: D(401000) });
    expect(project.contracts[0]).toMatchObject({
      contractSum: D(500000),
      completedStored: D(110000),
      retainageHeld: D(11000),
      balanceToFinish: D(401000),
      latestApplication: { id: app1Id, status: 'approved', applicationNumber: 1 },
    });

    const contract = (await getContractDetail(w.db, w.viewer, w.contractId))!;
    expect(contract.position).toEqual({
      originalAmount: D(500000),
      approvedChangeOrders: 0,
      contractSum: D(500000),
      approvedToDate: D(99000),
      completedStored: D(110000),
      retainageHeld: D(11000),
      earnedLessRetainage: D(99000),
      balanceToFinish: D(401000),
      latestApproved: { id: app1Id, applicationNumber: 1, periodTo: '2026-09-30' },
    });
    expect(contract.applications[0]).toMatchObject({ status: 'approved', approvedAmount: D(99000), approvedRetainage: D(11000) });
  });

  it('takes cumulative figures from the latest approved application and sums the payments', async () => {
    const app2 = await submit(w, packageFor(w, 1, stateAfter(packageFor(w, 0, null))));
    await approveApplication(w.db, w.controller, app2.id);

    const contract = (await getContractDetail(w.db, w.viewer, w.contractId))!;
    expect(contract.position).toMatchObject({
      approvedToDate: D(202500), // 99,000 + 103,500
      completedStored: D(225000),
      retainageHeld: D(22500),
      earnedLessRetainage: D(202500),
      balanceToFinish: D(297500),
      latestApproved: { id: app2.id, applicationNumber: 2, periodTo: '2026-10-31' },
    });
    // Newest first.
    expect(contract.applications.map((a) => a.applicationNumber)).toEqual([2, 1]);

    const project = (await getProjectDetail(w.db, w.viewer, w.projectId))!;
    expect(project.totals).toEqual({ committed: D(500000), approvedToDate: D(202500), retainageHeld: D(22500), balanceToFinish: D(297500) });
    expect(project.applications.map((a) => a.applicationNumber)).toEqual([2, 1]);
    expect((await listProjects(w.db, w.viewer))[0]).toMatchObject({ approvedToDate: D(202500), inReview: 0 });
  });

  it('adds approved change orders, and only approved ones, to the committed value and the schedule', async () => {
    const approvedId = await createChangeOrder(w.db, w.accountant, w.contractId, { number: 'CO-1', title: 'Added receptacles, level 2', amount: D(12000), status: 'approved', approvedOn: '2026-11-03' });
    await createChangeOrder(w.db, w.accountant, w.contractId, { number: 'CO-2', title: 'Generator pad', amount: D(40000), status: 'pending' });

    const contract = (await getContractDetail(w.db, w.viewer, w.contractId))!;
    expect(contract.position).toMatchObject({ originalAmount: D(500000), approvedChangeOrders: D(12000), contractSum: D(512000), earnedLessRetainage: D(202500), balanceToFinish: D(309500) });
    expect(contract.changeOrders.map((c) => [c.number, c.amount, c.status, c.approvedOn])).toEqual([
      ['CO-1', D(12000), 'approved', '2026-11-03'],
      ['CO-2', D(40000), 'pending', null],
    ]);
    // The approved change order has a schedule line of its own, listed after the contract's lines.
    expect(contract.schedule.map((l) => [l.itemNo, l.changeOrderId])).toEqual([
      ['1', null],
      ['2', null],
      ['3', null],
      ['CO-1', approvedId],
    ]);
    expect(contract.scheduleTotal).toBe(D(512000));

    const project = (await getProjectDetail(w.db, w.viewer, w.projectId))!;
    expect(project.totals).toMatchObject({ committed: D(512000), balanceToFinish: D(309500) });
    expect((await listProjects(w.db, w.viewer))[0]).toMatchObject({ committed: D(512000) });
  });

  it('lets the schedule be edited in place: lines keep their ids and change-order lines are left alone', async () => {
    const before = (await getContractDetail(w.db, w.viewer, w.contractId))!;
    const base = before.schedule.filter((l) => !l.changeOrderId);
    const edited = base.map((l) => ({ id: l.id, itemNo: l.itemNo, description: l.itemNo === '3' ? 'Fixtures, trim and devices' : l.description, scheduledValue: l.scheduledValue }));
    await saveSchedule(w.db, w.accountant, w.contractId, [...edited, { itemNo: '4', description: 'Testing and commissioning', scheduledValue: D(5000) }]);

    const after = (await getContractDetail(w.db, w.viewer, w.contractId))!;
    expect(after.schedule.map((l) => [l.itemNo, l.description, !!l.changeOrderId])).toEqual([
      ['1', 'Mobilization', false],
      ['2', 'Rough-in, levels 1-3', false],
      ['3', 'Fixtures, trim and devices', false],
      ['4', 'Testing and commissioning', false],
      ['CO-1', 'Added receptacles, level 2', true],
    ]);
    expect(after.schedule.slice(0, 3).map((l) => l.id)).toEqual(base.map((l) => l.id));
    expect(after.scheduleTotal).toBe(D(517000));

    // A line with approved billing against it is part of the record and cannot be dropped.
    await expect(saveSchedule(w.db, w.accountant, w.contractId, edited.filter((l) => l.itemNo !== '2'))).rejects.toThrow(/Line 2 .* has approved billing against it and cannot be removed/);
  });

  it('offers the organisation’s own projects and subcontractors when setting up a subcontract', async () => {
    expect(await listProjectOptions(w.db, w.accountant)).toEqual([{ id: w.projectId, name: 'Riverside Medical Office Building', number: '2301', status: 'active' }]);
    expect(await listSubcontractorOptions(w.db, w.accountant)).toEqual([{ id: w.subcontractorId, name: 'Lone Star Electric, LLC', trade: 'Electrical' }]);
  });

  it('never shows one organisation another’s projects or contracts', async () => {
    const other = await createWorld();
    expect(await getProjectDetail(w.db, other.owner, w.projectId)).toBeNull();
    expect(await getContractDetail(w.db, other.owner, w.contractId)).toBeNull();
    expect(await getProjectDetail(w.db, w.owner, other.projectId)).toBeNull();
    expect(await getContractDetail(w.db, w.owner, other.contractId)).toBeNull();

    expect((await listProjects(w.db, other.owner)).map((p) => p.id)).toEqual([other.projectId]);
    expect((await listProjects(w.db, w.owner)).map((p) => p.id)).toEqual([w.projectId]);
    // The other organisation's figures are untouched by this one's approvals and change orders.
    expect((await listProjects(w.db, other.owner))[0]).toMatchObject({ committed: D(500000), approvedToDate: 0, inReview: 0 });
    expect((await getProjectDetail(w.db, other.owner, other.projectId))!.totals).toEqual({ committed: D(500000), approvedToDate: 0, retainageHeld: 0, balanceToFinish: D(500000) });
    expect((await listProjectOptions(w.db, other.owner)).map((p) => p.id)).toEqual([other.projectId]);
    expect((await listSubcontractorOptions(w.db, other.owner)).map((s) => s.id)).toEqual([other.subcontractorId]);
  });
});

describe('a contract that was already under way', () => {
  it('reports the opening balances and who recorded them, without counting them as approved here', async () => {
    const w = await createWorld();
    const app = await submit(w, packageFor(w, 1, stateAfter(packageFor(w, 0, null))));
    await setOpeningBalances(w.db, w.controller, app.id);

    const contract = (await getContractDetail(w.db, w.viewer, w.contractId))!;
    expect(contract.baseline).toMatchObject({
      asOfApplicationNumber: 1,
      previousCertificates: D(99000),
      retainageHeld: null,
      setByName: 'Carlos Controller',
      sourceApplication: { id: app.id, applicationNumber: 2 },
    });
    expect(contract.baseline!.setAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(contract.position).toMatchObject({ approvedToDate: 0, completedStored: 0, retainageHeld: 0, balanceToFinish: D(500000), latestApproved: null });

    // Once the application is approved, its record carries the cumulative figures, opening balance included.
    await approveApplication(w.db, w.controller, app.id);
    const after = (await getContractDetail(w.db, w.viewer, w.contractId))!;
    expect(after.position).toMatchObject({ approvedToDate: D(103500), completedStored: D(225000), retainageHeld: D(22500), earnedLessRetainage: D(202500), balanceToFinish: D(297500) });
  });
});

describe('setting up a subcontract from a package that could not be matched', () => {
  it('offers what the package states, matched to records on file, and nothing for anyone else', async () => {
    const w = await createWorld();
    // A package from a subcontractor and job that are not on file yet.
    const unmatched = await submit(
      w,
      packageFor(w, 0, null, (p) => {
        p.sub.name = 'Pecos Drywall, Inc.';
        p.project = { ...p.project, name: 'Cedar Park Clinic', number: '2417' };
        p.contract.number = 'SC-2417-09';
      }),
    );
    expect(unmatched.status).toBe('needs_matching');

    const draft = await getMatchingDraft(w.db, w.accountant, unmatched.id);
    expect(draft).toMatchObject({
      appId: unmatched.id,
      title: 'Pecos Drywall, Inc. · Application #1',
      contractorName: 'Pecos Drywall, Inc.',
      projectName: 'Cedar Park Clinic',
      projectNumber: '2417',
      contractNumber: 'SC-2417-09',
      projectId: null,
      subcontractorId: null,
    });
    // Only identifiers: never an amount or a rate to copy into the subcontract.
    expect(Object.keys(draft!).sort()).toEqual(['appId', 'contractNumber', 'contractorName', 'projectId', 'projectName', 'projectNumber', 'subcontractorId', 'title']);

    // Once the subcontractor is on file (spelt a little differently), it is recognised.
    const subId = await createSubcontractor(w.db, w.accountant, { name: 'Pecos Drywall Inc', trade: 'Drywall', contactName: null, contactEmail: null, phone: null, address: null });
    expect((await getMatchingDraft(w.db, w.accountant, unmatched.id))!.subcontractorId).toBe(subId);

    // Another organisation, a matched application or an unknown id gives nothing.
    const other = await createWorld();
    expect(await getMatchingDraft(other.db, other.accountant, unmatched.id)).toBeNull();
    const matched = await submit(w, packageFor(w, 0, null), { filename: 'matched.pdf' });
    expect(matched.status).not.toBe('needs_matching');
    expect(await getMatchingDraft(w.db, w.accountant, matched.id)).toBeNull();
    expect(await getMatchingDraft(w.db, w.accountant, 'pa_doesnotexist')).toBeNull();
    expect(await getMatchingDraft(w.db, w.accountant, null)).toBeNull();
  });
});
