/**
 * Demo workspace.
 *
 * A separate organisation (flagged `isDemo`, labelled on every screen) filled
 * with fictitious projects, subcontracts and five months of billing. Nothing
 * here is inserted as a finished number: every application is a generated PDF
 * that goes through the same intake, reading, matching, reconciliation and
 * approval code as a real one, with timestamps set in the past. The dashboard
 * therefore shows real records, and the demo cannot drift from the product.
 *
 * Demo data never mixes with a customer's own organisation, and the whole
 * workspace can be deleted in one step.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { and, eq, inArray, like, lt, ne, or } from 'drizzle-orm';
import type { DB } from '@/db';
import { changeOrders, contracts, findings, memberships, notifications, organizations, payApplications, primeContracts, primeLines, projects, sessions, sovLines, subcontractors, users } from '@/db/schema';
import { recordAudit } from '@/server/audit';
import { hashPassword } from '@/server/auth/password';
import { assertCan, UserError, type Ctx } from '@/server/auth/permissions';
import { dataDir, isInMemory } from '@/server/config';
import { newId, randomToken } from '@/server/ids';
import { renderPackage, renderTextlessPdf, type SamplePackage } from '@/server/samples/pdf';
import { buildPackage, defects, recompute, stateAfter, type BillingContract, type BillingState, type Parties } from '@/server/samples/scenario';
import type { Role } from '@/server/types';
import { createBatchExport, createExport } from './exports';
import { createApplication, processApplication } from './intake';
import { acceptFinding, approveApplication, assignReviewer, rejectApplication, sendSubcontractorMessage, submitForApproval } from './review';
import { createOrganization } from './team';

const DEMO_ORG_NAME = 'Northline Constructors (Demo)';
const GC = { name: 'Northline Constructors, Inc.', address: '4100 Guadalupe St, Suite 300, Austin, TX 78751' };
const DEMO_EMAIL_DOMAIN = 'demo.zephric.invalid';
/** Domain the fictitious colleagues had before the Zephric rename, still matched on removal. */
const OLD_DEMO_EMAIL_DOMAIN = 'demo.construction-rcm.invalid';
const SAMPLE_CONTRACT = 'SC-2312-22';

const D = (dollars: number) => Math.round(dollars * 100);
const DAY = 86_400_000;

// ── The fictitious portfolio ────────────────────────────────────────────────

const PROJECTS = [
  { name: 'Riverside Medical Office Building', number: '2301', address: '880 Riverside Dr', city: 'Austin', state: 'TX', zip: '78704', owner: 'Riverside Health Partners' },
  { name: 'Harbor Point Logistics Center', number: '2305', address: '2100 Pier Ave', city: 'Long Beach', state: 'CA', zip: '90802', owner: 'Harbor Point Industrial, LLC' },
  { name: 'Bayshore Residences, Phase II', number: '2312', address: '415 Bayshore Blvd', city: 'Tampa', state: 'FL', zip: '33606', owner: 'Bayshore Development Group' },
] as const;

type Current = 'double_billing' | 'short_retainage' | 'pending_approval' | 'unapproved_co' | 'on_hold' | 'approved_exported' | 'approved' | 'sample';

type Plan = {
  project: 0 | 1 | 2;
  sub: { name: string; trade: string; contact: string; email: string; address: string; title: string };
  number: string;
  title: string;
  date: string;
  retainage: [work: number, stored: number];
  /** Billing period index (0–4) of application #1. */
  first: number;
  /** item no., description, scheduled value in dollars, cumulative % complete at the end of each of the five periods. */
  lines: Array<[string, string, number, [number, number, number, number, number]]>;
  changeOrders?: Array<{ number: string; title: string; amount: number; status: 'approved' | 'pending'; pct: [number, number, number, number, number] }>;
  /** Stored materials billed in a period: [period, item no., dollars]. */
  stored?: Array<[number, string, number]>;
  current: Current;
  /** History quirks: [period, kind]. */
  history?: Array<[number, 'rejected_then_resubmitted' | 'waiver_date_warning']>;
};

