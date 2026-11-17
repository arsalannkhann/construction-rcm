/**
 * Billing periods: for each month, which subcontracts were expected to bill,
 * what arrived, where it is, and which are missing.
 *
 * A period is the calendar month of an application's "period to" date. A
 * subcontract is expected to bill in a month once it has started billing (an
 * application for an earlier period exists), while it is active and not yet
 * fully billed. For a month that has ended, an expected subcontract with no
 * application is missing; for the current month it is still due.
 *
 * Everything is computed from records at request time. Always scoped to ctx.orgId.
 */
import { and, asc, eq, inArray, isNotNull, ne } from 'drizzle-orm';
import type { DB } from '@/db';
import { changeOrders, contracts, payApplications, projects, subcontractors } from '@/db/schema';
import { recordAudit } from '@/server/audit';
import { assertCan, UserError, type Ctx } from '@/server/auth/permissions';
import { sum } from '@/lib/money';
import type { ApprovedRecord, AppStatus } from '@/server/types';
import { csvAmount, csvRow } from './exports';

// ── Months ──────────────────────────────────────────────────────────────────

const MONTH = /^(\d{4})-(0[1-9]|1[0-2])$/;

export function isMonth(value: unknown): value is string {
  return typeof value === 'string' && MONTH.test(value);
}

/** "2026-11" for a date or an ISO date string, in UTC. */
export function monthOf(date: Date | string): string {
  return typeof date === 'string' ? date.slice(0, 7) : date.toISOString().slice(0, 7);
}

export function shiftMonth(month: string, by: number): string {
  const [, y, m] = MONTH.exec(month)!;
  const d = new Date(Date.UTC(Number(y), Number(m) - 1 + by, 15));
  return monthOf(d);
}

/** `count` months ending with `last`, oldest first. */
export function monthsEnding(last: string, count: number): string[] {
  return Array.from({ length: count }, (_, i) => shiftMonth(last, i - (count - 1)));
}

// ── The board ───────────────────────────────────────────────────────────────

export type BoardProject = { id: string; name: string; number: string | null; status: string };
export type BoardContract = {
  id: string;
  projectId: string;
  number: string;
  title: string;
  subcontractorName: string;
  status: string;
  /** Original amount plus approved change orders. */
  contractSum: number;
};
export type BoardApplication = {
  id: string;
  contractId: string;
  status: AppStatus;
  applicationNumber: number | null;
  periodTo: string | null;
  receivedAt: Date;
  claimedAmount: number | null;
  approvedAmount: number | null;
  /** Total completed and stored to date, as approved. Null unless approved. */
  approvedCompletedStored: number | null;
};

/**
 * approved, in_review, on_hold and rejected: an application arrived.
 * missing: expected in a month that has ended, and none arrived.
 * due: expected this month, not arrived yet.
 * not_started, complete, closed: not expected.
 */
export type CellState = 'approved' | 'in_review' | 'on_hold' | 'rejected' | 'missing' | 'due' | 'not_started' | 'complete' | 'closed';

export const CELL_LABEL: Record<CellState, string> = {
  approved: 'Approved',
  in_review: 'In review',
  on_hold: 'Awaiting subcontractor',
  rejected: 'Rejected',
  missing: 'Missing',
  due: 'Not received yet',
  not_started: 'Not billing yet',
  complete: 'Fully billed',
  closed: 'Closed',
};

const EXPECTED: CellState[] = ['approved', 'in_review', 'on_hold', 'rejected', 'missing', 'due'];

export type BoardCell = {
  month: string;
  state: CellState;
  expected: boolean;
  application: Pick<BoardApplication, 'id' | 'status' | 'applicationNumber' | 'periodTo' | 'claimedAmount' | 'approvedAmount'> | null;
  /** Other applications for the same period on this subcontract (resubmissions, duplicates). */
  others: number;
};

export type BoardRow = BoardContract & { cells: BoardCell[] };

export type PeriodSummary = {
  month: string;
  /** Subcontracts expected to bill: every one with an application, plus the missing or due ones. */
  expected: number;
  /** Expected subcontracts with an application that is not rejected. */
  received: number;
  approved: number;
  inReview: number;
  missing: number;
  due: number;
  /** Rejected, and nothing else sent for the period. */
  rejected: number;
  requested: number;
  approvedAmount: number;
};

