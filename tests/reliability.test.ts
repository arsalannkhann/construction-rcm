/**
 * The things that must hold when more than one person is working, when the
 * server restarts mid-job, and when a package is read a second time.
 *
 * Run with `pnpm test:pg` these exercise real concurrent connections on a
 * PostgreSQL server; with `pnpm test` the embedded database runs them one at
 * a time, which checks the logic but not the locking.
 */
import { and, eq } from 'drizzle-orm';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { closeDb, getDb } from '@/db';
import { auditEvents, communications, documents, findings, jobs, notifications, payAppLines, payApplications, storedObjects } from '@/db/schema';
import { verifyAuditChain } from '@/server/audit';
import { ConflictError, UserError } from '@/server/auth/permissions';
import { newId } from '@/server/ids';
import { drain, enqueueJob, MAX_ATTEMPTS, queueHealth, registerJobHandler, requeueJob } from '@/server/jobs';
import { renderPackage } from '@/server/samples/pdf';
import { addDocuments, createApplication, processApplication, removeDocument } from '@/server/services/intake';
import {
  acceptFinding,
  addComment,
  approveApplication,
  confirmSignature,
  messageWordingProblem,
  rejectApplication,
  sendSubcontractorMessage,
  submitForApproval,
  supersedeApplication,
  updateHeader,
  updateLine,
} from '@/server/services/review';
import { getObject, putObject, storageMode } from '@/server/storage';
import { createWorld, dollars as D, getApp, openFindings, packageFor, stateAfter, submit, type World } from './helpers/world';

const onPostgres = !!process.env.RCM_TEST_PG_ADMIN_URL;
const settled = (results: PromiseSettledResult<unknown>[]) => ({
  ok: results.filter((r) => r.status === 'fulfilled').length,
  failed: results.filter((r): r is PromiseRejectedResult => r.status === 'rejected').map((r) => r.reason as Error),
});

describe('decisions are made on what the person saw', () => {
  let w: World;
  beforeAll(async () => {
    w = await createWorld();
  });

  it('refuses an approval when the application changed after the approver opened it', async () => {
    const app = await submit(w, packageFor(w, 0, null));
    const seen = app.version;
    // Meanwhile the accountant cuts a line.
    const [line] = await w.db.select().from(payAppLines).where(and(eq(payAppLines.payApplicationId, app.id), eq(payAppLines.itemNo, '2')));
    await updateLine(w.db, w.accountant, line!.id, { thisPeriod: D(40000) }, 'adjustment', 'Only two floors were roughed in');
    const now = await getApp(w, app.id);
    expect(now.version).toBeGreaterThan(seen);
    expect(now.verifiedAmount).toBe(D(81000));

    await expect(approveApplication(w.db, w.controller, app.id, { expectedVersion: seen, expectedAmount: D(99000), acknowledgeWarnings: true })).rejects.toBeInstanceOf(ConflictError);
    expect((await getApp(w, app.id)).status).toBe('needs_review');

    // Having looked again, the approver sees the short-pay the adjustment causes, signs off on it, and decides.
    for (const f of (await openFindings(w, app.id)).filter((x) => x.severity === 'blocking')) {
      await acceptFinding(w.db, w.controller, f.id, 'Short-paying for work not in place; subcontractor notified');
    }
    const ready = await getApp(w, app.id);
    const record = await approveApplication(w.db, w.controller, app.id, { expectedVersion: ready.version, expectedAmount: D(81000), acknowledgeWarnings: true });
    expect(record.approved.currentPaymentDue).toBe(D(81000));
    expect(record.varianceFromClaimed).toBe(D(-18000));
  });

  it('refuses to approve an amount other than the one shown, even when the version matches', async () => {
    const w2 = await createWorld();
    const app = await submit(w2, packageFor(w2, 0, null));
    await expect(approveApplication(w2.db, w2.controller, app.id, { expectedVersion: app.version, expectedAmount: D(98000) })).rejects.toThrow(/verified payment is now \$99,000\.00/);
    expect((await getApp(w2, app.id)).status).toBe('needs_review');
  });

  it('applies the same check to submitting, rejecting and overriding a finding', async () => {
    const w3 = await createWorld();
    const app = await submit(w3, packageFor(w3, 0, null, (pkg) => (pkg.waiver = null)));
    const stale = app.version;
    await addComment(w3.db, w3.accountant, app.id, 'Asked the sub for the waiver'); // a comment is not a change to the figures
    expect((await getApp(w3, app.id)).version).toBe(stale);
    await confirmSignature(w3.db, w3.accountant, app.id, true);
    expect((await getApp(w3, app.id)).version).toBeGreaterThan(stale);

    await expect(submitForApproval(w3.db, w3.accountant, app.id, null, { expectedVersion: stale })).rejects.toBeInstanceOf(ConflictError);
    await expect(rejectApplication(w3.db, w3.controller, app.id, 'Missing the lien waiver', { expectedVersion: stale })).rejects.toBeInstanceOf(ConflictError);
    const [finding] = await openFindings(w3, app.id);
    await expect(acceptFinding(w3.db, w3.controller, finding!.id, 'Waiver to follow by courier', { expectedVersion: stale })).rejects.toBeInstanceOf(ConflictError);
    expect((await getApp(w3, app.id)).status).toBe('needs_review');
  });

  it('does not make an approver start again because of unrelated activity on the same contract', async () => {
    const w4 = await createWorld();
    const first = packageFor(w4, 0, null);
    const app = await submit(w4, first);
    const seen = app.version;
    // An unrelated later application arrives on the same contract; this one is re-checked and nothing about it changes.
    await submit(w4, packageFor(w4, 1, stateAfter(first)));
    expect((await getApp(w4, app.id)).version).toBe(seen);
    await approveApplication(w4.db, w4.controller, app.id, { expectedVersion: seen, expectedAmount: D(99000) });
  });
});

