/**
 * What an operator needs to know about a running deployment: is the database
 * answering, is document processing moving, what failed and why, and what
 * arrived at the email-intake address. Everything here is scoped to one
 * organisation except `deploymentHealth`, which reports counts only.
 */
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import type { DB } from '@/db';
import { dbConnection } from '@/db';
import { DatabaseSetupError, type TlsMode } from '@/db/connection';
import { jobs, nextVersion, payApplications } from '@/db/schema';
import { locked } from '@/db/tx';
import { assertCan, ConflictError, UserError, type Ctx } from '@/server/auth/permissions';
import { recordAudit } from '@/server/audit';
import type { PdfText } from '@/server/documents/pdf-text';
import { checkPdfReader, type ReaderCheck } from '@/server/documents/reader-check';
import { queueHealth, requeueJob, runnerStatus, type QueueHealth } from '@/server/jobs';
import { storageMode, type StorageMode } from '@/server/storage';

/** Queued work older than this means nothing is draining the queue. */
export const STALL_MS = 10 * 60 * 1000;

export type DataApiExposure = {
  /** The roles Supabase's Data API uses exist, so this is (or looks like) a Supabase database. */
  rolesPresent: boolean;
  /** Tables in the public schema those roles hold any privilege on. Must be empty. */
  exposedTables: string[];
  /** Tables in the public schema without row level security. Must be empty. */
  tablesWithoutRls: string[];
};

/**
 * Whether any table can be reached through Supabase's Data API (PostgREST),
 * which serves the public schema to the anon, authenticated and service_role
 * roles. Migration 0002 locks every table twice over; this checks it stayed so.
 */
export async function dataApiExposure(db: DB): Promise<DataApiExposure> {
  // Both drivers (node-postgres and PGlite) return raw query results as { rows }.
  const rows = async <T,>(query: ReturnType<typeof sql>) => ((await db.execute(query)) as unknown as { rows: T[] }).rows;
  const rlsOff = await rows<{ relname: string }>(
    sql`select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind in ('r', 'p') and not c.relrowsecurity order by 1`,
  );
  const roles = await rows<{ rolname: string }>(sql`select rolname from pg_roles where rolname in ('anon', 'authenticated', 'service_role')`);
  const exposed = new Set<string>();
  for (const { rolname } of roles) {
    const reachable = await rows<{ relname: string }>(
      sql`select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind in ('r', 'p') and has_table_privilege(${rolname}, c.oid, 'SELECT, INSERT, UPDATE, DELETE')`,
    );
    for (const r of reachable) exposed.add(r.relname);
  }
  return { rolesPresent: roles.length > 0, exposedTables: [...exposed].sort(), tablesWithoutRls: rlsOff.map((r) => r.relname) };
}

export type Health = {
  status: 'ok' | 'degraded' | 'down';
  problems: string[];
  database: { ok: boolean; driver: 'pglite' | 'postgres' | null; latencyMs: number | null; tls: TlsMode | null };
  dataApi: DataApiExposure | null;
  storage: StorageMode;
  queue: (QueueHealth & { stalled: boolean }) | null;
  runner: { mode: 'poll' | 'request'; polling: boolean; lastActivityAt: Date | null };
  /** A test PDF was opened and its text found, with the reader uploads go through. */
  pdfReader: ReaderCheck;
};

/** Health of the whole deployment, for a load balancer or uptime monitor. Counts only; no organisation's data. */
export async function deploymentHealth(getDb: () => Promise<DB>, deps: { readPdf?: (bytes: Uint8Array) => Promise<PdfText> } = {}): Promise<Health> {
  const runner = runnerStatus();
  const storage = storageMode();
  const reading = checkPdfReader(deps.readPdf);
  let db: DB;
  const started = Date.now();
  try {
    db = await getDb();
    await db.execute(sql`select 1`);
  } catch (err) {
    console.error('[health] the database is not usable:', err);
    // A setup problem (schema behind, wrong migration mode, untrusted certificate) explains itself; anything else is an outage.
    const problem = err instanceof DatabaseSetupError ? err.message : 'The database is not answering.';
    return { status: 'down', problems: [problem], database: { ok: false, driver: null, latencyMs: null, tls: null }, dataApi: null, storage, queue: null, runner, pdfReader: await reading };
  }
  const latencyMs = Date.now() - started;
  const queue = await queueHealth(db);
  const stalled = !!queue.oldestQueuedAt && Date.now() - queue.oldestQueuedAt.getTime() > STALL_MS;
  const problems: string[] = [];
  if (stalled) problems.push(`Document processing is not keeping up: the oldest queued job has waited more than ${STALL_MS / 60_000} minutes.`);
  if (runner.mode === 'poll' && !runner.polling) problems.push('This process is not running the document-processing queue.');
  const connection = await dbConnection();
  if (connection.supabase && connection.tls === 'off') {
    problems.push('The connection to Supabase is not encrypted. Set DATABASE_CA_CERT to the project’s CA certificate; see docs/operations.md.');
  }
  const dataApi = await dataApiExposure(db);
  if (dataApi.rolesPresent && dataApi.exposedTables.length > 0) {
    problems.push(`${dataApi.exposedTables.length} table${dataApi.exposedTables.length === 1 ? ' is' : 's are'} reachable through Supabase's Data API (${dataApi.exposedTables.slice(0, 5).join(', ')}${dataApi.exposedTables.length > 5 ? ', …' : ''}). Revoke the grants; see docs/operations.md.`);
  }
  if (dataApi.rolesPresent && dataApi.tablesWithoutRls.length > 0) {
    problems.push(`${dataApi.tablesWithoutRls.length} table${dataApi.tablesWithoutRls.length === 1 ? ' has' : 's have'} row level security turned off (${dataApi.tablesWithoutRls.slice(0, 5).join(', ')}).`);
  }
  const pdfReader = await reading;
  if (!pdfReader.ok) problems.push('This deployment cannot read PDFs: a test document could not be opened. Uploaded packages are stored but not read. The cause is in the server log.');
  return {
    status: problems.length ? 'degraded' : 'ok',
    problems,
    dataApi,
    database: { ok: true, driver: connection.driver, latencyMs, tls: connection.tls },
    storage,
    queue: { ...queue, stalled },
    runner,
    pdfReader,
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
