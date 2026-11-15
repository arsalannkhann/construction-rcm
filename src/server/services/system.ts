/**
 * What an operator needs to know about a running deployment: is the database
 * answering, is document processing moving, what failed and why, and what
 * arrived at the email-intake address. Everything here is scoped to one
 * organisation except `deploymentHealth`, which reports counts only.
 */
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import type { DB } from '@/db';
import { dbDriver } from '@/db';
import { jobs, nextVersion, payApplications } from '@/db/schema';
import { locked } from '@/db/tx';
import { assertCan, ConflictError, UserError, type Ctx } from '@/server/auth/permissions';
import { recordAudit } from '@/server/audit';
import { queueHealth, requeueJob, runnerStatus, type QueueHealth } from '@/server/jobs';
import { storageMode, type StorageMode } from '@/server/storage';

/** Queued work older than this means nothing is draining the queue. */
export const STALL_MS = 10 * 60 * 1000;

export type Health = {
  status: 'ok' | 'degraded' | 'down';
  problems: string[];
  database: { ok: boolean; driver: 'pglite' | 'postgres' | null; latencyMs: number | null };
  storage: StorageMode;
  queue: (QueueHealth & { stalled: boolean }) | null;
  runner: { polling: boolean; lastActivityAt: Date | null };
};

/** Health of the whole deployment, for a load balancer or uptime monitor. Counts only; no organisation's data. */
export async function deploymentHealth(getDb: () => Promise<DB>): Promise<Health> {
  const runner = runnerStatus();
  const storage = storageMode();
  let db: DB;
  const started = Date.now();
  try {
    db = await getDb();
    await db.execute(sql`select 1`);
  } catch (err) {
    console.error('[health] the database did not answer:', err);
    return { status: 'down', problems: ['The database is not answering.'], database: { ok: false, driver: null, latencyMs: null }, storage, queue: null, runner };
  }
  const latencyMs = Date.now() - started;
  const queue = await queueHealth(db);
  const stalled = !!queue.oldestQueuedAt && Date.now() - queue.oldestQueuedAt.getTime() > STALL_MS;
  const problems: string[] = [];
  if (stalled) problems.push(`Document processing is not keeping up: the oldest queued job has waited more than ${STALL_MS / 60_000} minutes.`);
  if (!runner.polling) problems.push('This process is not running the document-processing queue.');
  return {
    status: problems.length ? 'degraded' : 'ok',
    problems,
    database: { ok: true, driver: await dbDriver(), latencyMs },
    storage,
    queue: { ...queue, stalled },
    runner,
  };
}

const JOB_LABEL: Record<string, string> = { process_application: 'Read a billing package' };

/** Failed background work for this organisation, newest first, with the application it was for. */
export async function listFailedJobs(db: DB, ctx: Ctx, limit = 50) {
  const rows = await db.select().from(jobs).where(and(eq(jobs.orgId, ctx.orgId), eq(jobs.status, 'failed'))).orderBy(desc(jobs.finishedAt)).limit(limit);
  const appIds = rows.map((j) => j.payload.applicationId).filter((x): x is string => typeof x === 'string');
  const apps = appIds.length
    ? await db
        .select({ id: payApplications.id, applicationNumber: payApplications.applicationNumber, status: payApplications.status })
        .from(payApplications)
        .where(and(eq(payApplications.orgId, ctx.orgId), inArray(payApplications.id, appIds)))
    : [];
  return rows.map((j) => {
    const app = apps.find((a) => a.id === j.payload.applicationId) ?? null;
    return {
      id: j.id,
      type: j.type,
      label: JOB_LABEL[j.type] ?? j.type,
      attempts: j.attempts,
      error: j.error,
      createdAt: j.createdAt,
      finishedAt: j.finishedAt,
      application: app,
      // Retrying only makes sense while the application is still waiting on it.
      retryable: j.type !== 'process_application' || app?.status === 'processing',
    };
  });
}

/** Put a failed job back on the queue with a fresh set of attempts. */
export const retryFailedJob = locked(async function retryFailedJob(db: DB, ctx: Ctx, jobId: string): Promise<void> {
  assertCan(ctx, 'application:upload');
  const [job] = await db.select().from(jobs).where(and(eq(jobs.orgId, ctx.orgId), eq(jobs.id, jobId)));
  if (!job) throw new UserError('That job is no longer on record.');
  if (job.status !== 'failed') throw new ConflictError('That job is no longer failed: it has already been retried. The page has been updated.');
  const appId = typeof job.payload.applicationId === 'string' ? job.payload.applicationId : null;
  if (job.type === 'process_application') {
    const [app] = appId ? await db.select().from(payApplications).where(and(eq(payApplications.orgId, ctx.orgId), eq(payApplications.id, appId))) : [];
    if (!app) throw new UserError('The application this job was reading no longer exists.');
    if (app.status !== 'processing') throw new UserError('That application has been read since; there is nothing to retry.');
    await db.update(payApplications).set({ version: nextVersion, processingError: null, updatedAt: new Date() }).where(eq(payApplications.id, app.id));
  }
  await requeueJob(db, ctx.orgId, jobId);
  await recordAudit(db, {
    orgId: ctx.orgId,
    actor: ctx,
    action: 'job.retried',
    entityType: 'job',
    entityId: jobId,
    payApplicationId: appId,
    summary: `Retried a failed background job (${JOB_LABEL[job.type] ?? job.type}) after: ${job.error ?? 'an unknown error'}`,
    data: { type: job.type, attempts: job.attempts, error: job.error },
  });
});
