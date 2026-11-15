/**
 * Retainage beyond a flat rate: stepped terms, releases, and the checks that
 * tell an agreed release from money quietly leaving retainage.
 */
import { eq } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import { retainageReleases } from '@/db/schema';
import { PermissionError, UserError } from '@/server/auth/permissions';
import { allocate, computeRetainage, reconcile } from '@/server/recon/engine';
import type { SamplePackage } from '@/server/samples/pdf';
import { createRetainageRelease, updateContract, voidRetainageRelease } from '@/server/services/records';
import { classifySender } from '@/server/services/reconcile';
import { approveApplication } from '@/server/services/review';
import { cleanInput } from './helpers/recon-fixture';
import { createWorld, dollars as D, getApp, openFindings, packageFor, stateAfter, submit, type World } from './helpers/world';

const find = (out: ReturnType<typeof reconcile>, code: string) => out.checks.filter((c) => c.code === code);
const base = { contractSum: D(500000), workBps: 1000, storedBps: 1000 };

describe('computeRetainage', () => {
  it('applies the flat rate when there are no special terms', () => {
    const r = computeRetainage({ ...base, work: D(215000), stored: D(10000) });
    expect(r).toMatchObject({ work: D(21500), stored: D(1000), total: D(22500), released: 0, special: false });
  });

  it('stops withholding on work beyond the threshold (10% until 50% complete, then none)', () => {
    const terms = { reduction: { atPercentBps: 5000, toBps: 0, appliesTo: 'future_work' as const } };
    expect(computeRetainage({ ...base, work: D(200000), stored: 0, terms }).total).toBe(D(20000)); // below the threshold: unchanged
    expect(computeRetainage({ ...base, work: D(250000), stored: 0, terms }).total).toBe(D(25000)); // exactly at it
    expect(computeRetainage({ ...base, work: D(400000), stored: 0, terms }).total).toBe(D(25000)); // capped
  });

  it('withholds at the reduced rate on work beyond the threshold only', () => {
    const terms = { reduction: { atPercentBps: 5000, toBps: 500, appliesTo: 'future_work' as const } };
    const r = computeRetainage({ ...base, work: D(300000), stored: D(20000), terms });
    // 10% of 250,000 + 5% of 50,000 on work; 10% of 20,000 stored
    expect(r).toMatchObject({ work: D(27500), stored: D(2000), total: D(29500), special: true });
    expect(r.basis).toContain('5%');
  });

  it('drops the rate on ALL work once the threshold is reached, releasing the difference', () => {
    const terms = { reduction: { atPercentBps: 5000, toBps: 500, appliesTo: 'all_work' as const } };
    expect(computeRetainage({ ...base, work: D(249999), stored: 0, terms }).total).toBe(applyTenPercent(D(249999)));
    expect(computeRetainage({ ...base, work: D(250000), stored: 0, terms }).total).toBe(D(12500));
    expect(computeRetainage({ ...base, work: D(400000), stored: 0, terms }).total).toBe(D(20000));
  });

  it('moves the threshold when change orders change the contract sum', () => {
    const terms = { reduction: { atPercentBps: 5000, toBps: 0, appliesTo: 'future_work' as const } };
    // Contract grows to 600,000: the cap moves from 25,000 to 30,000.
    expect(computeRetainage({ ...base, contractSum: D(600000), work: D(400000), stored: 0, terms }).total).toBe(D(30000));
  });

  it('takes releases off last and never goes below zero', () => {
    expect(computeRetainage({ ...base, work: D(215000), stored: D(10000), released: D(5000) })).toMatchObject({ work: D(16500), stored: D(1000), total: D(17500), released: D(5000), special: true });
    // More recorded than there is to release: everything is released, nothing more.
    expect(computeRetainage({ ...base, work: D(100000), stored: 0, released: D(50000) })).toMatchObject({ total: 0, released: D(10000) });
    // A release larger than the retainage on work comes out of stored-material retainage next.
    expect(computeRetainage({ ...base, work: D(10000), stored: D(100000), released: D(3000) })).toMatchObject({ work: 0, stored: D(8000), total: D(8000) });
  });

  it('rounds half a cent away from zero and stays in whole cents', () => {
    // 10% of $0.05 is half a cent.
    expect(computeRetainage({ ...base, work: 5, stored: 0 }).total).toBe(1);
    expect(computeRetainage({ ...base, work: 4, stored: 0 }).total).toBe(0);
    expect(Number.isInteger(computeRetainage({ ...base, work: 33333333, stored: 7777, workBps: 750, storedBps: 333 }).total)).toBe(true);
  });
});

