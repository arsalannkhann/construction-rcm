/**
 * Owner billing: the main contractor's own application for payment to the
 * owner, built from the approved subcontractor billing. The arithmetic is
 * tested on its own; the workflow runs against a real (in-memory) Postgres,
 * with subcontractor applications going through the real intake and approval.
 */
import { eq } from 'drizzle-orm';
import { PDFDocument } from 'pdf-lib';
import { beforeAll, describe, expect, it } from 'vitest';
import { auditEvents, ownerApplications } from '@/db/schema';
import { ConflictError } from '@/server/auth/permissions';
import { ownerChecks, ownerHeader, ownerLines, scale, type PrimeLineInput } from '@/server/services/owner-calc';
import {
  certifyOwnerApplication,
  createPrimeChangeOrder,
  deleteOwnerDraft,
  getOwnerApplication,
  getOwnerBilling,
  ownerApplicationForPdf,
  reopenOwnerApplication,
  savePrimeContract,
  savePrimeSchedule,
  saveOwnerEntries,
  startOwnerApplication,
  submitOwnerApplication,
  suggestedPeriod,
  updatePrimeChangeOrder,
} from '@/server/services/owner-billing';
import { renderOwnerApplicationPdf } from '@/server/services/owner-billing-pdf';
import { getDashboard } from '@/server/services/dashboard';
import { approveApplication } from '@/server/services/review';
import type { OwnerSource } from '@/server/types';
import { createWorld, dollars as D, packageFor, stateAfter, submit, type World } from './helpers/world';

const source = (id: string, over: Partial<OwnerSource> = {}): OwnerSource => ({
  contractId: id,
  contractNumber: `SC-${id}`,
  subcontractorName: `Sub ${id}`,
  contractSum: D(100_000),
  workToDate: 0,
  stored: 0,
  asOf: null,
  openThisPeriod: 0,
  primeLineIds: [],
  status: 'active',
  ...over,
});
const line = (id: string, over: Partial<PrimeLineInput> = {}): PrimeLineInput => ({ id, itemNo: id, description: `Line ${id}`, scheduledValue: D(100_000), basis: 'manual', contractIds: [], changeOrderNumber: null, ...over });
const calc = (lines: PrimeLineInput[], sources: OwnerSource[], previous: Record<string, number> = {}, entries = {}) => ownerLines({ lines, sources, previous, entries, retainageWorkBps: 1000, retainageStoredBps: 500 });

describe('scaling an amount by a fraction', () => {
  it('rounds half away from zero and stays exact for large amounts', () => {
    expect(scale(D(100_000), 1, 3)).toBe(3_333_333);
    expect(scale(D(100_000), 2, 3)).toBe(6_666_667);
    expect(scale(5, 1, 2)).toBe(3);
    expect(scale(-5, 1, 2)).toBe(-3);
    expect(scale(D(90_000_000), D(45_000_000), D(60_000_000))).toBe(D(67_500_000));
    expect(scale(D(1), 1, 0)).toBe(0);
  });
});

