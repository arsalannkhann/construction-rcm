/**
 * Durable work queue for document processing.
 *
 * Jobs are rows, so queued work survives a restart. The runner inside the
 * server process claims one job at a time; the claim is a single statement
 * with `FOR UPDATE SKIP LOCKED`, so several app instances (or a separate
 * worker process) sharing one PostgreSQL database never run the same job
 * twice at once.
 *
 * What happens when things go wrong:
 *   - The process dies mid-job. A running job holds a lease that the runner
 *     renews every 30 seconds. Once the lease is two minutes stale, any
 *     runner picks the job up again.
 *   - The job throws. It is retried with a delay, up to three attempts. Then
 *     it is marked failed, the handler's `onExhausted` is told (it notifies
 *     people), and the job shows up in the system status screen where it can
 *     be retried by hand.
 *   - Nobody kicked the runner (the enqueueing transaction committed on
 *     another instance, or a retry delay elapsed). The runner also polls.
 *
 * On serverless hosting (`jobRunnerMode() === 'request'`, the default on
 * Vercel) there is no process to poll from: nothing runs between requests.
 * There the work runs right after the response of the request that queued it,
 * kept alive with Next.js `after()`, and stops taking new jobs after
 * REQUEST_BUDGET_MS so the platform's time limit never cuts one off half-way.
 * Whatever is left, a retry whose delay has passed, or a job abandoned when an
 * instance was stopped, is picked up by the next request that looks: a page
 * view (`kickIfIdle`), the processing screen's status check, or the scheduled
 * call to /api/jobs/run.
 */
import os from 'node:os';
import { and, asc, eq, gte, isNull, lt, lte, or, sql } from 'drizzle-orm';
import { after } from 'next/server';
import { getDb, type DB } from '@/db';
import { jobs } from '@/db/schema';
import { afterCommit, outsideTransaction } from '@/db/tx';
import { isInMemory, jobRunnerMode, type JobRunnerMode } from './config';
import { newId, randomToken } from './ids';

type Run = (db: DB, orgId: string, payload: Record<string, unknown>) => Promise<void>;
type Exhausted = (db: DB, orgId: string, payload: Record<string, unknown>, error: string) => Promise<void>;
type Handler = { run: Run; onExhausted?: Exhausted };

const g = globalThis as unknown as {
  __rcmHandlers?: Map<string, Handler>;
  __rcmDraining?: Promise<void>;
  __rcmKickAgain?: boolean;
  __rcmPoller?: NodeJS.Timeout;
  __rcmWorkerId?: string;
  __rcmRunnerActivity?: number;
};
const handlers = (g.__rcmHandlers ??= new Map());
const workerId = (g.__rcmWorkerId ??= `${os.hostname()}:${process.pid}:${randomToken(4)}`);

export const MAX_ATTEMPTS = 3;
/** A running job whose lease is older than this was abandoned. */
export const LEASE_MS = 2 * 60 * 1000;
const HEARTBEAT_MS = 30 * 1000;
const POLL_MS = 5 * 1000;
/**
 * In request mode, stop taking new jobs this long after starting. The functions
 * that run the queue may live 300 seconds (`maxDuration`); a job taken just
 * before the budget runs out still has 150 seconds to finish.
 */
export const REQUEST_BUDGET_MS = 150 * 1000;
/** In request mode, a page view looks at the queue at most this often per instance. */
const IDLE_KICK_MS = 15 * 1000;
const KEEP_SUCCEEDED_MS = 7 * 24 * 60 * 60 * 1000;
/** Failed jobs stay visible on the system status screen for a month; the audit trail keeps the record for good. */
const KEEP_FAILED_MS = 30 * 24 * 60 * 60 * 1000;

/** Delay before retry number `attempt + 1`. */
function backoffMs(attempt: number): number {
  return isInMemory() ? 0 : Math.min(15_000 * 4 ** (attempt - 1), 5 * 60_000);
}

export function registerJobHandler(type: string, run: Run, opts: { onExhausted?: Exhausted } = {}): void {
  handlers.set(type, { run, onExhausted: opts.onExhausted });
}

