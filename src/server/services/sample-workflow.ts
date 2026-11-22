/**
 * The public sample workflow (`/sample`).
 *
 * One fictitious subcontract with three approved applications and a fourth
 * that has two things wrong with it. It is built the way the demo workspace
 * is: every application is a generated PDF that goes through the same intake,
 * reading, matching, reconciliation and approval code as a real one. The
 * fourth is then read back with the review workspace's own query and mapped
 * into the snapshot the page renders, so no figure or finding on the page is
 * typed by hand.
 *
 * `pnpm sample:build` saves the snapshot and the PDF. The test in
 * tests/sample-workflow.test.ts rebuilds it and fails when the saved copy no
 * longer matches what the product produces.
 */
import type { SampleBox, SampleFinding, SampleSnapshot, SampleSource } from '@/content/sample-types';
import type { DB } from '@/db';
import { memberships, users } from '@/db/schema';
import { formatDelta, formatMoney, percentOf } from '@/lib/money';
import { hashPassword } from '@/server/auth/password';
import type { Ctx } from '@/server/auth/permissions';
import { readPdfText } from '@/server/documents/pdf-text';
import { newId, randomToken } from '@/server/ids';
import { renderPackage, type SamplePackage } from '@/server/samples/pdf';
import { buildPackage, defects, stateAfter, type BillingContract, type BillingState, type Parties } from '@/server/samples/scenario';
import { getObject } from '@/server/storage';
import { APP_STATUS_LABEL, CLAIMED_FIELD_LABEL, CLAIMED_FIELDS, DOC_TYPE_LABEL, FINDING_CATEGORIES, FINDING_CATEGORY_LABEL, type AppStatus, type BBox, type FindingCategory, type Role } from '@/server/types';
import { createApplication, processApplication } from './intake';
import { getReviewData, listApplications, type ReviewData } from './queries';
import { createChangeOrder, createContract, createProject, createSubcontractor } from './records';
import { approveApplication, draftCorrectionRequest, submitForApproval } from './review';
import { createOrganization, getOrganization } from './team';

const D = (dollars: number) => Math.round(dollars * 100);
const DAY = 86_400_000;

// ── The fictitious subcontract ──────────────────────────────────────────────

const GC = { name: 'Northgate Builders, Inc.', address: '2200 Corbin Ave, Suite 310, Austin, TX 78702' };
// Texas, so the waiver is on a statutory form the product recognises.
const PROJECT = { name: 'Alder Street Clinic', number: '1042', address: '615 Alder St', city: 'Austin', state: 'TX', zip: '78702', owner: 'Alder Street Health Partners' };
const SUB = { name: 'Brightline Electric, LLC', trade: 'Electrical', contact: 'Teresa Lindqvist', title: 'Controller', email: 'billing@brightlineelectric.example', address: '4410 Tannery Row, Austin, TX 78744' };
const TEAM_DOMAIN = 'northgatebuilders.example';
const APPROVER = { name: 'Owen Hale', role: 'owner' } as const;
const REVIEWER = { name: 'Lucia Marin', role: 'accountant' } as const;

const SUBCONTRACT = { number: 'SC-1042-16', title: 'Electrical', date: '2026-06-08', retainage: [1000, 1000] as const };
/** item no., description, scheduled value in dollars, cumulative % complete at the end of each of the four periods. */
const LINES: Array<[string, string, number, [number, number, number, number]]> = [
  ['1', 'Mobilization & submittals', 48_000, [100, 100, 100, 100]],
  ['2', 'Site power & service entrance', 164_000, [60, 100, 100, 100]],
  ['3', 'Branch rough-in, first floor', 286_000, [0, 35, 70, 95]],
  ['4', 'Branch rough-in, second floor', 262_000, [0, 0, 30, 60]],
  ['5', 'Switchgear & panelboards', 228_000, [0, 10, 35, 60]],
  ['6', 'Lighting fixtures & controls', 152_000, [0, 0, 0, 15]],
  ['7', 'Fire alarm & low voltage', 60_000, [0, 0, 10, 30]],
];
const CHANGE_ORDER = { number: 'CO-1', title: 'Added circuits, imaging room', amount: 38_400, approvedOn: '2026-07-14', pct: [0, 0, 50, 100] };
/** Fixtures delivered in the last period and billed as stored material: [period, item no., dollars]. */
const STORED: [number, string, number] = [3, '6', 18_000];

