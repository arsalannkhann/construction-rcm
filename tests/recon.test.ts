import { describe, expect, it } from 'vitest';
import { reconcile, type CheckResult, type DocumentIntegrity } from '@/server/recon/engine';
import { cleanInput, dollars as D } from './helpers/recon-fixture';

const fails = (checks: CheckResult[]) => checks.filter((c) => c.outcome === 'fail');
const failCodes = (checks: CheckResult[]) => fails(checks).map((c) => c.code).sort();
const find = (checks: CheckResult[], code: string) => checks.find((c) => c.code === code && c.outcome === 'fail');

describe('reconcile: a clean application', () => {
  const out = reconcile(cleanInput());

  it('recomputes the G702 from first principles', () => {
    expect(out.verified).toMatchObject({
      originalContractSum: D(500000),
      netChangeOrders: 0,
      contractSumToDate: D(500000),
      totalCompletedStored: D(225000),
      retainageWork: D(21500),
      retainageStored: D(1000),
      retainageTotal: D(22500),
      totalEarnedLessRetainage: D(202500),
      lessPreviousCertificates: D(99000),
      currentPaymentDue: D(103500),
      balanceToFinish: D(297500),
      priorApplicationNumber: 1,
      excludedLines: 0,
    });
  });

  it('raises nothing', () => {
    expect(failCodes(out.checks)).toEqual([]);
  });

  it('reports the checks that passed, so reviewers can see what was verified', () => {
    const passed = out.checks.filter((c) => c.outcome === 'pass').map((c) => c.code);
    expect(passed).toEqual(
      expect.arrayContaining([
        'doc.pay_application',
        'doc.continuation_sheet',
        'doc.signature',
        'seq.duplicate_number',
        'seq.gap',
        'math.contract_sum',
        'math.earned',
        'math.current_due',
        'math.balance',
        'math.line_total',
        'math.sheet_total',
        'contract.original_sum',
        'sov.scheduled_value',
        'sov.overbilled',
        'prior.line_previous',
        'prior.previous_certificates',
        'ret.amount',
        'pay.current_due',
        'lw.present',
        'lw.amount',
        'lw.signature',
        'lw.form',
      ]),
    );
  });
});

