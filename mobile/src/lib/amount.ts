/**
 * The amount a person types when sending a receipt, read into integer cents
 * with string work only (no floating point), like the rest of the app's money
 * handling. "12,400", "$12400.5" and "12 400.50" all read as 1,240,050 cents.
 *
 * Pure, so it is tested without a phone (tests/mobile-uploads.test.ts).
 */

/** null for an empty box, 'invalid' for anything that is not an amount. */
export function parseAmount(text: string): number | null | 'invalid' {
  const t = text.replace(/[\s$,]/g, '');
  if (t === '') return null;
  const m = /^(\d{1,9})(?:\.(\d{0,2}))?$/.exec(t);
  if (!m) return 'invalid';
  const cents = (m[2] ?? '').padEnd(2, '0');
  return Number(m[1]) * 100 + Number(cents);
}

/** Cents as the person would type them back: "12400.50", or "12400" for whole dollars. */
export function amountInput(cents: number | null): string {
  if (cents === null) return '';
  const whole = Math.trunc(cents / 100);
  const rest = cents % 100;
  return rest === 0 ? String(whole) : `${whole}.${String(rest).padStart(2, '0')}`;
}