describe('two people at once', () => {
  it('lets exactly one of two simultaneous approvals through', async () => {
    const w = await createWorld();
    const app = await submit(w, packageFor(w, 0, null));
    const results = await Promise.allSettled([approveApplication(w.db, w.controller, app.id), approveApplication(w.db, w.owner, app.id)]);
    const { ok, failed } = settled(results);
    expect(ok).toBe(1);
    expect(failed).toHaveLength(1);
    expect(failed[0]).toBeInstanceOf(UserError);
    expect(failed[0]!.message).toMatch(/not in a state that can be approved/);

    const approvals = await w.db.select().from(auditEvents).where(and(eq(auditEvents.payApplicationId, app.id), eq(auditEvents.action, 'application.approved')));
    expect(approvals).toHaveLength(1);
    const final = await getApp(w, app.id);
    expect(final.status).toBe('approved');
    expect(final.approvedRecord!.approvedBy.id).toBe(final.decidedBy);
    expect(await verifyAuditChain(w.db, w.orgId)).toMatchObject({ ok: true });
  });

  it('never leaves an approval that disagrees with the lines it was made on', async () => {
    const w = await createWorld();
    const app = await submit(w, packageFor(w, 0, null));
    const [line] = await w.db.select().from(payAppLines).where(and(eq(payAppLines.payApplicationId, app.id), eq(payAppLines.itemNo, '2')));
    // An approval and an edit race. Either order is acceptable; a mix of the two is not.
    await Promise.allSettled([
      approveApplication(w.db, w.controller, app.id, { acknowledgeWarnings: true }),
      updateLine(w.db, w.accountant, line!.id, { thisPeriod: D(30000) }, 'adjustment', 'Less work was in place than billed'),
    ]);
    const final = await getApp(w, app.id);
    const [after] = await w.db.select().from(payAppLines).where(eq(payAppLines.id, line!.id));
    expect(final.status).toBe('approved');
    const approvedLine = final.approvedRecord!.lines.find((l) => l.itemNo === '2')!;
    // What was approved is exactly what the line said at that moment, and the line has not moved since.
    expect(approvedLine.thisPeriod).toBe(after!.thisPeriod);
    expect(final.approvedAmount).toBe(final.approvedRecord!.approved.currentPaymentDue);
    expect(final.approvedAmount).toBe(after!.thisPeriod === D(30000) ? D(72000) : D(99000));
    expect(await verifyAuditChain(w.db, w.orgId)).toMatchObject({ ok: true });
  });

  it('keeps the audit chain intact under a burst of simultaneous writes', async () => {
    const w = await createWorld();
    const app = await submit(w, packageFor(w, 0, null));
    const people = [w.owner, w.controller, w.accountant, w.pm];
    const results = await Promise.allSettled(Array.from({ length: 24 }, (_, i) => addComment(w.db, people[i % people.length]!, app.id, `Note ${i + 1}`)));
    expect(settled(results).ok).toBe(24);
    const chain = await verifyAuditChain(w.db, w.orgId);
    expect(chain.ok).toBe(true);
    const events = await w.db.select({ seq: auditEvents.seq }).from(auditEvents).where(eq(auditEvents.orgId, w.orgId));
    const seqs = events.map((e) => e.seq).sort((a, b) => a - b);
    expect(seqs).toEqual(Array.from({ length: seqs.length }, (_, i) => i + 1)); // no gaps, no duplicates
  });

  it('keeps two organisations from blocking or seeing each other', async () => {
    const a = await createWorld();
    const b = await createWorld();
    const [appA, appB] = await Promise.all([submit(a, packageFor(a, 0, null)), submit(b, packageFor(b, 0, null))]);
    await Promise.all([approveApplication(a.db, a.controller, appA.id), approveApplication(b.db, b.controller, appB.id)]);
    // A controller in one organisation cannot act on the other's application, even knowing its id.
    await expect(rejectApplication(a.db, a.controller, appB.id, 'Trying the wrong organisation')).rejects.toThrow(/not found/i);
    expect((await getApp(b, appB.id)).status).toBe('approved');
  });
});

