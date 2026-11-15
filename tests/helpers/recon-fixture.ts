import type { ReconInput, ReconLine } from '@/server/recon/engine';
import { DEFAULT_ORG_SETTINGS, EMPTY_CLAIMED } from '@/server/types';

const D = (dollars: number) => Math.round(dollars * 100);

/**
 * A clean application #2 on a $500,000 subcontract with 10% retainage.
 *
 *   SOV            scheduled   prior   this    stored
 *   1 Mobilization    50,000   50,000      0        0
 *   2 Rough-in       300,000   60,000  90,000       0
 *   3 Fixtures       150,000        0  15,000  10,000
 *
 *   Application #1 was approved at 110,000 complete, 11,000 retainage, 99,000 paid.
 *   #2: 225,000 complete · retainage 22,500 · earned 202,500 · less 99,000 · due 103,500.
 */
export function cleanInput(): ReconInput {
  const lines: ReconLine[] = [
    { id: 'l1', sovLineId: 's1', itemNo: '1', description: 'Mobilization', scheduledValue: D(50000), previous: D(50000), thisPeriod: 0, stored: 0, total: D(50000), balance: 0, retainage: D(5000) },
    { id: 'l2', sovLineId: 's2', itemNo: '2', description: 'Rough-in', scheduledValue: D(300000), previous: D(60000), thisPeriod: D(90000), stored: 0, total: D(150000), balance: D(150000), retainage: D(15000) },
    { id: 'l3', sovLineId: 's3', itemNo: '3', description: 'Fixtures', scheduledValue: D(150000), previous: 0, thisPeriod: D(15000), stored: D(10000), total: D(25000), balance: D(125000), retainage: D(2500) },
  ];
  return {
    policy: { ...DEFAULT_ORG_SETTINGS },
    today: '2026-11-05',
    project: { name: 'Riverside Medical Office Building', state: 'TX' },
    subcontractor: { name: 'Lone Star Electric, LLC' },
    contract: { number: 'SC-1001', originalAmount: D(500000), retainageWorkBps: 1000, retainageStoredBps: 1000 },
    changeOrders: [],
    sov: [
      { id: 's1', itemNo: '1', description: 'Mobilization', scheduledValue: D(50000) },
      { id: 's2', itemNo: '2', description: 'Rough-in', scheduledValue: D(300000) },
      { id: 's3', itemNo: '3', description: 'Fixtures', scheduledValue: D(150000) },
    ],
    prior: {
      kind: 'application',
      applicationNumber: 1,
      periodTo: '2026-09-30',
      totalEarnedLessRetainage: D(99000),
      retainageTotal: D(11000),
      currentPaymentDue: D(99000),
      workToDate: { s1: D(50000), s2: D(60000) },
    },
    siblings: [{ id: 'a1', applicationNumber: 1, periodTo: '2026-09-30', status: 'approved' }],
    app: {
      id: 'a2',
      applicationNumber: 2,
      periodTo: '2026-10-31',
      claimed: {
        ...EMPTY_CLAIMED,
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
      },
      signed: 'yes',
      signatureConfirmed: false,
      notarized: 'yes',
      confidence: {},
    },
    lines,
    documents: [
      {
        id: 'd1',
        filename: 'payapp-2.pdf',
        status: 'processed',
        statusDetail: null,
        duplicateOf: null,
        segments: [
          { type: 'pay_application', pageStart: 1, pageEnd: 1, confidence: 0.99 },
          { type: 'continuation_sheet', pageStart: 2, pageEnd: 2, confidence: 0.99 },
          { type: 'lien_waiver', pageStart: 3, pageEnd: 3, confidence: 0.99 },
        ],
      },
    ],
    waivers: [
      {
        id: 'w1',
        waiverType: 'conditional_progress',
        formState: 'TX',
        claimant: 'Lone Star Electric LLC',
        throughDate: null,
        amount: D(103500),
        exceptions: null,
        signed: 'yes',
      },
    ],
  };
}

export const dollars = D;
