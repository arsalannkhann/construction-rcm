/** Read models for projects, subcontractors and contracts. Always scoped to ctx.orgId. */
import { and, asc, desc, eq, inArray, ne, sql } from 'drizzle-orm';
import { sum } from '@/lib/money';
import type { DB } from '@/db';
import { changeOrders, contracts, memberships, payApplications, projects, retainageReleases, sovLines, subcontractors, users } from '@/db/schema';
import type { Ctx } from '@/server/auth/permissions';
import { OPEN_STATUSES } from '@/server/types';

export async function listSubcontractors(db: DB, ctx: Ctx) {
  const rows = await db.select().from(subcontractors).where(eq(subcontractors.orgId, ctx.orgId)).orderBy(subcontractors.name);
  const contractCounts = await db
    .select({ id: contracts.subcontractorId, n: sql<number>`count(*)::int`, value: sql<number>`coalesce(sum(${contracts.originalAmount}), 0)::float8` })
    .from(contracts)
    .where(eq(contracts.orgId, ctx.orgId))
    .groupBy(contracts.subcontractorId);
  const open = await db
    .select({ id: payApplications.subcontractorId, n: sql<number>`count(*)::int` })
    .from(payApplications)
    .where(and(eq(payApplications.orgId, ctx.orgId), sql`${payApplications.status} in ('needs_review', 'pending_approval', 'on_hold')`))
    .groupBy(payApplications.subcontractorId);
  return rows.map((s) => ({
    ...s,
    contracts: contractCounts.find((c) => c.id === s.id)?.n ?? 0,
    contractValue: Math.round(contractCounts.find((c) => c.id === s.id)?.value ?? 0),
    openApplications: open.find((o) => o.id === s.id)?.n ?? 0,
  }));
}

// ── Where a contract stands ─────────────────────────────────────────────────

/**
 * The financial position of one subcontract. The contract side (original
 * amount, change orders) is read live; the billing side is cumulative as of the
 * latest approved application and is zero until one has been approved.
 */
export type ContractPosition = {
  originalAmount: number;
  /** Net of the change orders approved on the contract. */
  approvedChangeOrders: number;
  /** Original amount plus approved change orders. */
  contractSum: number;
  /** Payments approved so far: the approved amount of every approved application. */
  approvedToDate: number;
  /** Total completed and stored to date, per the latest approved application. */
  completedStored: number;
  /** Retainage held, per the latest approved application. */
  retainageHeld: number;
  /** Total earned less retainage, per the latest approved application. */
  earnedLessRetainage: number;
  /** Contract sum to date less total earned less retainage, so it includes retainage. */
  balanceToFinish: number;
  latestApproved: { id: string; applicationNumber: number | null; periodTo: string | null } | null;
};

async function loadPositions(db: DB, ctx: Ctx, rows: Array<{ id: string; originalAmount: number }>): Promise<Map<string, ContractPosition>> {
  const positions = new Map<string, ContractPosition>();
  if (rows.length === 0) return positions;
  const ids = rows.map((r) => r.id);

  const approvedCos = await db
    .select({ contractId: changeOrders.contractId, amount: changeOrders.amount })
    .from(changeOrders)
    .where(and(eq(changeOrders.orgId, ctx.orgId), inArray(changeOrders.contractId, ids), eq(changeOrders.status, 'approved')));

  const approvedApps = await db
    .select({
      id: payApplications.id,
      contractId: payApplications.contractId,
      applicationNumber: payApplications.applicationNumber,
      periodTo: payApplications.periodTo,
      decidedAt: payApplications.decidedAt,
      approvedAmount: payApplications.approvedAmount,
      approvedRetainage: payApplications.approvedRetainage,
    })
    .from(payApplications)
    .where(and(eq(payApplications.orgId, ctx.orgId), inArray(payApplications.contractId, ids), eq(payApplications.status, 'approved')));

  // Cumulative figures come from the approved application with the highest number, as verification does.
  type Approved = (typeof approvedApps)[number];
  const later = (a: Approved, b: Approved) =>
    (a.applicationNumber ?? -1) !== (b.applicationNumber ?? -1) ? (a.applicationNumber ?? -1) > (b.applicationNumber ?? -1) : (a.decidedAt?.getTime() ?? 0) > (b.decidedAt?.getTime() ?? 0);
  const latest = new Map<string, Approved>();
  for (const app of approvedApps) {
    if (!app.contractId) continue;
    const current = latest.get(app.contractId);
    if (!current || later(app, current)) latest.set(app.contractId, app);
  }
  const latestIds = [...latest.values()].map((a) => a.id);
  const records = latestIds.length
    ? await db
        .select({ id: payApplications.id, record: payApplications.approvedRecord })
        .from(payApplications)
        .where(and(eq(payApplications.orgId, ctx.orgId), inArray(payApplications.id, latestIds)))
    : [];

  for (const row of rows) {
    const approvedChangeOrders = sum(approvedCos.filter((c) => c.contractId === row.id).map((c) => c.amount));
    const contractSum = row.originalAmount + approvedChangeOrders;
    const last = latest.get(row.id) ?? null;
    const figures = last ? records.find((r) => r.id === last.id)?.record?.approved : undefined;
    const earnedLessRetainage = figures?.totalEarnedLessRetainage ?? 0;
    positions.set(row.id, {
      originalAmount: row.originalAmount,
      approvedChangeOrders,
      contractSum,
      approvedToDate: sum(approvedApps.filter((a) => a.contractId === row.id).map((a) => a.approvedAmount)),
      completedStored: figures?.totalCompletedStored ?? 0,
      retainageHeld: last?.approvedRetainage ?? figures?.retainageTotal ?? 0,
      earnedLessRetainage,
      balanceToFinish: contractSum - earnedLessRetainage,
      latestApproved: last ? { id: last.id, applicationNumber: last.applicationNumber, periodTo: last.periodTo } : null,
    });
  }
  return positions;
}