describe('the job queue', () => {
  const ran: string[] = [];
  let failing = false;
  const exhausted: Array<{ id: string; error: string }> = [];
  beforeAll(() => {
    registerJobHandler(
      'test_job',
      async (_db, _orgId, payload) => {
        if (failing || payload.alwaysFail) throw new Error('simulated failure');
        await new Promise((r) => setTimeout(r, 5));
        ran.push(String(payload.n));
      },
      { onExhausted: async (_db, _orgId, payload, error) => void exhausted.push({ id: String(payload.n), error }) },
    );
  });

  it('runs each job exactly once when several runners drain the queue together', async () => {
    const db = await getDb();
    ran.length = 0;
    for (let n = 0; n < 12; n++) await enqueueJob(db, 'org_queue_test', 'test_job', { n });
    const counts = await Promise.all([drain(db), drain(db), drain(db)]);
    expect(counts.reduce((a, b) => a + b, 0)).toBe(12);
    expect([...ran].sort((a, b) => Number(a) - Number(b))).toEqual(Array.from({ length: 12 }, (_, i) => String(i)));
    expect(await queueHealth(db, 'org_queue_test')).toMatchObject({ queued: 0, running: 0, failed: 0 });
  });

  it('retries a failing job, then stops, records the failure and tells the handler', async () => {
    const db = await getDb();
    exhausted.length = 0;
    const id = await enqueueJob(db, 'org_queue_test', 'test_job', { n: 'x', alwaysFail: true });
    await drain(db);
    const [job] = await db.select().from(jobs).where(eq(jobs.id, id));
    expect(job).toMatchObject({ status: 'failed', attempts: MAX_ATTEMPTS, error: 'simulated failure' });
    expect(exhausted).toEqual([{ id: 'x', error: 'simulated failure' }]);
    expect((await queueHealth(db, 'org_queue_test')).failed).toBe(1);

    // A person can put it back; it gets a fresh set of attempts.
    expect(await requeueJob(db, 'some_other_org', id)).toBe(false);
    expect(await requeueJob(db, 'org_queue_test', id)).toBe(true);
    const [again] = await db.select().from(jobs).where(eq(jobs.id, id));
    expect(again).toMatchObject({ status: 'queued', attempts: 0, error: null });
    await db.delete(jobs).where(eq(jobs.id, id));
  });

  it('picks up a job that was abandoned mid-run by a server that went away', async () => {
    const db = await getDb();
    ran.length = 0;
    const abandoned = newId('job');
    const tenMinutesAgo = new Date(Date.now() - 10 * 60 * 1000);
    await db.insert(jobs).values({ id: abandoned, orgId: 'org_queue_test', type: 'test_job', payload: { n: 'abandoned' }, status: 'running', attempts: 1, startedAt: tenMinutesAgo, lockedBy: 'a-dead-server' });
    // One that is still being worked on (fresh lease) must be left alone.
    const live = newId('job');
    await db.insert(jobs).values({ id: live, orgId: 'org_queue_test', type: 'test_job', payload: { n: 'live' }, status: 'running', attempts: 1, startedAt: new Date(), lockedBy: 'a-live-server' });
    await drain(db);
    expect(ran).toEqual(['abandoned']);
    expect((await db.select().from(jobs).where(eq(jobs.id, abandoned)))[0]).toMatchObject({ status: 'succeeded', attempts: 2 });
    expect((await db.select().from(jobs).where(eq(jobs.id, live)))[0]).toMatchObject({ status: 'running', lockedBy: 'a-live-server' });
    await db.delete(jobs).where(eq(jobs.id, live));
  });

  it('gives up on a job abandoned during its last attempt instead of running it for ever', async () => {
    const db = await getDb();
    exhausted.length = 0;
    const id = newId('job');
    await db.insert(jobs).values({ id, orgId: 'org_queue_test', type: 'test_job', payload: { n: 'last' }, status: 'running', attempts: MAX_ATTEMPTS, startedAt: new Date(Date.now() - 10 * 60 * 1000), lockedBy: 'a-dead-server' });
    await drain(db);
    expect((await db.select().from(jobs).where(eq(jobs.id, id)))[0]).toMatchObject({ status: 'failed' });
    expect(exhausted.map((e) => e.id)).toEqual(['last']);
    await db.delete(jobs).where(eq(jobs.id, id));
  });

  it('makes a package that cannot be read visible to people instead of leaving it silently stuck', async () => {
    const w = await createWorld();
    const bytes = await renderPackage(packageFor(w, 0, null));
    const { id } = await createApplication(w.db, w.accountant, { files: [{ filename: 'payapp-1.pdf', bytes }] }); // queued, not deferred
    // The stored file goes missing (a lost volume, a bad restore).
    await w.db.update(documents).set({ storageKey: `${w.orgId}/documents/${'0'.repeat(64)}` }).where(eq(documents.payApplicationId, id));
    await drain(w.db);

    const app = await getApp(w, id);
    expect(app.status).toBe('processing');
    expect(app.processingError).toMatch(/missing/);
    const events = await w.db.select().from(auditEvents).where(and(eq(auditEvents.payApplicationId, id), eq(auditEvents.action, 'application.processing_failed')));
    expect(events).toHaveLength(1);
    expect(events[0]!.summary).toContain('Nothing was lost');
    const notes = await w.db.select().from(notifications).where(and(eq(notifications.orgId, w.orgId), eq(notifications.type, 'application.processing_failed')));
    expect(notes.length).toBeGreaterThan(0);
    expect((await queueHealth(w.db, w.orgId)).failed).toBe(1);
  });
});