export type BoardSection = {
  project: BoardProject;
  rows: BoardRow[];
  periods: PeriodSummary[];
  /** Applications on this project whose period could not be read, so they sit in no month. */
  undated: Array<{ id: string; contractId: string; applicationNumber: number | null; status: AppStatus }>;
};

export type Board = {
  months: string[];
  current: string;
  sections: BoardSection[];
  periods: PeriodSummary[];
};

const RANK: Record<AppStatus, number> = { approved: 0, pending_approval: 1, needs_review: 1, needs_matching: 1, processing: 1, on_hold: 2, rejected: 3, void: 9 };

function stateOf(status: AppStatus): CellState {
  if (status === 'approved') return 'approved';
  if (status === 'on_hold') return 'on_hold';
  if (status === 'rejected') return 'rejected';
  return 'in_review';
}

/** The application that speaks for a period: approved first, then open, then on hold, then rejected; the latest received breaks ties. */
function effective(apps: BoardApplication[]): BoardApplication | null {
  return [...apps].sort((a, b) => RANK[a.status] - RANK[b.status] || b.receivedAt.getTime() - a.receivedAt.getTime())[0] ?? null;
}

function summarise(month: string, cells: BoardCell[]): PeriodSummary {
  const of = (s: CellState) => cells.filter((c) => c.state === s);
  const live = cells.filter((c) => c.application && c.state !== 'rejected');
  return {
    month,
    expected: cells.filter((c) => c.expected).length,
    received: live.length,
    approved: of('approved').length,
    inReview: of('in_review').length + of('on_hold').length,
    missing: of('missing').length,
    due: of('due').length,
    rejected: of('rejected').length,
    requested: sum(live.map((c) => c.application!.claimedAmount)),
    approvedAmount: sum(of('approved').map((c) => c.application!.approvedAmount)),
  };
}

function totalOf(month: string, parts: PeriodSummary[]): PeriodSummary {
  const add = (k: Exclude<keyof PeriodSummary, 'month'>) => sum(parts.map((p) => p[k]));
  return {
    month,
    expected: add('expected'),
    received: add('received'),
    approved: add('approved'),
    inReview: add('inReview'),
    missing: add('missing'),
    due: add('due'),
    rejected: add('rejected'),
    requested: add('requested'),
    approvedAmount: add('approvedAmount'),
  };
}

/**
 * Lay out the billing board. `months` are the periods to show (any order);
 * `current` is this month: periods after it are not shown, and only periods
 * before it can be missing.
 */
export function buildBoard(input: { projects: BoardProject[]; contracts: BoardContract[]; applications: BoardApplication[]; months: string[]; current: string }): Board {
  const months = [...new Set(input.months)].filter((m) => m <= input.current).sort();
  const live = input.applications.filter((a) => a.status !== 'void');
  const byContract = new Map<string, BoardApplication[]>();
  for (const a of live) byContract.set(a.contractId, [...(byContract.get(a.contractId) ?? []), a]);
  const inWindow = (a: BoardApplication) => a.periodTo !== null && months.includes(monthOf(a.periodTo));

  const sections: BoardSection[] = [];
  for (const project of input.projects) {
    const mine = input.contracts.filter((c) => c.projectId === project.id);
    const rows: BoardRow[] = [];
    for (const contract of mine) {
      const apps = byContract.get(contract.id) ?? [];
      const showing = (contract.status === 'active' && project.status === 'active') || apps.some(inWindow);
      if (!showing) continue;
      const cells = months.map((month): BoardCell => {
        const here = apps.filter((a) => a.periodTo !== null && monthOf(a.periodTo) === month);
        const app = effective(here);
        if (app) {
          const { id, status, applicationNumber, periodTo, claimedAmount, approvedAmount } = app;
          return { month, state: stateOf(status), expected: true, application: { id, status, applicationNumber, periodTo, claimedAmount, approvedAmount }, others: here.length - 1 };
        }
        const earlier = apps.filter((a) => a.periodTo !== null && monthOf(a.periodTo) < month);
        const lastApproved = earlier
          .filter((a) => a.status === 'approved')
          .sort((a, b) => (a.periodTo! < b.periodTo! ? 1 : a.periodTo! > b.periodTo! ? -1 : (b.applicationNumber ?? 0) - (a.applicationNumber ?? 0)))[0];
        let state: CellState;
        if (contract.status !== 'active' || project.status !== 'active') state = 'closed';
        else if (earlier.length === 0) state = 'not_started';
        else if (lastApproved?.approvedCompletedStored != null && contract.contractSum > 0 && lastApproved.approvedCompletedStored >= contract.contractSum) state = 'complete';
        else state = month < input.current ? 'missing' : 'due';
        return { month, state, expected: EXPECTED.includes(state), application: null, others: 0 };
      });
      rows.push({ ...contract, cells });
    }
    const undated = live
      .filter((a) => a.periodTo === null && mine.some((c) => c.id === a.contractId))
      .map((a) => ({ id: a.id, contractId: a.contractId, applicationNumber: a.applicationNumber, status: a.status }));
    if (rows.length === 0 && undated.length === 0) continue;
    const periods = months.map((month, i) => summarise(month, rows.map((r) => r.cells[i]!)));
    sections.push({ project, rows, periods, undated });
  }
  return { months, current: input.current, sections, periods: months.map((month, i) => totalOf(month, sections.map((s) => s.periods[i]!))) };
}