const PLANS: Plan[] = [
  {
    project: 0,
    sub: { name: 'Lone Star Electric, LLC', trade: 'Electrical', contact: 'Maria Alvarez', email: 'billing@lonestarelectric.example', address: '2210 Industrial Blvd, Austin, TX 78745', title: 'Controller' },
    number: 'SC-2301-16',
    title: 'Electrical',
    date: '2026-03-02',
    retainage: [1000, 1000],
    first: 0,
    lines: [
      ['1', 'Mobilization & submittals', 60000, [100, 100, 100, 100, 100]],
      ['2', 'Underground & service entrance', 240000, [45, 90, 100, 100, 100]],
      ['3', 'Branch rough-in, levels 1-2', 420000, [0, 30, 65, 90, 100]],
      ['4', 'Branch rough-in, levels 3-4', 380000, [0, 0, 25, 55, 80]],
      ['5', 'Switchgear & panels', 330000, [0, 10, 40, 70, 85]],
      ['6', 'Lighting fixtures', 250000, [0, 0, 0, 15, 40]],
      ['7', 'Fire alarm & low voltage', 120000, [0, 0, 10, 30, 55]],
      ['8', 'Testing & closeout', 60000, [0, 0, 0, 0, 0]],
    ],
    changeOrders: [{ number: 'CO-1', title: 'Added receptacles, imaging suite', amount: 28400, status: 'approved', pct: [0, 0, 50, 100, 100] }],
    current: 'double_billing',
  },
  {
    project: 0,
    sub: { name: 'Hill Country Mechanical, Inc.', trade: 'HVAC', contact: 'Greg Tanaka', email: 'ar@hillcountrymech.example', address: '905 Ranch Rd 620, Lakeway, TX 78734', title: 'Vice President' },
    number: 'SC-2301-15',
    title: 'HVAC',
    date: '2026-03-18',
    retainage: [1000, 1000],
    first: 1,
    lines: [
      ['1', 'Mobilization', 75000, [0, 100, 100, 100, 100]],
      ['2', 'Ductwork rough-in', 640000, [0, 25, 55, 80, 95]],
      ['3', 'Hydronic piping', 520000, [0, 15, 45, 70, 90]],
      ['4', 'Rooftop units & air handlers', 610000, [0, 0, 20, 60, 85]],
      ['5', 'Controls & BAS', 310000, [0, 0, 0, 20, 45]],
      ['6', 'Insulation', 160000, [0, 0, 15, 40, 65]],
      ['7', 'Test, adjust & balance', 100000, [0, 0, 0, 0, 10]],
    ],
    current: 'short_retainage',
    history: [[2, 'rejected_then_resubmitted']],
  },
  {
    project: 0,
    sub: { name: 'Capitol Concrete Co.', trade: 'Concrete', contact: 'Deshawn Price', email: 'payapps@capitolconcrete.example', address: '7700 Burleson Rd, Austin, TX 78744', title: 'Project Accountant' },
    number: 'SC-2301-03',
    title: 'Cast-in-place concrete',
    date: '2026-02-10',
    retainage: [1000, 1000],
    first: 0,
    lines: [
      ['1', 'Mobilization', 90000, [100, 100, 100, 100, 100]],
      ['2', 'Footings & grade beams', 520000, [70, 100, 100, 100, 100]],
      ['3', 'Slab on grade', 610000, [20, 75, 100, 100, 100]],
      ['4', 'Elevated decks, levels 2-3', 980000, [0, 20, 60, 95, 100]],
      ['5', 'Elevated decks, level 4 & roof', 640000, [0, 0, 15, 55, 90]],
      ['6', 'Site concrete & curbs', 280000, [0, 0, 0, 10, 45]],
    ],
    current: 'pending_approval',
  },
  {
    project: 1,
    sub: { name: 'Pacific Steel Erectors, Inc.', trade: 'Structural steel', contact: 'Linh Tran', email: 'billing@pacificsteel.example', address: '1840 Anaheim St, Wilmington, CA 90744', title: 'Chief Financial Officer' },
    number: 'SC-2305-05',
    title: 'Structural steel',
    date: '2026-02-24',
    retainage: [1000, 1000],
    first: 0,
    lines: [
      ['1', 'Mobilization & shop drawings', 190000, [100, 100, 100, 100, 100]],
      ['2', 'Fabrication, sequence 1', 1150000, [60, 100, 100, 100, 100]],
      ['3', 'Fabrication, sequence 2', 1050000, [0, 40, 90, 100, 100]],
      ['4', 'Erection, sequence 1', 980000, [0, 30, 75, 100, 100]],
      ['5', 'Erection, sequence 2', 900000, [0, 0, 20, 60, 90]],
      ['6', 'Metal deck', 360000, [0, 0, 15, 50, 80]],
      ['7', 'Miscellaneous metals', 120000, [0, 0, 0, 20, 50]],
    ],
    changeOrders: [
      { number: 'CO-1', title: 'Added mezzanine framing', amount: 86500, status: 'approved', pct: [0, 0, 40, 100, 100] },
      { number: 'CO-2', title: 'Dock canopy revisions', amount: 46800, status: 'pending', pct: [0, 0, 0, 0, 100] },
    ],
    current: 'unapproved_co',
    history: [[1, 'waiver_date_warning']],
  },
  {
    project: 1,
    sub: { name: 'Harborview Roofing & Waterproofing', trade: 'Roofing', contact: 'Sofia Reyes', email: 'office@harborviewroofing.example', address: '660 W 17th St, Long Beach, CA 90813', title: 'Office Manager' },
    number: 'SC-2305-07',
    title: 'Roofing',
    date: '2026-05-06',
    retainage: [1000, 1000],
    first: 2,
    lines: [
      ['1', 'Mobilization', 40000, [0, 0, 100, 100, 100]],
      ['2', 'Roof insulation', 360000, [0, 0, 30, 70, 100]],
      ['3', 'TPO membrane', 520000, [0, 0, 10, 45, 80]],
      ['4', 'Flashings & sheet metal', 210000, [0, 0, 0, 25, 55]],
      ['5', 'Skylights & accessories', 150000, [0, 0, 0, 0, 30]],
    ],
    current: 'on_hold',
  },
  {
    project: 1,
    sub: { name: 'Golden State Fire Protection', trade: 'Fire sprinkler', contact: 'Aaron Feldman', email: 'ap@gsfire.example', address: '3301 Cherry Ave, Signal Hill, CA 90755', title: 'President' },
    number: 'SC-2305-11',
    title: 'Fire sprinkler',
    date: '2026-04-01',
    retainage: [500, 500],
    first: 1,
    lines: [
      ['1', 'Design & permits', 85000, [0, 100, 100, 100, 100]],
      ['2', 'Underground fire main', 170000, [0, 60, 100, 100, 100]],
      ['3', 'Overhead mains', 310000, [0, 0, 40, 80, 100]],
      ['4', 'Branch lines & heads', 290000, [0, 0, 10, 45, 75]],
      ['5', 'Fire pump & trim', 85000, [0, 0, 0, 0, 50]],
    ],
    current: 'approved_exported',
  },
  {
    project: 2,
    sub: { name: 'Gulfstream Plumbing, Inc.', trade: 'Plumbing', contact: 'Rafael Ortiz', email: 'billing@gulfstreamplumbing.example', address: '5120 W Cypress St, Tampa, FL 33607', title: 'Controller' },
    number: SAMPLE_CONTRACT,
    title: 'Plumbing',
    date: '2026-03-09',
    retainage: [1000, 1000],
    first: 0,
    lines: [
      ['1', 'Mobilization', 45000, [100, 100, 100, 100, 100]],
      ['2', 'Underground sanitary & storm', 280000, [80, 100, 100, 100, 100]],
      ['3', 'Domestic water rough-in', 390000, [0, 25, 60, 85, 100]],
      ['4', 'Sanitary & vent rough-in', 410000, [0, 20, 55, 80, 95]],
      ['5', 'Fixtures & trim', 300000, [0, 0, 0, 10, 35]],
      ['6', 'Testing & closeout', 95000, [0, 0, 0, 0, 0]],
    ],
    current: 'sample',
  },
  {
    project: 2,
    sub: { name: 'Suncoast Drywall & Framing, LLC', trade: 'Framing & drywall', contact: 'Tiffany Brooks', email: 'payapps@suncoastdrywall.example', address: '8402 Benjamin Rd, Tampa, FL 33634', title: 'Accounting Manager' },
    number: 'SC-2312-09',
    title: 'Framing & drywall',
    date: '2026-04-14',
    retainage: [1000, 0],
    first: 1,
    lines: [
      ['1', 'Mobilization', 50000, [0, 100, 100, 100, 100]],
      ['2', 'Metal stud framing, levels 1-3', 560000, [0, 35, 75, 100, 100]],
      ['3', 'Metal stud framing, levels 4-6', 520000, [0, 0, 30, 70, 95]],
      ['4', 'Drywall hang, levels 1-3', 380000, [0, 0, 20, 60, 90]],
      ['5', 'Drywall hang, levels 4-6', 350000, [0, 0, 0, 15, 50]],
      ['6', 'Tape & finish', 200000, [0, 0, 0, 10, 35]],
    ],
    stored: [[4, '5', 60000]],
    current: 'approved',
  },
];