function applyTenPercent(cents: number): number {
  return Math.floor((cents * 1000 + 5000) / 10000);
}

describe('allocate', () => {
  it('shares a total out in whole cents that add up exactly', () => {
    const parts = allocate(100, [1, 1, 1]);
    expect(parts.reduce((a, b) => a + b, 0)).toBe(100);
    expect(parts).toEqual([34, 33, 33]);
    for (const [total, weights] of [
      [D(17500), [D(5000), D(15000), D(2500)]],
      [1, [7, 11, 13]],
      [D(12345.67), [3, 0, 9, 1]],
    ] as Array<[number, number[]]>) {
      expect(allocate(total, weights).reduce((a, b) => a + b, 0)).toBe(total);
    }
  });

  it('gives nothing when there is nothing to share or nothing to share it across', () => {
    expect(allocate(0, [5, 5])).toEqual([0, 0]);
    expect(allocate(100, [0, 0])).toEqual([0, 0]);
  });
});

describe('retainage checks in the engine', () => {
  it('accepts an application that follows the stepped terms and rejects one that ignores them', () => {
    // 80% of the fixture's completed work is past the 20% threshold.
    const terms = { reduction: { atPercentBps: 2000, toBps: 0, appliesTo: 'future_work' as const } };
    const following = cleanInput();
    following.contract.retainageTerms = terms;
    // Threshold 100,000 of work: 10,000 held on work + 1,000 on stored.
    Object.assign(following.app.claimed, { retainageWork: D(10000), retainageStored: D(1000), retainageTotal: D(11000), totalEarnedLessRetainage: D(214000), currentPaymentDue: D(115000), balanceToFinish: D(286000) });
    const ok = reconcile(following);
    expect(ok.verified.retainageTotal).toBe(D(11000));
    expect(ok.verified.currentPaymentDue).toBe(D(115000));
    expect(find(ok, 'ret.amount')[0]).toMatchObject({ outcome: 'pass' });
    // Per-line retainage is shared out and still adds up to the total.
    expect(ok.lines.reduce((a, l) => a + l.retainage, 0)).toBe(D(11000));

    const ignoring = cleanInput(); // still withholding the flat 10%
    ignoring.contract.retainageTerms = terms;
    const out = reconcile(ignoring);
    expect(find(out, 'ret.amount')[0]).toMatchObject({ outcome: 'fail', title: 'Retainage withheld is higher than the contract requires' });
    expect(out.verified.currentPaymentDue).toBe(D(115000));
  });

  it('flags retainage going down when nothing on the contract accounts for it', () => {
    const input = cleanInput();
    Object.assign(input.app.claimed, { retainageWork: D(6500), retainageStored: D(1000), retainageTotal: D(7500), totalEarnedLessRetainage: D(217500), currentPaymentDue: D(118500), balanceToFinish: D(282500) });
    const out = reconcile(input);
    expect(find(out, 'ret.amount')[0]).toMatchObject({ outcome: 'fail', title: 'Too little retainage is withheld' });
    expect(find(out, 'ret.release')[0]).toMatchObject({ outcome: 'fail', severity: 'warning' });
    // The verified payment still holds the full contractual retainage.
    expect(out.verified.currentPaymentDue).toBe(D(103500));
  });

  it('passes the same application once the release is recorded, and pays it out', () => {
    const input = cleanInput();
    Object.assign(input.app.claimed, { retainageWork: D(6500), retainageStored: D(1000), retainageTotal: D(7500), totalEarnedLessRetainage: D(217500), currentPaymentDue: D(118500), balanceToFinish: D(282500) });
    input.retainageReleases = [{ id: 'r1', amount: D(15000), effectiveOn: '2026-10-15', note: 'Owner released half at substantial completion' }];
    for (const waiver of input.waivers) waiver.amount = D(118500); // the waiver covers the payment actually requested
    const out = reconcile(input);
    expect(find(out, 'ret.amount')[0]).toMatchObject({ outcome: 'pass' });
    expect(find(out, 'ret.release')[0]).toMatchObject({ outcome: 'pass', title: 'Retainage released per the contract' });
    expect(out.verified).toMatchObject({ retainageTotal: D(7500), retainageReleased: D(15000), currentPaymentDue: D(118500) });
    expect(out.checks.filter((c) => c.outcome === 'fail' && c.severity !== 'info')).toEqual([]);
  });

  it('does not count a release that takes effect after the period being billed', () => {
    const input = cleanInput();
    input.retainageReleases = [{ id: 'r1', amount: D(15000), effectiveOn: '2026-11-15', note: 'Next month' }];
    const out = reconcile(input);
    expect(out.verified).toMatchObject({ retainageTotal: D(22500), retainageReleased: 0, currentPaymentDue: D(103500) });
  });

  it('still flags a release that is bigger than what was recorded', () => {
    const input = cleanInput();
    input.retainageReleases = [{ id: 'r1', amount: D(5000), effectiveOn: '2026-10-15', note: 'Partial' }];
    // The subcontractor bills 15,000 of retainage; only 5,000 was authorised.
    Object.assign(input.app.claimed, { retainageWork: D(6500), retainageStored: D(1000), retainageTotal: D(7500), totalEarnedLessRetainage: D(217500), currentPaymentDue: D(118500), balanceToFinish: D(282500) });
    const out = reconcile(input);
    expect(find(out, 'ret.amount')[0]).toMatchObject({ outcome: 'fail' });
    expect(find(out, 'ret.release')[0]).toMatchObject({ outcome: 'fail' });
    expect(out.verified.currentPaymentDue).toBe(D(108500)); // only the authorised 5,000 is paid out
  });
});