// ── Projects ────────────────────────────────────────────────────────────────

export type ProjectListRow = Awaited<ReturnType<typeof listProjects>>[number];

export async function listProjects(db: DB, ctx: Ctx) {
  // Active projects first, then by name.
  const rows = await db.select().from(projects).where(eq(projects.orgId, ctx.orgId)).orderBy(asc(projects.status), asc(projects.name));
  if (rows.length === 0) return [];

  const contractRows = await db
    .select({ id: contracts.id, projectId: contracts.projectId, originalAmount: contracts.originalAmount })
    .from(contracts)
    .where(eq(contracts.orgId, ctx.orgId));
  const approvedCos = await db
    .select({ contractId: changeOrders.contractId, total: sql<number>`coalesce(sum(${changeOrders.amount}), 0)::bigint`.mapWith(Number) })
    .from(changeOrders)
    .where(and(eq(changeOrders.orgId, ctx.orgId), eq(changeOrders.status, 'approved')))
    .groupBy(changeOrders.contractId);
  const approved = await db
    .select({ contractId: payApplications.contractId, total: sql<number>`coalesce(sum(${payApplications.approvedAmount}), 0)::bigint`.mapWith(Number) })
    .from(payApplications)
    .where(and(eq(payApplications.orgId, ctx.orgId), eq(payApplications.status, 'approved')))
    .groupBy(payApplications.contractId);
  const inReview = await db
    .select({ projectId: payApplications.projectId, n: sql<number>`count(*)::int` })
    .from(payApplications)
    .where(and(eq(payApplications.orgId, ctx.orgId), inArray(payApplications.status, OPEN_STATUSES)))
    .groupBy(payApplications.projectId);

  return rows.map((p) => {
    const mine = contractRows.filter((c) => c.projectId === p.id);
    const contractIds = new Set(mine.map((c) => c.id));
    return {
      ...p,
      contracts: mine.length,
      /** Original contract amounts plus approved change orders. */
      committed: sum(mine.map((c) => c.originalAmount)) + sum(approvedCos.filter((c) => contractIds.has(c.contractId)).map((c) => c.total)),
      /** Payments approved so far across the project's subcontracts. */
      approvedToDate: sum(approved.filter((a) => a.contractId && contractIds.has(a.contractId)).map((a) => a.total)),
      /** Applications that are matched to this project and not yet decided. */
      inReview: inReview.find((r) => r.projectId === p.id)?.n ?? 0,
    };
  });
}

export type ProjectDetail = NonNullable<Awaited<ReturnType<typeof getProjectDetail>>>;

