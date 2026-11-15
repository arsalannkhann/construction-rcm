/**
 * What an operator relies on: the health check, failed work being visible and
 * retryable, and the review screen knowing which submissions belong together.
 */
import { and, eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { explainConnectError } from '@/db/connection';
import { SchemaBehindError } from '@/db/migrations';
import { auditEvents, communications, documents, jobs, scheduledRuns } from '@/db/schema';
import { ConflictError, PermissionError, UserError } from '@/server/auth/permissions';
import { drain, lastScheduledRun, recordScheduledRun, SCHEDULED_RUNS_KEPT } from '@/server/jobs';
import { renderPackage } from '@/server/samples/pdf';
import { createApplication } from '@/server/services/intake';
import { getReviewData } from '@/server/services/queries';
import { approveApplication, sendSubcontractorMessage, supersedeApplication } from '@/server/services/review';
import { deploymentHealth, listFailedJobs, retryFailedJob } from '@/server/services/system';
import { createWorld, getApp, packageFor, submit } from './helpers/world';

describe('the health check', () => {
  it('reports the database and the queue, and says when this process is not running the queue', async () => {
    const w = await createWorld();
    const health = await deploymentHealth(async () => w.db);
    expect(health.database.ok).toBe(true);
    expect(health.queue).toMatchObject({ stalled: false });
    // Tests drive the queue by hand, so no runner is polling here, and the check says so instead of reporting "ok".
    expect(health.runner.polling).toBe(false);
    expect(health.status).toBe('degraded');
    expect(health.problems.join(' ')).toMatch(/not running the document-processing queue/);
  });

  it('reports "down" when the database cannot be reached', async () => {
    const health = await deploymentHealth(async () => {
      throw new Error('connect ECONNREFUSED');
    });
    expect(health).toMatchObject({ status: 'down', database: { ok: false }, queue: null });
    expect(health.problems).toEqual(['The database is not answering.']);
  });

  it('explains a setup problem instead of calling it an outage, without naming the host', async () => {
    const tls = explainConnectError(Object.assign(new Error('self-signed certificate in certificate chain'), { code: 'SELF_SIGNED_CERT_IN_CHAIN' }));
    const health = await deploymentHealth(async () => {
      throw tls;
    });
    expect(health.status).toBe('down');
    expect(health.problems[0]).toMatch(/DATABASE_CA_CERT/);
    const behind = await deploymentHealth(async () => {
      throw new SchemaBehindError('The database schema is behind this version of the app: 20990101000000_0099_x not applied.');
    });
    expect(behind.problems[0]).toMatch(/0099_x not applied/);
  });

  it('opens a test PDF, so a deployment that cannot read documents is not reported healthy', async () => {
    const w = await createWorld();
    const health = await deploymentHealth(async () => w.db);
    expect(health.pdfReader).toEqual({ ok: true });
    expect(health.problems.join(' ')).not.toMatch(/PDF/);
  });

  it('reports a deployment that cannot read PDFs as degraded, without exposing the cause', async () => {
    // What the first live deployment did: pdf.js's worker was missing from the deployed files.
    const missingWorker = async (): Promise<never> => {
      throw new Error("Setting up fake worker failed: Cannot find module '/var/task/node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs'");
    };
    const w = await createWorld();
    const health = await deploymentHealth(async () => w.db, { readPdf: missingWorker });
    expect(health.pdfReader).toEqual({ ok: false });
    expect(health.status).toBe('degraded');
    expect(health.problems.join(' ')).toMatch(/cannot read PDFs/);
    expect(JSON.stringify(health)).not.toMatch(/var\/task|worker/);

    // Opening the file but not finding its text is a failure too.
    const blank = await deploymentHealth(async () => w.db, { readPdf: async () => ({ pageCount: 1, hasTextLayer: false, pages: [] }) });
    expect(blank.pdfReader).toEqual({ ok: false });
  });

  it('still checks the PDF reader when the database is down', async () => {
    const health = await deploymentHealth(async () => {
      throw new Error('connect ECONNREFUSED');
    });
    expect(health.status).toBe('down');
    expect(health.pdfReader).toEqual({ ok: true });
  });

  it('reports the connection’s encryption: none for the embedded database', async () => {
    const w = await createWorld();
    const health = await deploymentHealth(async () => w.db);
    expect(health.database.tls).toBe(process.env.DATABASE_URL ? 'off' : null);
  });

  it('shows when the scheduler last called, and calls a missed day a problem where the queue runs on request', async () => {
    const w = await createWorld();
    await w.db.delete(scheduledRuns);
    const previous = process.env.RCM_JOB_RUNNER;
    process.env.RCM_JOB_RUNNER = 'request';
    try {
      // Before the first run there is nothing to judge.
      let health = await deploymentHealth(async () => w.db);
      expect(health.scheduler).toEqual({ lastRunAt: null, overdue: false });
      expect(health.status).toBe('ok');

      const now = Date.now();
      const longAgo = new Date(now - 30 * 3_600_000);
      const recently = new Date(now - 2 * 3_600_000);
      await recordScheduledRun(w.db, { startedAt: longAgo, finishedAt: longAgo, ran: 0, queued: 0, failed: 0 });
      health = await deploymentHealth(async () => w.db);
      expect(health.scheduler).toEqual({ lastRunAt: longAgo, overdue: true });
      expect(health.status).toBe('degraded');
      expect(health.problems.join(' ')).toMatch(/scheduled run \(\/api\/jobs\/run\) last happened at .* more than a day ago/);

      await recordScheduledRun(w.db, { startedAt: recently, finishedAt: recently, ran: 1, queued: 0, failed: 0 });
      health = await deploymentHealth(async () => w.db);
      expect(health.scheduler).toEqual({ lastRunAt: recently, overdue: false });
      expect(health.status).toBe('ok');
    } finally {
      if (previous === undefined) delete process.env.RCM_JOB_RUNNER;
      else process.env.RCM_JOB_RUNNER = previous;
    }
    // Where a process polls the queue, the scheduled endpoint is not needed, so a stale run is not a problem.
    const polling = await deploymentHealth(async () => w.db);
    expect(polling.scheduler?.overdue).toBe(false);
  });

  it('keeps only the newest scheduled runs', async () => {
    const w = await createWorld();
    await w.db.delete(scheduledRuns);
    const base = Date.parse('2030-01-01T03:00:00Z');
    for (let i = 0; i < SCHEDULED_RUNS_KEPT + 5; i++) {
      const at = new Date(base + i * 86_400_000);
      await recordScheduledRun(w.db, { startedAt: at, finishedAt: at, ran: 0, queued: 0, failed: 0 });
    }
    expect(await w.db.select().from(scheduledRuns)).toHaveLength(SCHEDULED_RUNS_KEPT);
    expect(await lastScheduledRun(w.db)).toEqual(new Date(base + (SCHEDULED_RUNS_KEPT + 4) * 86_400_000));
  });
});

describe('failed background work', () => {
  it('is listed for the organisation and can be retried once the cause is fixed', async () => {
    const w = await createWorld();
    const other = await createWorld();
    const bytes = await renderPackage(packageFor(w, 0, null));
    const { id } = await createApplication(w.db, w.accountant, { files: [{ filename: 'payapp-1.pdf', bytes }] });
    const [doc] = await w.db.select().from(documents).where(eq(documents.payApplicationId, id));
    const realKey = doc!.storageKey;
    // The stored file goes missing (a volume not mounted after a restart).
    await w.db.update(documents).set({ storageKey: `${w.orgId}/documents/${'0'.repeat(64)}` }).where(eq(documents.id, doc!.id));
    await drain(w.db);

    const failed = await listFailedJobs(w.db, w.accountant);
    expect(failed).toHaveLength(1);
    expect(failed[0]).toMatchObject({ label: 'Read a billing package', retryable: true, application: { id, status: 'processing' } });
    expect(failed[0]!.error).toMatch(/missing/);
    // Another organisation sees none of it and cannot touch it.
    expect(await listFailedJobs(other.db, other.accountant)).toEqual([]);
    await expect(retryFailedJob(other.db, other.accountant, failed[0]!.id)).rejects.toBeInstanceOf(UserError);
    await expect(retryFailedJob(w.db, w.viewer, failed[0]!.id)).rejects.toBeInstanceOf(PermissionError);

    // The volume is back.
    await w.db.update(documents).set({ storageKey: realKey }).where(eq(documents.id, doc!.id));
    await retryFailedJob(w.db, w.accountant, failed[0]!.id);
    await expect(retryFailedJob(w.db, w.accountant, failed[0]!.id)).rejects.toBeInstanceOf(ConflictError);
    expect((await getApp(w, id)).processingError).toBeNull();
    await drain(w.db);

    expect((await getApp(w, id)).status).toBe('needs_review');
    expect(await listFailedJobs(w.db, w.accountant)).toEqual([]);
    const [job] = await w.db.select().from(jobs).where(eq(jobs.id, failed[0]!.id));
    expect(job!.status).toBe('succeeded');
    const retried = await w.db.select().from(auditEvents).where(and(eq(auditEvents.orgId, w.orgId), eq(auditEvents.action, 'job.retried')));
    expect(retried).toHaveLength(1);
  });
});

describe('the review screen', () => {
  it('lists the other submissions with the same number, and links a replaced one to its replacement', async () => {
    const w = await createWorld();
    const first = await submit(w, packageFor(w, 0, null, (p) => (p.waiver = null)), { now: new Date('2026-10-01T15:00:00Z') });
    const corrected = await submit(w, packageFor(w, 0, null), { now: new Date('2026-10-03T15:00:00Z'), filename: 'payapp-1-corrected.pdf' });

    const before = (await getReviewData(w.db, w.accountant, corrected.id))!;
    expect(before.sameNumber.map((s) => s.id)).toEqual([first.id]);
    expect(before.replaces).toEqual([]);

    await supersedeApplication(w.db, w.accountant, corrected.id, first.id);
    const after = (await getReviewData(w.db, w.accountant, corrected.id))!;
    expect(after.sameNumber).toEqual([]);
    expect(after.replaces.map((s) => s.id)).toEqual([first.id]);
    const old = (await getReviewData(w.db, w.accountant, first.id))!;
    expect(old.replacedBy?.id).toBe(corrected.id);
  });
});

describe('a message that mentions a payment', () => {
  it('is sent only once the reviewer vouches for it, and the record says they did', async () => {
    const w = await createWorld();
    const app = await submit(w, packageFor(w, 0, null));
    await approveApplication(w.db, w.controller, app.id);
    const message = { to: 'maria@lonestarelectric.example', subject: 'Application #1', body: 'Your application was approved and payment will be sent by ACH on Friday.' };
    await expect(sendSubcontractorMessage(w.db, w.controller, app.id, message)).rejects.toThrow(/does not issue or track payments/);
    expect(await w.db.select().from(communications).where(eq(communications.payApplicationId, app.id))).toEqual([]);

    await sendSubcontractorMessage(w.db, w.controller, app.id, { ...message, acknowledgeWording: true });
    const [event] = await w.db.select().from(auditEvents).where(and(eq(auditEvents.payApplicationId, app.id), eq(auditEvents.action, 'message.drafted')));
    expect(event!.data).toMatchObject({ paymentStatementConfirmed: true });
    expect(event!.summary).toMatch(/confirmed the payment statement/);
  });
});