describe('deductive change orders', () => {
  function withDeduct(thisPeriod: number) {
    const input = cleanInput();
    input.changeOrders = [{ id: 'co1', number: 'CO-1', title: 'Delete lobby fixtures', amount: D(-10000), status: 'approved' }];
    input.sov.push({ id: 's4', itemNo: 'CO-1', description: 'Delete lobby fixtures', scheduledValue: D(-10000) });
    input.lines.push({ id: 'l4', sovLineId: 's4', itemNo: 'CO-1', description: 'Delete lobby fixtures', scheduledValue: D(-10000), previous: 0, thisPeriod, stored: 0, total: thisPeriod, balance: D(-10000) - thisPeriod, retainage: null });
    return reconcile(input);
  }

  it('treats a credit against a deduct as normal billing, not as a suspicious negative', () => {
    const out = withDeduct(D(-4000));
    expect(out.verified.contractSumToDate).toBe(D(490000));
    expect(out.verified.totalCompletedStored).toBe(D(221000));
    expect(out.checks.filter((c) => c.code === 'sov.negative_billing')).toEqual([]);
    expect(out.checks.filter((c) => c.code === 'sov.overbilled' && c.outcome === 'fail')).toEqual([]);
  });

  it('blocks more credit than the deduct allows', () => {
    const [f] = withDeduct(D(-12000)).checks.filter((c) => c.code === 'sov.overbilled' && c.outcome === 'fail');
    expect(f).toMatchObject({ severity: 'blocking', title: expect.stringContaining('more credit taken than the deduct allows') });
  });

  it('blocks a deduct that is billed as a charge', () => {
    const [f] = withDeduct(D(1000)).checks.filter((c) => c.code === 'sov.overbilled' && c.outcome === 'fail');
    expect(f).toMatchObject({ severity: 'blocking', title: expect.stringContaining('a deduct is billed as a charge') });
  });
});