/** One project with its subcontracts and recent applications. Null if it is not in this organisation. */
export async function getProjectDetail(db: DB, ctx: Ctx, id: string) {
  const [project] = await db.select().from(projects).where(and(eq(projects.orgId, ctx.orgId), eq(projects.id, id)));
  if (!project) return null;

  const contractRows = await db
    .select({
      id: contracts.id,
      number: contracts.number,
      title: contracts.title,
      status: contracts.status,
      originalAmount: contracts.originalAmount,
      subcontractorId: subcontractors.id,
      subcontractorName: subcontractors.name,
    })
    .from(contracts)
    .innerJoin(subcontractors, eq(subcontractors.id, contracts.subcontractorId))
    .where(and(eq(contracts.orgId, ctx.orgId), eq(contracts.projectId, id)))
    .orderBy(asc(subcontractors.name), asc(contracts.number));
  const positions = await loadPositions(db, ctx, contractRows);

  // The most recently received application on each subcontract, ignoring voided ones.
  const received = contractRows.length
    ? await db
        .select({ id: payApplications.id, contractId: payApplications.contractId, status: payApplications.status, applicationNumber: payApplications.applicationNumber })
        .from(payApplications)
        .where(and(eq(payApplications.orgId, ctx.orgId), inArray(payApplications.contractId, contractRows.map((c) => c.id)), ne(payApplications.status, 'void')))
        .orderBy(desc(payApplications.receivedAt))
    : [];

  const subcontracts = contractRows.map((c) => {
    const latest = received.find((a) => a.contractId === c.id);
    return {
      ...c,
      ...positions.get(c.id)!,
      latestApplication: latest ? { id: latest.id, status: latest.status, applicationNumber: latest.applicationNumber } : null,
    };
  });

  const applications = await db
    .select({
      id: payApplications.id,
      status: payApplications.status,
      applicationNumber: payApplications.applicationNumber,
      periodTo: payApplications.periodTo,
      receivedAt: payApplications.receivedAt,
      claimedAmount: payApplications.claimedAmount,
      approvedAmount: payApplications.approvedAmount,
      subcontractorName: subcontractors.name,
      contractNumber: contracts.number,
    })
    .from(payApplications)
    .leftJoin(subcontractors, eq(subcontractors.id, payApplications.subcontractorId))
    .leftJoin(contracts, eq(contracts.id, payApplications.contractId))
    .where(and(eq(payApplications.orgId, ctx.orgId), eq(payApplications.projectId, id)))
    .orderBy(desc(payApplications.receivedAt))
    .limit(10);

  return {
    project,
    totals: {
      /** Contract sums to date: original amounts plus approved change orders. */
      committed: sum(subcontracts.map((c) => c.contractSum)),
      approvedToDate: sum(subcontracts.map((c) => c.approvedToDate)),
      retainageHeld: sum(subcontracts.map((c) => c.retainageHeld)),
      balanceToFinish: sum(subcontracts.map((c) => c.balanceToFinish)),
    },
    contracts: subcontracts,
    applications,
  };
}

// ── Contracts ───────────────────────────────────────────────────────────────

export type ContractDetail = NonNullable<Awaited<ReturnType<typeof getContractDetail>>>;

