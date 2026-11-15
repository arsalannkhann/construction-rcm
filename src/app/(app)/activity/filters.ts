/** Reads the Activity filters from a URL. Shared by the page and the CSV export so both select the same events. */
import { AUDIT_AREAS, type AuditFilter } from '@/server/services/audit-queries';
import type { ActivityValues } from './params';

export const PAGE_SIZE = 50;
const MAX_PAGE = 100_000;

type RawParams = Record<string, string | string[] | undefined>;

const one = (value: string | string[] | undefined): string => ((Array.isArray(value) ? value[0] : value) ?? '').trim();

/**
 * Midnight at the start of a YYYY-MM-DD day (plus `addDays`), in the server's
 * time zone, which is the zone the log's times are shown in. Null if the text
 * is not a real calendar date.
 */
function dayStart(day: string, addDays = 0): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (!m) return null;
  const [year, month, date] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (year < 1 || year > 9000) return null; // outside what the database accepts as a timestamp
  const d = new Date(2000, 0, 1);
  d.setFullYear(year, month - 1, date); // unlike the constructor, takes years below 100 literally
  if (d.getFullYear() !== year || d.getMonth() !== month - 1 || d.getDate() !== date) return null;
  if (addDays) d.setDate(d.getDate() + addDays);
  return d;
}

/** Anything unrecognised is dropped rather than guessed at, so the filter bar always shows exactly what is applied. */
export function readActivityParams(raw: RawParams): { values: ActivityValues; page: number } {
  const area = one(raw.area);
  const from = one(raw.from);
  const to = one(raw.to);
  const page = Math.trunc(Number(one(raw.page)));
  return {
    values: {
      q: one(raw.q).slice(0, 200),
      actor: one(raw.actor).slice(0, 100),
      area: AUDIT_AREAS.some(([known]) => known === area) ? area : '',
      from: dayStart(from) ? from : '',
      to: dayStart(to) ? to : '',
    },
    page: page >= 1 ? Math.min(page, MAX_PAGE) : 1,
  };
}

/** "From" and "To" are whole days, both included. */
export function toAuditFilter(values: ActivityValues): AuditFilter {
  return {
    q: values.q || null,
    actor: values.actor || null,
    area: values.area || null,
    from: dayStart(values.from),
    to: dayStart(values.to, 1),
  };
}
