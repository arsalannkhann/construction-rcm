/**
 * The Activity filters as they appear in the URL. Plain strings and no server
 * imports, so the client filter bar, the page and the export link all build
 * the same query.
 */
export type ActivityValues = { q: string; actor: string; area: string; from: string; to: string };

export const NO_FILTERS: ActivityValues = { q: '', actor: '', area: '', from: '', to: '' };

const KEYS = ['q', 'actor', 'area', 'from', 'to'] as const;

/** "?q=…&area=…" (or "" when nothing is set). Page 1 is the default and is left out. */
export function activityQuery(values: ActivityValues, page = 1): string {
  const params = new URLSearchParams();
  for (const key of KEYS) {
    const value = values[key].trim();
    if (value) params.set(key, value);
  }
  if (page > 1) params.set('page', String(page));
  const query = params.toString();
  return query ? `?${query}` : '';
}