describe('reading a package again keeps the reviewer’s work', () => {
  it('carries corrections across when a missing document is added', async () => {
    const w = await createWorld();
    const pkg = packageFor(w, 0, null);
    const app = await submit(w, pkg, { parts: ['pay_application', 'continuation_sheet'] });
    expect((await openFindings(w, app.id)).map((f) => f.code)).toContain('lw.present');

    const [line] = await w.db.select().from(payAppLines).where(and(eq(payAppLines.payApplicationId, app.id), eq(payAppLines.itemNo, '2')));
    await updateLine(w.db, w.accountant, line!.id, { thisPeriod: D(45000) }, 'adjustment', 'Level 3 rough-in not started');
    await updateHeader(w.db, w.accountant, app.id, { periodTo: '2026-09-29' });
    await confirmSignature(w.db, w.accountant, app.id, true);

    // The subcontractor sends the waiver; the whole package is read again.
    await addDocuments(w.db, w.accountant, app.id, [{ filename: 'waiver.pdf', bytes: await renderPackage(pkg, ['lien_waiver']) }], { defer: true });
    await processApplication(w.db, w.orgId, app.id);

    const after = await getApp(w, app.id);
    expect(after.revision).toBe(2);
    expect(after.periodTo).toBe('2026-09-29');
    expect(after.headerCorrections).toEqual({ periodTo: { from: '2026-09-30', to: '2026-09-29' } });
    expect(after.signatureConfirmedAt).not.toBeNull();
    const [kept] = await w.db.select().from(payAppLines).where(and(eq(payAppLines.payApplicationId, app.id), eq(payAppLines.itemNo, '2')));
    expect(kept).toMatchObject({ thisPeriod: D(45000), editKind: 'adjustment', editNote: 'Level 3 rough-in not started', editedBy: w.accountant.userId });
    expect(kept!.extracted!.thisPeriod).toBe(D(60000)); // what the document says is still on record
    expect(after.verifiedAmount).toBe(D(85500)); // (50,000 + 45,000) less 10%

    const [event] = await w.db.select().from(auditEvents).where(and(eq(auditEvents.payApplicationId, app.id), eq(auditEvents.action, 'application.reprocessed')));
    // The adjusted line and the corrected period; the signature confirmation is kept too but is not a correction.
    expect(event!.summary).toContain('2 earlier corrections carried over.');
    expect(event!.data).toMatchObject({ correctionsKept: 2, correctionsDropped: 0 });
  });

  it('drops a correction, and says so, when the document it was made on is replaced', async () => {
    const w = await createWorld();
    const pkg = packageFor(w, 0, null);
    const app = await submit(w, pkg, { parts: ['pay_application', 'continuation_sheet'] });
    await addDocuments(w.db, w.accountant, app.id, [{ filename: 'waiver.pdf', bytes: await renderPackage(pkg, ['lien_waiver']) }], { defer: true });
    await processApplication(w.db, w.orgId, app.id);
    const [line] = await w.db.select().from(payAppLines).where(and(eq(payAppLines.payApplicationId, app.id), eq(payAppLines.itemNo, '2')));
    await updateLine(w.db, w.accountant, line!.id, { thisPeriod: D(45000) }, 'adjustment', 'Level 3 rough-in not started');

    // The subcontractor resubmits the pay application with different figures on that line.
    const docs = await w.db.select().from(documents).where(eq(documents.payApplicationId, app.id));
    const original = docs.find((d) => d.filename === 'payapp-1.pdf')!;
    const revised = packageFor(w, 0, null, (p) => {
      const l = p.lines.find((x) => x.itemNo === '2')!;
      l.thisPeriod = D(50000);
      l.total = D(50000);
      l.balance = D(250000);
    });
    await removeDocument(w.db, w.accountant, original.id, { defer: true });
    await addDocuments(w.db, w.accountant, app.id, [{ filename: 'payapp-1-revised.pdf', bytes: await renderPackage(revised, ['pay_application', 'continuation_sheet']) }], { defer: true });
    await processApplication(w.db, w.orgId, app.id);

    const [now] = await w.db.select().from(payAppLines).where(and(eq(payAppLines.payApplicationId, app.id), eq(payAppLines.itemNo, '2')));
    expect(now).toMatchObject({ thisPeriod: D(50000), editKind: null });
    const events = await w.db.select().from(auditEvents).where(and(eq(auditEvents.payApplicationId, app.id), eq(auditEvents.action, 'application.reprocessed')));
    const last = events.sort((a, b) => a.seq - b.seq).at(-1)!;
    expect(last.summary).toMatch(/1 no longer applies because the document changed and was dropped/);
  });

  it('does not apply a reading of a package that changed while it was being read', async () => {
    const w = await createWorld();
    const pkg = packageFor(w, 0, null);
    const bytes = await renderPackage(pkg, ['pay_application', 'continuation_sheet']);
    const { id } = await createApplication(w.db, w.accountant, { files: [{ filename: 'payapp-1.pdf', bytes }], defer: true });
    // A document is added while the first reading is in flight.
    const reading = processApplication(w.db, w.orgId, id, {
      extract: {
        // Slow the read down enough for the upload to land in the middle of it.
        ai: undefined,
      },
    });
    await addDocuments(w.db, w.accountant, id, [{ filename: 'waiver.pdf', bytes: await renderPackage(pkg, ['lien_waiver']) }], { defer: true });
    await reading;
    const mid = await getApp(w, id);
    // Either the first reading finished before the upload (revision 1, then reset to processing by the upload),
    // or it noticed the package had changed and stood down (revision 0). It never applies a partial package.
    expect(mid.status).toBe('processing');
    await processApplication(w.db, w.orgId, id);
    const done = await getApp(w, id);
    expect(done.status).toBe('needs_review');
    expect((await openFindings(w, id)).map((f) => f.code)).not.toContain('lw.present');
  });
});

