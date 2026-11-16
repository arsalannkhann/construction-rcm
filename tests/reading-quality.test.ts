/**
 * What reviewers changed after the reader: the counts on the System page. They
 * measure reviewer effort, not accuracy; these tests pin down what is counted
 * as a correction and what is not.
 */
import { describe, expect, it } from 'vitest';
import { addLine, rejectApplication, updateHeader } from '@/server/services/review';
import { readerLabel, readingQuality, tallyReading } from '@/server/services/reading-quality';
import { EMPTY_CLAIMED } from '@/server/types';
import { createWorld, dollars as D, packageFor, submit } from './helpers/world';

const app = (id: string, over: Partial<Parameters<typeof tallyReading>[0][number]> = {}) => ({
  id,
  engine: 'claude:claude-opus-5-5',
  claimed: { ...EMPTY_CLAIMED, currentPaymentDue: D(1000), retainageTotal: D(100) },
  applicationNumber: 2,
  periodTo: '2026-10-31',
  headerCorrections: null,
  ...over,
});

describe('counting what reviewers changed after the reader', () => {
  it('tells a misread figure from one the reader missed, and counts only what the reader produced as read', () => {
    const [t] = tallyReading(
      [app('a1', { claimed: { ...EMPTY_CLAIMED, currentPaymentDue: D(1100), retainageTotal: D(100), originalContractSum: D(5000) }, headerCorrections: { currentPaymentDue: { from: D(1000), to: D(1100) }, originalContractSum: { from: null, to: D(5000) } } })],
      [],
      [],
      [],
    );
    // Read: currentPaymentDue (as read), retainageTotal, applicationNumber, periodTo. Not originalContractSum, which was blank.
    expect(t!.summary).toEqual({ read: 4, misread: 1, missed: 1 });
    expect(t!.withChanges).toBe(1);
  });

  it('does not count an adjustment (a decision about what to approve) as a reading error', () => {
    const snap = { itemNo: '1' } as never;
    const [t] = tallyReading(
      [app('a1')],
      [
        { payApplicationId: 'a1', extracted: snap, editKind: null },
        { payApplicationId: 'a1', extracted: snap, editKind: 'adjustment' },
        { payApplicationId: 'a1', extracted: snap, editKind: 'correction' },
        { payApplicationId: 'a1', extracted: null, editKind: 'correction' },
      ],
      [
        { payApplicationId: 'a1', extracted: {} as never, editedBy: null },
        { payApplicationId: 'a1', extracted: null, editedBy: 'usr_1' },
      ],
      [
        { payApplicationId: 'a1', status: 'processed', statusDetail: null },
        { payApplicationId: 'a1', status: 'processed', statusDetail: 'AI extraction failed: …' },
        { payApplicationId: 'a1', status: 'failed', statusDetail: 'AI extraction failed: …' },
      ],
    );
    expect(t!.lines).toEqual({ read: 3, corrected: 1, keyedByHand: 1 });
    expect(t!.waivers).toEqual({ read: 1, corrected: 0, keyedByHand: 1 });
    expect(t!.documents).toEqual({ total: 3, notRead: 1, backupReader: 1 });
  });

  it('keeps readers apart, and an application nobody had to change is not counted as changed', () => {
    const tallies = tallyReading([app('a1'), app('a2'), app('a3', { engine: 'text-layer' })], [], [], []);
    expect(tallies.map((t) => [t.reader, t.applications, t.withChanges])).toEqual([
      ['claude:claude-opus-5-5', 2, 0],
      ['text-layer', 1, 0],
    ]);
    expect(readerLabel('claude:claude-opus-5-5')).toBe('AI reader (claude-opus-5-5)');
    expect(readerLabel('claude:claude-opus-5-5, text-layer')).toBe('AI reader (claude-opus-5-5) + Text reader');
  });

  it('counts decided applications of this organisation only, from the real review actions', async () => {
    const w = await createWorld();
    const decided = await submit(w, packageFor(w, 0, null));
    const open = await submit(w, packageFor(w, 0, null), { filename: 'again.pdf' });
    expect(open.status).not.toBe('approved');

    await updateHeader(w.db, w.accountant, decided.id, { retainageTotal: D(12345) });
    await addLine(w.db, w.accountant, decided.id, { itemNo: '9', description: 'Missed row', scheduledValue: D(1000), thisPeriod: D(100) });
    await rejectApplication(w.db, w.controller, decided.id, 'Testing the counts');

    const [t, ...rest] = await readingQuality(w.db, w.accountant);
    expect(rest).toEqual([]);
    expect(t).toMatchObject({ reader: 'text-layer', applications: 1, withChanges: 1, summary: { misread: 1, missed: 0 }, lines: { corrected: 0, keyedByHand: 1 } });
    expect(t!.summary.read).toBeGreaterThan(5);
    expect(t!.lines.read).toBeGreaterThan(0);

    // Another organisation sees none of it.
    const other = await createWorld();
    expect(await readingQuality(other.db, other.accountant)).toEqual([]);
    // Outside the window, nothing.
    expect(await readingQuality(w.db, w.accountant, new Date(Date.now() + 400 * 24 * 60 * 60 * 1000))).toEqual([]);
  });
});
