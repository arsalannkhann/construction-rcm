import { describe, expect, it } from 'vitest';
import { extractFromText } from '@/server/documents/engine-text';
import { readPdfText } from '@/server/documents/pdf-text';
import { renderPackage, renderTextlessPdf, type SampleLine } from '@/server/samples/pdf';
import { CLAIMED_FIELDS } from '@/server/types';
import { dollars as D, samplePackage } from './helpers/sample';

async function extract(pkg = samplePackage(), parts?: Parameters<typeof renderPackage>[1]) {
  const bytes = await renderPackage(pkg, parts);
  const text = await readPdfText(bytes);
  return { text, result: extractFromText(text) };
}

describe('text-layer extraction: combined package', () => {
  it('splits one PDF into its documents', async () => {
    const { result } = await extract();
    expect(result.segments.map((s) => [s.type, s.pageStart, s.pageEnd])).toEqual([
      ['pay_application', 1, 1],
      ['continuation_sheet', 2, 2],
      ['lien_waiver', 3, 3],
    ]);
  });

  it('reads every G702 amount exactly, with a location for each', async () => {
    const pkg = samplePackage();
    const { result } = await extract(pkg);
    for (const field of CLAIMED_FIELDS) {
      const got = result.payApp!.amounts[field];
      expect(got.value, field).toBe(pkg.header[field]);
      expect(got.page).toBe(1);
      expect(got.bbox, `${field} bbox`).toBeTruthy();
      expect(got.confidence).toBeGreaterThan(0.9);
    }
  });

  it('reads the identifying fields', async () => {
    const { result } = await extract();
    const p = result.payApp!;
    expect(p.applicationNumber.value).toBe(2);
    expect(p.periodTo.value).toBe('2026-10-31');
    expect(p.applicationDate.value).toBe('2026-10-28');
    expect(p.projectName.value).toBe('Riverside Medical Office Building');
    expect(p.projectNumber.value).toBe('2301');
    expect(p.contractorName.value).toBe('Lone Star Electric, LLC');
    expect(p.toName.value).toBe('Northline Constructors, Inc.');
    expect(p.contractNumber.value).toBe('SC-2301-16');
    expect(p.contractDate.value).toBe('2026-03-02');
  });

  it('reads the schedule of values column by column', async () => {
    const pkg = samplePackage();
    const { result } = await extract(pkg);
    expect(result.lines).toHaveLength(3);
    result.lines!.forEach((line, i) => {
      const want = pkg.lines[i]!;
      expect(line).toMatchObject({
        itemNo: want.itemNo,
        description: want.description,
        scheduledValue: want.scheduledValue,
        previous: want.previous,
        thisPeriod: want.thisPeriod,
        stored: want.stored,
        total: want.total,
        balance: want.balance,
        retainage: want.retainage,
        page: 2,
      });
    });
    expect(result.lineTotals).toMatchObject({ scheduledValue: D(500000), total: D(225000), retainage: D(22500) });
  });

  it('detects an electronic signature and a completed notary block', async () => {
    const { result } = await extract();
    expect(result.payApp!.signed.value).toBe('yes');
    expect(result.payApp!.signerName.value).toBe('Maria Alvarez');
    expect(result.payApp!.notarized.value).toBe('yes');
  });

  it('reports "unclear", never "yes", when it cannot see a signature', async () => {
    const { result } = await extract(samplePackage({ signed: false, notarized: false }));
    expect(result.payApp!.signed.value).toBe('unclear');
    expect(result.payApp!.notarized.value).toBe('unclear');
    expect(result.notes.join(' ')).toContain('needs a visual check');
  });

  it('reads what is printed, not what would be correct', async () => {
    const pkg = samplePackage();
    pkg.header.lessPreviousCertificates = D(89000);
    pkg.header.currentPaymentDue = D(113500);
    const { result } = await extract(pkg);
    expect(result.payApp!.amounts.lessPreviousCertificates.value).toBe(D(89000));
    expect(result.payApp!.amounts.currentPaymentDue.value).toBe(D(113500));
  });
});

describe('text-layer extraction: schedule of values', () => {
  it('handles change-order item numbers and a sheet that runs over several pages', async () => {
    const lines: SampleLine[] = [];
    for (let i = 1; i <= 40; i++) {
      lines.push({ itemNo: String(i).padStart(2, '0'), description: `Work package ${i}`, scheduledValue: D(1000 * i), previous: D(100 * i), thisPeriod: D(50 * i), stored: 0, total: D(150 * i), balance: D(850 * i), retainage: D(15 * i) });
    }
    lines.push({ itemNo: 'CO-1', description: 'Added receptacles, level 2', scheduledValue: D(12000), previous: 0, thisPeriod: D(12000), stored: 0, total: D(12000), balance: 0, retainage: D(1200) });
    const { result } = await extract(samplePackage({ lines }));
    expect(result.segments.find((s) => s.type === 'continuation_sheet')).toMatchObject({ pageStart: 2, pageEnd: 3 });
    expect(result.lines).toHaveLength(41);
    expect(result.lines![40]).toMatchObject({ itemNo: 'CO-1', thisPeriod: D(12000), page: 3 });
    expect(result.lines![23]).toMatchObject({ itemNo: '24', page: 2 });
    expect(result.lines![24]).toMatchObject({ itemNo: '25', page: 3 });
  });

  it('keeps negative amounts negative', async () => {
    const pkg = samplePackage();
    pkg.lines[1]!.thisPeriod = -D(5000);
    const { result } = await extract(pkg);
    expect(result.lines![1]!.thisPeriod).toBe(-D(5000));
  });
});

