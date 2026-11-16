import { describe, expect, it } from 'vitest';
import { ago, date, money, plural } from '../mobile/src/lib/format';

/**
 * The phone shows amounts the server computed. These helpers only format
 * them: integer cents in, text out, with no floating point on the way.
 */
describe('mobile display formatting', () => {
  it('formats integer cents without floating point', () => {
    expect(money(0)).toBe('$0.00');
    expect(money(5)).toBe('$0.05');
    expect(money(123456)).toBe('$1,234.56');
    expect(money(-123456)).toBe('−$1,234.56');
    expect(money(100_000_000_000)).toBe('$1,000,000,000.00');
    // 0.1 + 0.2 style drift cannot creep in: the digits come from the integer.
    expect(money(30)).toBe('$0.30');
  });

  it('shows a dash rather than a number when there is no amount', () => {
    expect(money(null)).toBe('—');
    expect(money(undefined)).toBe('—');
    expect(money(Number.NaN)).toBe('—');
  });

  it('never rounds a fractional input up', () => {
    // Cents are always integers from the API; if one were not, the phone must not invent a cent.
    expect(money(1299.99)).toBe('$12.99');
  });

  it('keeps calendar dates on their day in every time zone', () => {
    expect(date('2026-09-30')).toBe('Sep 30, 2026');
    expect(date('2026-01-01')).toBe('Jan 1, 2026');
    expect(date(null)).toBe('—');
    expect(date('not a date')).toBe('—');
  });

  it('describes recent times relatively, then by date', () => {
    const now = Date.parse('2026-11-16T12:00:00Z');
    expect(ago('2026-11-16T11:59:30Z', now)).toBe('just now');
    expect(ago('2026-11-16T11:55:00Z', now)).toBe('5 min ago');
    expect(ago('2026-11-16T09:00:00Z', now)).toBe('3 h ago');
    expect(ago('2026-11-14T12:00:00Z', now)).toBe('2 d ago');
    expect(ago('2026-10-01', now)).toBe('Oct 1, 2026');
  });

  it('pluralises counts', () => {
    expect(plural(1, 'file')).toBe('1 file');
    expect(plural(3, 'file')).toBe('3 files');
  });
});
