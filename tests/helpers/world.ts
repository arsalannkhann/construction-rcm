/**
 * A small world for service-level tests: an organisation with a team, one
 * project, one subcontractor and one subcontract, plus helpers to submit
 * billing packages through the real intake pipeline.
 */
import { eq } from 'drizzle-orm';
import { getDb, type DB } from '@/db';
import { findings, memberships, payApplications, users } from '@/db/schema';
import type { Ctx } from '@/server/auth/permissions';
import { hashPassword } from '@/server/auth/password';
import { newId } from '@/server/ids';
import { renderPackage, type PackagePart, type SamplePackage } from '@/server/samples/pdf';
import { buildPackage, stateAfter, type BillingContract, type BillingState, type Parties, type PeriodInput } from '@/server/samples/scenario';
import { createApplication, processApplication } from '@/server/services/intake';
import { createContract, createProject, createSubcontractor } from '@/server/services/records';
import { signUp } from '@/server/services/team';
import type { Role } from '@/server/types';

const D = (n: number) => Math.round(n * 100);
let counter = 0;

export type World = {
  db: DB;
  orgId: string;
  owner: Ctx;
  controller: Ctx;
  accountant: Ctx;
  pm: Ctx;
  viewer: Ctx;
  projectId: string;
  subcontractorId: string;
  contractId: string;
  parties: Parties;
  contract: BillingContract;
};

export async function addMember(db: DB, orgId: string, orgName: string, role: Role, name: string): Promise<Ctx> {
  const id = newId('usr');
  const email = `${name.toLowerCase().replace(/\s+/g, '.')}.${++counter}@example.test`;
  await db.insert(users).values({ id, email, name, passwordHash: await hashPassword('correct horse battery') });
  await db.insert(memberships).values({ id: newId('mem'), orgId, userId: id, role });
  return { orgId, orgName, isDemo: false, userId: id, userName: name, userEmail: email, role };
}

export async function createWorld(opts: { state?: string; withSchedule?: boolean } = {}): Promise<World> {
  const db = await getDb();
  const n = ++counter;
  const orgName = `Northline Constructors ${n}`;
  const { userId, orgId } = await signUp(db, { name: 'Olivia Owner', email: `owner${n}@example.test`, password: 'correct horse battery', orgName });
  const owner: Ctx = { orgId, orgName, isDemo: false, userId, userName: 'Olivia Owner', userEmail: `owner${n}@example.test`, role: 'owner' };
  const controller = await addMember(db, orgId, orgName, 'controller', 'Carlos Controller');
  const accountant = await addMember(db, orgId, orgName, 'accountant', 'Ana Accountant');
  const pm = await addMember(db, orgId, orgName, 'project_manager', 'Pat Manager');
  const viewer = await addMember(db, orgId, orgName, 'viewer', 'Vic Viewer');

  const state = opts.state ?? 'TX';
  const parties: Parties = {
    gc: { name: orgName, address: '4100 Guadalupe St, Suite 300, Austin, TX 78751' },
    owner: 'Riverside Health Partners',
    project: { name: 'Riverside Medical Office Building', number: '2301', address: '880 Riverside Dr, Austin, TX 78704', state },
    sub: { name: 'Lone Star Electric, LLC', address: '2210 Industrial Blvd, Austin, TX 78745', signer: 'Maria Alvarez', signerTitle: 'Controller' },
  };
  const contract: BillingContract = {
    number: 'SC-2301-16',
    date: '2026-03-02',
    description: 'Electrical',
    originalAmount: D(500000),
    retainageWorkBps: 1000,
    retainageStoredBps: 1000,
    sov: [
      { itemNo: '1', description: 'Mobilization', scheduledValue: D(50000) },
      { itemNo: '2', description: 'Rough-in, levels 1-3', scheduledValue: D(300000) },
      { itemNo: '3', description: 'Fixtures and trim', scheduledValue: D(150000) },
    ],
    changeOrders: [],
  };

  const projectId = await createProject(db, owner, { name: parties.project.name, number: parties.project.number, address: parties.project.address, city: 'Austin', state, ownerName: parties.owner });
  const subcontractorId = await createSubcontractor(db, owner, { name: parties.sub.name, trade: 'Electrical', contactName: 'Maria Alvarez', contactEmail: 'maria@lonestarelectric.example' });
  const contractId = await createContract(db, owner, {
    projectId,
    subcontractorId,
    number: contract.number,
    title: contract.description,
    originalAmount: contract.originalAmount,
    retainageWorkBps: contract.retainageWorkBps,
    retainageStoredBps: contract.retainageStoredBps,
    executedOn: contract.date,
    schedule: opts.withSchedule === false ? [] : contract.sov,
  });

  return { db, orgId, owner, controller, accountant, pm, viewer, projectId, subcontractorId, contractId, parties, contract };
}

/** The standard three applications on the test contract. */
export const PERIODS: PeriodInput[] = [
  { applicationNumber: 1, periodTo: '2026-09-30', applicationDate: '2026-09-28', progress: { '1': { work: D(50000) }, '2': { work: D(60000) } } },
  { applicationNumber: 2, periodTo: '2026-10-31', applicationDate: '2026-10-28', progress: { '2': { work: D(90000) }, '3': { work: D(15000), stored: D(10000) } } },
  { applicationNumber: 3, periodTo: '2026-11-30', applicationDate: '2026-11-25', progress: { '2': { work: D(80000) }, '3': { work: D(30000) } } },
];

export function packageFor(w: World, index: number, prior: BillingState | null, mutate?: (pkg: SamplePackage) => void): SamplePackage {
  const pkg = buildPackage(w.parties, w.contract, prior, PERIODS[index]!);
  mutate?.(pkg);
  return pkg;
}

/** Upload a package through the real pipeline (store → read → match → reconcile) and return the application. */
export async function submit(w: World, pkg: SamplePackage, opts: { by?: Ctx; contractId?: string | null; parts?: PackagePart[]; now?: Date; filename?: string } = {}) {
  const bytes = await renderPackage(pkg, opts.parts);
  const { id } = await createApplication(w.db, opts.by ?? w.accountant, {
    files: [{ filename: opts.filename ?? `payapp-${pkg.applicationNumber}.pdf`, bytes }],
    contractId: opts.contractId,
    defer: true,
    receivedAt: opts.now,
  });
  await processApplication(w.db, w.orgId, id, { now: opts.now });
  return getApp(w, id);
}

export async function getApp(w: World, id: string) {
  const [app] = await w.db.select().from(payApplications).where(eq(payApplications.id, id));
  return app!;
}

export async function openFindings(w: World, appId: string) {
  const rows = await w.db.select().from(findings).where(eq(findings.payApplicationId, appId));
  return rows.filter((f) => f.status === 'open').sort((a, b) => a.sortOrder - b.sortOrder);
}

export { stateAfter, D as dollars };
