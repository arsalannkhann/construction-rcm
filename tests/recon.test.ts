import { describe, expect, it } from 'vitest';
import { reconcile, type CheckResult } from '@/server/recon/engine';
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

  it('blocks on a document that could not be read', () => {
    const input = cleanInput();
    input.documents.push({ id: 'd2', filename: 'scan.pdf', status: 'unreadable', statusDetail: null, duplicateOf: null, segments: [] });
    expect(find(reconcile(input).checks, 'doc.unreadable')?.subjectKey).toBe('d2');
  });
});