describe('a corrected resubmission', () => {
  it('replaces the earlier submission instead of sitting beside it', async () => {
    const w = await createWorld();
    const first = await submit(w, packageFor(w, 0, null, (p) => (p.waiver = null)), { now: new Date('2026-10-01T15:00:00Z') });
    const corrected = await submit(w, packageFor(w, 0, null), { now: new Date('2026-10-03T15:00:00Z'), filename: 'payapp-1-corrected.pdf' });
    expect((await openFindings(w, corrected.id)).map((f) => f.code)).toContain('seq.duplicate_number');

    // Only the later one can replace the earlier one, and only within the organisation.
    await expect(supersedeApplication(w.db, w.accountant, first.id, corrected.id)).rejects.toThrow(/arrived after this one/);
    await expect(supersedeApplication(w.db, w.viewer, corrected.id, first.id)).rejects.toThrow();
    await supersedeApplication(w.db, w.accountant, corrected.id, first.id);

    const old = await getApp(w, first.id);
    expect(old).toMatchObject({ status: 'void', supersededById: corrected.id });
    expect(old.decisionNote).toMatch(/Replaced by a corrected submission/);
    expect(await openFindings(w, corrected.id)).toEqual([]);
    // The earlier package is still there to look at.
    expect(await w.db.select().from(documents).where(eq(documents.payApplicationId, first.id))).toHaveLength(1);
  });

  it('will not replace an application that has already been approved', async () => {
    const w = await createWorld();
    const first = await submit(w, packageFor(w, 0, null), { now: new Date('2026-10-01T15:00:00Z') });
    await approveApplication(w.db, w.controller, first.id);
    const again = await submit(w, packageFor(w, 0, null), { now: new Date('2026-10-03T15:00:00Z'), filename: 'payapp-1-again.pdf' });
    await expect(supersedeApplication(w.db, w.controller, again.id, first.id)).rejects.toThrow(/already approved/);
    expect((await getApp(w, first.id)).status).toBe('approved');
  });
});