describe('reconcile: prior billing', () => {
  it('catches previously certified amounts being billed again', () => {
    const input = cleanInput();
    // The subcontractor deducts $10,000 too little on line 7 and so asks for $10,000 more.
    input.app.claimed.lessPreviousCertificates = D(89000);
    input.app.claimed.currentPaymentDue = D(113500);
    input.waivers[0]!.amount = D(113500);
    const out = reconcile(input);

    const prior = find(out.checks, 'prior.previous_certificates')!;
    expect(prior.severity).toBe('blocking');
    expect(prior.data).toMatchObject({ expected: D(99000), actual: D(89000), delta: -D(10000) });
    expect(prior.detail).toContain('would pay that amount a second time');

    const pay = find(out.checks, 'pay.current_due')!;
    expect(pay.data).toMatchObject({ expected: D(103500), actual: D(113500), delta: D(10000) });
    expect(pay.title).toBe('Requested payment is $10,000.00 more than the verified amount');

    // The verified amount is unaffected by what the subcontractor wrote.
    expect(out.verified.currentPaymentDue).toBe(D(103500));
    // And the waiver, which matches the inflated request, is flagged as not matching what will be paid.
    expect(find(out.checks, 'lw.amount_vs_verified')).toBeTruthy();
  });

  it('flags a line whose "previous" column disagrees with approved history', () => {
    const input = cleanInput();
    input.lines[1]!.previous = D(70000); // approved was 60,000
    input.lines[1]!.total = D(160000);
    const out = reconcile(input);
    const f = find(out.checks, 'prior.line_previous')!;
    expect(f.subjectKey).toBe('l2');
    expect(f.data).toMatchObject({ expected: D(60000), actual: D(70000), delta: D(10000) });
    // Verified totals use the approved history, not the submitted column.
    expect(out.verified.totalCompletedStored).toBe(D(225000));
  });

  it('blocks when an earlier application is still undecided', () => {
    const input = cleanInput();
    input.app.applicationNumber = 3;
    input.siblings.push({ id: 'a2', applicationNumber: 2, periodTo: '2026-10-15', status: 'needs_review' });
    const out = reconcile(input);
    expect(find(out.checks, 'seq.prior_pending')?.severity).toBe('blocking');
  });

  it('blocks a duplicate application number, but not a resubmission after rejection', () => {
    const dup = cleanInput();
    dup.siblings.push({ id: 'x', applicationNumber: 2, periodTo: '2026-10-31', status: 'needs_review' });
    expect(find(reconcile(dup).checks, 'seq.duplicate_number')).toBeTruthy();

    const resubmit = cleanInput();
    resubmit.siblings.push({ id: 'x', applicationNumber: 2, periodTo: '2026-10-31', status: 'rejected' });
    expect(find(reconcile(resubmit).checks, 'seq.duplicate_number')).toBeUndefined();
    expect(find(reconcile(resubmit).checks, 'seq.duplicate_period')).toBeUndefined();
  });

  it('blocks an application numbered at or before the last approved one', () => {
    const input = cleanInput();
    input.app.applicationNumber = 1;
    input.siblings = [];
    expect(find(reconcile(input).checks, 'seq.duplicate_number')?.title).toContain('not after the last approved');
  });

  it('warns about a gap in application numbers', () => {
    const input = cleanInput();
    input.app.applicationNumber = 4;
    const f = find(reconcile(input).checks, 'seq.gap')!;
    expect(f.severity).toBe('warning');
    expect(f.title).toBe('Application number jumps from #1 to #4');
  });

  it('flags a byte-identical file that was already submitted', () => {
    const input = cleanInput();
    input.documents[0]!.duplicateOf = { applicationNumber: 1, filename: 'payapp-1.pdf' };
    expect(find(reconcile(input).checks, 'doc.duplicate_file')?.severity).toBe('blocking');
  });

  it('keeps counting approved billing on a contract line the subcontractor left off the sheet', () => {
    const input = cleanInput();
    input.lines = input.lines.filter((l) => l.id !== 'l1'); // Mobilization (50,000 approved) omitted
    input.app.claimed.totalCompletedStored = D(175000);
    const out = reconcile(input);
    expect(out.verified.totalCompletedStored).toBe(D(225000));
    expect(find(out.checks, 'sov.missing_lines')?.detail).toContain('earlier approved billing');
    expect(find(out.checks, 'math.sheet_total')).toBeUndefined(); // the sheet is internally consistent…
    expect(find(out.checks, 'pay.current_due')).toBeUndefined(); // …and the request still equals the verified amount
  });
});

describe('reconcile: onboarding a contract that is already under way', () => {
  it('refuses to verify "previous" amounts with no history, and says how to fix it', () => {
    const input = cleanInput();
    input.prior = null;
    input.siblings = [];
    const out = reconcile(input);
    const f = find(out.checks, 'prior.no_history')!;
    expect(f.severity).toBe('blocking');
    expect(f.action).toContain('opening balances');
    // It does not pile on with per-line or bottom-line mismatches it cannot actually assess.
    expect(find(out.checks, 'prior.line_previous')).toBeUndefined();
    expect(find(out.checks, 'pay.current_due')).toBeUndefined();
    expect(find(out.checks, 'ret.amount')).toBeUndefined();
  });

  it('verifies cleanly once opening balances are set', () => {
    const input = cleanInput();
    input.siblings = [];
    input.prior = {
      kind: 'baseline',
      applicationNumber: 1,
      periodTo: null,
      totalEarnedLessRetainage: D(99000),
      retainageTotal: D(11000),
      currentPaymentDue: null,
      workToDate: { s1: D(50000), s2: D(60000) },
    };
    const out = reconcile(input);
    expect(failCodes(out.checks)).toEqual([]);
    expect(out.verified.currentPaymentDue).toBe(D(103500));
  });

  it('treats a genuine first application (nothing previous) as verifiable', () => {
    const input = cleanInput();
    input.prior = null;
    input.siblings = [];
    input.app.applicationNumber = 1;
    for (const l of input.lines) {
      l.total = (l.total ?? 0) - (l.previous ?? 0);
      l.balance = (l.scheduledValue ?? 0) - (l.total ?? 0);
      l.previous = 0;
    }
    // 90,000 + 15,000 work, 10,000 stored → 115,000; retainage 11,500; due 103,500
    Object.assign(input.app.claimed, {
      totalCompletedStored: D(115000),
      retainageWork: D(10500),
      retainageStored: D(1000),
      retainageTotal: D(11500),
      totalEarnedLessRetainage: D(103500),
      lessPreviousCertificates: 0,
      currentPaymentDue: D(103500),
      balanceToFinish: D(396500),
    });
    const out = reconcile(input);
    expect(failCodes(out.checks)).toEqual([]);
  });
});