export async function enqueueJob(db: DB, orgId: string, type: string, payload: Record<string, unknown>): Promise<string> {
  const id = newId('job');
  await db.insert(jobs).values({ id, orgId, type, payload });
  // Wake the runner only once the row is visible to it. Tests drive processing explicitly.
  if (!isInMemory()) afterCommit(kick);
  return id;
}

/**
 * Keep a serverless function alive until `work` settles, although the response
 * has already gone. Outside a request (the poller, a script) there is nothing
 * to extend and `after()` refuses; the work simply runs.
 */
function keepAlive(work: Promise<unknown>): void {
  try {
    after(work);
  } catch {
    /* not inside a request */
  }
}

/** Start draining in the background if not already doing so. */
export function kick(): void {
  if (g.__rcmDraining) {
    g.__rcmKickAgain = true;
    return;
  }
  const deadline = jobRunnerMode() === 'request' ? Date.now() + REQUEST_BUDGET_MS : undefined;
  // The runner must not inherit a caller's transaction.
  outsideTransaction(() => {
    g.__rcmDraining = (async () => {
      try {
        do {
          g.__rcmKickAgain = false;
          await drain(await getDb(), { deadline });
        } while (g.__rcmKickAgain && (deadline === undefined || Date.now() < deadline));
      } catch (err) {
        console.error('[jobs] runner stopped with an error (it will start again on the next poll):', err);
      } finally {
        g.__rcmDraining = undefined;
      }
    })();
    keepAlive(g.__rcmDraining);
  });
}

/**
 * Request mode only: look at the queue if this instance has not done so in the
 * last few seconds. Called on every signed-in page view, so queued work (a
 * retry whose delay has passed, a job an instance abandoned) moves whenever
 * anyone is using the app. The look happens after the response is sent.
 */
export function kickIfIdle(): void {
  if (isInMemory() || jobRunnerMode() !== 'request' || g.__rcmDraining) return;
  if (Date.now() - (g.__rcmRunnerActivity ?? 0) < IDLE_KICK_MS) return;
  g.__rcmRunnerActivity = Date.now();
  kick();
}

/** Called once at server start: resume anything queued or abandoned, then keep polling. Not used in request mode. */
export function startJobRunner(): void {
  kick();
  if (g.__rcmPoller) return;
  g.__rcmPoller = setInterval(kick, POLL_MS);
  g.__rcmPoller.unref();
}

type Job = typeof jobs.$inferSelect;

async function giveUpOnAbandoned(db: DB): Promise<void> {
  const stale = new Date(Date.now() - LEASE_MS);
  const dead = await db
    .update(jobs)
    .set({ status: 'failed', finishedAt: new Date(), error: `Stopped responding during attempt ${MAX_ATTEMPTS} of ${MAX_ATTEMPTS} (the server was probably restarted mid-run).` })
    .where(and(eq(jobs.status, 'running'), lt(jobs.startedAt, stale), gte(jobs.attempts, MAX_ATTEMPTS)))
    .returning();
  for (const job of dead) await exhausted(db, job, job.error ?? 'Abandoned');
}

/** Atomically take the oldest runnable job, or return null. */
async function claim(db: DB): Promise<Job | null> {
  const now = new Date();
  const stale = new Date(now.getTime() - LEASE_MS);
  const next = db
    .select({ id: jobs.id })
    .from(jobs)
    .where(
      or(
        and(eq(jobs.status, 'queued'), or(isNull(jobs.runAfter), lte(jobs.runAfter, now))),
        and(eq(jobs.status, 'running'), lt(jobs.startedAt, stale), lt(jobs.attempts, MAX_ATTEMPTS)),
      ),
    )
    .orderBy(asc(jobs.createdAt))
    .limit(1)
    .for('update', { skipLocked: true });
  const [job] = await db
    .update(jobs)
    .set({ status: 'running', attempts: sql`${jobs.attempts} + 1`, startedAt: now, lockedBy: workerId, runAfter: null, finishedAt: null })
    .where(eq(jobs.id, sql`(${next})`))
    .returning();
  return job ?? null;
}

async function exhausted(db: DB, job: Job, error: string): Promise<void> {
  try {
    await handlers.get(job.type)?.onExhausted?.(db, job.orgId, job.payload, error);
  } catch (err) {
    console.error(`[jobs] could not report the failure of ${job.type} ${job.id}:`, err);
  }
}

