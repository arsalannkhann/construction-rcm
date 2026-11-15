/**
 * End-to-end at the service layer, against a real (in-memory) Postgres:
 * a PDF goes in, gets read, matched, reconciled, reviewed, approved, and
 * leaves an immutable record and an intact audit chain.
 */
import { eq } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import { auditEvents, contracts, documents, findings, payAppLines, payApplications, sovLines } from '@/db/schema';
import { verifyAuditChain } from '@/server/audit';
import { PermissionError, UserError } from '@/server/auth/permissions';
import { buildSyntheticCorpus } from '@/server/samples/corpus';
import { renderPackage, renderTextlessPdf } from '@/server/samples/pdf';
import { defects, recompute } from '@/server/samples/scenario';
import { createApplication, processApplication } from '@/server/services/intake';
import { createChangeOrder, updateChangeOrder, updateContract } from '@/server/services/records';
import {
  acceptFinding,
  addLine,
  approveApplication,
  assignContract,
  confirmSignature,
  rejectApplication,
  reopenApplication,
  setOpeningBalances,
  submitForApproval,
  updateHeader,
  updateLine,
  voidApplication,
} from '@/server/services/review';
import { updatePolicy } from '@/server/services/team';
import { DEFAULT_ORG_SETTINGS } from '@/server/types';
import { createWorld, dollars as D, getApp, openFindings, packageFor, stateAfter, submit, type World } from './helpers/world';

const codes = (fs: Array<{ code: string }>) => fs.map((f) => f.code).sort();

describe('the happy path', () => {
  let w: World;
  beforeAll(async () => {
    w = await createWorld();
  });

  it('reads a package, matches it to the contract by itself and finds nothing wrong', async () => {
    const app = await submit(w, packageFor(w, 0, null));
    expect(app.status).toBe('needs_review');
    expect(app.contractId).toBe(w.contractId);
    expect(app.applicationNumber).toBe(1);
    expect(app.periodTo).toBe('2026-09-30');
    expect(app.engine).toBe('text-layer');
    expect(app.claimed.currentPaymentDue).toBe(D(99000));
    expect(app.verified?.currentPaymentDue).toBe(D(99000));
    expect(app.openBlocking).toBe(0);
    expect(await openFindings(w, app.id)).toEqual([]);

    const lines = await w.db.select().from(payAppLines).where(eq(payAppLines.payApplicationId, app.id));
    expect(lines).toHaveLength(3);
    expect(lines.every((l) => l.sovLineId)).toBe(true);
    // Every amount on the summary can be traced to a place on a page.
    expect(app.evidence.currentPaymentDue).toMatchObject({ page: 1, confidence: expect.any(Number) });
    expect(app.evidence.currentPaymentDue!.bbox).toHaveLength(4);
  });

  it('enforces who may approve', async () => {
    const [app] = await w.db.select().from(payApplications).where(eq(payApplications.orgId, w.orgId));
    await expect(approveApplication(w.db, w.accountant, app!.id)).rejects.toBeInstanceOf(PermissionError);
    await expect(approveApplication(w.db, w.pm, app!.id)).rejects.toBeInstanceOf(PermissionError);
    await expect(approveApplication(w.db, w.viewer, app!.id)).rejects.toBeInstanceOf(PermissionError);
  });

  it('approves into an immutable record that later applications build on', async () => {
    const [app1] = await w.db.select().from(payApplications).where(eq(payApplications.orgId, w.orgId));
    await submitForApproval(w.db, w.accountant, app1!.id, 'Clean');
    expect((await getApp(w, app1!.id)).status).toBe('pending_approval');

    const record = await approveApplication(w.db, w.controller, app1!.id, { note: 'OK to pay' });
    expect(record.approved.currentPaymentDue).toBe(D(99000));
    expect(record.approved.retainageTotal).toBe(D(11000));
    expect(record.varianceFromClaimed).toBe(0);
    expect(record.lines.map((l) => [l.itemNo, l.previous, l.thisPeriod])).toEqual([
      ['1', 0, D(50000)],
      ['2', 0, D(60000)],
      ['3', 0, 0],
    ]);
    expect(record.documents).toHaveLength(1);
    expect(record.documents[0]!.sha256).toMatch(/^[a-f0-9]{64}$/);

    const after = await getApp(w, app1!.id);
    expect(after.status).toBe('approved');
    expect(after.approvedAmount).toBe(D(99000));
    expect(after.approvedRetainage).toBe(D(11000));

    // Decided applications are locked.
    await expect(updateHeader(w.db, w.controller, app1!.id, { currentPaymentDue: 1 })).rejects.toThrow(/decided/);

    // Application #2 carries forward exactly what #1 approved.
    const state1 = stateAfter(packageFor(w, 0, null));
    const app2 = await submit(w, packageFor(w, 1, state1));
    expect(app2.verified).toMatchObject({ lessPreviousCertificates: D(99000), currentPaymentDue: D(103500), priorApplicationNumber: 1 });
    expect(await openFindings(w, app2.id)).toEqual([]);
  });
});

