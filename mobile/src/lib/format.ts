/**
 * Display formatting only. Amounts arrive from the server in cents, already
 * computed by the reconciliation engine; nothing here adds, subtracts or
 * rounds a financial figure. Integer string work, so no floating point.
 */

export function money(cents: number | null | undefined): string {
  if (cents === null || cents === undefined || !Number.isFinite(cents)) return '—';
  const whole = Math.trunc(cents);
  const negative = whole < 0;
  const digits = String(Math.abs(whole)).padStart(3, '0');
  const dollars = digits.slice(0, -2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${negative ? '−' : ''}$${dollars}.${digits.slice(-2)}`;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** A calendar date ("2026-09-30") or a timestamp, as "Sep 30, 2026". Calendar dates are not shifted by time zone. */
export function date(value: string | null | undefined): string {
  if (!value) return '—';
  const plain = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (plain) return `${MONTHS[Number(plain[2]) - 1]} ${Number(plain[3])}, ${plain[1]}`;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '—';
  return `${MONTHS[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}`;
}

export function dateTime(value: string | null | undefined): string {
  if (!value) return '—';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '—';
  const h = d.getHours();
  return `${date(value)}, ${h % 12 || 12}:${String(d.getMinutes()).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
}

/** "just now", "5 min ago", "3 h ago", "2 d ago", then the date. */
export function ago(value: string | null | undefined, now: number = Date.now()): string {
  if (!value) return '';
  const t = new Date(value).getTime();
  if (Number.isNaN(t)) return '';
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  if (s < 7 * 86400) return `${Math.floor(s / 86400)} d ago`;
  return date(value);
}

export function bytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

export function initials(name: string | null | undefined): string {
  const parts = (name ?? '').trim().split(/\s+/).filter(Boolean);
  return ((parts[0]?.[0] ?? '') + (parts.length > 1 ? (parts[parts.length - 1]?.[0] ?? '') : '')).toUpperCase() || '·';
}