const TEAM: Array<{ name: string; role: Role }> = [
  { name: 'Dana Whitaker', role: 'controller' },
  { name: 'Marcus Chen', role: 'accountant' },
  { name: 'Priya Natarajan', role: 'accountant' },
  { name: 'Tom Becker', role: 'project_manager' },
];

// ── Helpers ─────────────────────────────────────────────────────────────────

/** Small deterministic generator so a demo workspace looks the same each time it is built. */
function seeded(key: string): () => number {
  let h = 1779033703 ^ key.length;
  for (let i = 0; i < key.length; i++) {
    h = Math.imul(h ^ key.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  return () => {
    h = Math.imul(h ^ (h >>> 16), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    h ^= h >>> 16;
    return (h >>> 0) / 4294967296;
  };
}

const iso = (d: Date) => d.toISOString().slice(0, 10);

/** "Lone Star Electric, LLC" → "LoneStarElectric": how a subcontractor's office would name the file. */
const fileStem = (company: string) => company.split(',')[0]!.replace(/&/g, 'and').replace(/[^A-Za-z0-9]+/g, '');

/** The last day of each of the five billing months before `now`'s month. */
/**
 * Budgets chosen so the three projects show the three standings: comfortably
 * within budget, close to it, and over it once a pending change order counts.
 */
function demoBudget(project: Plan['project']): number {
  const plans = PLANS.filter((p) => p.project === project);
  const committed = plans.reduce((t, p) => t + p.lines.reduce((a, l) => a + l[2], 0) + (p.changeOrders ?? []).filter((c) => c.status === 'approved').reduce((a, c) => a + c.amount, 0), 0);
  const pending = plans.reduce((t, p) => t + (p.changeOrders ?? []).filter((c) => c.status === 'pending').reduce((a, c) => a + c.amount, 0), 0);
  const roundTo = (dollars: number, step: number) => Math.round(dollars / step) * step;
  if (project === 0) return D(roundTo(committed * 1.08, 5000));
  if (project === 1) return D(roundTo(committed + pending - 25000, 1000));
  return D(roundTo((committed + pending) / 0.97, 1000));
}

function periodEnds(now: Date): string[] {
  const out: string[] = [];
  for (let back = 5; back >= 1; back--) out.push(iso(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - back + 1, 0))));
  return out;
}

function partiesFor(plan: Plan): Parties {
  const p = PROJECTS[plan.project];
  return {
    gc: GC,
    owner: p.owner,
    project: { name: p.name, number: p.number, address: `${p.address}, ${p.city}, ${p.state} ${p.zip}`, state: p.state },
    sub: { name: plan.sub.name, address: plan.sub.address, signer: plan.sub.contact, signerTitle: plan.sub.title },
  };
}

function billingContract(plan: Plan, includePending: boolean): BillingContract {
  return {
    number: plan.number,
    date: plan.date,
    description: plan.title,
    originalAmount: D(plan.lines.reduce((a, l) => a + l[2], 0)),
    retainageWorkBps: plan.retainage[0],
    retainageStoredBps: plan.retainage[1],
    sov: plan.lines.map(([itemNo, description, value]) => ({ itemNo, description, scheduledValue: D(value) })),
    changeOrders: (plan.changeOrders ?? []).filter((c) => includePending || c.status === 'approved').map((c) => ({ number: c.number, title: c.title, amount: D(c.amount) })),
  };
}

/** Work and stored material billed in one period, from the plan's cumulative percentages. */
function progressFor(plan: Plan, period: number): Record<string, { work?: number; stored?: number }> {
  const out: Record<string, { work?: number; stored?: number }> = {};
  const delta = (value: number, pct: number[]) => {
    const prev = period === 0 ? 0 : pct[period - 1]!;
    return D(Math.round((value * (pct[period]! - prev)) / 100));
  };
  for (const [itemNo, , value, pct] of plan.lines) {
    const work = delta(value, pct);
    if (work) out[itemNo] = { work };
  }
  for (const co of plan.changeOrders ?? []) {
    const work = delta(co.amount, co.pct);
    if (work) out[co.number] = { work };
  }
  for (const [p, itemNo, dollars] of plan.stored ?? []) {
    if (p === period) out[itemNo] = { ...out[itemNo], stored: D(dollars) };
  }
  return out;
}

async function ctxFor(db: DB, orgId: string, userId: string): Promise<Ctx> {
  const [row] = await db
    .select({ user: users, role: memberships.role, org: organizations })
    .from(memberships)
    .innerJoin(users, eq(users.id, memberships.userId))
    .innerJoin(organizations, eq(organizations.id, memberships.orgId))
    .where(and(eq(memberships.orgId, orgId), eq(memberships.userId, userId)));
  if (!row) throw new Error('Demo member not found');
  return { orgId, orgName: row.org.name, isDemo: row.org.isDemo, userId, userName: row.user.name, userEmail: row.user.email, role: row.role as Role };
}

// ── Building the workspace ──────────────────────────────────────────────────

export async function findDemoOrganization(db: DB, userId: string): Promise<string | null> {
  const [row] = await db
    .select({ id: organizations.id })
    .from(memberships)
    .innerJoin(organizations, eq(organizations.id, memberships.orgId))
    .where(and(eq(memberships.userId, userId), eq(memberships.status, 'active'), eq(organizations.isDemo, true)));
  return row?.id ?? null;
}

/** Create the demo workspace for a user (or return the one they already have). Takes several seconds. */
export async function createDemoWorkspace(db: DB, userId: string, now: Date = new Date()): Promise<{ orgId: string; created: boolean }> {
  const existing = await findDemoOrganization(db, userId);
  if (existing) return { orgId: existing, created: false };

  const periods = periodEnds(now);
  const start = new Date(new Date(`${periods[0]}T15:00:00Z`).getTime() - 40 * DAY);
  const orgId = await createOrganization(db, userId, DEMO_ORG_NAME, { isDemo: true, at: start });
  const owner = await ctxFor(db, orgId, userId);

  // Fictitious colleagues, so assignments, approvals and workload have names. They cannot sign in.
  const team: Record<string, Ctx> = {};
  for (const member of TEAM) {
    const id = newId('usr');
    const email = `${member.name.toLowerCase().replace(/[^a-z]+/g, '.')}.${randomToken(4).toLowerCase().replace(/[^a-z0-9]/g, 'x')}@${DEMO_EMAIL_DOMAIN}`;
    await db.insert(users).values({ id, email, name: member.name, passwordHash: await hashPassword(randomToken(24)), createdAt: start });
    await db.insert(memberships).values({ id: newId('mem'), orgId, userId: id, role: member.role, createdAt: start });
    team[member.name] = { orgId, orgName: DEMO_ORG_NAME, isDemo: true, userId: id, userName: member.name, userEmail: email, role: member.role };
  }
  const controller = team['Dana Whitaker']!;
  const reviewerFor = (plan: Plan) => (plan.project === 0 ? team['Marcus Chen']! : team['Priya Natarajan']!);
  await recordAudit(db, { orgId, actor: owner, action: 'team.joined', entityType: 'membership', summary: `Demo team added: ${TEAM.map((t) => t.name).join(', ')}`, at: start });

  // Records. Inserted directly (not through the record services) only so they can carry past dates.
  const projectIds: string[] = [];
  for (const [index, p] of PROJECTS.entries()) {
    const id = newId('prj');
    projectIds.push(id);
    await db.insert(projects).values({ id, orgId, name: p.name, number: p.number, address: p.address, city: p.city, state: p.state, ownerName: p.owner, budget: demoBudget(index as Plan['project']), createdBy: userId, createdAt: start });
    await recordAudit(db, { orgId, actor: owner, action: 'project.created', entityType: 'project', entityId: id, summary: `Created project ${p.name}`, at: start });
  }
  const contractIds = new Map<Plan, string>();
  for (const plan of PLANS) {
    const subId = newId('sub');
    await db.insert(subcontractors).values({ id: subId, orgId, name: plan.sub.name, trade: plan.sub.trade, contactName: plan.sub.contact, contactEmail: plan.sub.email, address: plan.sub.address, createdAt: start });
    const contractId = newId('con');
    contractIds.set(plan, contractId);
    const bc = billingContract(plan, false);
    await db.insert(contracts).values({ id: contractId, orgId, projectId: projectIds[plan.project]!, subcontractorId: subId, number: plan.number, title: plan.title, originalAmount: bc.originalAmount, retainageWorkBps: plan.retainage[0], retainageStoredBps: plan.retainage[1], executedOn: plan.date, createdAt: start });
    let order = 0;
    for (const line of bc.sov) await db.insert(sovLines).values({ id: newId('sov'), orgId, contractId, itemNo: line.itemNo, description: line.description, scheduledValue: line.scheduledValue, sortOrder: order++, createdAt: start });
    for (const co of plan.changeOrders ?? []) {
      const coId = newId('co');
      await db.insert(changeOrders).values({ id: coId, orgId, contractId, number: co.number, title: co.title, amount: D(co.amount), status: co.status, approvedOn: co.status === 'approved' ? periods[Math.max(0, co.pct.findIndex((x) => x > 0) - 1)]! : null, createdAt: start });
      if (co.status === 'approved') await db.insert(sovLines).values({ id: newId('sov'), orgId, contractId, itemNo: co.number, description: co.title, scheduledValue: D(co.amount), sortOrder: order++, changeOrderId: coId, createdAt: start });
    }
    await recordAudit(db, { orgId, actor: owner, action: 'contract.created', entityType: 'contract', entityId: contractId, summary: `Created subcontract ${plan.number} with ${plan.sub.name} on ${PROJECTS[plan.project].name}`, at: start });
  }

  // The contract with the owner on the first project, so owner billing has something to work from.
  // Its schedule follows the three subcontracts, plus general conditions, insurance and the fee.
  // No application to the owner is made: starting the first one is left to whoever explores.
  {
    const project = 0 as const;
    const plans = PLANS.filter((p) => p.project === project).sort((a, b) => a.number.localeCompare(b.number));
    const subValue = (plan: Plan) => D(plan.lines.reduce((a, l) => a + l[2], 0) + (plan.changeOrders ?? []).filter((c) => c.status === 'approved').reduce((a, c) => a + c.amount, 0));
    const subTotal = plans.reduce((a, p) => a + subValue(p), 0);
    const share = (bps: number) => Math.round((subTotal * bps) / 10_000 / 100_000) * 100_000; // to the nearest $1,000
    const rows: Array<{ description: string; value: number; basis: 'subcontracts' | 'overall' | 'manual'; contractIds: string[] }> = [
      { description: 'General conditions', value: share(600), basis: 'manual', contractIds: [] },
      ...plans.map((plan) => ({ description: `${plan.title} (${plan.sub.name})`, value: subValue(plan), basis: 'subcontracts' as const, contractIds: [contractIds.get(plan)!] })),
      { description: 'Insurance and bonds', value: share(150), basis: 'overall', contractIds: [] },
      { description: 'Contractor’s fee', value: share(450), basis: 'overall', contractIds: [] },
    ];
    const primeId = newId('pc');
    const p = PROJECTS[project];
    await db.insert(primeContracts).values({ id: primeId, orgId, projectId: projectIds[project]!, number: `OC-${p.number}`, architectName: 'Moreno Kline Architects', originalAmount: rows.reduce((a, r) => a + r.value, 0), retainageWorkBps: 1000, retainageStoredBps: 1000, executedOn: '2026-01-20', createdBy: userId, createdAt: start });
    for (const [i, r] of rows.entries()) {
      await db.insert(primeLines).values({ id: newId('pl'), orgId, primeContractId: primeId, itemNo: String(i + 1), description: r.description, scheduledValue: r.value, sortOrder: i, basis: r.basis, contractIds: r.contractIds, createdAt: start });
    }
    await recordAudit(db, { orgId, actor: owner, action: 'owner_billing.contract_created', entityType: 'project', entityId: projectIds[project]!, summary: `Set up the owner contract on ${p.name} with ${p.owner}`, at: start });
  }

  // Lay the whole history out as timed steps, then run them in chronological order
  // so the audit trail reads the way it would have happened.
  type Step = { at: Date; run: () => Promise<void> };
  const steps: Step[] = [];
  const states = new Map<Plan, BillingState | null>(PLANS.map((p) => [p, null]));
  const appIds = new Map<string, string>();
  const submitPackage = async (plan: Plan, pkg: SamplePackage, at: Date, key: string, by: Ctx, via: 'upload' | 'email' = 'upload') => {
    const bytes = await renderPackage(pkg);
    const filename = `${fileStem(pkg.sub.name)}-PayApp-${String(pkg.applicationNumber).padStart(2, '0')}-${pkg.periodTo}.pdf`;
    const { id } = await createApplication(db, via === 'email' ? { system: true, orgId, name: 'Email intake' } : by, {
      files: [{ filename, bytes }],
      receivedAt: at,
      receivedVia: via,
      senderEmail: via === 'email' ? plan.sub.email : null,
      defer: true,
    });
    await processApplication(db, orgId, id, { now: new Date(at.getTime() + 40_000) });
    appIds.set(key, id);
    return id;
  };

  for (const plan of PLANS) {
    const rand = seeded(plan.number);
    const reviewer = reviewerFor(plan);
    const parties = partiesFor(plan);

    for (let period = plan.first; period <= 3; period++) {
      const number = period - plan.first + 1;
      const key = `${plan.number}#${number}`;
      const end = new Date(`${periods[period]}T00:00:00Z`).getTime();
      const received = new Date(end + (-3 + Math.floor(rand() * 5)) * DAY + (15 + Math.floor(rand() * 6)) * 3_600_000 + Math.floor(rand() * 3_000_000));
      const submitted = new Date(received.getTime() + (0.8 + rand() * 2.2) * DAY);
      const approved = new Date(submitted.getTime() + (0.4 + rand() * 2.4) * DAY);
      const quirk = plan.history?.find((h) => h[0] === period)?.[1];
      const build = () => buildPackage(parties, billingContract(plan, false), states.get(plan) ?? null, { applicationNumber: number, periodTo: periods[period]!, applicationDate: iso(received), progress: progressFor(plan, period) });

      if (quirk === 'rejected_then_resubmitted') {
        // First attempt over-bills a line and is rejected; the corrected resubmission follows.
        const firstTry = new Date(received.getTime() - 4 * DAY);
        steps.push({
          at: firstTry,
          run: async () => {
            const pkg = build();
            pkg.applicationDate = iso(firstTry);
            defects.overbill(pkg, plan.lines[1]![0], D(18500));
            await submitPackage(plan, pkg, firstTry, `${key}-rejected`, reviewer);
          },
        });
        steps.push({
          at: new Date(firstTry.getTime() + 1.2 * DAY),
          run: async () => rejectApplication(db, controller, appIds.get(`${key}-rejected`)!, `Bills ${plan.lines[1]![1]} beyond its scheduled value. Returned to ${plan.sub.name} for a corrected application.`, { now: new Date(firstTry.getTime() + 1.2 * DAY) }),
        });
      }

      steps.push({
        at: received,
        run: async () => {
          const pkg = build();
          if (quirk === 'waiver_date_warning' && pkg.waiver) pkg.waiver.throughDate = iso(new Date(end - 6 * DAY));
          states.set(plan, stateAfter(pkg));
          const id = await submitPackage(plan, pkg, received, key, reviewer, rand() < 0.35 ? 'email' : 'upload');
          await assignReviewer(db, reviewer, id, reviewer.userId, { now: new Date(received.getTime() + 20 * 60_000) });
        },
      });
      steps.push({ at: submitted, run: async () => submitForApproval(db, reviewer, appIds.get(key)!, null, { now: submitted }) });
      steps.push({
        at: approved,
        run: async () => {
          const id = appIds.get(key)!;
          const open = await db.select().from(findings).where(and(eq(findings.payApplicationId, id), eq(findings.status, 'open')));
          await approveApplication(db, controller, id, { now: approved, acknowledgeWarnings: open.some((f) => f.severity === 'warning') });
        },
      });
      // Approved billing is handed to accounts payable the next working morning.
      const exported = new Date(approved.getTime() + (0.6 + rand() * 0.8) * DAY);
      steps.push({ at: exported, run: async () => void (await createExport(db, reviewer, appIds.get(key)!, 'csv', { now: exported })) });
    }

    // ── The current billing cycle: one of each situation a finance team actually sees ──
    const number = 4 - plan.first + 1;
    const key = `${plan.number}#${number}`;
    const ago = (days: number, hours = 0) => new Date(now.getTime() - days * DAY - hours * 3_600_000);
    const current = (mutate?: (pkg: SamplePackage) => void) => {
      const pkg = buildPackage(parties, billingContract(plan, plan.current === 'unapproved_co'), states.get(plan) ?? null, { applicationNumber: number, periodTo: periods[4]!, applicationDate: periods[4]!, progress: progressFor(plan, 4) });
      mutate?.(pkg);
      return pkg;
    };

    switch (plan.current) {
      case 'double_billing':
        steps.push({
          at: ago(3, 5),
          run: async () => {
            const id = await submitPackage(plan, current((p) => defects.understatePreviousCertificates(p, D(18400))), ago(3, 5), key, reviewer, 'email');
            await assignReviewer(db, reviewer, id, reviewer.userId, { now: ago(3, 4) });
          },
        });
        break;
      case 'short_retainage':
        steps.push({
          at: ago(2, 2),
          run: async () => {
            const id = await submitPackage(plan, current((p) => defects.retainAt(p, 500)), ago(2, 2), key, reviewer);
            await assignReviewer(db, reviewer, id, reviewer.userId, { now: ago(2, 1) });
          },
        });
        break;
      case 'unapproved_co':
        steps.push({
          at: ago(1, 6),
          run: async () => {
            await submitPackage(plan, current(), ago(1, 6), key, reviewer, 'email');
          },
        });
        break;
      case 'pending_approval':
        steps.push({
          at: ago(5, 3),
          run: async () => {
            const id = await submitPackage(plan, current(), ago(5, 3), key, reviewer);
            await assignReviewer(db, reviewer, id, reviewer.userId, { now: ago(5, 2) });
          },
        });
        steps.push({ at: ago(1, 3), run: async () => submitForApproval(db, reviewer, appIds.get(key)!, 'Checked against the September certificate. Clean.', { now: ago(1, 3) }) });
        break;
      case 'on_hold':
        steps.push({
          at: ago(8, 4),
          run: async () => {
            const id = await submitPackage(
              plan,
              current((p) => {
                defects.arithmeticSlip(p, D(2700));
                defects.waiverAmount(p, (p.header.currentPaymentDue ?? 0) - D(9000));
              }),
              ago(8, 4),
              key,
              reviewer,
            );
            await assignReviewer(db, reviewer, id, reviewer.userId, { now: ago(8, 3) });
          },
        });
        steps.push({
          at: ago(6, 2),
          run: async () => {
            await sendSubcontractorMessage(db, reviewer, appIds.get(key)!, {
              to: plan.sub.email,
              subject: `Pay application #${number} – ${PROJECTS[plan.project].name}: corrections needed`,
              body: `Hi ${plan.sub.contact.split(' ')[0]},\n\nWe cannot approve application #${number} as submitted:\n\n1. Line 6 does not equal line 4 less line 5.\n2. The conditional waiver is for a different amount than the application.\n\nPlease send a corrected application and a waiver for the correct amount.\n\nThank you,\n${reviewer.userName}`,
              hold: true,
              now: ago(6, 2),
            });
          },
        });
        break;
      case 'approved_exported':
      case 'approved':
        steps.push({
          at: ago(9, 5),
          run: async () => {
            const id = await submitPackage(plan, current(), ago(9, 5), key, reviewer);
            await assignReviewer(db, reviewer, id, reviewer.userId, { now: ago(9, 4) });
          },
        });
        steps.push({ at: ago(7, 6), run: async () => submitForApproval(db, reviewer, appIds.get(key)!, null, { now: ago(7, 6) }) });
        steps.push({
          at: ago(plan.current === 'approved' ? 1 : 6, 1),
          run: async () => {
            await approveApplication(db, controller, appIds.get(key)!, { now: ago(plan.current === 'approved' ? 1 : 6, 1) });
          },
        });
        if (plan.current === 'approved_exported') {
          steps.push({
            at: ago(5, 4),
            run: async () => {
              await createExport(db, controller, appIds.get(key)!, 'pdf', { now: ago(5, 4) });
              await createBatchExport(db, controller, [appIds.get(key)!], { now: ago(5, 3) });
            },
          });
        }
        break;
      case 'sample':
        break; // left for the person exploring the demo to upload
    }
  }

  // A package from a subcontractor nobody has set up yet.
  const stranger = PLANS[0]!;
  steps.push({
    at: new Date(now.getTime() - 5 * 3_600_000),
    run: async () => {
      const parties = partiesFor(stranger);
      parties.sub = { name: 'Tri-County Glass & Glazing, Inc.', address: '1420 Rutherford Ln, Austin, TX 78753', signer: 'Helen Voss', signerTitle: 'Controller' };
      const contract: BillingContract = {
        number: 'SC-2301-27',
        date: '2026-08-12',
        description: 'Storefront & glazing',
        originalAmount: D(684000),
        retainageWorkBps: 1000,
        retainageStoredBps: 1000,
        sov: [
          { itemNo: '1', description: 'Shop drawings & engineering', scheduledValue: D(48000) },
          { itemNo: '2', description: 'Storefront framing', scheduledValue: D(286000) },
          { itemNo: '3', description: 'Glass & glazing', scheduledValue: D(302000) },
          { itemNo: '4', description: 'Sealants & closeout', scheduledValue: D(48000) },
        ],
        changeOrders: [],
      };
      const pkg = buildPackage(parties, contract, null, { applicationNumber: 1, periodTo: periods[4]!, applicationDate: periods[4]!, progress: { '1': { work: D(48000) }, '2': { work: D(71500), stored: D(38000) } } });
      await submitPackage({ ...stranger, sub: { ...stranger.sub, name: parties.sub.name, email: 'accounting@tricountyglass.example' } }, pkg, new Date(now.getTime() - 5 * 3_600_000), 'stranger', owner, 'email');
    },
  });

  steps.sort((a, b) => a.at.getTime() - b.at.getTime());
  for (const step of steps) await step.run();

  // Leave only the last few days unread so the notification list is useful, not a wall.
  await db.update(notifications).set({ readAt: now }).where(and(eq(notifications.orgId, orgId), lt(notifications.createdAt, new Date(now.getTime() - 4 * DAY))));
  await recordAudit(db, { orgId, actor: { system: true }, action: 'organization.demo_ready', entityType: 'organization', entityId: orgId, summary: 'Demo workspace built: sample documents were generated and processed through the normal intake, verification and approval steps', at: now });
  return { orgId, created: true };
}

/** Remove a demo workspace and everything in it. */
export async function deleteDemoWorkspace(db: DB, ctx: Ctx): Promise<void> {
  assertCan(ctx, 'org:manage');
  const [org] = await db.select().from(organizations).where(eq(organizations.id, ctx.orgId));
  if (!org?.isDemo) throw new UserError('Only a demo workspace can be deleted this way.');

  const members = await db.select({ userId: memberships.userId }).from(memberships).where(eq(memberships.orgId, org.id));
  // Move anyone signed in to this workspace back to another organisation of theirs.
  for (const m of members) {
    const [other] = await db.select({ orgId: memberships.orgId }).from(memberships).where(and(eq(memberships.userId, m.userId), ne(memberships.orgId, org.id), eq(memberships.status, 'active')));
    await db.update(sessions).set({ orgId: other?.orgId ?? null }).where(and(eq(sessions.userId, m.userId), eq(sessions.orgId, org.id)));
  }
  await db.delete(organizations).where(eq(organizations.id, org.id));
  // The fictitious colleagues exist only for this workspace.
  const fictitious = await db
    .select({ id: users.id })
    .from(users)
    .where(or(like(users.email, `%@${DEMO_EMAIL_DOMAIN}`), like(users.email, `%@${OLD_DEMO_EMAIL_DOMAIN}`)));
  const stillUsed = fictitious.length ? await db.select({ userId: memberships.userId }).from(memberships).where(inArray(memberships.userId, fictitious.map((u) => u.id))) : [];
  const orphans = fictitious.filter((u) => !stillUsed.some((m) => m.userId === u.id)).map((u) => u.id);
  if (orphans.length) await db.delete(users).where(inArray(users.id, orphans));
  if (!isInMemory()) await fs.rm(path.join(dataDir(), 'storage', org.id), { recursive: true, force: true }).catch(() => undefined);
}

// ── Sample packages to upload by hand ───────────────────────────────────────

export type DemoSample = { key: string; title: string; description: string };

async function sampleContext(db: DB, ctx: Ctx) {
  if (!ctx.isDemo) return null;
  const [row] = await db
    .select({ contract: contracts, project: projects, sub: subcontractors })
    .from(contracts)
    .innerJoin(projects, eq(projects.id, contracts.projectId))
    .innerJoin(subcontractors, eq(subcontractors.id, contracts.subcontractorId))
    .where(and(eq(contracts.orgId, ctx.orgId), eq(contracts.number, SAMPLE_CONTRACT)));
  if (!row) return null;
  const sov = await db.select().from(sovLines).where(eq(sovLines.contractId, row.contract.id)).orderBy(sovLines.sortOrder);
  const approved = (await db.select().from(payApplications).where(and(eq(payApplications.contractId, row.contract.id), eq(payApplications.status, 'approved')))).filter((a) => a.approvedRecord).sort((a, b) => (b.applicationNumber ?? 0) - (a.applicationNumber ?? 0));
  const last = approved[0]?.approvedRecord ?? null;
  const itemBySov = new Map(sov.map((s) => [s.id, s.itemNo]));
  const state: BillingState | null = last
    ? {
        applicationNumber: last.application.number,
        totalEarnedLessRetainage: last.approved.totalEarnedLessRetainage,
        workToDate: Object.fromEntries(last.lines.filter((l) => l.sovLineId && itemBySov.has(l.sovLineId)).map((l) => [itemBySov.get(l.sovLineId!)!, l.previous + l.thisPeriod])),
      }
    : null;
  // The period after the last approved one.
  const lastEnd = last ? new Date(`${last.application.periodTo}T00:00:00Z`) : new Date();
  const periodTo = iso(new Date(Date.UTC(lastEnd.getUTCFullYear(), lastEnd.getUTCMonth() + 2, 0)));
  const plan = PLANS.find((p) => p.number === SAMPLE_CONTRACT)!;
  const parties: Parties = {
    gc: GC,
    owner: row.project.ownerName ?? '',
    project: { name: row.project.name, number: row.project.number ?? '', address: [row.project.address, row.project.city, row.project.state].filter(Boolean).join(', '), state: row.project.state ?? 'FL' },
    sub: { name: row.sub.name, address: row.sub.address ?? '', signer: row.sub.contactName ?? plan.sub.contact, signerTitle: plan.sub.title },
  };
  const contract: BillingContract = {
    number: row.contract.number,
    date: row.contract.executedOn ?? plan.date,
    description: row.contract.title,
    originalAmount: row.contract.originalAmount,
    retainageWorkBps: row.contract.retainageWorkBps,
    retainageStoredBps: row.contract.retainageStoredBps,
    sov: sov.filter((s) => !s.changeOrderId).map((s) => ({ itemNo: s.itemNo, description: s.description, scheduledValue: s.scheduledValue })),
    changeOrders: sov.filter((s) => s.changeOrderId).map((s) => ({ number: s.itemNo, title: s.description, amount: s.scheduledValue })),
  };
  // Bill roughly an eighth of each unfinished line.
  const progress: Record<string, { work?: number }> = {};
  for (const s of sov) {
    const done = state?.workToDate[s.itemNo] ?? 0;
    const remaining = s.scheduledValue - done;
    if (remaining <= 0) continue;
    const step = Math.min(remaining, Math.round((s.scheduledValue * 0.125) / 10000) * 10000);
    if (step > 0) progress[s.itemNo] = { work: step };
  }
  const number = (state?.applicationNumber ?? 0) + 1;
  const build = () => buildPackage(parties, contract, state, { applicationNumber: number, periodTo, applicationDate: periodTo, progress });
  return { name: row.sub.name, number, build, anyProgress: Object.keys(progress).length > 0 };
}

export async function listDemoSamples(db: DB, ctx: Ctx): Promise<DemoSample[]> {
  const sample = await sampleContext(db, ctx);
  if (!sample || !sample.anyProgress) return [];
  return [
    { key: 'clean', title: `${sample.name} – application #${sample.number}, in order`, description: 'Pay application, schedule of values and a Florida progress-payment waiver in one PDF. Every check should pass.' },
    {
      key: 'discrepancies',
      title: `${sample.name} – application #${sample.number}, with three problems`,
      description: 'Re-bills $14,200 that was already certified, withholds retainage at 5% instead of 10%, and the waiver is for a different amount.',
    },
    { key: 'scan', title: 'A scanned page with no readable text', description: 'Shows what happens when a document cannot be read automatically on this deployment.' },
  ];
}

export async function renderDemoSample(db: DB, ctx: Ctx, key: string): Promise<{ filename: string; bytes: Uint8Array }> {
  if (key === 'scan') return { filename: 'scanned-page.pdf', bytes: await renderTextlessPdf() };
  const sample = await sampleContext(db, ctx);
  if (!sample) throw new UserError('Sample packages are only available in the demo workspace.');
  const pkg = sample.build();
  if (key === 'discrepancies') {
    defects.understatePreviousCertificates(pkg, D(14200));
    defects.retainAt(pkg, 500);
    defects.waiverAmount(pkg, (pkg.header.currentPaymentDue ?? 0) + D(6500));
  } else if (key !== 'clean') {
    throw new UserError('Unknown sample.');
  } else {
    recompute(pkg);
  }
  const base = fileStem(sample.name);
  return { filename: `${base}-PayApp-${String(sample.number).padStart(2, '0')}${key === 'discrepancies' ? '-with-discrepancies' : ''}.pdf`, bytes: await renderPackage(pkg) };
}