describe('messages to subcontractors', () => {
  let w: World;
  let appId: string;
  const message = { to: 'maria@lonestarelectric.example', subject: 'Pay application #1: corrections needed', body: 'Please send the conditional waiver for this period.' };
  beforeAll(async () => {
    w = await createWorld();
    appId = (await submit(w, packageFor(w, 0, null, (p) => (p.waiver = null)))).id;
  });

  it('records a message as a draft, never as sent, when no email provider is configured', async () => {
    const result = await sendSubcontractorMessage(w.db, w.accountant, appId, { ...message, hold: true });
    expect(result.status).toBe('not_sent');
    const [row] = await w.db.select().from(communications).where(eq(communications.payApplicationId, appId));
    expect(row).toMatchObject({ status: 'not_sent', provider: null, providerRef: null });
    expect((await getApp(w, appId)).status).toBe('on_hold');
  });

  it('refuses to record the same message twice in a row', async () => {
    await expect(sendSubcontractorMessage(w.db, w.accountant, appId, message)).rejects.toThrow(/already saved on the record as a draft/);
    expect(await w.db.select().from(communications).where(eq(communications.payApplicationId, appId))).toHaveLength(1);
    // A different message is fine.
    await sendSubcontractorMessage(w.db, w.accountant, appId, { ...message, body: 'Please also send the notarised G702.' });
  });

  it('lets only one of two identical simultaneous sends through', async () => {
    const body = 'Following up on the waiver we asked for last week.';
    const results = await Promise.allSettled([sendSubcontractorMessage(w.db, w.accountant, appId, { ...message, body }), sendSubcontractorMessage(w.db, w.controller, appId, { ...message, body })]);
    expect(settled(results).ok).toBe(1);
    const rows = await w.db.select().from(communications).where(and(eq(communications.payApplicationId, appId), eq(communications.body, body)));
    expect(rows).toHaveLength(1);
  });

  it('records an unconfirmed send as such, does not put the application on hold, and will not send it again', async () => {
    const w2 = await createWorld();
    const id = (await submit(w2, packageFor(w2, 0, null, (p) => (p.waiver = null)))).id;
    process.env.RESEND_API_KEY = 're_test_key';
    process.env.EMAIL_FROM = 'ap@northline.example';
    const provider = vi.fn(async () => {
      throw Object.assign(new Error('timed out'), { name: 'TimeoutError' });
    });
    vi.stubGlobal('fetch', provider);
    try {
      const result = await sendSubcontractorMessage(w2.db, w2.accountant, id, { ...message, hold: true });
      expect(result.status).toBe('unconfirmed');
      // Retried once, with the record's id as the key both times.
      expect(provider).toHaveBeenCalledTimes(2);
      const keys = (provider.mock.calls as unknown as Array<[string, RequestInit]>).map((c) => (c[1].headers as Record<string, string>)['Idempotency-Key']);
      const [row] = await w2.db.select().from(communications).where(eq(communications.payApplicationId, id));
      expect(keys).toEqual([row!.id, row!.id]);
      expect(row).toMatchObject({ status: 'unconfirmed', provider: 'resend' });
      expect(row!.error).toMatch(/may have been sent/);
      expect((await getApp(w2, id)).status).not.toBe('on_hold');
      await expect(sendSubcontractorMessage(w2.db, w2.accountant, id, message)).rejects.toThrow(/may already have been sent/);
      expect(provider).toHaveBeenCalledTimes(2);
    } finally {
      vi.unstubAllGlobals();
      delete process.env.RESEND_API_KEY;
      delete process.env.EMAIL_FROM;
    }
  }, 20_000);

  it('will not send wording that says an unapproved application was approved or paid', async () => {
    expect(messageWordingProblem('needs_review', 'Your application has been approved.')).toMatchObject({ level: 'block' });
    expect(messageWordingProblem('on_hold', 'Payment has been sent by ACH.')).toMatchObject({ level: 'block' });
    expect(messageWordingProblem('needs_review', 'We cannot approve it as submitted. Please correct line 2.')).toBeNull();
    expect(messageWordingProblem('approved', 'Your application has been approved for $99,000.00.')).toBeNull();
    // Even once approved, this product cannot know that a payment went out.
    expect(messageWordingProblem('approved', 'Payment was issued on the 15th.')).toMatchObject({ level: 'confirm' });

    await expect(sendSubcontractorMessage(w.db, w.accountant, appId, { ...message, subject: 'Good news', body: 'Your pay application has been approved and payment will be sent Friday.' })).rejects.toThrow(/has not been approved/);
    const rows = await w.db.select().from(communications).where(eq(communications.payApplicationId, appId));
    expect(rows.some((r) => r.subject === 'Good news')).toBe(false);
  });
});

