/** Wording for retainage terms. Safe to import anywhere. */
import { formatBps } from '@/lib/money';
import type { RetainageTerms } from '@/server/types';

/** "10%" or "10% until 50% complete, then 5% on further work". */
export function describeRetainageTerms(workBps: number, terms: RetainageTerms | null | undefined): string {
  const r = terms?.reduction;
  if (!r) return formatBps(workBps);
  const tail = r.appliesTo === 'future_work' ? (r.toBps === 0 ? 'then none on further work' : `then ${formatBps(r.toBps)} on further work`) : `then ${formatBps(r.toBps)} on all work`;
  return `${formatBps(workBps)} until ${formatBps(r.atPercentBps)} complete, ${tail}`;
}
