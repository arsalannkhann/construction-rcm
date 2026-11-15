/**
 * A change either happens completely or not at all. Here a failure is forced
 * late in a service (after the status change and the audit event have been
 * written) and nothing may be left behind.
 */
import { and, eq } from 'drizzle-orm';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { auditEvents, payAppLines } from '@/db/schema';
import { verifyAuditChain } from '@/server/audit';

const fail = { notifyUsers: false };
vi.mock('@/server/services/notify', async (original) => {
  const real = await original<typeof import('@/server/services/notify')>();
  return {
    ...real,
    notifyUsers: vi.fn((...args: Parameters<typeof real.notifyUsers>) => {
      if (fail.notifyUsers) return Promise.reject(new Error('simulated crash after the status change'));
      return real.notifyUsers(...args);
    }),
  };
});

const { rejectApplication, approveApplication, updateLine } = await import('@/server/services/review');
const { createWorld, dollars: D, getApp, packageFor, submit } = await import('./helpers/world');
type World = Awaited<ReturnType<typeof createWorld>>;

describe('a failure part-way through a change', () => {
  let w: World;
  beforeAll(async () => {
    w = await createWorld();
  });

  it('rolls back a rejection whose last step fails: no status change, no audit event', async () => {
    const app = await submit(w, packageFor(w, 0, null));
    const before = await getApp(w, app.id);
    const eventsBefore = await w.db.select().from(auditEvents).where(eq(auditEvents.orgId, w.orgId));

    fail.notifyUsers = true;
    await expect(rejectApplication(w.db, w.controller, app.id, 'Duplicate of last month')).rejects.toThrow(/simulated crash/);
    fail.notifyUsers = false;

    const after = await getApp(w, app.id);
    expect(after).toMatchObject({ status: 'needs_review', decidedAt: null, decidedBy: null, decisionNote: null, version: before.version });
    const eventsAfter = await w.db.select().from(auditEvents).where(eq(auditEvents.orgId, w.orgId));
    expect(eventsAfter).toHaveLength(eventsBefore.length);
    expect(eventsAfter.some((e) => e.action === 'application.rejected')).toBe(false);
    expect(await verifyAuditChain(w.db, w.orgId)).toMatchObject({ ok: true });

    // The same action works once the fault is gone, and is recorded once.
    await rejectApplication(w.db, w.controller, app.id, 'Duplicate of last month');
    expect((await getApp(w, app.id)).status).toBe('rejected');
    const rejected = await w.db.select().from(auditEvents).where(and(eq(auditEvents.payApplicationId, app.id), eq(auditEvents.action, 'application.rejected')));
    expect(rejected).toHaveLength(1);
  });

  it('rolls back an approval whose notification step fails: the record is not half-approved', async () => {
    const w2 = await createWorld();
    const app = await submit(w2, packageFor(w2, 0, null));
    // Give the approval someone to notify, so the failing step is reached.
    const { assignReviewer } = await import('@/server/services/review');
    await assignReviewer(w2.db, w2.controller, app.id, w2.accountant.userId);

    fail.notifyUsers = true;
    await expect(approveApplication(w2.db, w2.controller, app.id)).rejects.toThrow(/simulated crash/);
    fail.notifyUsers = false;

    const after = await getApp(w2, app.id);
    expect(after).toMatchObject({ status: 'needs_review', approvedAmount: null, approvedRecord: null, decidedAt: null });
    const approvals = await w2.db.select().from(auditEvents).where(and(eq(auditEvents.payApplicationId, app.id), eq(auditEvents.action, 'application.approved')));
    expect(approvals).toEqual([]);

    const record = await approveApplication(w2.db, w2.controller, app.id);
    expect(record.approved.currentPaymentDue).toBe(D(99000));
    expect(await verifyAuditChain(w2.db, w2.orgId)).toMatchObject({ ok: true });
  });

  it('rolls back a line edit when re-checking the application fails', async () => {
    const w3 = await createWorld();
    const app = await submit(w3, packageFor(w3, 0, null));
    const [line] = await w3.db.select().from(payAppLines).where(and(eq(payAppLines.payApplicationId, app.id), eq(payAppLines.itemNo, '2')));
    const reconcile = await import('@/server/recon/engine');
    const spy = vi.spyOn(reconcile, 'reconcile').mockImplementationOnce(() => {
      throw new Error('simulated failure while re-checking');
    });
    await expect(updateLine(w3.db, w3.accountant, line!.id, { thisPeriod: D(10000) }, 'adjustment', 'Testing rollback')).rejects.toThrow(/simulated failure/);
    spy.mockRestore();

    const [after] = await w3.db.select().from(payAppLines).where(eq(payAppLines.id, line!.id));
    expect(after).toMatchObject({ thisPeriod: D(60000), editKind: null, editNote: null });
    expect((await getApp(w3, app.id)).verifiedAmount).toBe(D(99000));
    const edits = await w3.db.select().from(auditEvents).where(and(eq(auditEvents.payApplicationId, app.id), eq(auditEvents.action, 'line.adjusted')));
    expect(edits).toEqual([]);
  });
});