describe('a submission with problems', () => {
  let w: World;
  let appId: string;
  beforeAll(async () => {
    w = await createWorld();
    const app1 = await submit(w, packageFor(w, 0, null));
    await approveApplication(w.db, w.controller, app1.id);
    // #2 re-bills $10,000 that was already certified.
    const app2 = await submit(w, packageFor(w, 1, stateAfter(packageFor(w, 0, null)), (p) => defects.understatePreviousCertificates(p, D(10000))));
    appId = app2.id;
  });

  it('finds the double billing and will not let it through', async () => {
    const app = await getApp(w, appId);
    expect(app.claimed.currentPaymentDue).toBe(D(113500));
    expect(app.verified?.currentPaymentDue).toBe(D(103500));
    const open = await openFindings(w, appId);
    expect(codes(open)).toEqual(['lw.amount_vs_verified', 'pay.current_due', 'prior.previous_certificates']);
    expect(app.openBlocking).toBe(2);
    await expect(approveApplication(w.db, w.controller, appId)).rejects.toThrow(/2 blocking findings are still open/);
  });

  it('lets a reviewer hand it to an approver but not override blocking findings themselves', async () => {
    const [blocking] = (await openFindings(w, appId)).filter((f) => f.code === 'pay.current_due');
    await expect(acceptFinding(w.db, w.accountant, blocking!.id, 'looks fine to me')).rejects.toBeInstanceOf(PermissionError);
    await submitForApproval(w.db, w.accountant, appId);
    expect((await getApp(w, appId)).status).toBe('pending_approval');
  });

  it('requires a written reason to override, then approves at the verified amount', async () => {
    const open = await openFindings(w, appId);
    const prior = open.find((f) => f.code === 'prior.previous_certificates')!;
    const pay = open.find((f) => f.code === 'pay.current_due')!;
    await expect(acceptFinding(w.db, w.controller, pay.id, '')).rejects.toThrow(/Explain why/);
    await acceptFinding(w.db, w.controller, prior.id, 'Sub confirmed by phone their line 7 is wrong; paying the verified amount.');
    await acceptFinding(w.db, w.controller, pay.id, 'Short-paying $10,000 that was already certified on #1.');

    // One warning is still open; approving requires acknowledging it.
    await expect(approveApplication(w.db, w.controller, appId)).rejects.toThrow(/Acknowledge the 1 open warning/);
    const record = await approveApplication(w.db, w.controller, appId, { acknowledgeWarnings: true });

    expect(record.approved.currentPaymentDue).toBe(D(103500));
    expect(record.claimed.currentPaymentDue).toBe(D(113500));
    expect(record.varianceFromClaimed).toBe(-D(10000));
    expect(record.acceptedFindings.map((f) => f.code).sort()).toEqual(['lw.amount_vs_verified', 'pay.current_due', 'prior.previous_certificates']);
    expect(record.acceptedFindings.find((f) => f.code === 'pay.current_due')).toMatchObject({ by: 'Carlos Controller', note: expect.stringContaining('Short-paying') });
  });

  it('builds the next application on the approved amount, not the claimed one', async () => {
    const state2 = stateAfter(packageFor(w, 1, stateAfter(packageFor(w, 0, null))));
    const app3 = await submit(w, packageFor(w, 2, state2));
    expect(app3.verified).toMatchObject({ lessPreviousCertificates: D(202500), priorApplicationNumber: 2 });
    expect(await openFindings(w, app3.id)).toEqual([]);
  });

  it('keeps a complete, tamper-evident history', async () => {
    const events = await w.db.select().from(auditEvents).where(eq(auditEvents.payApplicationId, appId));
    const actions = events.sort((a, b) => a.seq - b.seq).map((e) => e.action);
    expect(actions).toEqual([
      'application.received',
      'application.processed',
      'application.submitted_for_approval',
      'finding.overridden',
      'finding.overridden',
      'application.approved',
    ]);
    expect(await verifyAuditChain(w.db, w.orgId)).toMatchObject({ ok: true });

    // Quietly editing history is detectable.
    const victim = events.find((e) => e.action === 'application.approved')!;
    await w.db.update(auditEvents).set({ summary: 'Approved for $1.00' }).where(eq(auditEvents.id, victim.id));
    expect(await verifyAuditChain(w.db, w.orgId)).toMatchObject({ ok: false, brokenAtSeq: victim.seq });
    await w.db.update(auditEvents).set({ summary: victim.summary }).where(eq(auditEvents.id, victim.id));
    expect(await verifyAuditChain(w.db, w.orgId)).toMatchObject({ ok: true });
  });
});