// ── Loading ─────────────────────────────────────────────────────────────────

/** The billing board for the organisation, or for one project. */
export async function getBillingBoard(db: DB, ctx: Ctx, opts: { months: string[]; current: string; projectId?: string }): Promise<Board> {
  return boardForOrg(db, ctx.orgId, opts);
}

/**
 * The board for an organisation, with no member behind the request: the
 * scheduler and the subcontractor portal use it (src/server/services/portal.ts),
 * so that "due" and "missing" mean the same everywhere. `contractIds` limits it
 * to those subcontracts. Always scoped to `orgId`.
 */
export async function boardForOrg(db: DB, orgId: string, opts: { months: string[]; current: string; projectId?: string; contractIds?: string[] }): Promise<Board> {
  if (opts.contractIds && opts.contractIds.length === 0) return buildBoard({ projects: [], contracts: [], applications: [], months: opts.months, current: opts.current });
  const projectRows = await db
    .select({ id: projects.id, name: projects.name, number: projects.number, status: projects.status })
    .from(projects)
    .where(opts.projectId ? and(eq(projects.orgId, orgId), eq(projects.id, opts.projectId)) : eq(projects.orgId, orgId))
    .orderBy(asc(projects.status), asc(projects.name));
  if (projectRows.length === 0) return buildBoard({ projects: [], contracts: [], applications: [], months: opts.months, current: opts.current });
  const projectIds = projectRows.map((p) => p.id);

  const contractRows = await db
    .select({
      id: contracts.id,
      projectId: contracts.projectId,
      number: contracts.number,
      title: contracts.title,
      status: contracts.status,
      originalAmount: contracts.originalAmount,
      subcontractorName: subcontractors.name,
    })
    .from(contracts)
    .innerJoin(subcontractors, eq(subcontractors.id, contracts.subcontractorId))
    .where(and(eq(contracts.orgId, orgId), inArray(contracts.projectId, projectIds), opts.contractIds ? inArray(contracts.id, opts.contractIds) : undefined))
    .orderBy(asc(subcontractors.name), asc(contracts.number));
  const contractIds = contractRows.map((c) => c.id);

  const [approvedCos, appRows] = contractIds.length
    ? await Promise.all([
        db
          .select({ contractId: changeOrders.contractId, amount: changeOrders.amount })
          .from(changeOrders)
          .where(and(eq(changeOrders.orgId, orgId), inArray(changeOrders.contractId, contractIds), eq(changeOrders.status, 'approved'))),
        db
          .select({
            id: payApplications.id,
            contractId: payApplications.contractId,
            status: payApplications.status,
            applicationNumber: payApplications.applicationNumber,
            periodTo: payApplications.periodTo,
            receivedAt: payApplications.receivedAt,
            claimedAmount: payApplications.claimedAmount,
            approvedAmount: payApplications.approvedAmount,
            approvedRecord: payApplications.approvedRecord,
          })
          .from(payApplications)
          .where(and(eq(payApplications.orgId, orgId), inArray(payApplications.contractId, contractIds), ne(payApplications.status, 'void'))),
      ])
    : [[], []];

  return buildBoard({
    projects: projectRows,
    contracts: contractRows.map((c) => ({
      id: c.id,
      projectId: c.projectId,
      number: c.number,
      title: c.title,
      subcontractorName: c.subcontractorName,
      status: c.status,
      contractSum: c.originalAmount + sum(approvedCos.filter((co) => co.contractId === c.id).map((co) => co.amount)),
    })),
    applications: appRows
      .filter((a): a is typeof a & { contractId: string } => a.contractId !== null)
      .map((a) => ({
        id: a.id,
        contractId: a.contractId,
        status: a.status as AppStatus,
        applicationNumber: a.applicationNumber,
        periodTo: a.periodTo,
        receivedAt: a.receivedAt,
        claimedAmount: a.claimedAmount,
        approvedAmount: a.approvedAmount,
        approvedCompletedStored: a.status === 'approved' ? (a.approvedRecord?.approved.totalCompletedStored ?? null) : null,
      })),
    months: opts.months,
    current: opts.current,
  });
}

