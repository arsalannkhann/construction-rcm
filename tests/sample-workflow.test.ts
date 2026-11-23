/**
 * The public sample page (/sample) renders a saved snapshot of one application
 * the product read and checked, next to the PDF it was read from. This rebuilds
 * both through the real pipeline, on the test database, and fails when the
 * saved copies have drifted from what the product now produces. It then checks
 * the things the page relies on without looking: counts that add up, highlights
 * that land on a page that exists.
 */
import fs from 'node:fs';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import type { SampleSnapshot, SampleSource } from '@/content/sample-types';
import { getDb } from '@/db';
import { readPdfText } from '@/server/documents/pdf-text';
import { buildSampleWorkflow } from '@/server/services/sample-workflow';
import { FINDING_CATEGORY_LABEL } from '@/server/types';

/** The same moment scripts/build-sample.ts uses. */
const NOW = new Date('2026-11-05T15:00:00Z');
const STALE = 'The saved sample no longer matches what the product produces. Run `pnpm sample:build` and commit the result.';

const saved = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'src', 'content', 'sample-workflow.json'), 'utf8')) as SampleSnapshot;
const savedPdfPath = path.join(process.cwd(), 'public', ...saved.document.url.split('/').filter(Boolean));

let built: { snapshot: SampleSnapshot; pdf: Uint8Array };

beforeAll(async () => {
  built = await buildSampleWorkflow(await getDb(), NOW);
}, 120_000);

describe('sample workflow', () => {
  it('is saved exactly as the product produces it', () => {
    expect(built.snapshot, STALE).toEqual(saved);
  });

  it('is saved with the PDF the figures were read from', async () => {
    expect(saved.document.url).toBe('/sample/brightline-electric-pay-application-4.pdf');
    expect(fs.existsSync(savedPdfPath), STALE).toBe(true);
    const pdf = fs.readFileSync(savedPdfPath);
    expect(pdf.subarray(0, 4).toString('latin1')).toBe('%PDF');
    // The generator fixes the PDF's dates, so the same package is the same bytes.
    expect(pdf.equals(built.pdf), STALE).toBe(true);

    const text = await readPdfText(pdf);
    expect(text.pageCount).toBe(saved.document.pageCount);
    expect(saved.document.pages.map((p) => p.page)).toEqual(text.pages.map((p) => p.page));
    expect(saved.document.pages.map((p) => [p.width, p.height])).toEqual(text.pages.map((p) => [p.viewWidth ?? p.width, p.viewHeight ?? p.height]));
    expect(saved.document.pages.map((p) => p.label)).toEqual(['Pay application', 'Schedule of values', 'Lien waiver']);
  });

  it('shows an undecided application with the two planted problems found', () => {
    const { application, contract, checks, findings } = saved;
    expect(saved.reader).toBe('text-layer');
    expect(contract.history.map((h) => h.number)).toEqual([1, 2, 3]);
    expect(contract.history.every((h) => h.approved > 0)).toBe(true);
    expect(application.number).toBe(4);
    expect(application.statusLabel).toBe('Needs review');

    // Paying what was asked would overpay: that is the point of the page.
    expect(application.verified).toBeLessThan(application.requested);
    expect(application.difference).toBe(application.verified - application.requested);

    expect(checks.blocking + checks.warnings).toBe(findings.length);
    expect(findings.filter((f) => f.severity === 'blocking')).toHaveLength(checks.blocking);
    expect(findings.filter((f) => f.severity === 'warning')).toHaveLength(checks.warnings);
    expect(checks.passed).toBeGreaterThan(0);
    // Blocking first, numbered in the order shown.
    expect(findings.map((f) => f.id)).toEqual(findings.map((_, i) => `f${i + 1}`));
    const order = findings.map((f) => f.severity);
    expect(order).toEqual([...order.filter((s) => s === 'blocking'), ...order.filter((s) => s === 'warning')]);

    const blocking = findings.filter((f) => f.severity === 'blocking').map((f) => f.category);
    expect(blocking).toEqual(expect.arrayContaining([FINDING_CATEGORY_LABEL.prior_billing, FINDING_CATEGORY_LABEL.payment]));
    expect(findings.some((f) => f.severity === 'blocking' && f.source?.bbox)).toBe(true);
    // A family with something open is not listed as passed.
    expect(saved.checks.passedGroups.filter((g) => findings.some((f) => f.category === g))).toEqual([]);

    expect(saved.correction?.subject).toContain('#4');
    expect(saved.correction?.body).toContain(findings[0]!.title);
  });

  it('points every highlight at a place on a page of the document', () => {
    const sources = [...saved.summary, ...saved.lines, ...saved.findings].map((x) => x.source).filter((s): s is SampleSource => s !== null);
    expect(sources.length).toBeGreaterThan(saved.findings.length);
    for (const source of sources) {
      expect(Number.isInteger(source.page) && source.page >= 1 && source.page <= saved.document.pageCount, `page ${source.page}`).toBe(true);
      if (!source.bbox) continue;
      const [x, y, w, h] = source.bbox;
      expect(source.bbox.every((n) => n >= 0 && n <= 1), `bbox ${source.bbox.join(', ')}`).toBe(true);
      expect(w > 0 && h > 0, `bbox ${source.bbox.join(', ')}`).toBe(true);
      // Boxes are rounded to four decimals, so allow that much past the edge.
      expect(x + w <= 1.0001 && y + h <= 1.0001, `bbox ${source.bbox.join(', ')}`).toBe(true);
    }
    // The figures read from the pay application are all located.
    expect(saved.summary.every((row) => row.onDocument !== null && row.source?.bbox)).toBe(true);
    expect(saved.lines.every((line) => line.source?.bbox)).toBe(true);
  });
});
