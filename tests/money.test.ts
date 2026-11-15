import { describe, expect, it } from 'vitest';
import { applyBps, centsToDecimalString, formatDelta, formatMoney, parseMoney, parsePercentToBps } from '@/lib/money';
import { parseLooseDate } from '@/lib/utils';

describe('parseMoney', () => {
  it.each([
    ['1,234.56', 123456],
    ['$1,234.56', 123456],
    ['$ 1,234.56', 123456],
    ['1234.5', 123450],
    ['1234', 123400],
    ['0.00', 0],
    ['(1,234.56)', -123456],
    ['-1,234.56', -123456],
    ['1,234.56-', -123456],
    ['$(500.00)', null], // ambiguous ordering is rejected rather than guessed
    ['12,34.56', null],
    ['1.234', null],
    ['abc', null],
    ['', null],
    ['10%', null],
  ])('%s → %s', (input, expected) => {
    expect(parseMoney(input)).toBe(expected);
  });

  it('does not lose cents on large values', () => {
    expect(parseMoney('249,999,999.99')).toBe(24999999999);
  });
});

describe('formatting', () => {
  it('formats with accounting negatives', () => {
    expect(formatMoney(123456)).toBe('$1,234.56');
    expect(formatMoney(-123456)).toBe('($1,234.56)');
    expect(formatMoney(5)).toBe('$0.05');
    expect(formatMoney(null)).toBe('—');
    expect(formatDelta(-1000)).toBe('−$10.00');
    expect(centsToDecimalString(-105)).toBe('-1.05');
  });
});

describe('applyBps', () => {
  it('rounds half away from zero to the cent', () => {
    expect(applyBps(100000, 1000)).toBe(10000); // 10% of $1,000.00
    expect(applyBps(12345, 1000)).toBe(1235); // $123.45 × 10% = $12.345 → $12.35
    expect(applyBps(12344, 1000)).toBe(1234);
    expect(applyBps(-12345, 1000)).toBe(-1235);
    expect(applyBps(33333, 750)).toBe(2500); // 7.5%
    expect(applyBps(0, 1000)).toBe(0);
  });
});

describe('parsePercentToBps', () => {
  it('parses percentages', () => {
    expect(parsePercentToBps('10')).toBe(1000);
    expect(parsePercentToBps('7.5%')).toBe(750);
    expect(parsePercentToBps('0')).toBe(0);
    expect(parsePercentToBps('101')).toBeNull();
    expect(parsePercentToBps('ten')).toBeNull();
  });
});

describe('parseLooseDate', () => {
  it.each([
    ['2026-10-31', '2026-10-31'],
    ['10/31/2026', '2026-10-31'],
    ['10/31/26', '2026-10-31'],
    ['October 31, 2026', '2026-10-31'],
    ['Oct 31 2026', '2026-10-31'],
    ['31 October 2026', '2026-10-31'],
    ['02/30/2026', null],
    ['not a date', null],
  ])('%s → %s', (input, expected) => {
    expect(parseLooseDate(input)).toBe(expected);
  });
});