describe('working out the lines', () => {
  it('passes the approved amounts through when the line is worth what the subcontract is', () => {
    const [l] = calc([line('1', { basis: 'subcontracts', contractIds: ['a'] })], [source('a', { workToDate: D(40_000), stored: D(5_000) })], { '1': D(25_000) });
    expect(l).toMatchObject({ previous: D(25_000), thisPeriod: D(15_000), stored: D(5_000), total: D(45_000), balance: D(55_000), percent: 45 });
    // 10% of work, 5% of stored material.
    expect(l!.retainage).toBe(D(4_000) + D(250));
    expect(l!.basisNote).toBe('SC-a 40% complete, 5% stored, as approved');
  });

  it('bills a marked-up line at the subcontracts’ percent complete, weighted by their contract sums', () => {
    const [l] = calc([line('1', { scheduledValue: D(330_000), basis: 'subcontracts', contractIds: ['a', 'b'] })], [source('a', { contractSum: D(100_000), workToDate: D(50_000) }), source('b', { contractSum: D(200_000), workToDate: D(40_000) })]);
    // (50,000 + 40,000) / 300,000 = 30% of 330,000.
    expect(l).toMatchObject({ thisPeriod: D(99_000), stored: 0, suggested: { workToDate: D(99_000), thisPeriod: D(99_000), stored: 0 } });
    expect(l!.basisNote).toBe('2 subcontracts 30% complete, as approved');
  });

  it('bills fee lines at the percent of work done on the rest, and leaves hand-entered lines at nothing', () => {
    const lines = calc(
      [line('1', { basis: 'subcontracts', contractIds: ['a'] }), line('2', { scheduledValue: D(50_000) }), line('3', { scheduledValue: D(7_500), basis: 'overall' })],
      [source('a', { workToDate: D(60_000) })],
    );
    expect(lines.map((l) => l.thisPeriod)).toEqual([D(60_000), 0, D(3_000)]); // 60,000 of 150,000 = 40% of 7,500
    expect(lines[2]!.basisNote).toBe('Rest of the contract 40% complete');
    expect(lines[1]!.suggested).toBeNull();
  });

  it('uses figures someone typed over, and the fee follows them', () => {
    const lines = calc([line('1', { scheduledValue: D(100_000) }), line('2', { scheduledValue: D(10_000), basis: 'overall' })], [], {}, { '1': { thisPeriod: D(25_000), stored: D(1_000), note: 'General conditions, month 3', by: 'Ana', at: '2026-10-01' } });
    expect(lines[0]).toMatchObject({ thisPeriod: D(25_000), stored: D(1_000), entered: { note: 'General conditions, month 3' } });
    expect(lines[1]!.thisPeriod).toBe(D(2_500));
  });
});

describe('the summary and the checks', () => {
  it('adds up G702 lines 1 to 9 from the lines', () => {
    const lines = calc([line('1', { basis: 'subcontracts', contractIds: ['a'] })], [source('a', { workToDate: D(40_000), stored: D(10_000) })]);
    const h = ownerHeader({ originalAmount: D(90_000), approvedChangeOrders: D(10_000), lines, retainageWorkBps: 1000, retainageStoredBps: 500, previousCertificates: D(20_000) });
    expect(h).toEqual({
      originalContractSum: D(90_000),
      netChangeOrders: D(10_000),
      contractSumToDate: D(100_000),
      totalCompletedStored: D(50_000),
      retainageWork: D(4_000),
      retainageStored: D(500),
      retainageTotal: D(4_500),
      totalEarnedLessRetainage: D(45_500),
      lessPreviousCertificates: D(20_000),
      currentPaymentDue: D(25_500),
      balanceToFinish: D(54_500),
    });
  });

  it('blocks a schedule that does not add up and a line billed beyond its value; warns about the rest', () => {
    const lines = calc(
      [line('1', { basis: 'subcontracts', contractIds: ['a'] }), line('2', { scheduledValue: D(10_000) }), line('3', { basis: 'subcontracts', contractIds: [] })],
      [source('a', { workToDate: D(30_000), openThisPeriod: 1, primeLineIds: ['1'] }), source('b', { workToDate: D(5_000) })],
      {},
      { '1': { thisPeriod: D(45_000), stored: 0, note: null, by: 'Ana', at: '' }, '2': { thisPeriod: D(12_000), stored: 0, note: null, by: 'Ana', at: '' } },
    );
    const header = ownerHeader({ originalAmount: D(200_000), approvedChangeOrders: 0, lines, retainageWorkBps: 1000, retainageStoredBps: 1000, previousCertificates: 0 });
    const checks = ownerChecks({ month: '2026-10', header, lines, sources: [source('a', { workToDate: D(30_000), openThisPeriod: 1, primeLineIds: ['1'] }), source('b', { workToDate: D(5_000) })], pendingChangeOrders: 2 });
    expect(checks.map((c) => [c.severity, c.code])).toEqual([
      ['blocking', 'schedule.total'],
      ['blocking', 'line.over'],
      ['warning', 'line.ahead'],
      ['warning', 'line.unlinked'],
      ['warning', 'source.open'],
      ['warning', 'source.unlinked'],
      ['info', 'changes.pending'],
    ]);
    expect(checks[0]!.detail).toContain('$210,000.00');
    expect(checks.find((c) => c.code === 'line.ahead')!.detail).toContain('$15,000.00 more than the approved subcontractor billing supports');
  });
});

