import { describe, expect, it } from 'vitest';
import { amountInput, parseAmount } from '../mobile/src/lib/amount';
import { buildUploads, filterUploads, searchUploads, tagCounts } from '../mobile/src/lib/uploads';

type Draft = Parameters<typeof buildUploads>[0][number];
type Row = Parameters<typeof buildUploads>[1][number];

function draft(over: Partial<Draft>): Draft {
  return {
    id: 'd1',
    title: '',
    contract: null,
    files: [{ name: 'Page 1.jpg' }],
    status: 'draft',
    error: null,
    applicationId: null,
    createdAt: '2026-11-17T18:20:00.000Z',
    updatedAt: '2026-11-17T18:20:00.000Z',
    submittedAt: null,
    ...over,
  };
}

function row(over: Partial<Row>): Row {
  return {
    id: 'pa_1',
    title: null,
    status: 'needs_review',
    statusLabel: 'Needs review',
    number: null,
    periodTo: null,
    receivedAt: '2026-11-10T10:00:00.000Z',
    project: null,
    subcontractor: null,
    contractNumber: null,
    claimed: null,
    verified: null,
    approved: null,
    openBlocking: 0,
    failed: false,
    ...over,
  };
}

describe('my uploads', () => {
  it('titles each upload with the name the person gave it, not "Unmatched submission"', () => {
    const items = buildUploads([], [row({ id: 'a', title: 'Concrete' }), row({ id: 'b', title: 'Steel', subcontractor: 'Pacific Steel Erectors' })]);
    expect(items.map((i) => i.title)).toEqual(['Concrete', 'Steel']);
    expect(items[1].detail).toBe('Pacific Steel Erectors');
  });

  it('falls back to the company when there is no name', () => {
    expect(buildUploads([], [row({ subcontractor: 'Lone Star Electric' })])[0].title).toBe('Lone Star Electric');
    expect(buildUploads([], [row({})])[0].title).toBe('Upload');
  });

  it('puts uploads still on the phone and ones the server has in one list, newest first', () => {
    const items = buildUploads([draft({ id: 'd1', title: 'Concrete', status: 'sending' })], [row({ id: 'a', title: 'Steel' })]);
    expect(items.map((i) => [i.title, i.status])).toEqual([
      ['Concrete', 'Sending…'],
      ['Steel', 'Received – being checked'],
    ]);
    expect(items[0].target).toEqual({ kind: 'draft', id: 'd1' });
  });

  it('shows a sent draft once: by the server row when the server has it', () => {
    const sent = draft({ id: 'd1', title: 'Concrete', status: 'submitted', applicationId: 'pa_1', submittedAt: '2026-11-17T18:21:00.000Z' });
    expect(buildUploads([sent], [row({ id: 'pa_1', title: 'Concrete' })])).toHaveLength(1);
    // Before the list has refreshed, the draft stands in and opens the application.
    const alone = buildUploads([sent], []);
    expect(alone).toHaveLength(1);
    expect(alone[0].target).toEqual({ kind: 'application', id: 'pa_1' });
  });

  it('leaves out drafts that were opened and left empty', () => {
    expect(buildUploads([draft({ files: [] })], [])).toEqual([]);
  });

  it('gives each upload a short stamp word', () => {
    const items = buildUploads(
      [draft({ id: 'd1', status: 'sending', updatedAt: '2026-11-17T18:22:00.000Z' })],
      [row({ id: 'a', status: 'approved' }), row({ id: 'b', openBlocking: 2, receivedAt: '2026-11-09T10:00:00.000Z' }), row({ id: 'c', failed: true, receivedAt: '2026-11-08T10:00:00.000Z' })],
    );
    expect(items.map((i) => i.stamp)).toEqual(['Sending', 'Approved', 'Problem', 'Unreadable']);
  });

  it('says a failed send can be tried again', () => {
    expect(buildUploads([draft({ status: 'failed', error: 'x' })], [])[0]).toMatchObject({ status: 'Not sent – tap to try again', tone: 'problem' });
  });

  describe('search', () => {
    const items = buildUploads(
      [draft({ id: 'd1', title: 'Concrete pour level 2', status: 'queued' })],
      [
        row({ id: 'a', title: 'Steel', subcontractor: 'Pacific Steel Erectors', project: 'Riverside Tower', claimed: 1_240_000, number: 5, receivedAt: '2026-10-02T10:00:00.000Z' }),
        row({ id: 'b', title: 'Electrical', subcontractor: 'Lone Star Electric', project: 'Mesa Clinic', approved: 810_000 }),
      ],
    );
    const find = (q: string) => searchUploads(items, q).map((i) => i.title);

    it('finds by the name given, ignoring case', () => expect(find('CONCRETE')).toEqual(['Concrete pour level 2']));
    it('finds by company or project', () => {
      expect(find('pacific')).toEqual(['Steel']);
      expect(find('mesa')).toEqual(['Electrical']);
    });
    it('finds by amount, typed with or without $ and commas', () => {
      expect(find('12,400')).toEqual(['Steel']);
      expect(find('$12400')).toEqual(['Steel']);
      expect(find('8100')).toEqual(['Electrical']);
    });
    it('finds by month and by application number', () => {
      expect(find('oct')).toEqual(['Steel']);
      expect(find('#5')).toEqual(['Steel']);
    });
    it('needs every word, in any order', () => {
      expect(find('level concrete')).toEqual(['Concrete pour level 2']);
      expect(find('concrete steel')).toEqual([]);
    });
    it('shows everything when the box is empty', () => expect(find('  ')).toHaveLength(3));
  });

  describe('descriptions, tags and typed amounts', () => {
    const now = Date.parse('2026-11-22T12:00:00.000Z');
    const items = buildUploads(
      [draft({ id: 'd1', title: 'Diesel', tags: ['Fuel'], amountCents: 8_550, status: 'queued', updatedAt: '2026-11-21T09:00:00.000Z' })],
      [
        row({ id: 'a', title: 'Concrete', description: 'Level 2 pour, 40 yards', tags: ['Concrete', 'Site 2'], stated: 1_240_000, claimed: 1_250_000, receivedAt: '2026-11-20T10:00:00.000Z' }),
        row({ id: 'b', title: 'Rebar', tags: ['Site 2'], receivedAt: '2026-10-01T10:00:00.000Z', approved: 300_000 }),
      ],
    );
    const titles = (list: typeof items) => list.map((i) => i.title);

    it('shows the amount the person typed first, and says so', () => {
      expect(items.find((i) => i.title === 'Concrete')).toMatchObject({ amount: '$12,400.00', amountTyped: true });
      expect(items.find((i) => i.title === 'Rebar')).toMatchObject({ amount: '$3,000.00', amountTyped: false });
      expect(items.find((i) => i.title === 'Diesel')).toMatchObject({ amount: '$85.50', amountTyped: true });
    });
    it('finds by words in the description and by tag', () => {
      expect(titles(searchUploads(items, 'yards'))).toEqual(['Concrete']);
      expect(titles(searchUploads(items, 'fuel'))).toEqual(['Diesel']);
    });
    it('finds by the typed amount and by the one Zephric read', () => {
      expect(titles(searchUploads(items, '12400'))).toEqual(['Concrete']);
      expect(titles(searchUploads(items, '12,500'))).toEqual(['Concrete']);
      expect(titles(searchUploads(items, '85.50'))).toEqual(['Diesel']);
    });
    it('filters by one tag, ignoring case, and by this week or this month', () => {
      expect(titles(filterUploads(items, { tag: 'site 2', now }))).toEqual(['Concrete', 'Rebar']);
      expect(titles(filterUploads(items, { period: 'week', now }))).toEqual(['Diesel', 'Concrete']);
      expect(titles(filterUploads(items, { tag: 'Site 2', period: 'month', now }))).toEqual(['Concrete']);
      expect(titles(filterUploads(items, { query: 'rebar', tag: 'Fuel', now }))).toEqual([]);
    });
    it('offers the most used tags first', () => {
      expect(tagCounts(items)).toEqual([
        { tag: 'Site 2', count: 2 },
        { tag: 'Concrete', count: 1 },
        { tag: 'Fuel', count: 1 },
      ]);
    });
  });

  describe('typing an amount', () => {
    it('reads what people type into whole cents', () => {
      expect(parseAmount('12,400')).toBe(1_240_000);
      expect(parseAmount('$12400.5')).toBe(1_240_050);
      expect(parseAmount(' 12 400.50 ')).toBe(1_240_050);
      expect(parseAmount('0.07')).toBe(7);
      expect(parseAmount('')).toBeNull();
    });
    it('refuses what is not an amount', () => {
      for (const bad of ['12.345', 'abc', '1.2.3', '-5', '12e3']) expect(parseAmount(bad)).toBe('invalid');
    });
    it('shows a stored amount back the way it would be typed', () => {
      expect(amountInput(1_240_000)).toBe('12400');
      expect(amountInput(1_240_050)).toBe('12400.50');
      expect(amountInput(null)).toBe('');
    });
  });
});
