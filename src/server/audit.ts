/**
 * Audit trail. Append-only and hash-chained per organisation: each event
 * commits to the previous event's hash, so any later edit or deletion of a row
 * is detectable by `verifyAuditChain`.
 */
import { asc, desc, eq, sql } from 'drizzle-orm';
import type { DB } from '@/db';
import { auditEvents } from '@/db/schema';
import type { Ctx } from './auth/permissions';
import { newId, sha256Hex } from './ids';

export type AuditActor = Ctx | { system: true; name?: string };

export type AuditInput = {
  orgId: string;
  actor: AuditActor;
  action: string;
  entityType: string;
  entityId?: string | null;
  payApplicationId?: string | null;
  summary: string;
  data?: Record<string, unknown>;
  at?: Date;
};

const GENESIS = 'genesis';

function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonical(obj[k])}`)
    .join(',')}}`;
}

type Hashable = {
  orgId: string;
  seq: number;
  actorType: string;
  actorId: string | null;
  actorName: string;
  action: string;
  entityType: string;
  entityId: string | null;
  payApplicationId: string | null;
  summary: string;
  data: Record<string, unknown> | null;
  createdAt: Date;
};

function hashEvent(prevHash: string, e: Hashable): string {
  return sha256Hex(
    `${prevHash}\n${canonical({
      orgId: e.orgId,
      seq: e.seq,
      actorType: e.actorType,
      actorId: e.actorId,
      actorName: e.actorName,
      action: e.action,
      entityType: e.entityType,
      entityId: e.entityId,
      payApplicationId: e.payApplicationId,
      summary: e.summary,
      data: e.data,
      createdAt: e.createdAt.toISOString(),
    })}`,
  );
}

export async function recordAudit(db: DB, input: AuditInput): Promise<void> {
  const isSystem = 'system' in input.actor;
  const actorType = isSystem ? 'system' : 'user';
  const actorId = isSystem ? null : (input.actor as Ctx).userId;
  const actorName = isSystem ? ((input.actor as { name?: string }).name ?? 'Construction RCM') : (input.actor as Ctx).userName;
  // Round-trip through JSON so what we hash is exactly what the database will hand back.
  const data = input.data ? (JSON.parse(JSON.stringify(input.data)) as Record<string, unknown>) : null;
  const createdAt = input.at ?? new Date();

  await db.transaction(async (tx) => {
    // Serialise writers per organisation so the chain never forks.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${'audit:' + input.orgId}))`);
    const [last] = await tx
      .select({ seq: auditEvents.seq, hash: auditEvents.hash })
      .from(auditEvents)
      .where(eq(auditEvents.orgId, input.orgId))
      .orderBy(desc(auditEvents.seq))
      .limit(1);
    const seq = (last?.seq ?? 0) + 1;
    const prevHash = last?.hash ?? GENESIS;
    const event: Hashable = {
      orgId: input.orgId,
      seq,
      actorType,
      actorId,
      actorName,
      action: input.action,
      entityType: input.entityType,
      entityId: input.entityId ?? null,
      payApplicationId: input.payApplicationId ?? null,
      summary: input.summary,
      data,
      createdAt,
    };
    await tx.insert(auditEvents).values({ id: newId('evt'), ...event, prevHash, hash: hashEvent(prevHash, event) });
  });
}

export type ChainStatus = { ok: true; events: number } | { ok: false; events: number; brokenAtSeq: number };

/** Recompute every hash for an organisation and confirm the chain is intact. */
export async function verifyAuditChain(db: DB, orgId: string): Promise<ChainStatus> {
  const rows = await db.select().from(auditEvents).where(eq(auditEvents.orgId, orgId)).orderBy(asc(auditEvents.seq));
  let prev = GENESIS;
  let expectedSeq = 1;
  for (const row of rows) {
    const ok =
      row.seq === expectedSeq &&
      row.prevHash === prev &&
      row.hash === hashEvent(prev, { ...row, data: row.data ?? null });
    if (!ok) return { ok: false, events: rows.length, brokenAtSeq: row.seq };
    prev = row.hash;
    expectedSeq += 1;
  }
  return { ok: true, events: rows.length };
}
