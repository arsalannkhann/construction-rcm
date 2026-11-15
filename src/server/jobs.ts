/**
 * Durable in-process work queue for document processing.
 *
 * Jobs are rows, so nothing is lost on restart: `startJobRunner` (called once
 * at server boot) picks up anything left queued or abandoned mid-run. One job
 * runs at a time, which is all the embedded database supports and is plenty
 * for a single-node deployment. A separate worker process can run the same
 * `drain()` against PostgreSQL when volume calls for it.
 */
import { and, asc, eq, lt, or } from 'drizzle-orm';
import { getDb, type DB } from '@/db';
import { jobs } from '@/db/schema';
import { isInMemory } from './config';
import { newId } from './ids';

type Handler = (db: DB, orgId: string, payload: Record<string, unknown>) => Promise<void>;
const g = globalThis as unknown as { __rcmHandlers?: Map<string, Handler>; __rcmDraining?: Promise<void> };
const handlers = (g.__rcmHandlers ??= new Map());

const MAX_ATTEMPTS = 3;
const STALE_MS = 15 * 60 * 1000;

export function registerJobHandler(type: string, handler: Handler): void {
  handlers.set(type, handler);
}

export async function enqueueJob(db: DB, orgId: string, type: string, payload: Record<string, unknown>): Promise<string> {
  const id = newId('job');
  await db.insert(jobs).values({ id, orgId, type, payload });
  // Tests drive processing explicitly so they stay deterministic.
  if (!isInMemory()) kick();
  return id;
}

/** Start draining in the background if not already doing so. */
export function kick(): void {
  if (g.__rcmDraining) return;
  g.__rcmDraining = (async () => {
    try {
      await drain(await getDb());
    } catch (err) {
      console.error('[jobs] runner stopped with an error:', err);
    } finally {
      g.__rcmDraining = undefined;
    }
  })();
}

/** Run queued jobs until none are left. */
export async function drain(db: DB): Promise<number> {
  let ran = 0;
  for (;;) {
    const staleBefore = new Date(Date.now() - STALE_MS);
    const [job] = await db
      .select()
      .from(jobs)
      .where(or(eq(jobs.status, 'queued'), and(eq(jobs.status, 'running'), lt(jobs.startedAt, staleBefore))))
      .orderBy(asc(jobs.createdAt))
      .limit(1);
    if (!job) return ran;
    const handler = handlers.get(job.type);
    const attempts = job.attempts + 1;
    await db.update(jobs).set({ status: 'running', attempts, startedAt: new Date() }).where(eq(jobs.id, job.id));
    try {
      if (!handler) throw new Error(`No handler registered for job type "${job.type}"`);
      await handler(db, job.orgId, job.payload);
      await db.update(jobs).set({ status: 'succeeded', finishedAt: new Date(), error: null }).where(eq(jobs.id, job.id));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[jobs] ${job.type} ${job.id} failed (attempt ${attempts}/${MAX_ATTEMPTS}):`, err);
      await db
        .update(jobs)
        .set({ status: attempts >= MAX_ATTEMPTS ? 'failed' : 'queued', error: message, finishedAt: attempts >= MAX_ATTEMPTS ? new Date() : null })
        .where(eq(jobs.id, job.id));
    }
    ran++;
  }
}