/** The billing periods. The first three applications are reviewed and approved on the dates given; the fourth is left open. */
const PERIODS = [
  { periodTo: '2026-07-31', applicationDate: '2026-07-30', submitted: '2026-07-31', approved: '2026-08-03' },
  { periodTo: '2026-08-31', applicationDate: '2026-08-28', submitted: '2026-08-31', approved: '2026-09-01' },
  { periodTo: '2026-09-30', applicationDate: '2026-09-29', submitted: '2026-09-30', approved: '2026-10-01' },
  { periodTo: '2026-10-31', applicationDate: '2026-10-30' },
];

// What is wrong with application #4.
/** Line 7 leaves out this much of what was certified, so it would be paid a second time. */
const UNDERSTATED_PREVIOUS = D(17_280);

const filenameFor = (applicationNumber: number) => `brightline-electric-pay-application-${applicationNumber}.pdf`;

const PARTIES: Parties = {
  gc: GC,
  owner: PROJECT.owner,
  project: { name: PROJECT.name, number: PROJECT.number, address: `${PROJECT.address}, ${PROJECT.city}, ${PROJECT.state} ${PROJECT.zip}`, state: PROJECT.state },
  sub: { name: SUB.name, address: SUB.address, signer: SUB.contact, signerTitle: SUB.title },
};

const BILLING: BillingContract = {
  number: SUBCONTRACT.number,
  date: SUBCONTRACT.date,
  description: SUBCONTRACT.title,
  originalAmount: D(LINES.reduce((a, l) => a + l[2], 0)),
  retainageWorkBps: SUBCONTRACT.retainage[0],
  retainageStoredBps: SUBCONTRACT.retainage[1],
  sov: LINES.map(([itemNo, description, value]) => ({ itemNo, description, scheduledValue: D(value) })),
  changeOrders: [{ number: CHANGE_ORDER.number, title: CHANGE_ORDER.title, amount: D(CHANGE_ORDER.amount) }],
};

/** Work and stored material billed in one period, from the cumulative percentages. */
function progressFor(period: number): Record<string, { work?: number; stored?: number }> {
  const out: Record<string, { work?: number; stored?: number }> = {};
  const delta = (value: number, pct: number[]) => D(Math.round((value * (pct[period]! - (period === 0 ? 0 : pct[period - 1]!))) / 100));
  for (const [itemNo, , value, pct] of LINES) {
    const work = delta(value, pct);
    if (work) out[itemNo] = { work };
  }
  const work = delta(CHANGE_ORDER.amount, CHANGE_ORDER.pct);
  if (work) out[CHANGE_ORDER.number] = { work };
  if (STORED[0] === period) out[STORED[1]] = { ...out[STORED[1]], stored: D(STORED[2]) };
  return out;
}

// ── Building it ─────────────────────────────────────────────────────────────

/**
 * Build the sample on `db` and return the snapshot with the PDF of application #4.
 *
 * `now` is when application #4 is on the reviewer's desk; the history before it
 * has fixed dates. Everything is created in a new organisation, so the database
 * should be one that is thrown away afterwards.
 */