/** One subcontract with its schedule, change orders and billing history. Null if it is not in this organisation. */
export async function getContractDetail(db: DB, ctx: Ctx, id: string) {
  const [contract] = await db.select().from(contracts).where(and(eq(contracts.orgId, ctx.orgId), eq(contracts.id, id)));
  if (!contract) return null;
  const [project] = await db
    .select({ id: projects.id, name: projects.name, number: projects.number, state: projects.state, status: projects.status })
    .from(projects)
    .where(and(eq(projects.orgId, ctx.orgId), eq(projects.id, contract.projectId)));
  const [subcontractor] = await db
    .select({ id: subcontractors.id, name: subcontractors.name, trade: subcontractors.trade })
    .from(subcontractors)
    .where(and(eq(subcontractors.orgId, ctx.orgId), eq(subcontractors.id, contract.subcontractorId)));
  if (!project || !subcontractor) return null;

  const lines = await db
    .select({ id: sovLines.id, itemNo: sovLines.itemNo, description: sovLines.description, scheduledValue: sovLines.scheduledValue, sortOrder: sovLines.sortOrder, changeOrderId: sovLines.changeOrderId })
    .from(sovLines)
    .where(and(eq(sovLines.orgId, ctx.orgId), eq(sovLines.contractId, id)))
    .orderBy(asc(sovLines.sortOrder), asc(sovLines.createdAt));
  // The contract's own lines first, then the lines that exist because of change orders.
  const schedule = [...lines.filter((l) => !l.changeOrderId), ...lines.filter((l) => l.changeOrderId)];

  const cos = await db
    .select({ id: changeOrders.id, number: changeOrders.number, title: changeOrders.title, amount: changeOrders.amount, status: changeOrders.status, approvedOn: changeOrders.approvedOn })
    .from(changeOrders)
    .where(and(eq(changeOrders.orgId, ctx.orgId), eq(changeOrders.contractId, id)))
    .orderBy(asc(changeOrders.createdAt), asc(changeOrders.number));

  const history = await db
    .select({
      id: payApplications.id,
      status: payApplications.status,
      applicationNumber: payApplications.applicationNumber,
      periodTo: payApplications.periodTo,
      receivedAt: payApplications.receivedAt,
      claimedAmount: payApplications.claimedAmount,
      approvedAmount: payApplications.approvedAmount,
      approvedRetainage: payApplications.approvedRetainage,
      decidedAt: payApplications.decidedAt,
    })
    .from(payApplications)
    .where(and(eq(payApplications.orgId, ctx.orgId), eq(payApplications.contractId, id)))
    .orderBy(desc(payApplications.receivedAt));
  // Newest application number first; anything not yet numbered sits on top.
  const applications = [...history].sort((a, b) => (b.applicationNumber ?? Number.MAX_SAFE_INTEGER) - (a.applicationNumber ?? Number.MAX_SAFE_INTEGER) || b.receivedAt.getTime() - a.receivedAt.getTime());

  const position = (await loadPositions(db, ctx, [contract])).get(contract.id)!;

  let baseline: {
    asOfApplicationNumber: number;
    previousCertificates: number;
    retainageHeld: number | null;
    setAt: string;
    setByName: string | null;
    sourceApplication: { id: string; applicationNumber: number | null } | null;
  } | null = null;
  if (contract.baseline) {
    const b = contract.baseline;
    const [setBy] = b.setBy
      ? await db
          .select({ name: users.name })
          .from(users)
          .innerJoin(memberships, eq(memberships.userId, users.id))
          .where(and(eq(memberships.orgId, ctx.orgId), eq(users.id, b.setBy)))
      : [];
    const source = b.sourceApplicationId ? history.find((a) => a.id === b.sourceApplicationId) : undefined;
    baseline = {
      asOfApplicationNumber: b.asOfApplicationNumber,
      previousCertificates: b.previousCertificates,
      retainageHeld: b.retainageHeld,
      setAt: b.setAt,
      setByName: setBy?.name ?? null,
      sourceApplication: source ? { id: source.id, applicationNumber: source.applicationNumber } : null,
    };
  }

  // Retainage releases. One is "billed" once an approval has counted it: the same rule that stops it being cancelled.
  const releaseRows = await db
    .select({
      id: retainageReleases.id,
      amount: retainageReleases.amount,
      effectiveOn: retainageReleases.effectiveOn,
      note: retainageReleases.note,
      status: retainageReleases.status,
      createdAt: retainageReleases.createdAt,
      createdBy: retainageReleases.createdBy,
      voidedBy: retainageReleases.voidedBy,
      voidedAt: retainageReleases.voidedAt,
    })
    .from(retainageReleases)
    .where(and(eq(retainageReleases.orgId, ctx.orgId), eq(retainageReleases.contractId, id)))
    .orderBy(desc(retainageReleases.effectiveOn), desc(retainageReleases.createdAt));
  const releasePeople = [...new Set(releaseRows.flatMap((r) => [r.createdBy, r.voidedBy]).filter((x): x is string => !!x))];
  const names = releasePeople.length
    ? new Map(
        (
          await db
            .select({ id: users.id, name: users.name })
            .from(users)
            .innerJoin(memberships, and(eq(memberships.userId, users.id), eq(memberships.orgId, ctx.orgId)))
            .where(inArray(users.id, releasePeople))
        ).map((u) => [u.id, u.name]),
      )
    : new Map<string, string>();
  const approvedApps = history.filter((a) => a.status === 'approved');
  const releases = releaseRows.map((r) => {
    const countedIn = r.status === 'approved' ? approvedApps.find((a) => a.periodTo !== null && a.periodTo >= r.effectiveOn && a.decidedAt !== null && a.decidedAt >= r.createdAt) : undefined;
    return {
      id: r.id,
      amount: r.amount,
      effectiveOn: r.effectiveOn,
      note: r.note,
      status: r.status,
      createdAt: r.createdAt.toISOString(),
      createdByName: r.createdBy ? (names.get(r.createdBy) ?? null) : null,
      voidedByName: r.voidedBy ? (names.get(r.voidedBy) ?? null) : null,
      voidedAt: r.voidedAt ? r.voidedAt.toISOString() : null,
      countedIn: countedIn ? { id: countedIn.id, applicationNumber: countedIn.applicationNumber } : null,
    };
  });
  const releasePending = sum(releases.filter((r) => r.status === 'approved' && !r.countedIn).map((r) => r.amount));

  return {
    contract,
    project,
    subcontractor,
    position,
    releases,
    releasePending,
    schedule,
    scheduleTotal: sum(schedule.map((l) => l.scheduledValue)),
    changeOrders: cos,
    baseline,
    applications,
  };
}

// ── Options for forms ───────────────────────────────────────────────────────

/** Projects a subcontract can be added to. Active projects first. */
export async function listProjectOptions(db: DB, ctx: Ctx) {
  return db
    .select({ id: projects.id, name: projects.name, number: projects.number, status: projects.status })
    .from(projects)
    .where(eq(projects.orgId, ctx.orgId))
    .orderBy(asc(projects.status), asc(projects.name));
}

export async function listSubcontractorOptions(db: DB, ctx: Ctx) {
  return db
    .select({ id: subcontractors.id, name: subcontractors.name, trade: subcontractors.trade })
    .from(subcontractors)
    .where(eq(subcontractors.orgId, ctx.orgId))
    .orderBy(asc(subcontractors.name));
}
