/**
 * Money helpers. All amounts are integer cents; nothing in the system does
 * arithmetic on floating-point dollars.
 */

/** Parse a human-entered or document-printed amount into cents. Returns null if it is not a clean amount. */
export function parseMoney(input: string | number | null | undefined): number | null {
  if (input === null || input === undefined) return null;
  if (typeof input === 'number') {
    if (!Number.isFinite(input)) return null;
    return Math.round(input * 100);
  }
  let s = input.trim();
  if (!s) return null;
  let negative = false;
  // Accounting negatives: (1,234.56) or 1,234.56- or -1,234.56 or 1,234.56 CR
  if (/^\(.*\)$/.test(s)) {
    negative = true;
    s = s.slice(1, -1);
  }
  if (/\bCR$/i.test(s)) {
    negative = true;
    s = s.replace(/\s*CR$/i, '');
  }
  s = s.replace(/[$\s]/g, '');
  if (s.endsWith('-')) {
    negative = true;
    s = s.slice(0, -1);
  }
  if (s.startsWith('-')) {
    negative = !negative;
    s = s.slice(1);
  } else if (s.startsWith('+')) {
    s = s.slice(1);
  }
  if (!/^(\d{1,3}(,\d{3})+|\d+)(\.\d{1,2})?$|^\.\d{1,2}$/.test(s)) return null;
  const [whole, frac = ''] = s.replace(/,/g, '').split('.');
  const cents = Number(whole || '0') * 100 + Number((frac + '00').slice(0, 2));
  if (!Number.isSafeInteger(cents)) return null;
  return negative ? -cents : cents;
}

/** $1,234.56 — negatives in accounting parentheses. */
export function formatMoney(cents: number | null | undefined, opts: { symbol?: boolean; blank?: string } = {}): string {
  if (cents === null || cents === undefined) return opts.blank ?? '—';
  const symbol = opts.symbol === false ? '' : '$';
  const abs = Math.abs(cents);
  const whole = Math.floor(abs / 100).toLocaleString('en-US');
  const frac = String(abs % 100).padStart(2, '0');
  const body = `${symbol}${whole}.${frac}`;
  return cents < 0 ? `(${body})` : body;
}

/** $1.2M / $340K — for dashboard tiles only, never for records. */
export function formatMoneyCompact(cents: number | null | undefined): string {
  if (cents === null || cents === undefined) return '—';
  const dollars = cents / 100;
  const abs = Math.abs(dollars);
  const sign = dollars < 0 ? '-' : '';
  if (abs >= 1_000_000) return `${sign}$${(abs / 1_000_000).toFixed(abs >= 10_000_000 ? 1 : 2)}M`;
  if (abs >= 10_000) return `${sign}$${(abs / 1_000).toFixed(abs >= 100_000 ? 0 : 1)}K`;
  return `${sign}$${Math.round(abs).toLocaleString('en-US')}`;
}

/** Signed difference for variance columns: +$10.00 / −$10.00. */
export function formatDelta(cents: number | null | undefined): string {
  if (cents === null || cents === undefined) return '—';
  if (cents === 0) return '$0.00';
  const body = formatMoney(Math.abs(cents));
  return cents > 0 ? `+${body}` : `−${body}`;
}

/** Plain decimal string for CSV/JSON exports: 1234.56 */
export function centsToDecimalString(cents: number): string {
  const abs = Math.abs(cents);
  return `${cents < 0 ? '-' : ''}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}

/** amount × rate, rounded half away from zero to the cent. Rate is in basis points. */
export function applyBps(cents: number, bps: number): number {
  const product = cents * bps;
  const sign = product < 0 ? -1 : 1;
  return sign * Math.floor((Math.abs(product) + 5000) / 10000);
}

export function sum(values: Array<number | null | undefined>): number {
  let total = 0;
  for (const v of values) total += v ?? 0;
  return total;
}

/** 1050 → "10.5%" */
export function formatBps(bps: number): string {
  const pct = bps / 100;
  return `${Number.isInteger(pct) ? pct : pct.toFixed(2).replace(/0+$/, '').replace(/\.$/, '')}%`;
}

/** "10" or "10.5" → 1000 / 1050. Returns null for anything outside 0–100%. */
export function parsePercentToBps(input: string): number | null {
  const s = input.trim().replace(/%$/, '').trim();
  if (!/^\d{1,3}(\.\d{1,2})?$/.test(s)) return null;
  const bps = Math.round(Number(s) * 100);
  return bps >= 0 && bps <= 10000 ? bps : null;
}

/** Percent complete as a number with one decimal, or null when the base is zero. */
export function percentOf(part: number, whole: number): number | null {
  if (!whole) return null;
  return Math.round((part / whole) * 1000) / 10;
}