export async function buildSampleWorkflow(db: DB, now: Date): Promise<{ snapshot: SampleSnapshot; pdf: Uint8Array }> {
  const start = new Date(`${SUBCONTRACT.date}T15:00:00Z`);

  // Two people who cannot sign in: one reviews, the other approves.
  const member = async (who: { name: string; role: Role }) => {
    const id = newId('usr');
    // The suffix keeps the address unique if the sample is built twice on one database.
    const email = `${who.name.toLowerCase().replace(/[^a-z]+/g, '.')}.${randomToken(4).toLowerCase().replace(/[^a-z0-9]/g, 'x')}@${TEAM_DOMAIN}`;
    await db.insert(users).values({ id, email, name: who.name, passwordHash: await hashPassword(randomToken(24)), createdAt: start });
    return { id, email };
  };
  const owner = await member(APPROVER);
  const orgId = await createOrganization(db, owner.id, GC.name, { at: start });
  const ctxFor = (who: { name: string; role: Role }, account: { id: string; email: string }): Ctx => ({ orgId, orgName: GC.name, isDemo: false, userId: account.id, userName: who.name, userEmail: account.email, role: who.role });
  const approver = ctxFor(APPROVER, owner);
  const accountant = await member(REVIEWER);
  await db.insert(memberships).values({ id: newId('mem'), orgId, userId: accountant.id, role: REVIEWER.role, createdAt: start });
  const reviewer = ctxFor(REVIEWER, accountant);

  const projectId = await createProject(db, approver, { name: PROJECT.name, number: PROJECT.number, address: PROJECT.address, city: PROJECT.city, state: PROJECT.state, ownerName: PROJECT.owner });
  const subcontractorId = await createSubcontractor(db, approver, { name: SUB.name, trade: SUB.trade, contactName: SUB.contact, contactEmail: SUB.email, address: SUB.address });
  const contractId = await createContract(db, approver, {
    projectId,
    subcontractorId,
    number: BILLING.number,
    title: BILLING.description,
    originalAmount: BILLING.originalAmount,
    retainageWorkBps: BILLING.retainageWorkBps,
    retainageStoredBps: BILLING.retainageStoredBps,
    executedOn: BILLING.date,
    schedule: BILLING.sov,
  });
  await createChangeOrder(db, approver, contractId, { number: CHANGE_ORDER.number, title: CHANGE_ORDER.title, amount: D(CHANGE_ORDER.amount), status: 'approved', approvedOn: CHANGE_ORDER.approvedOn });

  const packageFor = (period: number, prior: BillingState | null) =>
    buildPackage(PARTIES, BILLING, prior, { applicationNumber: period + 1, periodTo: PERIODS[period]!.periodTo, applicationDate: PERIODS[period]!.applicationDate, progress: progressFor(period) });
  // Upload → read → match → reconcile. The contract is not named: the product has to find it from the document.
  const submit = async (pkg: SamplePackage, receivedAt: Date) => {
    const { id } = await createApplication(db, reviewer, { files: [{ filename: filenameFor(pkg.applicationNumber), bytes: await renderPackage(pkg) }], receivedAt, defer: true });
    // Always the rule-based reader, whatever this environment has configured: the same bytes then always read the same.
    await processApplication(db, orgId, id, { now: new Date(receivedAt.getTime() + 40_000), extract: { ai: { configured: false } } });
    return id;
  };
  const read = async (id: string) => {
    const data = await getReviewData(db, reviewer, id);
    if (!data || data.contract?.id !== contractId || data.app.status !== 'needs_review') throw new Error('A sample application was not read and matched to its subcontract.');
    return data;
  };

  let state: BillingState | null = null;
  for (const [index, period] of PERIODS.entries()) {
    if (!period.approved) break;
    const pkg = packageFor(index, state);
    const id = await submit(pkg, new Date(`${period.applicationDate}T16:00:00Z`));
    const open = (await read(id)).findings.filter((f) => f.status === 'open' && f.severity !== 'info');
    if (open.length > 0) throw new Error(`Sample application #${pkg.applicationNumber} was meant to be in order, but the checks found: ${open.map((f) => f.title).join('; ')}`);
    await submitForApproval(db, reviewer, id, null, { now: new Date(`${period.submitted}T15:00:00Z`) });
    await approveApplication(db, approver, id, { now: new Date(`${period.approved}T17:00:00Z`) });
    state = stateAfter(pkg);
  }

  const last = packageFor(PERIODS.length - 1, state);
  // One thing wrong, so the page can be followed at a glance: the findings are that one cause and what follows from it.
  defects.understatePreviousCertificates(last, UNDERSTATED_PREVIOUS);
  // It came in three days ago and nobody has decided it.
  const appId = await submit(last, new Date(now.getTime() - 3 * DAY));

  // Read it back the way the review workspace does.
  const data = await read(appId);
  const organization = await getOrganization(db, reviewer);
  const history = (await listApplications(db, reviewer, { contractId, statuses: ['approved'] })).sort((a, b) => (a.applicationNumber ?? 0) - (b.applicationNumber ?? 0));
  // What "Request correction" would put in front of the reviewer. Drafted only: nothing is sent.
  const draft = await draftCorrectionRequest(db, reviewer, appId);
  if (data.documents.length !== 1) throw new Error('The sample application should be a single PDF.');
  // The stored file, not the bytes handed to intake, so the PDF on the page is the one that was read.
  const pdf = await getObject(data.documents[0]!.storageKey);
  const pages = (await readPdfText(pdf)).pages.map((p) => ({ page: p.page, width: p.viewWidth ?? p.width, height: p.viewHeight ?? p.height }));

  return { snapshot: toSnapshot(data, { generalContractor: organization.name, history, pages, draft }), pdf };
}