describe('corrections and re-checking', () => {
  let w: World;
  beforeAll(async () => {
    w = await createWorld();
  });

  it('clears findings when a correction makes the figures agree, and reopens accepted ones when the facts change', async () => {
    const app = await submit(w, packageFor(w, 0, null, (p) => defects.arithmeticSlip(p, D(2700))));
    let open = await openFindings(w, app.id);
    expect(codes(open)).toEqual(['math.balance', 'math.current_due', 'math.earned']);

    // A reviewer decides the document has a typo and records what line 6 should read.
    await updateHeader(w.db, w.accountant, app.id, { totalEarnedLessRetainage: D(99000) });
    expect(await openFindings(w, app.id)).toEqual([]);

    // An accepted warning stays accepted only while its facts are unchanged.
    await updateHeader(w.db, w.accountant, app.id, { balanceToFinish: D(400000) });
    open = await openFindings(w, app.id);
    expect(codes(open)).toEqual(['math.balance']);
    await acceptFinding(w.db, w.accountant, open[0]!.id, 'Known typo on line 9');
    expect(await openFindings(w, app.id)).toEqual([]);
    await updateHeader(w.db, w.accountant, app.id, { balanceToFinish: D(390000) });
    expect(codes(await openFindings(w, app.id))).toEqual(['math.balance']);
  });

  it('separates fixing a misread from adjusting what will be paid', async () => {
    const w2 = await createWorld();
    const app = await submit(w2, packageFor(w2, 0, null));
    const lines = await w2.db.select().from(payAppLines).where(eq(payAppLines.payApplicationId, app.id));
    const roughIn = lines.find((l) => l.itemNo === '2')!;

    await expect(updateLine(w2.db, w2.accountant, roughIn.id, { thisPeriod: D(40000) }, 'adjustment')).rejects.toThrow(/Say why/);
    await updateLine(w2.db, w2.accountant, roughIn.id, { thisPeriod: D(40000) }, 'adjustment', 'PM walked the site: level 3 rough-in not started');

    const after = await getApp(w2, app.id);
    expect(after.verified?.currentPaymentDue).toBe(D(81000)); // (50,000 + 40,000) × 90%
    expect(after.claimed.currentPaymentDue).toBe(D(99000)); // what was asked for is untouched
    expect(codes(await openFindings(w2, app.id))).toEqual(expect.arrayContaining(['pay.current_due', 'math.sheet_total']));

    // The original reading is preserved alongside the adjustment.
    const [edited] = await w2.db.select().from(payAppLines).where(eq(payAppLines.id, roughIn.id));
    expect(edited).toMatchObject({ thisPeriod: D(40000), total: D(40000), editKind: 'adjustment' });
    expect(edited!.extracted).toMatchObject({ thisPeriod: D(60000) });
  });

  it('re-checks open applications when the contract changes underneath them', async () => {
    const w3 = await createWorld();
    const app = await submit(w3, packageFor(w3, 0, null));
    expect(app.openBlocking).toBe(0);
    await updateContract(w3.db, w3.controller, w3.contractId, { number: 'SC-2301-16', title: 'Electrical', originalAmount: D(500000), retainageWorkBps: 500, retainageStoredBps: 500 });
    const open = await openFindings(w3, app.id);
    expect(codes(open)).toEqual(expect.arrayContaining(['ret.amount', 'pay.current_due']));
  });

  it('re-checks when policy changes', async () => {
    const w4 = await createWorld();
    const app = await submit(w4, packageFor(w4, 0, null, (p) => defects.noWaiver(p)));
    expect(codes(await openFindings(w4, app.id))).toEqual(['lw.present']);
    await expect(updatePolicy(w4.db, w4.accountant, { ...DEFAULT_ORG_SETTINGS, requireConditionalWaiver: false })).rejects.toBeInstanceOf(PermissionError);
    await updatePolicy(w4.db, w4.controller, { ...DEFAULT_ORG_SETTINGS, requireConditionalWaiver: false });
    expect(await openFindings(w4, app.id)).toEqual([]);
  });
});

