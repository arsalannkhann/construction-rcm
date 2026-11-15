/**
 * Writes a small set of sample billing packages to samples/out, for trying the
 * product in your own (non-demo) organisation.
 *
 *   pnpm samples
 *
 * They belong to one fictitious subcontract. Set it up first (see README,
 * "Try it from an empty organisation"), then upload the files in order.
 */
import fs from 'node:fs';
import path from 'node:path';
import { renderPackage, renderTextlessPdf } from '../src/server/samples/pdf';
import { buildPackage, defects, stateAfter, type BillingContract, type Parties } from '../src/server/samples/scenario';

const D = (n: number) => Math.round(n * 100);
const out = path.join(process.cwd(), 'samples', 'out');

const parties: Parties = {
  gc: { name: process.env.SAMPLE_GC_NAME ?? 'Your Company', address: '100 Main St, Austin, TX 78701' },
  owner: 'Riverside Health Partners',
  project: { name: 'Riverside Medical Office Building', number: '2301', address: '880 Riverside Dr, Austin, TX 78704', state: 'TX' },
  sub: { name: 'Lone Star Electric, LLC', address: '2210 Industrial Blvd, Austin, TX 78745', signer: 'Maria Alvarez', signerTitle: 'Controller' },
};
const contract: BillingContract = {
  number: 'SC-2301-16',
  date: '2026-03-02',
  description: 'Electrical',
  originalAmount: D(500000),
  retainageWorkBps: 1000,
  retainageStoredBps: 1000,
  sov: [
    { itemNo: '1', description: 'Mobilization', scheduledValue: D(50000) },
    { itemNo: '2', description: 'Rough-in, levels 1-3', scheduledValue: D(300000) },
    { itemNo: '3', description: 'Fixtures and trim', scheduledValue: D(150000) },
  ],
  changeOrders: [],
};

async function main() {
  fs.mkdirSync(out, { recursive: true });
  const first = buildPackage(parties, contract, null, { applicationNumber: 1, periodTo: '2026-09-30', applicationDate: '2026-09-28', progress: { '1': { work: D(50000) }, '2': { work: D(60000) } } });
  const second = () => buildPackage(parties, contract, stateAfter(first), { applicationNumber: 2, periodTo: '2026-10-31', applicationDate: '2026-10-28', progress: { '2': { work: D(90000) }, '3': { work: D(15000), stored: D(10000) } } });
  const wrong = second();
  defects.understatePreviousCertificates(wrong, D(10000));
  defects.retainAt(wrong, 500);

  const files: Array<[string, Uint8Array]> = [
    ['1-application-01-in-order.pdf', await renderPackage(first)],
    ['2a-application-02-in-order.pdf', await renderPackage(second())],
    ['2b-application-02-with-discrepancies.pdf', await renderPackage(wrong)],
    ['3-scanned-page-no-text.pdf', await renderTextlessPdf()],
  ];
  for (const [name, bytes] of files) fs.writeFileSync(path.join(out, name), bytes);
  fs.writeFileSync(path.join(out, 'schedule-of-values.tsv'), contract.sov.map((l) => [l.itemNo, l.description, (l.scheduledValue / 100).toFixed(2)].join('\t')).join('\n') + '\n');

  console.log(`Wrote ${files.length} PDFs and schedule-of-values.tsv to ${path.relative(process.cwd(), out)}/\n`);
  console.log('Subcontract to set up before uploading:');
  console.log('  Project         Riverside Medical Office Building, number 2301, Texas');
  console.log('  Subcontractor   Lone Star Electric, LLC');
  console.log('  Contract        SC-2301-16 "Electrical", $500,000.00, retainage 10% / 10%');
  console.log('  Schedule        paste schedule-of-values.tsv into the schedule editor');
  console.log('\nUpload 1, approve it, then upload 2a or 2b (not both: they are the same application number).');
}

main();