describe('reconcile: retainage', () => {
  it('catches under-withheld retainage', () => {
    const input = cleanInput();
    // 5% withheld instead of the contract's 10%
    Object.assign(input.app.claimed, {
      retainageWork: D(10750),
      retainageStored: D(500),
      retainageTotal: D(11250),
      totalEarnedLessRetainage: D(213750),
      currentPaymentDue: D(114750),
      balanceToFinish: D(286250),
    });
    input.waivers[0]!.amount = D(114750);
    const out = reconcile(input);
    const f = find(out.checks, 'ret.amount')!;
    expect(f.title).toBe('Too little retainage is withheld');
    expect(f.data).toMatchObject({ expected: D(22500), actual: D(11250), delta: -D(11250) });
    expect(find(out.checks, 'pay.current_due')?.data?.delta).toBe(D(11250));
    // The submitted arithmetic is internally consistent, so no math findings.
    expect(failCodes(out.checks).filter((c) => c.startsWith('math.'))).toEqual([]);
  });

  it('applies a different rate to stored materials when the contract says so', () => {
    const input = cleanInput();
    input.contract.retainageStoredBps = 0;
    const out = reconcile(input);
    expect(out.verified.retainageStored).toBe(0);
    expect(out.verified.retainageTotal).toBe(D(21500));
    expect(find(out.checks, 'ret.amount')?.data?.delta).toBe(D(1000));
  });

  it('warns when retainage held would go down', () => {
    const input = cleanInput();
    input.app.claimed.retainageTotal = D(8000);
    input.app.claimed.retainageWork = D(8000);
    input.app.claimed.retainageStored = 0;
    expect(find(reconcile(input).checks, 'ret.release')?.severity).toBe('warning');
  });

  it('treats sub-dollar rounding differences as rounding, not discrepancies', () => {
    const input = cleanInput();
    input.app.claimed.retainageTotal = D(22500) + 60;
    input.app.claimed.totalEarnedLessRetainage = D(202500) - 60;
    input.app.claimed.currentPaymentDue = D(103500) - 60;
    input.app.claimed.balanceToFinish = D(297500) + 60;
    input.waivers[0]!.amount = D(103500) - 60;
    expect(failCodes(reconcile(input).checks)).toEqual([]);

    input.app.claimed.retainageTotal = D(22500) + 101;
    expect(find(reconcile(input).checks, 'ret.amount')).toBeTruthy();
  });
});

describe('reconcile: arithmetic on the submitted documents', () => {
  it('catches a G702 that does not add up', () => {
    const input = cleanInput();
    input.app.claimed.totalEarnedLessRetainage = D(205200); // transposed digits
    const out = reconcile(input);
    const f = find(out.checks, 'math.earned')!;
    expect(f.data).toMatchObject({ expected: D(202500), actual: D(205200) });
    expect(find(out.checks, 'math.current_due')).toBeTruthy(); // 205,200 − 99,000 ≠ 103,500
    expect(find(out.checks, 'math.balance')).toBeTruthy();
  });

  it('catches a row whose total is not previous + this period + stored', () => {
    const input = cleanInput();
    input.lines[1]!.total = D(155000);
    const out = reconcile(input);
    expect(find(out.checks, 'math.line_total')?.subjectKey).toBe('l2');
    expect(find(out.checks, 'math.sheet_total')).toBeTruthy();
  });

  it('skips arithmetic it cannot evaluate rather than inventing a result', () => {
    const input = cleanInput();
    input.app.claimed.totalEarnedLessRetainage = null;
    const out = reconcile(input);
    expect(out.checks.find((c) => c.code === 'math.earned')).toBeUndefined();
    expect(find(out.checks, 'extract.missing_value')?.subjectKey).toBe('totalEarnedLessRetainage');
  });
});

