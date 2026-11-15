/**
 * Figures for the overview page. Everything is computed from application,
 * contract and finding records at request time; nothing is stored, estimated
 * or illustrative.
 */
import { and, eq, inArray, sql } from 'drizzle-orm';
import type { DB } from '@/db';
import { changeOrders, contracts, findings, memberships, payApplications, projects, subcontractors, users } from '@/db/schema';
import type { Ctx } from '@/server/auth/permissions';
import type { AppStatus, FindingCategory } from '@/server/types';
import { FINDING_CATEGORIES } from '@/server/types';

const OPEN: AppStatus[] = ['needs_matching', 'needs_review', 'pending_approval', 'on_hold'];
const DAY = 86_400_000;
const monthKey = (d: Date | string) => (typeof d === 'string' ? d.slice(0, 7) : d.toISOString().slice(0, 7));

export type Dashboard = Awaited<ReturnType<typeof getDashboard>>;

export async function getDashboard(db: DB, ctx: Ctx, now: Date = new Date()) {
  const apps = await db
    .select({
      id: payApplications.id,
      status: payApplications.status,
      applicationNumber: payApplications.applicationNumber,
      periodTo: payApplications.periodTo,
      receivedAt: payApplications.receivedAt,
      decidedAt: payApplications.decidedAt,
      claimedAmount: payApplications.claimedAmount,
      verifiedAmount: payApplications.verifiedAmount,
      approvedAmount: payApplications.approvedAmount,
      approvedRetainage: payApplications.approvedRetainage,
      approvedRecord: payApplications.approvedRecord,
      openBlocking: payApplications.openBlocking,
      openWarnings: payApplications.openWarnings,
      transferStatus: payApplications.transferStatus,
      assigneeId: payApplications.assigneeId,
      projectId: payApplications.projectId,
      contractId: payApplications.contractId,
      stated: payApplications.stated,
      subcontractorName: subcontractors.name,
      projectName: projects.name,
    })
    .from(payApplications)
    .leftJoin(subcontractors, eq(subcontractors.id, payApplications.subcontractorId))
    .leftJoin(projects, eq(projects.id, payApplications.projectId))
    .where(eq(payApplications.orgId, ctx.orgId));

  const projectRows = await db.select().from(projects).where(eq(projects.orgId, ctx.orgId)).orderBy(projects.name);
  const contractRows = await db.select().from(contracts).where(eq(contracts.orgId, ctx.orgId));
  const approvedCos = await db
    .select({ contractId: changeOrders.contractId, total: sql<number>`coalesce(sum(${changeOrders.amount}), 0)::float8` })
    .from(changeOrders)
    .where(and(eq(changeOrders.orgId, ctx.orgId), eq(changeOrders.status, 'approved')))
    .groupBy(changeOrders.contractId);
  const members = await db
    .select({ userId: users.id, name: users.name })
    .from(memberships)
    .innerJoin(users, eq(users.id, memberships.userId))
    .where(and(eq(memberships.orgId, ctx.orgId), eq(memberships.status, 'active')));

  const live = apps.filter((a) => a.status !== 'void');
  const open = live.filter((a) => (OPEN as string[]).includes(a.status));
  const approved = live.filter((a) => a.status === 'approved');
  const amountOf = (a: (typeof apps)[number]) => a.verifiedAmount ?? a.claimedAmount ?? 0;
  const group = (rows: typeof apps) => ({ count: rows.length, amount: rows.reduce((t, a) => t + amountOf(a), 0) });

  // ── Headline figures ──
  const thisMonth = monthKey(now);
  const lastMonth = monthKey(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 15)));
  const approvedIn = (m: string) => {
    const rows = approved.filter((a) => a.decidedAt && monthKey(a.decidedAt) === m);
    return { count: rows.length, amount: rows.reduce((t, a) => t + (a.approvedAmount ?? 0), 0) };
  };
  const overAsk = open.filter((a) => a.claimedAmount !== null && a.verifiedAmount !== null && a.claimedAmount > a.verifiedAmount && a.status !== 'needs_matching');
  const decidedRecently = live.filter((a) => a.decidedAt && (a.status === 'approved' || a.status === 'rejected') && now.getTime() - a.decidedAt.getTime() <= 90 * DAY);
  const turnaround = decidedRecently.length ? decidedRecently.reduce((t, a) => t + (a.decidedAt!.getTime() - a.receivedAt.getTime()), 0) / decidedRecently.length / DAY : null;
  const shortPaid = approved.filter((a) => (a.approvedRecord?.varianceFromClaimed ?? 0) < 0 && a.decidedAt && now.getTime() - a.decidedAt.getTime() <= 90 * DAY);

  // ── Latest approved position per contract ──
  const latest = new Map<string, (typeof apps)[number]>();
  for (const a of approved) {
    if (!a.contractId || a.applicationNumber === null) continue;
    const cur = latest.get(a.contractId);
    if (!cur || (cur.applicationNumber ?? 0) < a.applicationNumber) latest.set(a.contractId, a);
  }
  const coTotal = new Map(approvedCos.map((c) => [c.contractId, Math.round(c.total)]));
  const retainageHeld = [...latest.values()].reduce((t, a) => t + (a.approvedRetainage ?? 0), 0);

  // ── Billing by period (last six billing months that have data, ending with the latest) ──
  const months: string[] = [];
  const latestPeriod = live.map((a) => a.periodTo).filter((p): p is string => !!p).sort().pop();
  const anchor = latestPeriod ? new Date(`${latestPeriod.slice(0, 7)}-15T00:00:00Z`) : now;
  for (let back = 5; back >= 0; back--) months.push(monthKey(new Date(Date.UTC(anchor.getUTCFullYear(), anchor.getUTCMonth() - back, 15))));
  const firstWith = <T,>(rows: T[], has: (r: T) => boolean) => rows.slice(Math.max(0, rows.findIndex(has)));
  const monthly = firstWith(
    months.map((month) => {
      const inPeriod = live.filter((a) => a.periodTo?.slice(0, 7) === month && a.status !== 'rejected' && a.status !== 'needs_matching');
      return {
        month,
        requested: inPeriod.reduce((t, a) => t + (a.claimedAmount ?? 0), 0),
        approved: inPeriod.filter((a) => a.status === 'approved').reduce((t, a) => t + (a.approvedAmount ?? 0), 0),
        applications: inPeriod.length,
        undecided: inPeriod.filter((a) => a.status !== 'approved').length,
      };
    }),
    (m) => m.applications > 0,
  );

  // ── Turnaround by the month the decision was made (six calendar months to date) ──
  const turnaroundTrend = firstWith(
    Array.from({ length: 6 }, (_, i) => monthKey(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - (5 - i), 15)))).map((month) => {
      const decided = live.filter((a) => a.decidedAt && monthKey(a.decidedAt) === month && (a.status === 'approved' || a.status === 'rejected'));
      return {
        month,
        value: decided.length ? decided.reduce((t, a) => t + (a.decidedAt!.getTime() - a.receivedAt.getTime()), 0) / decided.length / DAY : null,
        sample: decided.length,
      };
    }),
    (m) => m.sample > 0,
  );

  // ── Pipeline ──
  const pipeline = (['needs_matching', 'needs_review', 'pending_approval', 'on_hold'] as AppStatus[]).map((status) => ({ status, ...group(open.filter((a) => a.status === status)) }));

  // ── Open findings by category ──
  const openIds = open.map((a) => a.id);
  const openFindings = openIds.length
    ? await db
        .select({ category: findings.category, severity: findings.severity, n: sql<number>`count(*)::int` })
        .from(findings)
        .where(and(eq(findings.orgId, ctx.orgId), eq(findings.status, 'open'), inArray(findings.payApplicationId, openIds), inArray(findings.severity, ['blocking', 'warning'])))
        .groupBy(findings.category, findings.severity)
    : [];
  const findingsByCategory = FINDING_CATEGORIES.map((category: FindingCategory) => ({
    category,
    blocking: openFindings.find((f) => f.category === category && f.severity === 'blocking')?.n ?? 0,
    warnings: openFindings.find((f) => f.category === category && f.severity === 'warning')?.n ?? 0,
  }))
    .filter((c) => c.blocking + c.warnings > 0)
    .sort((a, b) => b.blocking + b.warnings - (a.blocking + a.warnings));

  // ── Projects ──
  const projectSummaries = projectRows.map((p) => {
    const cs = contractRows.filter((c) => c.projectId === p.id);
    const committed = cs.reduce((t, c) => t + c.originalAmount + (coTotal.get(c.id) ?? 0), 0);
    const positions = cs.map((c) => latest.get(c.id)?.approvedRecord?.approved).filter((x): x is NonNullable<typeof x> => !!x);
    const completed = positions.reduce((t, a) => t + a.totalCompletedStored, 0);
    const earned = positions.reduce((t, a) => t + a.totalEarnedLessRetainage, 0);
    return {
      id: p.id,
      name: p.name,
      number: p.number,
      state: p.state,
      contracts: cs.length,
      committed,
      completed,
      percent: committed ? Math.round((completed / committed) * 1000) / 10 : null,
      approvedToDate: earned,
      retainageHeld: positions.reduce((t, a) => t + a.retainageTotal, 0),
      balanceToFinish: committed - earned,
      openApplications: open.filter((a) => a.projectId === p.id).length,
    };
  });

  // ── Team workload ──
  const byAssignee = new Map<string | null, typeof apps>();
  for (const a of open) byAssignee.set(a.assigneeId, [...(byAssignee.get(a.assigneeId) ?? []), a]);
  const workload = [...byAssignee.entries()]
    .map(([userId, rows]) => ({
      userId,
      name: userId ? (members.find((m) => m.userId === userId)?.name ?? 'Former member') : 'Unassigned',
      ...group(rows),
      blocking: rows.reduce((t, a) => t + a.openBlocking, 0),
      oldestDays: Math.max(...rows.map((a) => Math.floor((now.getTime() - a.receivedAt.getTime()) / DAY))),
    }))
    .sort((a, b) => (a.userId === null ? 1 : b.userId === null ? -1 : b.count - a.count));

  // ── Oldest open work ──
  const attention = [...open]
    .sort((a, b) => a.receivedAt.getTime() - b.receivedAt.getTime())
    .slice(0, 6)
    .map((a) => ({
      id: a.id,
      subcontractor: a.subcontractorName ?? a.stated?.contractorName ?? 'Unidentified',
      project: a.projectName,
      applicationNumber: a.applicationNumber,
      status: a.status,
      amount: a.claimedAmount,
      ageDays: Math.floor((now.getTime() - a.receivedAt.getTime()) / DAY),
      blocking: a.openBlocking,
      warnings: a.openWarnings,
    }));

  const awaitingTransfer = approved.filter((a) => a.transferStatus === 'none' || a.transferStatus === 'failed');

  return {
    setup: { projects: projectRows.length, contracts: contractRows.length, applications: live.length, members: members.length, approved: approved.length },
    kpis: {
      awaitingReview: group(open.filter((a) => a.status === 'needs_review' || a.status === 'needs_matching')),
      pendingApproval: group(open.filter((a) => a.status === 'pending_approval')),
      onHold: group(open.filter((a) => a.status === 'on_hold')),
      approvedThisMonth: approvedIn(thisMonth),
      approvedLastMonth: approvedIn(lastMonth),
      overAsk: { count: overAsk.length, amount: overAsk.reduce((t, a) => t + (a.claimedAmount! - a.verifiedAmount!), 0) },
      shortPaid: { count: shortPaid.length, amount: shortPaid.reduce((t, a) => t - (a.approvedRecord?.varianceFromClaimed ?? 0), 0) },
      retainageHeld,
      turnaroundDays: turnaround,
      turnaroundSample: decidedRecently.length,
      awaitingTransfer: { count: awaitingTransfer.length, amount: awaitingTransfer.reduce((t, a) => t + (a.approvedAmount ?? 0), 0) },
      failedTransfers: approved.filter((a) => a.transferStatus === 'failed').length,
    },
    monthly,
    turnaroundTrend,
    pipeline,
    findingsByCategory,
    projects: projectSummaries,
    workload,
    attention,
  };
}
