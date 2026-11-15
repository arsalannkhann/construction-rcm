import type { ModelOutput } from '@/server/documents/engine-claude';
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

/** What a careful model would return for `samplePackage()` (the same answer tests/claude-engine.test.ts uses). For stubbed clients only. */
export function sampleModelAnswer(): ModelOutput {
  const v = (text: string | null, page: number | null = 1) => ({ text, page, confidence: 'high' as const });
  const tri = (value: 'yes' | 'no' | 'unclear', page = 1) => ({ value, page, confidence: 'high' as const });
  return {
    segments: [
      { type: 'pay_application', page_start: 1, page_end: 1, confidence: 'high' },
      { type: 'continuation_sheet', page_start: 2, page_end: 2, confidence: 'high' },
      { type: 'lien_waiver', page_start: 3, page_end: 3, confidence: 'high' },
    ],
    pay_application: {
      application_number: v('2'),
      period_to: v('10/31/2026'),
      application_date: v('10/28/2026'),
      project_name: v('Riverside Medical Office Building'),
      project_number: v('2301'),
      contractor_name: v('Lone Star Electric, LLC'),
      to_name: v('Northline Constructors, Inc.'),
      contract_number: v('SC-2301-16'),
      contract_date: v('03/02/2026'),
      amounts: {
        original_contract_sum: v('500,000.00'),
        net_change_orders: v('0.00'),
        contract_sum_to_date: v('500,000.00'),
        total_completed_stored: v('225,000.00'),
        retainage_work: v('21,500.00'),
        retainage_stored: v('1,000.00'),
        retainage_total: v('22,500.00'),
        total_earned_less_retainage: v('202,500.00'),
        less_previous_certificates: v('99,000.00'),
        current_payment_due: v('$103,500.00'),
        balance_to_finish: v('297,500.00'),
      },
      signed: tri('yes'),
      signer_name: v('Maria Alvarez'),
      notarized: tri('yes'),
    },
    line_items: [
      { item_no: '1', description: 'Mobilization', scheduled_value: '50,000.00', previous: '50,000.00', this_period: '0.00', stored: '0.00', total: '50,000.00', balance: '0.00', retainage: '5,000.00', page: 2, confidence: 'high' },
      { item_no: '2', description: 'Rough-in, levels 1-3', scheduled_value: '300,000.00', previous: '60,000.00', this_period: '90,000.00', stored: '0.00', total: '150,000.00', balance: '150,000.00', retainage: '15,000.00', page: 2, confidence: 'high' },
      { item_no: '3', description: 'Fixtures and trim', scheduled_value: '150,000.00', previous: '0.00', this_period: '15,000.00', stored: '10,000.00', total: '25,000.00', balance: '125,000.00', retainage: '2,500.00', page: 2, confidence: 'high' },
    ],
    line_totals: { scheduled_value: '500,000.00', previous: '110,000.00', this_period: '105,000.00', stored: '10,000.00', total: '225,000.00', balance: '275,000.00', retainage: '22,500.00' },
    lien_waivers: [
      {
        page: 3,
        waiver_type: 'conditional_progress',
        waiver_type_confidence: 'high',
        statutory_form_state: 'TX',
        title: v('CONDITIONAL WAIVER AND RELEASE ON PROGRESS PAYMENT', 3),
        claimant: v('Lone Star Electric, LLC', 3),
        customer: v('Northline Constructors, Inc.', 3),
        owner: v('Riverside Health Partners', 3),
        job_description: v('Electrical', 3),
        through_date: v(null, 3),
        amount: v('$103,500.00', 3),
        exceptions: v(null, 3),
        signed: tri('yes', 3),
        signer_name: v('Maria Alvarez', 3),
        signer_title: v('Controller', 3),
        signed_date: v('October 28, 2026', 3),
        notarized: tri('no', 3),
      },
    ],
    notes: [],
  };
}