describe('reconcile: contract value and change orders', () => {
  it('catches a contract sum that does not match the contract', () => {
    const input = cleanInput();
    input.app.claimed.originalContractSum = D(525000);
    input.app.claimed.contractSumToDate = D(525000);
    const f = find(reconcile(input).checks, 'contract.original_sum')!;
    expect(f.data?.delta).toBe(D(25000));
  });

  it('names the pending change order behind an unapproved amount and excludes its line', () => {
    const input = cleanInput();
    input.changeOrders = [{ id: 'co1', number: 'CO-1', title: 'Added receptacles, level 2', amount: D(12000), status: 'pending' }];
    input.lines.push({ id: 'l4', sovLineId: null, itemNo: 'CO-1', description: 'Added receptacles, level 2', scheduledValue: D(12000), previous: 0, thisPeriod: D(12000), stored: 0, total: D(12000), balance: 0, retainage: D(1200) });
    Object.assign(input.app.claimed, {
      netChangeOrders: D(12000),
      contractSumToDate: D(512000),
      totalCompletedStored: D(237000),
      retainageWork: D(22700),
      retainageTotal: D(23700),
      totalEarnedLessRetainage: D(213300),
      currentPaymentDue: D(114300),
      balanceToFinish: D(298700),
    });
    input.waivers[0]!.amount = D(114300);
    const out = reconcile(input);

    const co = find(out.checks, 'co.net_change')!;
    expect(co.detail).toContain('pending change order CO-1');
    expect(co.detail).toContain('has not been approved');
    expect(find(out.checks, 'sov.unknown_line')?.subjectKey).toBe('l4');
    expect(out.verified.excludedLines).toBe(1);
    expect(out.verified.currentPaymentDue).toBe(D(103500));
    expect(find(out.checks, 'pay.current_due')?.data?.delta).toBe(D(10800)); // 12,000 less 10% retainage
  });

  it('accepts the same billing once the change order is approved and on the schedule', () => {
    const input = cleanInput();
    input.changeOrders = [{ id: 'co1', number: 'CO-1', title: 'Added receptacles, level 2', amount: D(12000), status: 'approved' }];
    input.sov.push({ id: 's4', itemNo: 'CO-1', description: 'Added receptacles, level 2', scheduledValue: D(12000) });
    input.lines.push({ id: 'l4', sovLineId: 's4', itemNo: 'CO-1', description: 'Added receptacles, level 2', scheduledValue: D(12000), previous: 0, thisPeriod: D(12000), stored: 0, total: D(12000), balance: 0, retainage: D(1200) });
    Object.assign(input.app.claimed, {
      netChangeOrders: D(12000),
      contractSumToDate: D(512000),
      totalCompletedStored: D(237000),
      retainageWork: D(22700),
      retainageTotal: D(23700),
      totalEarnedLessRetainage: D(213300),
      currentPaymentDue: D(114300),
      balanceToFinish: D(298700),
    });
    input.waivers[0]!.amount = D(114300);
    const out = reconcile(input);
    expect(failCodes(out.checks)).toEqual([]);
    expect(out.verified.currentPaymentDue).toBe(D(114300));
  });

  it('flags our own schedule of values when it does not total the contract sum', () => {
    const input = cleanInput();
    input.sov[2]!.scheduledValue = D(140000);
    input.lines[2]!.scheduledValue = D(140000);
    input.lines[2]!.balance = D(115000);
    expect(find(reconcile(input).checks, 'sov.contract_total')?.severity).toBe('warning');
  });
});