describe('text-layer extraction: lien waivers', () => {
  it('reads a Texas conditional progress waiver', async () => {
    const { result } = await extract();
    const w = result.waivers![0]!;
    expect(w.waiverType.value).toBe('conditional_progress');
    expect(w.formState.value).toBe('TX');
    expect(w.amount.value).toBe(D(103500));
    expect(w.claimant.value).toBe('Lone Star Electric, LLC');
    expect(w.customer.value).toBe('Northline Constructors, Inc.');
    expect(w.owner.value).toBe('Riverside Health Partners');
    expect(w.throughDate.value).toBeNull(); // the Texas form has no through date
    expect(w.signed.value).toBe('yes');
  });

  it('reads a California conditional progress waiver, including its through date', async () => {
    const pkg = samplePackage();
    pkg.project.state = 'CA';
    pkg.waiver = { form: 'CA', type: 'conditional_progress', amount: D(103500), throughDate: '2026-10-31', claimant: 'Lone Star Electric, LLC', signed: true };
    const { result } = await extract(pkg, ['lien_waiver']);
    const w = result.waivers![0]!;
    expect(w.formState.value).toBe('CA');
    expect(w.waiverType.value).toBe('conditional_progress');
    expect(w.amount.value).toBe(D(103500));
    expect(w.throughDate.value).toBe('2026-10-31');
    expect(w.claimant.value).toBe('Lone Star Electric, LLC');
    expect(w.owner.value).toBe('Riverside Health Partners');
    expect(w.exceptions.value).toBeNull();
  });

  it('reads a California unconditional waiver as unconditional', async () => {
    const pkg = samplePackage();
    pkg.waiver = { form: 'CA', type: 'unconditional_progress', amount: D(99000), throughDate: '2026-09-30', claimant: 'Lone Star Electric, LLC', signed: true };
    const { result } = await extract(pkg, ['lien_waiver']);
    expect(result.waivers![0]!.waiverType.value).toBe('unconditional_progress');
    expect(result.waivers![0]!.amount.value).toBe(D(99000));
  });

  it('reads a Florida progress waiver and whether it is conditioned on payment', async () => {
    const pkg = samplePackage();
    pkg.waiver = { form: 'FL', type: 'conditional_progress', amount: D(48200), throughDate: '2026-10-31', claimant: 'Lone Star Electric, LLC', signed: true };
    const cond = (await extract(pkg, ['lien_waiver'])).result.waivers![0]!;
    expect(cond.formState.value).toBe('FL');
    expect(cond.waiverType.value).toBe('conditional_progress');
    expect(cond.amount.value).toBe(D(48200));
    expect(cond.throughDate.value).toBe('2026-10-31');
    expect(cond.claimant.value).toBe('Lone Star Electric, LLC');

    pkg.waiver.type = 'unconditional_progress';
    const plain = (await extract(pkg, ['lien_waiver'])).result.waivers![0]!;
    expect(plain.waiverType.value).toBe('unconditional_progress');
  });

  it('recognises a non-statutory waiver without claiming it matches a state form', async () => {
    const pkg = samplePackage();
    pkg.waiver = { form: 'generic', type: 'conditional_progress', amount: D(103500), throughDate: '2026-10-31', claimant: 'Lone Star Electric, LLC', signed: true, exceptions: 'Disputed extra work claim of $4,200.00' };
    const w = (await extract(pkg, ['lien_waiver'])).result.waivers![0]!;
    expect(w.formState.value).toBeNull();
    expect(w.waiverType.value).toBe('conditional_progress');
    expect(w.amount.value).toBe(D(103500));
    expect(w.throughDate.value).toBe('2026-10-31');
    expect(w.exceptions.value).toContain('Disputed extra work claim');
  });

  it('leaves a blank amount blank', async () => {
    const pkg = samplePackage();
    pkg.waiver!.amount = null;
    const { result } = await extract(pkg, ['lien_waiver']);
    expect(result.waivers![0]!.amount.value).toBeNull();
    expect(result.notes.join(' ')).toContain('No amount could be read');
  });
});

describe('text-layer extraction: limits', () => {
  it('reports that a PDF has no text layer', async () => {
    const text = await readPdfText(await renderTextlessPdf());
    expect(text.hasTextLayer).toBe(false);
    expect(text.pageCount).toBe(1);
  });
});
