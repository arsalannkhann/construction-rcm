/**
 * Read models for the audit log. Everything here is scoped to ctx.orgId;
 * nothing returns an event from another organisation.
 */
import { and, asc, desc, eq, gt, gte, ilike, lt, sql, type SQL } from 'drizzle-orm';
import type { DB } from '@/db';
import { auditEvents } from '@/db/schema';
import type { Ctx } from '@/server/auth/permissions';

/** The part of an action before the dot ("application.approved" → application), with the name shown in the filter. */
export const AUDIT_AREAS: ReadonlyArray<readonly [area: string, label: string]> = [
  ['application', 'Pay applications'],
  ['finding', 'Findings'],
  ['line', 'Line items'],
  ['waiver', 'Lien waivers'],
  ['contract', 'Contracts'],
  ['change_order', 'Change orders'],
  ['project', 'Projects'],
  ['subcontractor', 'Subcontractors'],
  ['team', 'Team'],
  ['policy', 'Review policy'],
  ['organization', 'Organisation'],
  ['message', 'Messages'],
  ['comment', 'Comments'],
  ['transfer', 'Transfers'],
  ['billing', 'Billing periods'],
  ['integration', 'Integrations'],
];

/** Value of `AuditFilter.actor` that selects events recorded by the product itself. */
export const SYSTEM_ACTOR = 'system';

export type AuditFilter = {
  /** Free text, matched anywhere in the summary. */
  q?: string | null;
  /** A user id, or SYSTEM_ACTOR. */
  actor?: string | null;
  /** One of AUDIT_AREAS. */
  area?: string | null;
  /** Inclusive. */
  from?: Date | null;
  /** Exclusive. */
  to?: Date | null;
};

const columns = {
  id: auditEvents.id,
  seq: auditEvents.seq,
  createdAt: auditEvents.createdAt,
  actorType: auditEvents.actorType,
  actorId: auditEvents.actorId,
  actorName: auditEvents.actorName,
  action: auditEvents.action,
  summary: auditEvents.summary,
  payApplicationId: auditEvents.payApplicationId,
  hash: auditEvents.hash,
};

export type AuditEventRow = {
  id: string;
  seq: number;
  createdAt: Date;
  actorType: string;
  actorId: string | null;
  actorName: string;
  action: string;
  summary: string;
  payApplicationId: string | null;
  hash: string;
};

function conditions(ctx: Ctx, filter: AuditFilter): SQL[] {
  // The organisation comes from the session, never from the filter.
  const where: SQL[] = [eq(auditEvents.orgId, ctx.orgId)];
  const q = filter.q?.trim();
  if (q) where.push(ilike(auditEvents.summary, `%${q.replace(/[\\%_]/g, '\\$&')}%`));
  if (filter.actor === SYSTEM_ACTOR) where.push(eq(auditEvents.actorType, 'system'));
  else if (filter.actor) where.push(eq(auditEvents.actorType, 'user'), eq(auditEvents.actorId, filter.actor));
  if (filter.area) where.push(sql`split_part(${auditEvents.action}, '.', 1) = ${filter.area}`);
  if (filter.from) where.push(gte(auditEvents.createdAt, filter.from));
  if (filter.to) where.push(lt(auditEvents.createdAt, filter.to));
  return where;
}

/** One page of the log, newest first, with the number of events the filter matches in total. */
export async function listAuditEvents(
  db: DB,
  ctx: Ctx,
  filter: AuditFilter = {},
  page: { limit?: number; offset?: number } = {},
): Promise<{ events: AuditEventRow[]; total: number }> {
  const where = and(...conditions(ctx, filter));
  const limit = Math.min(Math.max(Math.trunc(page.limit ?? 50) || 50, 1), 500);
  const offset = Math.max(Math.trunc(page.offset ?? 0) || 0, 0);
  const [count] = await db.select({ n: sql<number>`count(*)::int` }).from(auditEvents).where(where);
  const events = await db.select(columns).from(auditEvents).where(where).orderBy(desc(auditEvents.seq)).limit(limit).offset(offset);
  return { events, total: count?.n ?? 0 };
}

/**
 * The filtered log in the order it was written (oldest first), in batches, so
 * an export can be streamed without holding the whole log in memory.
 */
export async function* auditEventBatches(db: DB, ctx: Ctx, filter: AuditFilter = {}, batchSize = 500): AsyncGenerator<AuditEventRow[]> {
  const where = conditions(ctx, filter);
  let after = 0;
  for (;;) {
    const rows = await db
      .select(columns)
      .from(auditEvents)
      .where(and(...where, gt(auditEvents.seq, after)))
      .orderBy(asc(auditEvents.seq))
      .limit(batchSize);
    if (rows.length === 0) return;
    yield rows;
    if (rows.length < batchSize) return;
    after = rows[rows.length - 1]!.seq;
  }
}

/** Everyone who appears in this organisation's log, for the "who" filter. People first, by name; the system last. */
export async function listAuditActors(db: DB, ctx: Ctx): Promise<Array<{ id: string; name: string }>> {
  const rows = await db
    .select({
      type: auditEvents.actorType,
      id: auditEvents.actorId,
      // The name as most recently recorded, which is what the rows themselves show.
      name: sql<string>`(array_agg(${auditEvents.actorName} order by ${auditEvents.seq} desc))[1]`,
    })
    .from(auditEvents)
    .where(eq(auditEvents.orgId, ctx.orgId))
    .groupBy(auditEvents.actorType, auditEvents.actorId);
  const people = rows
    .filter((r): r is { type: string; id: string; name: string } => r.type === 'user' && !!r.id)
    .map((r) => ({ id: r.id, name: r.name }))
    .sort((a, b) => a.name.localeCompare(b.name));
  return rows.some((r) => r.type === 'system') ? [...people, { id: SYSTEM_ACTOR, name: 'System' }] : people;
}

// ── CSV export ──────────────────────────────────────────────────────────────

export const AUDIT_CSV_HEADER = 'seq,time,actor,actor_type,action,summary,application_id,hash\r\n';

function csvCell(value: string, freeText = false): string {
  // Free text can start with a character a spreadsheet would run as a formula; neutralise it.
  const safe = freeText && /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

export function auditCsvRow(e: AuditEventRow): string {
  return (
    [
      String(e.seq),
      e.createdAt.toISOString(),
      csvCell(e.actorName, true),
      csvCell(e.actorType),
      csvCell(e.action),
      csvCell(e.summary, true),
      csvCell(e.payApplicationId ?? ''),
      csvCell(e.hash),
    ].join(',') + '\r\n'
  );
}