describe('reconcile: schedule of values', () => {
  it('catches a line billed beyond its scheduled value', () => {
    const input = cleanInput();
    input.lines[0]!.thisPeriod = D(5000); // Mobilization was already 100% billed
    input.lines[0]!.total = D(55000);
    input.lines[0]!.balance = -D(5000);
    const out = reconcile(input);
    const f = find(out.checks, 'sov.overbilled')!;
    expect(f.subjectKey).toBe('l1');
    expect(f.data).toMatchObject({ expected: D(50000), actual: D(55000), delta: D(5000) });
  });

  it('catches a scheduled value that was changed on the submission', () => {
    const input = cleanInput();
    input.lines[1]!.scheduledValue = D(310000);
    input.lines[1]!.balance = D(160000);
    const f = find(reconcile(input).checks, 'sov.scheduled_value')!;
    expect(f.data?.delta).toBe(D(10000));
  });

  it('requires a schedule of values on the contract before anything can be verified', () => {
    const input = cleanInput();
    input.sov = [];
    for (const l of input.lines) l.sovLineId = null;
    const out = reconcile(input);
    expect(find(out.checks, 'sov.none_on_contract')?.severity).toBe('blocking');
    expect(find(out.checks, 'pay.current_due')).toBeUndefined();
  });
});

describe('reconcile: package completeness', () => {
  it('blocks when the pay application or schedule is missing', () => {
    const input = cleanInput();
    input.documents[0]!.segments = [{ type: 'lien_waiver', pageStart: 1, pageEnd: 1, confidence: 0.9 }];
    const codes = failCodes(reconcile(input).checks);
    expect(codes).toContain('doc.pay_application');
    expect(codes).toContain('doc.continuation_sheet');
  });

  it('never assumes a signature: unclear means a person has to look', () => {
    const unclear = cleanInput();
    unclear.app.signed = 'unclear';
    expect(find(reconcile(unclear).checks, 'doc.signature')?.title).toBe('Signature could not be confirmed automatically');

    unclear.app.signatureConfirmed = true;
    expect(find(reconcile(unclear).checks, 'doc.signature')).toBeUndefined();

    const unsigned = cleanInput();
    unsigned.app.signed = 'no';
    expect(find(reconcile(unsigned).checks, 'doc.signature')?.title).toBe('Pay application is not signed');
  });

  it('flags values the engine was unsure about', () => {
    const input = cleanInput();
    input.app.confidence = { currentPaymentDue: 0.5, retainageTotal: 0.95 };
    const f = find(reconcile(input).checks, 'extract.low_confidence')!;
    expect(f.detail).toContain('Current payment due');
    expect(f.detail).not.toContain('Total retainage');
  });

  it('warns, without blocking, when the AI read failed and the backup reader stood in', () => {
    const input = cleanInput();
    input.documents.push({ id: 'd2', filename: 'waiver.pdf', status: 'processed', statusDetail: 'AI extraction failed: the AI service could not be reached. Read with the text-layer parser instead.', duplicateOf: null, segments: [] });
    const f = find(reconcile(input).checks, 'doc.read_without_ai')!;
    expect(f).toMatchObject({ subjectKey: 'd2', severity: 'warning', outcome: 'fail', refs: { documentId: 'd2', tab: 'documents' } });
    expect(f.detail).toContain('could not be reached');
    // A document read normally carries no detail, and gets no warning.
    expect(find(reconcile(cleanInput()).checks, 'doc.read_without_ai')).toBeUndefined();
  });

  it('blocks on a document that could not be read', () => {
    const input = cleanInput();
    input.documents.push({ id: 'd2', filename: 'scan.pdf', status: 'unreadable', statusDetail: null, duplicateOf: null, segments: [] });
    expect(find(reconcile(input).checks, 'doc.unreadable')?.subjectKey).toBe('d2');
  });
});