describe('who an emailed package came from', () => {
  it('recognises the contact on file, their company domain and the team, and nothing else', () => {
    const team = ['ana@northline.example'];
    expect(classifySender('Maria@LoneStarElectric.example', 'maria@lonestarelectric.example', team)).toBe('contact');
    expect(classifySender('billing@lonestarelectric.example', 'maria@lonestarelectric.example', team)).toBe('domain');
    expect(classifySender('ana@northline.example', 'maria@lonestarelectric.example', team)).toBe('team');
    expect(classifySender('maria@lonestar-electric.example', 'maria@lonestarelectric.example', team)).toBe('unknown');
    expect(classifySender(null, 'maria@lonestarelectric.example', team)).toBe('unknown');
    // Sharing a public mail provider with the contact proves nothing.
    expect(classifySender('someone.else@gmail.com', 'maria.alvarez@gmail.com', team)).toBe('unknown');
  });

  it('blocks approval of a package from an unknown address and says why', () => {
    const input = cleanInput();
    input.intake = { via: 'email', senderEmail: 'billing@unknown.example', sender: 'unknown' };
    const [f] = find(reconcile(input), 'intake.sender');
    expect(f).toMatchObject({ outcome: 'fail', severity: 'blocking' });
    expect(f!.detail).toContain('billing@unknown.example');

    input.intake = { via: 'email', senderEmail: 'maria@lonestarelectric.example', sender: 'contact' };
    expect(find(reconcile(input), 'intake.sender')[0]).toMatchObject({ outcome: 'pass' });

    input.intake = { via: 'upload', senderEmail: null, sender: 'unknown' };
    expect(find(reconcile(input), 'intake.sender')).toEqual([]);
  });
});

