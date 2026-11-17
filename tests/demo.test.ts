/**
 * Builds the whole demo workspace against an in-memory database. Because the
 * demo is produced by the real pipeline, this doubles as a broad regression
 * test: ~40 generated packages across Texas, California and Florida go through
 * intake, reading, matching, reconciliation, approval and export.
 */
import { and, eq } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import { getDb, type DB } from '@/db';
import { auditEvents, findings, organizations, payApplications, projects, transfers, users } from '@/db/schema';
import { verifyAuditChain } from '@/server/audit';
import { createDemoWorkspace, deleteDemoWorkspace, listDemoSamples, renderDemoSample } from '@/server/services/demo';
import { createApplication, processApplication } from '@/server/services/intake';
import { getOwnerApplication, getOwnerBilling, startOwnerApplication } from '@/server/services/owner-billing';
import { signUp } from '@/server/services/team';
import type { Ctx } from '@/server/auth/permissions';

let db: DB;
let userId: string;
let realOrgId: string;
let demoOrgId: string;
let ctx: Ctx;

beforeAll(async () => {
  db = await getDb();
  const account = await signUp(db, { name: 'Casey Founder', email: 'casey@example.test', password: 'correct horse battery', orgName: 'Real Builders Inc' });
  userId = account.userId;
  realOrgId = account.orgId;
  const result = await createDemoWorkspace(db, userId, new Date('2026-11-15T16:00:00Z'));
  demoOrgId = result.orgId;
  ctx = { orgId: demoOrgId, orgName: 'Northline Constructors (Demo)', isDemo: true, userId, userName: 'Casey Founder', userEmail: 'casey@example.test', role: 'owner' };
}, 240_000);