describe('reconcile: what the reading saw besides the figures', () => {
  // The clean fixture's schedule, column by column.
  const printedTotals = () => ({
    scheduledValue: D(500000),
    previous: D(110000),
    thisPeriod: D(105000),
    stored: D(10000),
    total: D(225000),
    balance: D(275000),
    retainage: D(22500),
  });
  const withFacts = (facts: Partial<DocumentIntegrity> = {}) => {
    const input = cleanInput();
    input.lines.forEach((l) => (l.documentId = 'd1'));
    input.documents[0]!.integrity = {
      pageNumbering: [],
      scheduleGrandTotal: { page: 2, label: 'GRAND TOTAL', confidence: 0.97, values: printedTotals() },
      conflicts: [],
      unreadablePages: [],
      payApplicationNumber: 2,
      ...facts,
    };
    return input;
  };
  const grandTotal = (input: ReturnType<typeof cleanInput>) => reconcile(input).checks.find((c) => c.code === 'math.grand_total');
  const NEW_CODES = ['math.grand_total', 'doc.page_missing', 'doc.unreadable_pages', 'doc.conflict'];

  it('passes when every column of the printed grand total equals the sum of the rows, and adds nothing else', () => {
    const input = withFacts();
    expect(grandTotal(input)).toMatchObject({ outcome: 'pass', subjectKey: 'd1', refs: { documentId: 'd1', page: 2, tab: 'lines' } });
    expect(failCodes(reconcile(input).checks).filter((c) => NEW_CODES.includes(c))).toEqual([]);
    // A reading from before these facts were recorded changes nothing.
    expect(reconcile(cleanInput()).checks.filter((c) => NEW_CODES.includes(c.code))).toEqual([]);
  });

  it('blocks when the rows fall short of the printed grand total, as when a row or page was not read', () => {
    const input = withFacts();
    const g = input.documents[0]!.integrity!.scheduleGrandTotal!;
    Object.assign(g.values, { scheduledValue: D(540000), thisPeriod: D(117000), total: D(237000), balance: D(303000) });
    const f = grandTotal(input)!;
    expect(f).toMatchObject({ outcome: 'fail', severity: 'blocking', category: 'math', data: { expected: D(225000), actual: D(237000), delta: D(12000) } });
    expect(f.detail).toContain('this period (E) is printed as $117,000.00 but the rows add up to $105,000.00 ($12,000.00 short)');
    expect(f.detail).toContain('completed and stored to date (G) is printed as $237,000.00');
    expect(f.detail).not.toContain('retainage is printed');
  });

  it('warns, without blocking, when only columns that do not feed the payment differ', () => {
    const input = withFacts();
    input.documents[0]!.integrity!.scheduleGrandTotal!.values.scheduledValue = D(510000);
    expect(grandTotal(input)).toMatchObject({ outcome: 'fail', severity: 'warning' });
  });

  it('sums the rows itself in integer cents and allows only the configured tolerance', () => {
    const input = withFacts();
    input.documents[0]!.integrity!.scheduleGrandTotal!.values.thisPeriod = D(105000) + 100;
    expect(grandTotal(input)?.outcome).toBe('pass');
    input.documents[0]!.integrity!.scheduleGrandTotal!.values.thisPeriod = D(105000) + 101;
    expect(grandTotal(input)?.outcome).toBe('fail');
  });

  it('counts a row keyed by hand toward the printed total, so keying the missed row clears the finding', () => {
    const input = withFacts();
    Object.assign(input.documents[0]!.integrity!.scheduleGrandTotal!.values, { scheduledValue: D(540000), thisPeriod: D(117000), total: D(237000), balance: D(303000), retainage: D(23700) });
    expect(grandTotal(input)?.outcome).toBe('fail');
    input.lines.push({ id: 'l4', documentId: null, sovLineId: null, itemNo: '4', description: 'Low voltage', scheduledValue: D(40000), previous: 0, thisPeriod: D(12000), stored: 0, total: D(12000), balance: D(28000), retainage: D(1200) });
    expect(grandTotal(input)?.outcome).toBe('pass');
  });

  it('compares a row a reviewer adjusted by what the document prints, not by the adjusted amount', () => {
    const input = withFacts();
    const l2 = input.lines[1]!;
    l2.printed = { scheduledValue: l2.scheduledValue, previous: l2.previous, thisPeriod: l2.thisPeriod, stored: l2.stored, total: l2.total, balance: l2.balance, retainage: l2.retainage };
    Object.assign(l2, { thisPeriod: D(80000), total: D(140000), balance: D(160000) });
    expect(grandTotal(input)?.outcome).toBe('pass');
  });

  it('with two printed totals in the package, ties each to the rows of its own file', () => {
    const input = withFacts();
    input.lines[2]!.documentId = 'd2';
    input.documents.push({
      id: 'd2',
      filename: 'sheet-2.pdf',
      status: 'processed',
      statusDetail: null,
      duplicateOf: null,
      segments: [{ type: 'continuation_sheet', pageStart: 1, pageEnd: 1, confidence: 0.9 }],
      integrity: { pageNumbering: [], scheduleGrandTotal: { page: 1, label: 'TOTAL', confidence: 0.97, values: { thisPeriod: D(15000), stored: D(10000), total: D(25000) } }, conflicts: [], unreadablePages: [], payApplicationNumber: null },
    });
    Object.assign(input.documents[0]!.integrity!.scheduleGrandTotal!.values, { scheduledValue: D(350000), previous: D(110000), thisPeriod: D(90000), stored: 0, total: D(200000), balance: D(150000), retainage: D(20000) });
    const results = reconcile(input).checks.filter((c) => c.code === 'math.grand_total');
    expect(results.map((c) => [c.subjectKey, c.outcome])).toEqual([
      ['d1', 'pass'],
      ['d2', 'pass'],
    ]);
  });

  it('says when the printed total itself was read with low confidence', () => {
    const input = withFacts();
    const g = input.documents[0]!.integrity!.scheduleGrandTotal!;
    g.confidence = 0.45;
    g.values.total = D(230000);
    expect(grandTotal(input)?.detail).toContain('read with low confidence');
  });

  it('blocks on pages that could not be read, naming them, until a person keys them and accepts', () => {
    const f = find(reconcile(withFacts({ unreadablePages: [2, 3, 4, 7] })).checks, 'doc.unreadable_pages')!;
    expect(f).toMatchObject({ severity: 'blocking', category: 'extraction', subjectKey: 'd1', title: 'Pages 2–4 and 7 of “payapp-2.pdf” could not be read automatically', refs: { documentId: 'd1', page: 2 } });
    expect(find(reconcile(withFacts({ unreadablePages: [3] })).checks, 'doc.unreadable_pages')?.title).toBe('Page 3 of “payapp-2.pdf” could not be read automatically');
    // A file that could not be read at all is already flagged as a whole.
    const whole = withFacts({ unreadablePages: [1, 2] });
    whole.documents[0]!.status = 'unreadable';
    expect(find(reconcile(whole).checks, 'doc.unreadable_pages')).toBeUndefined();
  });

  const mark = (page: number, number: number, of: number | null) => ({ page, number, of, source: of ? `Page ${number} of ${of}` : `Page ${number}` });

  it('blocks on a page missing from the printed numbering', () => {
    const f = find(reconcile(withFacts({ pageNumbering: [mark(1, 1, 4), mark(2, 2, 4), mark(3, 4, 4)] })).checks, 'doc.page_missing')!;
    expect(f).toMatchObject({ severity: 'blocking', category: 'documents', subjectKey: 'd1', title: '“payapp-2.pdf” is missing page 3 of 4' });
    expect(f.detail).toContain('marked “Page 1 of 4”');
    // The last pages missing count too when the total is printed.
    expect(find(reconcile(withFacts({ pageNumbering: [mark(1, 1, 3)] })).checks, 'doc.page_missing')?.title).toBe('“payapp-2.pdf” is missing pages 2 and 3 of 3');
    // Complete numbering, or a new document starting again at 1, is not a gap.
    expect(find(reconcile(withFacts({ pageNumbering: [mark(1, 1, 2), mark(2, 2, 2), mark(3, 1, 1)] })).checks, 'doc.page_missing')).toBeUndefined();
  });

  it('does not call a page missing when another file of the package carries it', () => {
    const input = withFacts({ pageNumbering: [mark(1, 1, 2)] });
    input.documents.push({ id: 'd2', filename: 'g703.pdf', status: 'processed', statusDetail: null, duplicateOf: null, segments: [], integrity: { pageNumbering: [mark(1, 2, 2)], scheduleGrandTotal: null, conflicts: [], unreadablePages: [], payApplicationNumber: null } });
    expect(find(reconcile(input).checks, 'doc.page_missing')).toBeUndefined();
  });

  const at = (value: number | null, page: number, docType: 'pay_application' | 'continuation_sheet' = 'pay_application') => ({ value, page, docType });

  it('blocks when the file states two application numbers', () => {
    const input = withFacts({ conflicts: [{ kind: 'application_number', field: 'applicationNumber', reported: at(2, 1), others: [at(3, 2, 'continuation_sheet')] }] });
    const f = find(reconcile(input).checks, 'doc.conflict')!;
    expect(f).toMatchObject({ severity: 'blocking', subjectKey: 'd1:application_number:applicationNumber', data: { expected: 2, actual: 3 }, refs: { documentId: 'd1', page: 2 } });
    expect(f.detail).toContain('is numbered 2, but the schedule of values (page 2) says 3');
  });

  it('blocks when the file holds a second pay application that was not read', () => {
    const input = withFacts({ conflicts: [{ kind: 'second_pay_application', field: 'applicationNumber', reported: at(2, 1), others: [at(null, 4)] }] });
    const f = find(reconcile(input).checks, 'doc.conflict')!;
    expect(f).toMatchObject({ severity: 'blocking', title: '“payapp-2.pdf” holds more than one pay application', refs: { page: 4 } });
    expect(f.detail).toContain('1 other application starts on page 4');
  });

  it('reports printed totals that disagree between the application and the schedule, by what they affect', () => {
    const contract = withFacts({ conflicts: [{ kind: 'total', field: 'contractSumToDate', reported: at(D(500000), 1), others: [at(D(490000), 2, 'continuation_sheet')] }] });
    expect(find(reconcile(contract).checks, 'doc.conflict')).toMatchObject({ severity: 'warning', data: { expected: D(500000), actual: D(490000), delta: -D(10000) } });
    // Within the tolerance is not a disagreement.
    const close = withFacts({ conflicts: [{ kind: 'total', field: 'contractSumToDate', reported: at(D(500000), 1), others: [at(D(500000) + 50, 2, 'continuation_sheet')] }] });
    expect(find(reconcile(close).checks, 'doc.conflict')).toBeUndefined();
    // Line 4 against the schedule is settled by the row sums, so it is not said twice.
    const line4 = withFacts({ conflicts: [{ kind: 'total', field: 'totalCompletedStored', reported: at(D(225000), 1), others: [at(D(216000), 2, 'continuation_sheet')] }] });
    expect(find(reconcile(line4).checks, 'doc.conflict')).toBeUndefined();
    line4.lines = [];
    expect(find(reconcile(line4).checks, 'doc.conflict')).toMatchObject({ severity: 'blocking' });
  });

  it('blocks when two files in the package carry pay applications with different numbers', () => {
    const input = withFacts();
    input.documents.push({ id: 'd2', filename: 'payapp-3.pdf', status: 'processed', statusDetail: null, duplicateOf: null, segments: [], integrity: { pageNumbering: [], scheduleGrandTotal: null, conflicts: [], unreadablePages: [], payApplicationNumber: 3 } });
    const f = reconcile(input).checks.find((c) => c.code === 'doc.conflict' && c.subjectKey === 'package:applicationNumber')!;
    expect(f).toMatchObject({ outcome: 'fail', severity: 'blocking' });
    expect(f.detail).toContain('“payapp-2.pdf” is application #2; “payapp-3.pdf” is application #3');
    // The same number twice (a copy of the application) is not a conflict.
    input.documents[1]!.integrity!.payApplicationNumber = 2;
    expect(reconcile(input).checks.find((c) => c.subjectKey === 'package:applicationNumber')).toBeUndefined();
  });
});