describe('document storage', () => {
  it('keeps documents in the database when asked to, and notices if the bytes change', async () => {
    const before = process.env.RCM_STORAGE;
    process.env.RCM_STORAGE = 'database';
    try {
      expect(storageMode()).toBe('database');
      const db = await getDb();
      const bytes = new Uint8Array(200_000).map((_, i) => (i * 31 + 7) % 256);
      const stored = await putObject('org_storage_test', 'documents', bytes);
      await putObject('org_storage_test', 'documents', bytes); // the same content again is a no-op
      const rows = await db.select({ size: storedObjects.size }).from(storedObjects).where(eq(storedObjects.key, stored.key));
      expect(rows).toEqual([{ size: 200_000 }]);
      expect(Buffer.compare(await getObject(stored.key), Buffer.from(bytes))).toBe(0);

      // Someone edits the stored bytes behind our back.
      await db.update(storedObjects).set({ bytes: new Uint8Array([1, 2, 3]) }).where(eq(storedObjects.key, stored.key));
      await expect(getObject(stored.key)).rejects.toThrow(/integrity check/);
      await expect(getObject(`org_storage_test/documents/${'a'.repeat(64)}`)).rejects.toThrow(/missing/);
      await expect(getObject('../../etc/passwd')).rejects.toThrow(/Invalid storage key/);
    } finally {
      if (before === undefined) delete process.env.RCM_STORAGE;
      else process.env.RCM_STORAGE = before;
    }
  });

  it.runIf(onPostgres)('defaults to the database on PostgreSQL, so uploads live where the backup is', async () => {
    expect(storageMode()).toBe('database');
    const w = await createWorld();
    const app = await submit(w, packageFor(w, 0, null));
    const [doc] = await w.db.select().from(documents).where(eq(documents.payApplicationId, app.id));
    const [row] = await w.db.select({ size: storedObjects.size, orgId: storedObjects.orgId }).from(storedObjects).where(eq(storedObjects.key, doc!.storageKey));
    expect(row).toEqual({ size: doc!.size, orgId: w.orgId });
  });
});