// ── What the review workspace shows, as a snapshot ──────────────────────────

/** Four decimals: a hundredth of a percent of the page, and free of the last digits of floating-point layout arithmetic. */
const box = (b: BBox | null | undefined): SampleBox | null => (b ? (b.map((n) => Math.round(n * 10_000) / 10_000) as SampleBox) : null);

function toSnapshot(
  data: ReviewData,
  rest: {
    generalContractor: string;
    /** Earlier approved applications on the subcontract, oldest first. */
    history: Array<{ applicationNumber: number | null; periodTo: string | null; approvedAmount: number | null }>;
    /** Page sizes of the PDF, in points. */
    pages: Array<{ page: number; width: number; height: number }>;
    draft: { subject: string; body: string };
  },
): SampleSnapshot {
  const { history, pages, draft } = rest;
  const { app, contract, project, subcontractor } = data;
  const doc = data.documents[0]!;
  const verified = app.verified;
  if (!contract || !project || !subcontractor || !verified || app.applicationNumber === null || !app.periodTo || app.claimedAmount === null || app.verifiedAmount === null) {
    throw new Error('The sample application is missing figures the page shows.');
  }

  // The same choices as the workspace's "Show in document".
  const fieldSource = (key: string): SampleSource | null => {
    const ev = app.evidence?.[key];
    return ev ? { page: ev.page, bbox: box(ev.bbox) } : null;
  };
  const lineSource = (lineId: string): SampleSource | null => {
    const x = data.lines.find((l) => l.id === lineId)?.extracted;
    return x ? { page: x.page, bbox: box(x.bbox) } : null;
  };
  const waiverSource = (waiverId: string): SampleSource | null => {
    const w = data.waivers.find((x) => x.id === waiverId);
    return w ? { page: w.page, bbox: box(w.extracted?.amount.bbox ?? w.extracted?.waiverType.bbox) } : null;
  };

  // "Needs attention", in the order the findings tab lists it: blocking first, then warnings.
  const open = data.findings.filter((f) => f.status === 'open' && f.severity !== 'info');
  const blocking = open.filter((f) => f.severity === 'blocking');
  const warnings = open.filter((f) => f.severity === 'warning');
  const passed = data.findings.filter((f) => f.status === 'passed');
  const findings: SampleFinding[] = [...blocking, ...warnings].map((f, i) => {
    const hasNumbers = typeof f.data?.expected === 'number' && typeof f.data.actual === 'number';
    return {
      id: `f${i + 1}`,
      severity: f.severity === 'blocking' ? 'blocking' : 'warning',
      category: FINDING_CATEGORY_LABEL[f.category as FindingCategory] ?? f.category,
      title: f.title,
      message: f.detail,
      expected: hasNumbers ? formatMoney(f.data!.expected) : null,
      onDocument: hasNumbers ? formatMoney(f.data!.actual) : null,
      difference: hasNumbers ? formatDelta(f.data!.delta ?? null) : null,
      whatToDo: f.action,
      source:
        (f.refs?.field ? fieldSource(f.refs.field) : null) ??
        (f.refs?.lineId ? lineSource(f.refs.lineId) : null) ??
        (f.refs?.waiverId ? waiverSource(f.refs.waiverId) : null) ??
        (f.refs?.documentId ? { page: f.refs.page ?? 1, bbox: null } : null),
    };
  });

  const verifiedBySov = new Map(data.verifiedLines.map((v) => [v.sovLineId, v]));

  return {
    reader: app.engine ?? '',
    parties: {
      generalContractor: rest.generalContractor,
      project: project.name,
      projectLocation: [project.city, project.state].filter(Boolean).join(', '),
      owner: project.ownerName ?? '',
      subcontractor: subcontractor.name,
      trade: subcontractor.trade ?? '',
      contractNumber: contract.number,
      contractTitle: contract.title,
    },
    contract: {
      originalAmount: contract.originalAmount,
      approvedChangeOrders: data.changeOrders.filter((c) => c.status === 'approved').reduce((a, c) => a + c.amount, 0),
      contractSumToDate: verified.contractSumToDate,
      retainageWorkBps: contract.retainageWorkBps,
      retainageStoredBps: contract.retainageStoredBps,
      history: history.map((h) => ({ number: h.applicationNumber ?? 0, periodTo: h.periodTo ?? '', approved: h.approvedAmount ?? 0 })),
    },
    application: {
      number: app.applicationNumber,
      periodTo: app.periodTo,
      requested: app.claimedAmount,
      verified: app.verifiedAmount,
      difference: app.verifiedAmount - app.claimedAmount,
      retainageHeld: verified.retainageTotal,
      statusLabel: APP_STATUS_LABEL[app.status as AppStatus] ?? app.status,
    },
    document: {
      filename: doc.filename,
      url: `/sample/${doc.filename}`,
      pageCount: doc.pageCount ?? pages.length,
      pages: pages.map((p) => {
        const segment = doc.segments.find((s) => s.pageStart <= p.page && p.page <= s.pageEnd);
        // The short name the document viewer uses: the type's label without the form number.
        return { page: p.page, label: DOC_TYPE_LABEL[segment?.type ?? 'other'].replace(/\s*\(.*\)$/, ''), width: p.width, height: p.height };
      }),
    },
    summary: CLAIMED_FIELDS.map((field) => {
      const onDocument = app.claimed[field];
      const ours = verified[field] ?? null;
      return { key: field, label: CLAIMED_FIELD_LABEL[field], onDocument, verified: ours, agrees: onDocument !== null && ours !== null && onDocument === ours, source: fieldSource(field) };
    }),
    lines: data.lines.map((l) => {
      const ours = l.sovLineId ? verifiedBySov.get(l.sovLineId) : undefined;
      const total = l.total ?? (l.previous ?? 0) + (l.thisPeriod ?? 0) + (l.stored ?? 0);
      return {
        itemNo: l.itemNo ?? '',
        description: l.description ?? '',
        scheduledValue: l.scheduledValue ?? 0,
        previous: l.previous ?? 0,
        thisPeriod: l.thisPeriod ?? 0,
        stored: l.stored ?? 0,
        completedToDate: total,
        // As the schedule tab works it out: against the contract's figures where the line is on the contract.
        percent: percentOf(ours?.total ?? total, ours?.scheduledValue ?? l.scheduledValue ?? 0) ?? 0,
        source: lineSource(l.id),
      };
    }),
    checks: {
      passed: passed.length,
      blocking: blocking.length,
      warnings: warnings.length,
      passedGroups: FINDING_CATEGORIES.filter((c) => passed.some((f) => f.category === c) && !open.some((f) => f.category === c)).map((c) => FINDING_CATEGORY_LABEL[c]),
    },
    findings,
    correction: { subject: draft.subject, body: draft.body },
  };
}