describe('change orders', () => {
  it('excludes an unapproved change order from the verified amount until it is approved on the contract', async () => {
    const w = await createWorld();
    const coId = await createChangeOrder(w.db, w.accountant, w.contractId, { number: 'CO-1', title: 'Added receptacles, level 2', amount: D(12000), status: 'pending' });
    // The subcontractor bills as if CO-1 were approved.
    w.contract.changeOrders = [{ number: 'CO-1', title: 'Added receptacles, level 2', amount: D(12000) }];
    const pkg = packageFor(w, 0, null);
    const co = pkg.lines.find((l) => l.itemNo === 'CO-1')!;
    co.thisPeriod = D(12000);
    co.total = D(12000);
    co.balance = 0;
    recompute(pkg);

    const app = await submit(w, pkg);
    expect(app.claimed.currentPaymentDue).toBe(D(109800));
    expect(app.verified).toMatchObject({ currentPaymentDue: D(99000), excludedLines: 1, netChangeOrders: 0 });
    const open = await openFindings(w, app.id);
    expect(codes(open)).toEqual(expect.arrayContaining(['co.net_change', 'sov.unknown_line', 'pay.current_due']));
    expect(open.find((f) => f.code === 'co.net_change')!.detail).toContain('pending change order CO-1');

    // Approving the change order on the contract is the fix; no edits to the application needed.
    await updateChangeOrder(w.db, w.controller, coId, { number: 'CO-1', title: 'Added receptacles, level 2', amount: D(12000), status: 'approved', approvedOn: '2026-09-20' });
    const after = await getApp(w, app.id);
    expect(after.verified).toMatchObject({ currentPaymentDue: D(109800), excludedLines: 0, netChangeOrders: D(12000) });
    expect(await openFindings(w, app.id)).toEqual([]);

    const sov = await w.db.select().from(sovLines).where(eq(sovLines.contractId, w.contractId));
    expect(sov.find((s) => s.itemNo === 'CO-1')).toMatchObject({ scheduledValue: D(12000), changeOrderId: coId });

    // Once billing against it is approved, the change order cannot be un-approved.
    await approveApplication(w.db, w.controller, app.id);
    await expect(updateChangeOrder(w.db, w.controller, coId, { number: 'CO-1', title: 'Added receptacles, level 2', amount: D(12000), status: 'void' })).rejects.toThrow(/approved billing against it/);
  });
});