/**
 * Run queued jobs until none are runnable, or until `deadline` (epoch ms) has
 * passed: then no new job is taken and the rest wait for the next drain.
 * Returns how many ran.
 */
export async function drain(db: DB, opts: { deadline?: number } = {}): Promise<number> {
  g.__rcmRunnerActivity = Date.now();
  let ran = 0;
  await giveUpOnAbandoned(db);
  for (;;) {
    if (opts.deadline !== undefined && Date.now() >= opts.deadline) break;
    const job = await claim(db);
    if (!job) break;
    const handler = handlers.get(job.type);
    const heartbeat = setInterval(() => {
      db.update(jobs)
        .set({ startedAt: new Date() })
        .where(and(eq(jobs.id, job.id), eq(jobs.status, 'running'), eq(jobs.lockedBy, workerId)))
        .catch((err) => console.error(`[jobs] could not renew the lease on ${job.id}:`, err));
    }, HEARTBEAT_MS);
    heartbeat.unref();
    try {
      if (!handler) throw new Error(`No handler registered for job type "${job.type}"`);
      await handler.run(db, job.orgId, job.payload);
      await db.update(jobs).set({ status: 'succeeded', finishedAt: new Date(), error: null }).where(eq(jobs.id, job.id));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const final = job.attempts >= MAX_ATTEMPTS;
      console.error(`[jobs] ${job.type} ${job.id} failed (attempt ${job.attempts}/${MAX_ATTEMPTS}):`, err);
      await db
        .update(jobs)
        .set(final ? { status: 'failed', error: message, finishedAt: new Date() } : { status: 'queued', error: message, runAfter: new Date(Date.now() + backoffMs(job.attempts)) })
        .where(eq(jobs.id, job.id));
      if (final) await exhausted(db, job, message);
    } finally {
      clearInterval(heartbeat);
    }
    ran++;
  }
  if (ran > 0) {
    await db
      .delete(jobs)
      .where(
        or(
          and(eq(jobs.status, 'succeeded'), lt(jobs.finishedAt, new Date(Date.now() - KEEP_SUCCEEDED_MS))),
          and(eq(jobs.status, 'failed'), lt(jobs.finishedAt, new Date(Date.now() - KEEP_FAILED_MS))),
        ),
      );
  }
  g.__rcmRunnerActivity = Date.now();
  return ran;
}

/** Put a failed job back on the queue with a fresh set of attempts. */
export async function requeueJob(db: DB, orgId: string, jobId: string): Promise<boolean> {
  const [job] = await db
    .update(jobs)
    .set({ status: 'queued', attempts: 0, error: null, runAfter: null, startedAt: null, finishedAt: null, lockedBy: null })
    .where(and(eq(jobs.orgId, orgId), eq(jobs.id, jobId), eq(jobs.status, 'failed')))
    .returning({ id: jobs.id });
  if (job && !isInMemory()) afterCommit(kick);
  return !!job;
}

export type QueueHealth = { queued: number; running: number; failed: number; oldestQueuedAt: Date | null };

/** Queue depth, for one organisation or (with no orgId) the whole deployment. */
export async function queueHealth(db: DB, orgId?: string): Promise<QueueHealth> {
  const rows = await db
    .select({ status: jobs.status, n: sql<number>`count(*)::int`, oldest: sql<Date | string | null>`min(${jobs.createdAt})` })
    .from(jobs)
    .where(orgId ? eq(jobs.orgId, orgId) : undefined)
    .groupBy(jobs.status);
  const of = (status: string) => rows.find((r) => r.status === status);
  const oldest = of('queued')?.oldest ?? null;
  return { queued: of('queued')?.n ?? 0, running: of('running')?.n ?? 0, failed: of('failed')?.n ?? 0, oldestQueuedAt: oldest ? new Date(oldest) : null };
}

/** How the queue is run here, whether this process is polling it, and when it last looked at it. */
export function runnerStatus(): { mode: JobRunnerMode; polling: boolean; lastActivityAt: Date | null } {
  return { mode: jobRunnerMode(), polling: !!g.__rcmPoller, lastActivityAt: g.__rcmRunnerActivity ? new Date(g.__rcmRunnerActivity) : null };
}