// ── Roll-up of approved billing, for the owner invoice ──────────────────────

const ROLLUP_COLUMNS = [
  'Project', 'Project No', 'Billing Period', 'Subcontractor', 'Contract No', 'Application No', 'Period To', 'Approved On', 'Approved By',
  'Contract Sum To Date', 'Work This Period', 'Materials Presently Stored', 'Total Completed And Stored', 'Retainage Held',
  'Total Earned Less Retainage', 'Less Previous Certificates', 'Approved Payment', 'Record Id',
];

export function renderRollupCsv(month: string, records: ApprovedRecord[]): string {
  const out = [ROLLUP_COLUMNS.join(',')];
  for (const r of records) {
    const a = r.approved;
    out.push(
      csvRow([
        r.project.name, r.project.number, month, r.subcontractor.name, r.contract.number, r.application.number, r.application.periodTo, r.approvedAt.slice(0, 10), r.approvedBy.name,
        csvAmount(a.contractSumToDate), csvAmount(sum(r.lines.map((l) => l.thisPeriod))), csvAmount(sum(r.lines.map((l) => l.stored))), csvAmount(a.totalCompletedStored), csvAmount(a.retainageTotal),
        csvAmount(a.totalEarnedLessRetainage), csvAmount(a.lessPreviousCertificates), csvAmount(a.currentPaymentDue), r.application.id,
      ]),
    );
  }
  return `${out.join('\r\n')}\r\n`;
}

/**
 * The approved subcontractor billing on one project for one period, as CSV: the
 * figures a main contractor builds the owner's invoice from. Only approved
 * applications, each from its immutable approved record.
 */
export async function billingRollup(db: DB, ctx: Ctx, projectId: string, month: string): Promise<{ filename: string; csv: string; count: number }> {
  assertCan(ctx, 'export:run');
  if (!isMonth(month)) throw new UserError('Choose a billing period.');
  const [project] = await db.select({ id: projects.id, name: projects.name, number: projects.number }).from(projects).where(and(eq(projects.orgId, ctx.orgId), eq(projects.id, projectId)));
  if (!project) throw new UserError('Project not found.');

  const rows = await db
    .select({ id: payApplications.id, periodTo: payApplications.periodTo, record: payApplications.approvedRecord, subcontractorName: subcontractors.name, contractNumber: contracts.number })
    .from(payApplications)
    .innerJoin(contracts, eq(contracts.id, payApplications.contractId))
    .innerJoin(subcontractors, eq(subcontractors.id, contracts.subcontractorId))
    .where(and(eq(payApplications.orgId, ctx.orgId), eq(payApplications.projectId, projectId), eq(payApplications.status, 'approved'), isNotNull(payApplications.approvedRecord)));
  const records = rows
    .filter((r) => r.periodTo !== null && monthOf(r.periodTo) === month)
    .sort((a, b) => a.subcontractorName.localeCompare(b.subcontractorName) || a.contractNumber.localeCompare(b.contractNumber))
    .map((r) => r.record!);

  await recordAudit(db, {
    orgId: ctx.orgId,
    actor: ctx,
    action: 'billing.rollup_exported',
    entityType: 'project',
    entityId: project.id,
    summary: `Downloaded the approved billing roll-up for ${project.name}, ${month} (${records.length} application${records.length === 1 ? '' : 's'})`,
    data: { month, applications: records.map((r) => r.application.id) },
  });
  const slug = (project.number ?? project.name).replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '').toLowerCase() || 'project';
  return { filename: `approved-billing-${slug}-${month}.csv`, csv: renderRollupCsv(month, records), count: records.length };
}