describe('owner applications, end to end', () => {
  let w: World;
  let other: World;
  let appId: string;

  const riversideSchedule = (contractId: string) => [
    { itemNo: '1', description: 'General conditions', scheduledValue: D(60_000), basis: 'manual' as const },
    { itemNo: '2', description: 'Electrical', scheduledValue: D(500_000), basis: 'subcontracts' as const, contractIds: [contractId] },
    { itemNo: '3', description: 'Fee', scheduledValue: D(40_000), basis: 'overall' as const },
  ];

  beforeAll(async () => {
    w = await createWorld();
    other = await createWorld();
    const app1 = await submit(w, packageFor(w, 0, null));
    await approveApplication(w.db, w.controller, app1.id);
  });

  it('keeps setting up the owner contract to people who keep the records', async () => {
    const terms = { number: 'OC-2301', architectName: 'Hollis Architects', originalAmount: D(600_000), retainageWorkBps: 1000, retainageStoredBps: 1000, executedOn: '2026-02-15' };
    await expect(savePrimeContract(w.db, w.viewer, w.projectId, terms)).rejects.toThrow(/permission/);
    await expect(savePrimeContract(w.db, w.pm, w.projectId, terms)).rejects.toThrow(/permission/);
    await expect(savePrimeContract(other.db, other.owner, w.projectId, terms)).rejects.toThrow(/Project not found/);
    await expect(savePrimeContract(w.db, w.accountant, w.projectId, { ...terms, originalAmount: 0 })).rejects.toThrow(/original contract sum/);
    const id = await savePrimeContract(w.db, w.accountant, w.projectId, terms);
    expect(await savePrimeContract(w.db, w.accountant, w.projectId, terms)).toBe(id);
  });

  it('links schedule lines only to this project’s subcontracts', async () => {
    await expect(savePrimeSchedule(w.db, w.accountant, w.projectId, [{ itemNo: '1', description: 'Theirs', scheduledValue: D(1), basis: 'subcontracts', contractIds: [other.contractId] }])).rejects.toThrow(/only subcontracts on this project/);
    await savePrimeSchedule(w.db, w.accountant, w.projectId, riversideSchedule(w.contractId));
    const billing = (await getOwnerBilling(w.db, w.viewer, w.projectId))!;
    expect(billing.lines.map((l) => [l.itemNo, l.basis, l.contractIds])).toEqual([
      ['1', 'manual', []],
      ['2', 'subcontracts', [w.contractId]],
      ['3', 'overall', []],
    ]);
    expect(await getOwnerBilling(other.db, other.owner, w.projectId)).toBeNull();
  });

  it('starts a draft worked out from the approved subcontractor billing', async () => {
    expect(suggestedPeriod(null, new Date('2026-09-12T00:00:00Z'))).toBe('2026-09-30');
    expect(suggestedPeriod('2026-09-30')).toBe('2026-10-31');
    appId = await startOwnerApplication(w.db, w.accountant, w.projectId, '2026-09-30');
    await expect(startOwnerApplication(w.db, w.accountant, w.projectId, '2026-10-31')).rejects.toThrow(/still a draft/);

    const found = (await getOwnerApplication(w.db, w.viewer, appId))!;
    expect(found.app.applicationNumber).toBe(1);
    // The electrical subcontract approved $110,000 of $500,000; the fee follows the rest (110,000 of 560,000).
    expect(found.computed.lines.map((l) => [l.itemNo, l.thisPeriod, l.stored])).toEqual([
      ['1', 0, 0],
      ['2', D(110_000), 0],
      ['3', scale(D(40_000), D(110_000), D(560_000)), 0],
    ]);
    expect(found.computed.header).toMatchObject({ contractSumToDate: D(600_000), totalCompletedStored: D(110_000) + 785_714, lessPreviousCertificates: 0 });
    expect(found.computed.checks.filter((c) => c.severity === 'blocking')).toEqual([]);
    expect(found.computed.sources[0]).toMatchObject({ contractId: w.contractId, workToDate: D(110_000), asOf: { applicationNumber: 1, periodTo: '2026-09-30' } });
    expect(await getOwnerApplication(other.db, other.owner, appId)).toBeNull();
  });

  it('takes figures typed over a line, refusing an edit made on figures that have since changed', async () => {
    const { app, prime } = (await getOwnerApplication(w.db, w.viewer, appId))!;
    const lines = (await getOwnerBilling(w.db, w.viewer, w.projectId))!.lines;
    const gc = lines.find((l) => l.itemNo === '1')!.id;
    await expect(saveOwnerEntries(w.db, w.viewer, appId, app.version, [{ primeLineId: gc, thisPeriod: D(20_000), stored: null }])).rejects.toThrow(/permission/);
    await expect(saveOwnerEntries(other.db, other.owner, appId, app.version, [{ primeLineId: gc, thisPeriod: D(20_000), stored: null }])).rejects.toThrow(/not found/);
    await saveOwnerEntries(w.db, w.accountant, appId, app.version, [{ primeLineId: gc, thisPeriod: D(20_000), stored: null, note: 'Month 1 of 3' }]);
    await expect(saveOwnerEntries(w.db, w.accountant, appId, app.version, [{ primeLineId: gc, thisPeriod: D(1), stored: null }])).rejects.toBeInstanceOf(ConflictError);

    const after = (await getOwnerApplication(w.db, w.viewer, appId))!;
    expect(after.computed.lines[0]).toMatchObject({ thisPeriod: D(20_000), entered: { note: 'Month 1 of 3', by: 'Ana Accountant' } });
    // The fee now follows 130,000 of 560,000.
    expect(after.computed.lines[2]!.thisPeriod).toBe(scale(D(40_000), D(130_000), D(560_000)));
    expect(prime.id).toBe(after.prime.id);
  });

  it('is submitted by an approver, on the figures they saw, and then stays as submitted', async () => {
    const { computed } = (await getOwnerApplication(w.db, w.viewer, appId))!;
    await expect(submitOwnerApplication(w.db, w.accountant, appId, computed.fingerprint)).rejects.toThrow(/permission/);
    await expect(submitOwnerApplication(w.db, w.controller, appId, 'not-what-they-saw')).rejects.toBeInstanceOf(ConflictError);
    await submitOwnerApplication(w.db, w.controller, appId, computed.fingerprint);

    const [row] = await w.db.select().from(ownerApplications).where(eq(ownerApplications.id, appId));
    expect(row).toMatchObject({ status: 'submitted', amountDue: computed.header.currentPaymentDue });
    expect(row!.record).toMatchObject({ application: { number: 1, periodTo: '2026-09-30' }, header: computed.header, submittedBy: { name: 'Carlos Controller' } });
    await expect(saveOwnerEntries(w.db, w.accountant, appId, row!.version, [{ primeLineId: computed.lines[0]!.primeLineId, thisPeriod: 0, stored: 0 }])).rejects.toThrow(/Only a draft/);

    // October's subcontractor application is approved later; September's owner application does not move.
    const app2 = await submit(w, packageFor(w, 1, stateAfter(packageFor(w, 0, null))));
    await approveApplication(w.db, w.controller, app2.id);
    expect((await getOwnerApplication(w.db, w.viewer, appId))!.computed.header).toEqual(computed.header);
  });

  it('records the owner’s certification, asking why when it is short', async () => {
    const due = (await getOwnerApplication(w.db, w.viewer, appId))!.app.amountDue!;
    await expect(certifyOwnerApplication(w.db, w.accountant, appId, { amount: due, certifiedOn: '2026-10-10' })).rejects.toThrow(/permission/);
    await expect(certifyOwnerApplication(w.db, w.controller, appId, { amount: due + 1, certifiedOn: '2026-10-10' })).rejects.toThrow(/cannot certify more/);
    await expect(certifyOwnerApplication(w.db, w.controller, appId, { amount: due - D(5_000), certifiedOn: '2026-10-10' })).rejects.toThrow(/Say what the owner held back/);
    await certifyOwnerApplication(w.db, w.controller, appId, { amount: due - D(5_000), certifiedOn: '2026-10-10', note: 'Architect held $5,000 of general conditions' });
    await expect(reopenOwnerApplication(w.db, w.controller, appId, 'Owner asked for a change')).rejects.toThrow(/certified application cannot be reopened/);
  });

  it('builds the next application on the last one: previous work, and what the owner certified', async () => {
    const first = (await getOwnerApplication(w.db, w.viewer, appId))!;
    const nextId = await startOwnerApplication(w.db, w.accountant, w.projectId, '2026-10-31');
    await expect(startOwnerApplication(w.db, w.accountant, w.projectId, '2026-09-15')).rejects.toThrow(/still a draft/);
    const next = (await getOwnerApplication(w.db, w.viewer, nextId))!;
    expect(next.app.applicationNumber).toBe(2);
    const electrical = next.computed.lines.find((l) => l.itemNo === '2')!;
    // October: $105,000 more work and $10,000 of stored material on the subcontract.
    expect(electrical).toMatchObject({ previous: D(110_000), thisPeriod: D(105_000), stored: D(10_000) });
    expect(next.computed.lines[0]).toMatchObject({ previous: D(20_000), thisPeriod: 0, entered: null });
    expect(next.computed.header.lessPreviousCertificates).toBe(first.app.certifiedAmount);
    expect(next.computed.header.currentPaymentDue).toBe(next.computed.header.totalEarnedLessRetainage - first.app.certifiedAmount!);

    // A draft can be deleted; a submitted one can be reopened by an approver, only while it is the latest.
    await deleteOwnerDraft(w.db, w.accountant, nextId);
    const again = await startOwnerApplication(w.db, w.accountant, w.projectId, '2026-10-31');
    const fp = (await getOwnerApplication(w.db, w.viewer, again))!.computed.fingerprint;
    await submitOwnerApplication(w.db, w.controller, again, fp);
    await expect(reopenOwnerApplication(w.db, w.controller, again, 'no')).rejects.toThrow(/Say why/);
    await reopenOwnerApplication(w.db, w.controller, again, 'Owner asked to split the stored materials');
    expect((await getOwnerApplication(w.db, w.viewer, again))!.app).toMatchObject({ status: 'draft', record: null, amountDue: null, applicationNumber: 2 });
  });

  it('protects billed lines and billed change orders', async () => {
    const billing = (await getOwnerBilling(w.db, w.viewer, w.projectId))!;
    const keepOnly = billing.lines.filter((l) => l.itemNo !== '2').map((l) => ({ id: l.id, itemNo: l.itemNo, description: l.description, scheduledValue: l.scheduledValue, basis: l.basis, contractIds: l.contractIds }));
    await expect(savePrimeSchedule(w.db, w.accountant, w.projectId, keepOnly)).rejects.toThrow(/has been billed to the owner/);

    const coId = await createPrimeChangeOrder(w.db, w.accountant, w.projectId, { number: 'OCO-1', title: 'Added EV chargers', amount: D(25_000), status: 'approved', approvedOn: '2026-10-20' });
    const withCo = (await getOwnerBilling(w.db, w.viewer, w.projectId))!;
    expect(withCo.prime!.contractSumToDate).toBe(D(625_000));
    expect(withCo.lines.at(-1)).toMatchObject({ itemNo: 'OCO-1', scheduledValue: D(25_000), changeOrderNumber: 'OCO-1', basis: 'manual' });
    // Not billed yet, so its approval can still be withdrawn.
    await updatePrimeChangeOrder(w.db, w.accountant, coId, { number: 'OCO-1', title: 'Added EV chargers', amount: D(25_000), status: 'pending' });
    expect((await getOwnerBilling(w.db, w.viewer, w.projectId))!.lines.some((l) => l.itemNo === 'OCO-1')).toBe(false);
  });

  it('flags approved subcontractor billing that has not been billed to the owner', async () => {
    // October's subcontractor billing is approved, and application #2 is a draft again.
    const d = await getDashboard(w.db, w.viewer, new Date('2026-11-20T12:00:00Z'));
    const risk = d.risks.find((r) => r.key === `owner:${w.projectId}`);
    expect(risk).toMatchObject({ tone: 'warn', title: 'Oct 2026 not billed to the owner on Riverside Medical Office Building', href: `/projects/${w.projectId}/owner-billing` });
    expect(risk!.detail).toContain('the last application to the owner runs to 2026-09-30');
    // Still flagged once November has ended with nothing approved for it: October is the latest approved billing.
    const later = await getDashboard(w.db, w.viewer, new Date('2026-12-05T12:00:00Z'));
    expect(later.risks.find((r) => r.key === `owner:${w.projectId}`)?.title).toBe('Oct 2026 not billed to the owner on Riverside Medical Office Building');
    // Nothing to flag for September, which went to the owner.
    const before = await getDashboard(w.db, w.viewer, new Date('2026-10-20T12:00:00Z'));
    expect(before.risks.some((r) => r.key === `owner:${w.projectId}`)).toBe(false);
  });

  it('renders the PDF for people who can export, and logs every download', async () => {
    const draft = (await getOwnerBilling(w.db, w.viewer, w.projectId))!.applications.find((a) => a.status === 'draft')!;
    await expect(ownerApplicationForPdf(w.db, w.pm, draft.id)).rejects.toThrow(/permission/);
    await expect(ownerApplicationForPdf(other.db, other.owner, appId)).rejects.toThrow(/not found/);
    const frozen = await ownerApplicationForPdf(w.db, w.accountant, appId);
    expect(frozen).toMatchObject({ draft: false, filename: 'owner-application-2301-1-2026-09-30.pdf' });
    const bytes = await renderOwnerApplicationPdf(frozen.record);
    const pdf = await PDFDocument.load(bytes);
    expect(pdf.getPageCount()).toBe(2);
    expect(pdf.getPage(1).getSize()).toEqual({ width: 792, height: 612 });
    // A long schedule, with a description that wraps, carries on over further continuation sheets.
    const long = { ...frozen.record, lines: Array.from({ length: 60 }, (_, i) => ({ ...frozen.record.lines[0]!, primeLineId: `l${i}`, itemNo: String(i + 1), description: i === 3 ? 'Exterior envelope '.repeat(20) : `Line ${i + 1}` })) };
    const longPdf = await PDFDocument.load(await renderOwnerApplicationPdf(long));
    expect(longPdf.getPageCount()).toBe(3);
    expect(longPdf.getPages().slice(1).every((p) => p.getSize().width === 792)).toBe(true);

    const live = await ownerApplicationForPdf(w.db, w.accountant, draft.id);
    expect(live).toMatchObject({ draft: true, filename: 'owner-application-2301-2-2026-10-31-draft.pdf' });
    expect((await PDFDocument.load(await renderOwnerApplicationPdf(live.record, { draft: true }))).getPageCount()).toBe(2);

    const logged = await w.db.select().from(auditEvents).where(eq(auditEvents.orgId, w.orgId));
    const actions = logged.map((e) => e.action).filter((a) => a.startsWith('owner_billing.'));
    expect(actions).toEqual(
      expect.arrayContaining(['owner_billing.contract_created', 'owner_billing.schedule_saved', 'owner_billing.application_started', 'owner_billing.application_edited', 'owner_billing.application_submitted', 'owner_billing.application_certified', 'owner_billing.application_reopened', 'owner_billing.application_deleted', 'owner_billing.pdf_downloaded']),
    );
  });
});