describe('demo workspace', () => {
  it('is a separate organisation, flagged as a demo', async () => {
    const [org] = await db.select().from(organizations).where(eq(organizations.id, demoOrgId));
    expect(org).toMatchObject({ isDemo: true });
    expect(demoOrgId).not.toBe(realOrgId);
    const inReal = await db.select().from(payApplications).where(eq(payApplications.orgId, realOrgId));
    expect(inReal).toEqual([]);
  });

  it('is idempotent per user', async () => {
    expect(await createDemoWorkspace(db, userId)).toEqual({ orgId: demoOrgId, created: false });
  });

  it('contains a realistic spread of applications, each produced by the pipeline', async () => {
    const apps = await db.select().from(payApplications).where(eq(payApplications.orgId, demoOrgId));
    const byStatus = apps.reduce<Record<string, number>>((acc, a) => ({ ...acc, [a.status]: (acc[a.status] ?? 0) + 1 }), {});
    expect(byStatus).toEqual({ approved: 29, rejected: 1, needs_review: 3, pending_approval: 1, on_hold: 1, needs_matching: 1 });
    expect(apps.every((a) => a.engine === 'text-layer' && a.revision === 1)).toBe(true);
    // Approved history is clean: nothing was approved over an open blocking finding.
    const approved = apps.filter((a) => a.status === 'approved');
    expect(approved.every((a) => a.approvedRecord && a.approvedAmount !== null && a.openBlocking === 0)).toBe(true);
    // Timestamps are in the past and decisions follow receipt.
    expect(approved.every((a) => a.decidedAt! > a.receivedAt && a.decidedAt! < new Date('2026-11-15T16:00:01Z'))).toBe(true);
  });

  it('shows the intended discrepancy on each open application', async () => {
    const apps = await db.select().from(payApplications).where(eq(payApplications.orgId, demoOrgId));
    const openCodes = async (contractNumber: string) => {
      const app = apps.find((a) => a.approvedRecord === null && a.stated?.contractNumber === contractNumber && a.status !== 'rejected');
      const rows = await db.select().from(findings).where(and(eq(findings.payApplicationId, app!.id), eq(findings.status, 'open')));
      return { app: app!, codes: rows.map((f) => f.code).sort() };
    };
    const electric = await openCodes('SC-2301-16');
    expect(electric.codes).toEqual(['lw.amount_vs_verified', 'pay.current_due', 'prior.previous_certificates']);
    expect(electric.app.claimedAmount! - electric.app.verifiedAmount!).toBe(1_840_000);

    const mechanical = await openCodes('SC-2301-15');
    // Withholding at half the rate also means retainage held would fall below last month's.
    expect(mechanical.codes).toEqual(['lw.amount_vs_verified', 'pay.current_due', 'ret.amount', 'ret.release']);

    const steel = await openCodes('SC-2305-05');
    expect(steel.codes).toEqual(['co.net_change', 'lw.amount_vs_verified', 'pay.current_due', 'sov.unknown_line']);

    const roofing = await openCodes('SC-2305-07');
    expect(roofing.app.status).toBe('on_hold');
    expect(roofing.codes).toEqual(expect.arrayContaining(['math.earned', 'lw.amount']));

    const concrete = await openCodes('SC-2301-03');
    expect(concrete.app.status).toBe('pending_approval');
    expect(concrete.codes).toEqual([]);
  });

  it('records exports and keeps an intact audit chain in chronological order', async () => {
    const exported = await db.select().from(transfers).where(eq(transfers.orgId, demoOrgId));
    // Every historical approval was handed over as a CSV; the latest also has its PDF record and a summary file.
    expect(exported.filter((t) => t.kind === 'csv')).toHaveLength(28);
    expect(exported.filter((t) => t.kind === 'pdf')).toHaveLength(1);
    expect(exported.every((t) => t.status === 'completed' && t.sha256)).toBe(true);
    const waiting = (await db.select().from(payApplications).where(eq(payApplications.orgId, demoOrgId))).filter((a) => a.status === 'approved' && a.transferStatus === 'none');
    expect(waiting).toHaveLength(1);
    expect(await verifyAuditChain(db, demoOrgId)).toMatchObject({ ok: true });
    const events = await db.select({ seq: auditEvents.seq, at: auditEvents.createdAt }).from(auditEvents).where(eq(auditEvents.orgId, demoOrgId));
    events.sort((a, b) => a.seq - b.seq);
    const outOfOrder = events.filter((e, i) => i > 0 && e.at.getTime() < events[i - 1]!.at.getTime() - 60 * 60 * 1000);
    expect(outOfOrder).toEqual([]);
  });

  it('offers sample packages that behave as described when uploaded', async () => {
    const samples = await listDemoSamples(db, ctx);
    expect(samples.map((s) => s.key)).toEqual(['clean', 'discrepancies', 'scan']);

    const upload = async (key: string) => {
      const sample = await renderDemoSample(db, ctx, key);
      const { id } = await createApplication(db, ctx, { files: [{ filename: sample.filename, bytes: sample.bytes }], defer: true });
      await processApplication(db, demoOrgId, id);
      const [app] = await db.select().from(payApplications).where(eq(payApplications.id, id));
      const open = await db.select().from(findings).where(and(eq(findings.payApplicationId, id), eq(findings.status, 'open')));
      return { app: app!, codes: open.map((f) => f.code).sort() };
    };

    const bad = await upload('discrepancies');
    expect(bad.app.status).toBe('needs_review');
    expect(bad.app.stated?.contractNumber).toBe('SC-2312-22');
    expect(bad.codes).toEqual(expect.arrayContaining(['prior.previous_certificates', 'ret.amount', 'pay.current_due', 'lw.amount']));
  });

  it('has an owner contract on Riverside that bills cleanly from the approved subcontractor billing', async () => {
    const [riverside] = await db.select().from(projects).where(and(eq(projects.orgId, demoOrgId), eq(projects.number, '2301')));
    const billing = (await getOwnerBilling(db, ctx, riverside!.id))!;
    expect(billing.prime).toMatchObject({ number: 'OC-2301', contractSumToDate: 831_340_000 });
    expect(billing.lines.map((l) => [l.itemNo, l.basis, l.contractIds.length])).toEqual([
      ['1', 'manual', 0],
      ['2', 'subcontracts', 1],
      ['3', 'subcontracts', 1],
      ['4', 'subcontracts', 1],
      ['5', 'overall', 0],
      ['6', 'overall', 0],
    ]);
    expect(billing.applications).toEqual([]);
    // Every subcontract on the project is on the owner schedule, so the draft has nothing blocking.
    const appId = await startOwnerApplication(db, ctx, riverside!.id, '2026-10-31');
    const { computed } = (await getOwnerApplication(db, ctx, appId))!;
    expect(computed.checks.filter((c) => c.severity === 'blocking')).toEqual([]);
    expect(computed.checks.some((c) => c.code === 'source.unlinked' || c.code === 'line.unlinked')).toBe(false);
    expect(computed.header.contractSumToDate).toBe(831_340_000);
    expect(computed.header.currentPaymentDue).toBeGreaterThan(0);
    expect(computed.lines.filter((l) => l.basis === 'subcontracts').every((l) => l.total > 0 && l.total <= l.scheduledValue)).toBe(true);
  });

  it('can be deleted without touching the real organisation', async () => {
    await expect(deleteDemoWorkspace(db, { ...ctx, orgId: realOrgId, isDemo: false })).rejects.toThrow(/Only a demo workspace/);
    await deleteDemoWorkspace(db, ctx);
    expect(await db.select().from(organizations).where(eq(organizations.id, demoOrgId))).toEqual([]);
    expect(await db.select().from(payApplications).where(eq(payApplications.orgId, demoOrgId))).toEqual([]);
    expect(await db.select().from(organizations).where(eq(organizations.id, realOrgId))).toHaveLength(1);
    const fictitious = (await db.select().from(users)).filter((u) => u.email.endsWith('.invalid'));
    expect(fictitious).toEqual([]);
  });
});