describe.runIf(onPostgres)('a server restart', () => {
  it('loses nothing: records, documents and queued work are all still there afterwards', async () => {
    const w = await createWorld();
    const approved = await submit(w, packageFor(w, 0, null));
    await approveApplication(w.db, w.controller, approved.id);
    const bytes = await renderPackage(packageFor(w, 1, stateAfter(packageFor(w, 0, null))));
    const { id: queued } = await createApplication(w.db, w.accountant, { files: [{ filename: 'payapp-2.pdf', bytes }] }); // queued, never processed

    await closeDb(); // the server goes away with work outstanding

    const db = await getDb(); // and comes back
    const [again] = await db.select().from(payApplications).where(eq(payApplications.id, approved.id));
    expect(again).toMatchObject({ status: 'approved', approvedAmount: D(99000) });
    expect(again!.approvedRecord!.approved.currentPaymentDue).toBe(D(99000));
    expect(await verifyAuditChain(db, w.orgId)).toMatchObject({ ok: true });
    const [doc] = await db.select().from(documents).where(eq(documents.payApplicationId, approved.id));
    expect((await getObject(doc!.storageKey)).byteLength).toBe(doc!.size);

    // The queued package is picked up exactly as the runner does at boot.
    expect((await db.select().from(payApplications).where(eq(payApplications.id, queued)))[0]!.status).toBe('processing');
    await drain(db);
    const [processed] = await db.select().from(payApplications).where(eq(payApplications.id, queued));
    expect(processed).toMatchObject({ status: 'needs_review', applicationNumber: 2, verifiedAmount: D(103500) });
    expect(await db.select().from(findings).where(and(eq(findings.payApplicationId, queued), eq(findings.status, 'open')))).toEqual([]);
  });
});
