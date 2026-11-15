import type { SamplePackage } from '@/server/samples/pdf';

const D = (n: number) => Math.round(n * 100);

/** The same clean application #2 as the reconciliation fixture, as a printable package. */
export function samplePackage(overrides: Partial<SamplePackage> = {}): SamplePackage {
  return {
    gc: { name: 'Northline Constructors, Inc.', address: '4100 Guadalupe St, Suite 300, Austin, TX 78751' },
    owner: 'Riverside Health Partners',
    project: { name: 'Riverside Medical Office Building', number: '2301', address: '880 Riverside Dr, Austin, TX 78704', state: 'TX' },
    sub: { name: 'Lone Star Electric, LLC', address: '2210 Industrial Blvd, Austin, TX 78745', signer: 'Maria Alvarez', signerTitle: 'Controller' },
    contract: { number: 'SC-2301-16', date: '2026-03-02', description: 'Electrical' },
    applicationNumber: 2,
    applicationDate: '2026-10-28',
    periodTo: '2026-10-31',
    retainageWorkBps: 1000,
    retainageStoredBps: 1000,
    header: {
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
    lines: [
      { itemNo: '1', description: 'Mobilization', scheduledValue: D(50000), previous: D(50000), thisPeriod: 0, stored: 0, total: D(50000), balance: 0, retainage: D(5000) },
      { itemNo: '2', description: 'Rough-in, levels 1-3', scheduledValue: D(300000), previous: D(60000), thisPeriod: D(90000), stored: 0, total: D(150000), balance: D(150000), retainage: D(15000) },
      { itemNo: '3', description: 'Fixtures and trim', scheduledValue: D(150000), previous: 0, thisPeriod: D(15000), stored: D(10000), total: D(25000), balance: D(125000), retainage: D(2500) },
    ],
    signed: true,
    notarized: true,
    waiver: { form: 'TX', type: 'conditional_progress', amount: D(103500), throughDate: '2026-10-31', claimant: 'Lone Star Electric, LLC', signed: true },
    ...overrides,
  };
}

export const dollars = D;