describe('sequence and duplicates', () => {
  let w: World;
  beforeAll(async () => {
    w = await createWorld();
  });

  it('flags the same file submitted twice', async () => {
    const pkg = packageFor(w, 0, null);
    const first = await submit(w, pkg);
    const second = await submit(w, pkg);
    expect(codes(await openFindings(w, second.id))).toEqual(['doc.duplicate_file', 'seq.duplicate_number']);
    // …and the first one now knows it has a twin as well.
    expect(codes(await openFindings(w, first.id))).toEqual(['doc.duplicate_file', 'seq.duplicate_number']);
    await voidApplication(w.db, w.controller, second.id, 'Duplicate upload of application #1');
    expect((await getApp(w, second.id)).status).toBe('void');
    expect(await openFindings(w, first.id)).toEqual([]);
  });

  it('will not decide a later application before an earlier one', async () => {
    const [first] = (await w.db.select().from(payApplications).where(eq(payApplications.orgId, w.orgId))).filter((a) => a.status === 'needs_review');
    const app2 = await submit(w, packageFor(w, 1, stateAfter(packageFor(w, 0, null))));
    expect(codes(await openFindings(w, app2.id))).toContain('seq.prior_pending');
    await expect(approveApplication(w.db, w.controller, app2.id)).rejects.toThrow(/blocking/);

    // Deciding #1 re-checks #2 automatically.
    await approveApplication(w.db, w.controller, first!.id);
    expect(await openFindings(w, app2.id)).toEqual([]);
    expect((await getApp(w, app2.id)).verified?.currentPaymentDue).toBe(D(103500));
  });

  it('will not reopen an application that later billing is built on', async () => {
    const apps = await w.db.select().from(payApplications).where(eq(payApplications.orgId, w.orgId));
    const app1 = apps.find((a) => a.applicationNumber === 1 && a.status === 'approved')!;
    const app2 = apps.find((a) => a.applicationNumber === 2)!;
    await approveApplication(w.db, w.controller, app2.id);
    await expect(reopenApplication(w.db, w.controller, app1.id, 'Need to change line 2')).rejects.toThrow(/Application #2 was approved after this one/);
    await reopenApplication(w.db, w.controller, app2.id, 'Approved in error');
    const reopened = await getApp(w, app2.id);
    expect(reopened).toMatchObject({ status: 'needs_review', approvedAmount: null, approvedRecord: null });
  });

  it('lets a rejected application be resubmitted under the same number', async () => {
    const apps = await w.db.select().from(payApplications).where(eq(payApplications.orgId, w.orgId));
    const app2 = apps.find((a) => a.applicationNumber === 2)!;
    await expect(rejectApplication(w.db, w.controller, app2.id, '')).rejects.toThrow(/reason/);
    await rejectApplication(w.db, w.controller, app2.id, 'Billed level 3 rough-in that has not started');
    const pkg = packageFor(w, 1, stateAfter(packageFor(w, 0, null)));
    pkg.applicationDate = '2026-11-02'; // a revised document, not the same bytes
    const resubmitted = await submit(w, pkg);
    expect(await openFindings(w, resubmitted.id)).toEqual([]);
  });
});

describe('matching', () => {
  it('asks a person when it cannot tell which contract a package belongs to', async () => {
    const w = await createWorld();
    const pkg = packageFor(w, 0, null);
    pkg.sub = { ...pkg.sub, name: 'Gulf Coast Mechanical, Inc.' };
    pkg.project = { ...pkg.project, name: 'Harbor Point Logistics Center', number: '9911' };
    pkg.contract = { ...pkg.contract, number: 'HP-7' };
    if (pkg.waiver) pkg.waiver.claimant = pkg.sub.name;
    const app = await submit(w, pkg);
    expect(app.status).toBe('needs_matching');
    expect(app.contractId).toBeNull();
    expect(app.stated).toMatchObject({ contractorName: 'Gulf Coast Mechanical, Inc.', projectName: 'Harbor Point Logistics Center' });

    await assignContract(w.db, w.accountant, app.id, w.contractId);
    const matched = await getApp(w, app.id);
    expect(matched.status).toBe('needs_review');
    // Matched by a person to a contract whose subcontractor differs: the waiver check says so.
    expect(codes(await openFindings(w, app.id))).toContain('lw.claimant');
  });

  it('tolerates the ways names differ between documents and records', async () => {
    const w = await createWorld();
    const pkg = packageFor(w, 0, null);
    pkg.sub = { ...pkg.sub, name: 'LONE STAR ELECTRIC L.L.C.' };
    pkg.project = { ...pkg.project, name: 'Riverside MOB', number: '2301' };
    const app = await submit(w, pkg);
    expect(app.contractId).toBe(w.contractId);
  });
});

describe('a contract that was already under way', () => {
  it('needs opening balances before "previous" can be verified, then verifies', async () => {
    const w = await createWorld();
    // The first application this organisation ever sees for the contract is #2.
    const pkg = packageFor(w, 1, stateAfter(packageFor(w, 0, null)));
    const app = await submit(w, pkg);
    expect(codes(await openFindings(w, app.id))).toEqual(['prior.no_history']);

    await expect(setOpeningBalances(w.db, w.accountant, app.id)).rejects.toBeInstanceOf(PermissionError);
    await setOpeningBalances(w.db, w.controller, app.id);

    const [contract] = await w.db.select().from(contracts).where(eq(contracts.id, w.contractId));
    expect(contract!.baseline).toMatchObject({ asOfApplicationNumber: 1, previousCertificates: D(99000), sourceApplicationId: app.id });
    expect(await openFindings(w, app.id)).toEqual([]);
    expect((await getApp(w, app.id)).verified?.currentPaymentDue).toBe(D(103500));
  });
});

describe('documents that cannot be read automatically', () => {
  it('says so, blocks approval, and supports keying by hand', async () => {
    const w = await createWorld();
    const { id } = await createApplication(w.db, w.accountant, { files: [{ filename: 'scan.pdf', bytes: await renderTextlessPdf() }], contractId: w.contractId, defer: true });
    await processApplication(w.db, w.orgId, id);
    const app = await getApp(w, id);
    expect(app.status).toBe('needs_review');
    const [doc] = await w.db.select().from(documents).where(eq(documents.payApplicationId, id));
    expect(doc).toMatchObject({ status: 'unreadable', hasTextLayer: false });
    expect(doc!.statusDetail).toContain('AI extraction, which is not configured');
    const open = await openFindings(w, id);
    expect(codes(open)).toEqual(expect.arrayContaining(['doc.unreadable', 'doc.pay_application', 'doc.continuation_sheet', 'seq.number_missing']));

    // A reviewer keys the essentials from the document.
    await updateHeader(w.db, w.accountant, id, { applicationNumber: 1, periodTo: '2026-09-30', originalContractSum: D(500000), contractSumToDate: D(500000), totalCompletedStored: D(110000), retainageTotal: D(11000), totalEarnedLessRetainage: D(99000), lessPreviousCertificates: 0, currentPaymentDue: D(99000) });
    await addLine(w.db, w.accountant, id, { itemNo: '1', description: 'Mobilization', scheduledValue: D(50000), thisPeriod: D(50000) });
    await addLine(w.db, w.accountant, id, { itemNo: '2', description: 'Rough-in, levels 1-3', scheduledValue: D(300000), thisPeriod: D(60000) });
    const keyed = await getApp(w, id);
    expect(keyed.verified?.currentPaymentDue).toBe(D(99000));
    // Still blocked: nobody has vouched for the unreadable document, the signature or the missing waiver.
    expect(keyed.openBlocking).toBeGreaterThan(0);
    await expect(approveApplication(w.db, w.controller, id)).rejects.toBeInstanceOf(UserError);
  });

  it('asks a person to confirm a signature it cannot see', async () => {
    const w = await createWorld();
    const pkg = packageFor(w, 0, null);
    pkg.signed = false;
    const app = await submit(w, pkg);
    expect(codes(await openFindings(w, app.id))).toEqual(['doc.signature']);
    await confirmSignature(w.db, w.accountant, app.id, true);
    expect(await openFindings(w, app.id)).toEqual([]);
  });
});

describe('what the reading saw besides the figures', () => {
  let w: World;
  beforeAll(async () => {
    w = await createWorld();
  });
  const submitCase = async (caseId: string) => {
    const [c] = await buildSyntheticCorpus(caseId);
    const { id } = await createApplication(w.db, w.accountant, { files: [{ filename: c!.file.filename, bytes: c!.file.bytes }], contractId: w.contractId, defer: true });
    await processApplication(w.db, w.orgId, id);
    return id;
  };
  const result = async (appId: string, code: string) => (await w.db.select().from(findings).where(eq(findings.payApplicationId, appId))).filter((f) => f.code === code);

  it('ties the schedule rows to its printed grand total, and keeps them tied through an adjustment', async () => {
    const app = await submit(w, packageFor(w, 0, null));
    expect(await result(app.id, 'math.grand_total')).toMatchObject([{ status: 'passed' }]);

    // Approving less than was billed does not change what the document prints.
    const roughIn = (await w.db.select().from(payAppLines).where(eq(payAppLines.payApplicationId, app.id))).find((l) => l.itemNo === '2')!;
    await updateLine(w.db, w.accountant, roughIn.id, { thisPeriod: D(40000) }, 'adjustment', 'Level 3 not started');
    expect(await result(app.id, 'math.grand_total')).toMatchObject([{ status: 'passed' }]);
    await voidApplication(w.db, w.controller, app.id, 'Test package');
  });

  it('blocks on a page missing from the printed numbering, and on rows short of the printed grand total', async () => {
    const id = await submitCase('integrity/missing-schedule-page');
    const open = await openFindings(w, id);
    expect(open.find((f) => f.code === 'doc.page_missing')).toMatchObject({ severity: 'blocking', title: expect.stringContaining('is missing page 3 of 4') });
    expect(open.find((f) => f.code === 'math.grand_total')).toMatchObject({ severity: 'blocking' });
    await voidApplication(w.db, w.controller, id, 'Test package');
  });

  it('blocks on a page it could not read until a person accounts for it', async () => {
    const id = await submitCase('scan/one-scanned-page-in-text-pdf');
    const open = await openFindings(w, id);
    const f = open.find((x) => x.code === 'doc.unreadable_pages')!;
    expect(f).toMatchObject({ severity: 'blocking', category: 'extraction', title: expect.stringContaining('Page 2 of') });
    await acceptFinding(w.db, w.controller, f.id, 'Keyed page 2 by hand');
    expect((await openFindings(w, id)).find((x) => x.code === 'doc.unreadable_pages')).toBeUndefined();
    await voidApplication(w.db, w.controller, id, 'Test package');
  });

  it('blocks when the application and its schedule state different application numbers', async () => {
    const id = await submitCase('integrity/application-number-differs');
    const open = await openFindings(w, id);
    expect(open.find((f) => f.code === 'doc.conflict')).toMatchObject({ severity: 'blocking', title: expect.stringContaining('two different application numbers') });
    await voidApplication(w.db, w.controller, id, 'Test package');
  });
});

describe('tenant isolation', () => {
  it('never lets one organisation touch another’s records', async () => {
    const a = await createWorld();
    const b = await createWorld();
    const app = await submit(a, packageFor(a, 0, null));
    const [line] = await a.db.select().from(payAppLines).where(eq(payAppLines.payApplicationId, app.id));
    const [finding] = await a.db.select().from(payApplications).where(eq(payApplications.id, app.id));

    await expect(approveApplication(b.db, b.owner, app.id)).rejects.toThrow('Application not found.');
    await expect(updateHeader(b.db, b.owner, app.id, { currentPaymentDue: 1 })).rejects.toThrow('Application not found.');
    await expect(updateLine(b.db, b.owner, line!.id, { thisPeriod: 1 }, 'correction')).rejects.toThrow('Line not found.');
    await expect(assignContract(b.db, b.owner, app.id, b.contractId)).rejects.toThrow('Application not found.');
    await expect(createApplication(b.db, b.owner, { files: [{ filename: 'x.pdf', bytes: await renderPackage(packageFor(a, 0, null)) }], contractId: a.contractId, defer: true })).rejects.toThrow(/no longer exists/);
    await expect(createChangeOrder(b.db, b.owner, a.contractId, { number: 'CO-9', title: 'x', amount: 100, status: 'approved' })).rejects.toThrow('Contract not found.');
    expect(finding!.orgId).toBe(a.orgId);

    // The same package arriving at organisation B does not match organisation A's contract.
    const { id } = await createApplication(b.db, b.accountant, { files: [{ filename: 'x.pdf', bytes: await renderPackage(packageFor(a, 0, null)) }], defer: true });
    await processApplication(b.db, b.orgId, id);
    const inB = await getApp(b, id);
    expect(inB.contractId).toBe(b.contractId); // B has its own contract with the same subcontractor name
    expect(inB.orgId).toBe(b.orgId);
  });
});