describe('retainage releases through the services', () => {
  let w: World;
  let state: ReturnType<typeof stateAfter>;
  beforeAll(async () => {
    w = await createWorld();
    const pkg = packageFor(w, 0, null);
    const app = await submit(w, pkg);
    await approveApplication(w.db, w.controller, app.id);
    state = stateAfter(pkg);
  });

  /** The subcontractor bills `amount` of previously withheld retainage on this application. */
  const billRelease = (amount: number) => (pkg: SamplePackage) => {
    const h = pkg.header;
    h.retainageWork = (h.retainageWork ?? 0) - amount;
    h.retainageTotal = (h.retainageTotal ?? 0) - amount;
    h.totalEarnedLessRetainage = (h.totalEarnedLessRetainage ?? 0) + amount;
    h.currentPaymentDue = (h.currentPaymentDue ?? 0) + amount;
    h.balanceToFinish = (h.balanceToFinish ?? 0) - amount;
    if (pkg.waiver) pkg.waiver.amount = h.currentPaymentDue;
  };

  it('is an approver decision, needs a reason, and cannot exceed what is held', async () => {
    const input = { amount: D(5000), effectiveOn: '2026-10-15', note: 'Owner approved a partial release, letter dated Oct 12' };
    await expect(createRetainageRelease(w.db, w.accountant, w.contractId, input)).rejects.toBeInstanceOf(PermissionError);
    await expect(createRetainageRelease(w.db, w.pm, w.contractId, input)).rejects.toBeInstanceOf(PermissionError);
    await expect(createRetainageRelease(w.db, w.controller, w.contractId, { ...input, note: '' })).rejects.toBeInstanceOf(UserError);
    // 11,000 is held after application #1.
    await expect(createRetainageRelease(w.db, w.controller, w.contractId, { ...input, amount: D(11000.01) })).rejects.toThrow(/Only \$11,000\.00 of retainage is available/);
    await createRetainageRelease(w.db, w.controller, w.contractId, input);
    // What is already recorded counts against what is left.
    await expect(createRetainageRelease(w.db, w.controller, w.contractId, { ...input, amount: D(6000.01) })).rejects.toThrow(/Only \$6,000\.00 of retainage is available/);
  });

  it('verifies and approves the application that bills the release, and records it on the approval', async () => {
    const app = await submit(w, packageFor(w, 1, state, billRelease(D(5000))));
    expect(await openFindings(w, app.id)).toEqual([]);
    expect(app.claimed.currentPaymentDue).toBe(D(108500));
    expect(app.verified).toMatchObject({ currentPaymentDue: D(108500), retainageTotal: D(17500), retainageReleased: D(5000) });

    const record = await approveApplication(w.db, w.controller, app.id);
    expect(record.approved.currentPaymentDue).toBe(D(108500));
    expect(record.retainageReleases).toEqual([{ amount: D(5000), effectiveOn: '2026-10-15', note: 'Owner approved a partial release, letter dated Oct 12' }]);
    expect(record.lines.reduce((a, l) => a + l.retainage, 0)).toBe(D(17500));
    expect((await getApp(w, app.id)).approvedRetainage).toBe(D(17500));
  });

  it('will not cancel a release that an approval has already paid out', async () => {
    const [release] = await w.db.select().from(retainageReleases).where(eq(retainageReleases.contractId, w.contractId));
    await expect(voidRetainageRelease(w.db, w.controller, release!.id, 'Recorded in error')).rejects.toThrow(/was approved with this release counted/);
  });

  it('re-checks open applications when a release is recorded or cancelled', async () => {
    const w2 = await createWorld();
    const first = packageFor(w2, 0, null);
    await approveApplication(w2.db, w2.controller, (await submit(w2, first)).id);
    // The subcontractor bills a release nobody has recorded.
    const app = await submit(w2, packageFor(w2, 1, stateAfter(first), billRelease(D(4000))));
    const unrecorded = (await openFindings(w2, app.id)).map((f) => f.code).sort();
    // Retainage still grows from the 11,000 held before, just by 4,000 too little: under-withholding, a short
    // payment against the verified figure, and a waiver that no longer matches it.
    expect(unrecorded).toEqual(['lw.amount_vs_verified', 'pay.current_due', 'ret.amount']);

    const id = await createRetainageRelease(w2.db, w2.controller, w2.contractId, { amount: D(4000), effectiveOn: '2026-10-01', note: 'Agreed with the owner' });
    expect(await openFindings(w2, app.id)).toEqual([]);
    expect((await getApp(w2, app.id)).verifiedAmount).toBe(D(107500));

    await voidRetainageRelease(w2.db, w2.controller, id, 'Owner withdrew the approval');
    expect((await openFindings(w2, app.id)).map((f) => f.code).sort()).toEqual(unrecorded);
    expect((await getApp(w2, app.id)).verifiedAmount).toBe(D(103500));
  });

  it('applies stepped terms set on the contract to the next application', async () => {
    const w3 = await createWorld();
    const first = packageFor(w3, 0, null);
    await approveApplication(w3.db, w3.controller, (await submit(w3, first)).id);
    // 10% until 20% complete (100,000 of work), then nothing further.
    await updateContract(w3.db, w3.controller, w3.contractId, {
      number: w3.contract.number,
      title: w3.contract.description,
      originalAmount: w3.contract.originalAmount,
      retainageWorkBps: 1000,
      retainageStoredBps: 1000,
      retainageReduction: { atPercentBps: 2000, toBps: 0, appliesTo: 'future_work' },
    });
    // The subcontractor still withholds a flat 10%: more than the contract now requires.
    const app = await submit(w3, packageFor(w3, 1, stateAfter(first)));
    const open = await openFindings(w3, app.id);
    expect(open.map((f) => f.code)).toContain('ret.amount');
    expect(open.find((f) => f.code === 'ret.amount')!.title).toBe('Retainage withheld is higher than the contract requires');
    // 10,000 on work (capped) + 1,000 on stored = 11,000 held; 225,000 − 11,000 − 99,000 = 115,000.
    expect(app.verified).toMatchObject({ retainageTotal: D(11000), currentPaymentDue: D(115000) });
    await expect(updateContract(w3.db, w3.controller, w3.contractId, { number: w3.contract.number, title: w3.contract.description, originalAmount: w3.contract.originalAmount, retainageWorkBps: 1000, retainageStoredBps: 1000, retainageReduction: { atPercentBps: 2000, toBps: 1000, appliesTo: 'future_work' } })).rejects.toThrow(/must be lower/);
  });
});
