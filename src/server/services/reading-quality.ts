/**
 * What reviewers had to change after the reader, on decided applications.
 *
 * This is the one signal about reading quality that real packages produce on
 * their own during a pilot. It is not an accuracy rate: a misread value that no
 * reviewer noticed counts as read correctly here, and a reviewer who keyed a
 * figure the reader had left blank is counted separately from one who fixed a
 * figure it got wrong. Measured accuracy needs the double-keyed protocol in
 * docs/extraction-evaluation.md.
 *
 * Counts only, scoped to one organisation. No document content leaves here.
 */
import { and, eq, gte, inArray } from 'drizzle-orm';
import type { DB } from '@/db';
import { documents, lienWaivers, payAppLines, payApplications } from '@/db/schema';
import type { Ctx } from '@/server/auth/permissions';
import { CLAIMED_FIELDS, type ClaimedHeader, type HeaderCorrections } from '@/server/types';

export const READING_WINDOW_DAYS = 90;

/** Summary fields a reviewer can correct (src/server/services/review.ts, updateHeader). */
const SUMMARY_FIELDS = [...CLAIMED_FIELDS, 'applicationNumber', 'periodTo'] as const;

export type ReadingTally = {
  /** How the packages were read: "claude:<model>", "text-layer", or several joined by ", ". */
  reader: string;
  applications: number;
  /** Applications where a reviewer corrected or keyed at least one value the reader produced or missed. */
  withChanges: number;
  summary: { read: number; misread: number; missed: number };
  lines: { read: number; corrected: number; keyedByHand: number };
  waivers: { read: number; corrected: number; keyedByHand: number };
  documents: { total: number; notRead: number; backupReader: number };
};

type AppRow = Pick<typeof payApplications.$inferSelect, 'id' | 'engine' | 'claimed' | 'applicationNumber' | 'periodTo' | 'headerCorrections'>;
type LineRow = Pick<typeof payAppLines.$inferSelect, 'payApplicationId' | 'extracted' | 'editKind'>;
type WaiverRow = Pick<typeof lienWaivers.$inferSelect, 'payApplicationId' | 'extracted' | 'editedBy'>;
type DocRow = Pick<typeof documents.$inferSelect, 'payApplicationId' | 'status' | 'statusDetail'>;

const blank = (reader: string): ReadingTally => ({
  reader,
  applications: 0,
  withChanges: 0,
  summary: { read: 0, misread: 0, missed: 0 },
  lines: { read: 0, corrected: 0, keyedByHand: 0 },
  waivers: { read: 0, corrected: 0, keyedByHand: 0 },
  documents: { total: 0, notRead: 0, backupReader: 0 },
});

/** Pure: the tallies for the given rows, one per reader, most applications first. */
export function tallyReading(apps: AppRow[], lines: LineRow[], waivers: WaiverRow[], docs: DocRow[]): ReadingTally[] {
  const byReader = new Map<string, ReadingTally>();
  const byApp = <T extends { payApplicationId: string | null }>(rows: T[]) => {
    const m = new Map<string, T[]>();
    for (const r of rows) if (r.payApplicationId) m.set(r.payApplicationId, [...(m.get(r.payApplicationId) ?? []), r]);
    return m;
  };
  const linesOf = byApp(lines);
  const waiversOf = byApp(waivers);
  const docsOf = byApp(docs);

  for (const app of apps) {
    const reader = app.engine ?? 'not read';
    const t = byReader.get(reader) ?? blank(reader);
    byReader.set(reader, t);
    t.applications++;
    let changed = false;

    const corrections: HeaderCorrections = app.headerCorrections ?? {};
    const current: Record<string, unknown> = { ...(app.claimed as ClaimedHeader), applicationNumber: app.applicationNumber, periodTo: app.periodTo };
    for (const field of SUMMARY_FIELDS) {
      const c = corrections[field];
      // What the reader produced: the "from" of a correction, else the value as it stands.
      const asRead = c ? c.from : (current[field] ?? null);
      if (asRead !== null && asRead !== undefined) t.summary.read++;
      if (c && c.from !== c.to) {
        changed = true;
        if (c.from === null) t.summary.missed++;
        else t.summary.misread++;
      }
    }

    for (const l of linesOf.get(app.id) ?? []) {
      if (!l.extracted) {
        t.lines.keyedByHand++;
        changed = true;
        continue;
      }
      t.lines.read++;
      // An adjustment is the reviewer's decision about the amount to approve, not a reading error.
      if (l.editKind === 'correction') {
        t.lines.corrected++;
        changed = true;
      }
    }
    for (const w of waiversOf.get(app.id) ?? []) {
      if (!w.extracted) {
        t.waivers.keyedByHand++;
        changed = true;
        continue;
      }
      t.waivers.read++;
      if (w.editedBy) {
        t.waivers.corrected++;
        changed = true;
      }
    }
    for (const d of docsOf.get(app.id) ?? []) {
      t.documents.total++;
      if (d.status === 'failed' || d.status === 'unreadable') t.documents.notRead++;
      else if (d.status === 'processed' && d.statusDetail) t.documents.backupReader++;
    }
    if (changed) t.withChanges++;
  }
  return [...byReader.values()].sort((a, b) => b.applications - a.applications || a.reader.localeCompare(b.reader));
}

/** Tallies for this organisation's applications approved or rejected in the last READING_WINDOW_DAYS days. */
export async function readingQuality(db: DB, ctx: Ctx, now = new Date()): Promise<ReadingTally[]> {
  const since = new Date(now.getTime() - READING_WINDOW_DAYS * 24 * 60 * 60 * 1000);
  const apps = await db
    .select({
      id: payApplications.id,
      engine: payApplications.engine,
      claimed: payApplications.claimed,
      applicationNumber: payApplications.applicationNumber,
      periodTo: payApplications.periodTo,
      headerCorrections: payApplications.headerCorrections,
    })
    .from(payApplications)
    .where(and(eq(payApplications.orgId, ctx.orgId), inArray(payApplications.status, ['approved', 'rejected']), gte(payApplications.decidedAt, since)));
  if (apps.length === 0) return [];
  const ids = apps.map((a) => a.id);
  const [lines, waivers, docs] = await Promise.all([
    db
      .select({ payApplicationId: payAppLines.payApplicationId, extracted: payAppLines.extracted, editKind: payAppLines.editKind })
      .from(payAppLines)
      .where(and(eq(payAppLines.orgId, ctx.orgId), inArray(payAppLines.payApplicationId, ids))),
    db
      .select({ payApplicationId: lienWaivers.payApplicationId, extracted: lienWaivers.extracted, editedBy: lienWaivers.editedBy })
      .from(lienWaivers)
      .where(and(eq(lienWaivers.orgId, ctx.orgId), inArray(lienWaivers.payApplicationId, ids))),
    db
      .select({ payApplicationId: documents.payApplicationId, status: documents.status, statusDetail: documents.statusDetail })
      .from(documents)
      .where(and(eq(documents.orgId, ctx.orgId), inArray(documents.payApplicationId, ids))),
  ]);
  return tallyReading(apps, lines, waivers, docs);
}

/** A reader label a finance team can read. */
export function readerLabel(reader: string): string {
  return reader
    .split(', ')
    .map((r) => (r.startsWith('claude:') ? `AI reader (${r.slice('claude:'.length)})` : r === 'claude' ? 'AI reader' : r === 'text-layer' ? 'Text reader' : r))
    .join(' + ');
}
