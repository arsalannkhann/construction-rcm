/**
 * Import from Procore: a project, its vendors, its approved subcontracts with
 * their schedules of values, and their change orders.
 *
 * Everything is matched on the Procore id stored as `externalId`, so importing
 * the same project again creates nothing twice and never deletes local data.
 * Records are written through the records service, so validation, the audit
 * trail and re-verification of open applications behave exactly as they do
 * for records entered by hand.
 */
import { and, asc, eq } from 'drizzle-orm';
import { pluralize } from '@/lib/utils';
import type { DB } from '@/db';
import { changeOrders, contracts, projects, sovLines, subcontractors } from '@/db/schema';
import { recordAudit } from '@/server/audit';
import { assertCan, UserError, type Ctx } from '@/server/auth/permissions';
import {
  createChangeOrder,
  createContract,
  createProject,
  createSubcontractor,
  saveSchedule,
  updateChangeOrder,
  updateContract,
  type ChangeOrderInput,
  type ScheduleLineInput,
} from '@/server/services/records';
import { procoreId } from './client';
import { friendly, openProcore } from './connection';
import { ProcoreConnectionError, updateIntegration } from './oauth';

const SOURCE = 'procore';

export type ProcoreProjectListing = { id: string; name: string; number: string | null; active: boolean; imported: boolean };

export type ProcoreImportResult = {
  projectId: string;
  created: { subcontractors: number; contracts: number; scheduleLines: number; changeOrders: number };
  updated: { contracts: number };
  skipped: Array<{ what: string; reason: string }>;
};

type Raw = Record<string, unknown>;

const text = (v: unknown): string | null => (typeof v === 'string' ? v.trim() || null : typeof v === 'number' && Number.isFinite(v) ? String(v) : null);
const clip = (s: string, max = 200) => (s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s);
const nameKey = (s: string) => s.trim().replace(/\s+/g, ' ').toLowerCase();
const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

/**
 * Procore sends amounts and percentages as numbers or as decimal strings.
 * Returns the value in hundredths (dollars → cents, percent → basis points).
 * Strings are read digit by digit so no value passes through floating point.
 */
export function toHundredths(value: unknown): number | null {
  let out: number;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return null;
    out = Math.round(value * 100);
  } else if (typeof value === 'string') {
    const m = /^([+-]?)(\d*)(?:\.(\d*))?$/.exec(value.trim().replace(/,/g, ''));
    if (!m || (!m[2] && !m[3])) return null;
    const frac = m[3] ?? '';
    out = Number(m[2] || '0') * 100 + Number(`${frac}00`.slice(0, 2));
    if (frac.length > 2 && frac[2]! >= '5') out += 1; // round half away from zero
    if (m[1] === '-') out = -out;
  } else {
    return null;
  }
  if (!Number.isSafeInteger(out)) return null;
  return out === 0 ? 0 : out;
}

const isBillable = (status: string) => ['approved', 'complete'].includes(status.toLowerCase());

function changeOrderStatus(status: string | null): ChangeOrderInput['status'] {
  const s = status?.toLowerCase();
  return s === 'approved' ? 'approved' : s === 'rejected' ? 'rejected' : s === 'void' ? 'void' : 'pending';
}

/** A local validation failure on one record is reported and the import carries on; a broken connection stops it. */
const isRecordProblem = (err: unknown): err is UserError => err instanceof UserError && !(err instanceof ProcoreConnectionError);

// ── Listing ─────────────────────────────────────────────────────────────────

export async function listProcoreProjects(db: DB, ctx: Ctx): Promise<ProcoreProjectListing[]> {
  assertCan(ctx, 'integrations:manage');
  return friendly(async () => {
    const { client, companyId } = await openProcore(db, ctx.orgId);
    const rows = await client.getAll<Raw>('/rest/v1.1/projects', { company_id: companyId });
    const local = await db.select({ externalId: projects.externalId }).from(projects).where(and(eq(projects.orgId, ctx.orgId), eq(projects.externalSource, SOURCE)));
    const imported = new Set(local.map((p) => p.externalId));
    const out: ProcoreProjectListing[] = [];
    for (const r of rows) {
      const id = procoreId(r.id);
      if (!id) continue;
      out.push({ id, name: text(r.name) ?? `Project ${id}`, number: text(r.project_number), active: r.active !== false, imported: imported.has(id) });
    }
    return out.sort((a, b) => Number(b.active) - Number(a.active) || a.name.localeCompare(b.name));
  });
}

// ── Import ──────────────────────────────────────────────────────────────────

type RemoteLine = { externalId: string; itemNo: string; description: string; scheduledValue: number };

/** Schedule lines in Procore's order. Throws a UserError naming the line if any amount cannot be read exactly. */
function readLines(rows: Raw[]): RemoteLine[] {
  const ordered = rows
    .map((row, index) => ({ row, index, position: Number(row.position) }))
    .sort((a, b) => (Number.isFinite(a.position) ? a.position : Infinity) - (Number.isFinite(b.position) ? b.position : Infinity) || a.index - b.index);
  const positions = ordered.map((o) => text(o.row.position));
  const usePositions = positions.every((p) => p !== null) && new Set(positions).size === positions.length;
  return ordered.map((o, i) => {
    const itemNo = usePositions ? positions[i]! : String(i + 1);
    const externalId = procoreId(o.row.id);
    const scheduledValue = toHundredths(o.row.amount);
    const description = clip(text(o.row.description) ?? `Line ${itemNo}`);
    if (!externalId) throw new UserError(`Schedule line ${itemNo} “${description}” has no id in Procore’s response.`);
    if (scheduledValue === null) throw new UserError(`Schedule line ${itemNo} “${description}” has an amount that could not be read exactly.`);
    return { externalId, itemNo, description, scheduledValue };
  });
}

export async function importProject(db: DB, ctx: Ctx, procoreProjectId: string): Promise<ProcoreImportResult> {
  assertCan(ctx, 'integrations:manage');
  assertCan(ctx, 'records:write');
  const pid = procoreId(procoreProjectId);
  if (!pid) throw new UserError('Choose a Procore project to import.');

  return friendly(async () => {
    const { client, companyId, companyName } = await openProcore(db, ctx.orgId);
    const result: ProcoreImportResult = { projectId: '', created: { subcontractors: 0, contracts: 0, scheduleLines: 0, changeOrders: 0 }, updated: { contracts: 0 }, skipped: [] };
    const skip = (what: string, reason: string) => void result.skipped.push({ what, reason });

    // ── Project ──
    const remoteProject = (await client.getAll<Raw>('/rest/v1.1/projects', { company_id: companyId })).find((p) => procoreId(p.id) === pid);
    if (!remoteProject) throw new UserError(`That project was not found in the connected Procore company${companyName ? ` (${companyName})` : ''}.`);
    const byExternalId = and(eq(projects.orgId, ctx.orgId), eq(projects.externalSource, SOURCE), eq(projects.externalId, pid));
    let [project] = await db.select().from(projects).where(byExternalId);
    if (!project) {
      await createProject(db, ctx, { name: clip(text(remoteProject.name) ?? `Procore project ${pid}`), number: text(remoteProject.project_number) }, { source: SOURCE, id: pid });
      [project] = await db.select().from(projects).where(byExternalId);
    }
    if (!project) throw new Error('The imported project could not be read back.');
    result.projectId = project.id;
    if (!project.state) skip(`Project ${project.name}: state`, 'The project’s state is not read from Procore. Set it on the project so lien waivers are checked against the right statutory form.');

    // ── Vendors → subcontractors ──
    const local = await db.select().from(subcontractors).where(eq(subcontractors.orgId, ctx.orgId));
    const linked = new Map<string, string>();
    const unlinkedByName = new Map<string, string>();
    for (const s of local) {
      if (s.externalSource === SOURCE && s.externalId) linked.set(s.externalId, s.id);
      else if (!s.externalId && !unlinkedByName.has(nameKey(s.name))) unlinkedByName.set(nameKey(s.name), s.id);
    }
    const ensureSubcontractor = async (vendor: { id: string; name: string; email: string | null }): Promise<string> => {
      const known = linked.get(vendor.id);
      if (known) return known;
      // The same company entered by hand earlier: link it rather than create a twin.
      const sameName = unlinkedByName.get(nameKey(vendor.name));
      if (sameName) {
        await db.update(subcontractors).set({ externalSource: SOURCE, externalId: vendor.id }).where(and(eq(subcontractors.orgId, ctx.orgId), eq(subcontractors.id, sameName)));
        await recordAudit(db, { orgId: ctx.orgId, actor: ctx, action: 'subcontractor.linked', entityType: 'subcontractor', entityId: sameName, summary: `Linked subcontractor ${vendor.name} to Procore vendor ${vendor.id} (matched by name)`, data: { source: SOURCE, externalId: vendor.id } });
        unlinkedByName.delete(nameKey(vendor.name));
        linked.set(vendor.id, sameName);
        return sameName;
      }
      const id = await createSubcontractor(db, ctx, { name: clip(vendor.name), contactEmail: vendor.email && EMAIL.test(vendor.email) ? vendor.email : null }, { source: SOURCE, id: vendor.id });
      result.created.subcontractors += 1;
      linked.set(vendor.id, id);
      return id;
    };

    const vendors = new Map<string, { id: string; name: string; email: string | null; active: boolean }>();
    for (const v of await client.getAll<Raw>(`/rest/v1.1/projects/${pid}/vendors`)) {
      const id = procoreId(v.id);
      if (!id) continue;
      const name = text(v.name);
      if (!name) {
        skip(`Vendor ${id}`, 'Has no name in Procore.');
        continue;
      }
      vendors.set(id, { id, name, email: text(v.email_address), active: v.is_active !== false });
    }
    for (const vendor of vendors.values()) {
      // Inactive vendors come in only if an approved subcontract below needs them.
      if (vendor.active) await ensureSubcontractor(vendor);
    }

    // ── Subcontracts ──
    for (const listed of await client.getAll<Raw>('/rest/v1.0/work_order_contracts', { project_id: pid })) {
      const cid = procoreId(listed.id);
      if (!cid) continue;
      const listedStatus = text(listed.status);
      const listedLabel = `Subcontract ${text(listed.number) ?? cid}`;
      const notBillable = (status: string | null) => `Its status in Procore is ${status ? `“${status}”` : 'not set'}. Only Approved or Complete subcontracts are imported.`;
      if (listedStatus && !isBillable(listedStatus)) {
        skip(listedLabel, notBillable(listedStatus));
        continue;
      }

      const detail = await client.get<Raw>(`/rest/v1.0/work_order_contracts/${cid}`, { project_id: pid });
      const number = clip(text(detail.number) ?? text(listed.number) ?? `PROCORE-${cid}`);
      const label = `Subcontract ${number}`;
      const status = text(detail.status) ?? listedStatus;
      if (!status || !isBillable(status)) {
        skip(label, notBillable(status));
        continue;
      }
      if (text(detail.accounting_method)?.toLowerCase().startsWith('unit')) {
        skip(label, 'It is billed by unit and quantity in Procore. Unit/quantity billing is not supported; only amount-based subcontracts are imported.');
        continue;
      }
      const vendorRef = (detail.vendor ?? null) as Raw | null;
      const vendorId = procoreId(vendorRef?.id);
      const vendor = vendorId ? (vendors.get(vendorId) ?? (text(vendorRef?.name) ? { id: vendorId, name: text(vendorRef?.name)!, email: null, active: true } : null)) : null;
      if (!vendor) {
        skip(label, 'No contract company is assigned to it in Procore.');
        continue;
      }

      const lineRows = await client.getAll<Raw>(`/rest/v1.0/work_order_contracts/${cid}/line_items`, { project_id: pid });
      const changeOrderRows = (await client.getAll<Raw>(`/rest/v1.0/projects/${pid}/commitment_change_orders`, { 'filters[contract_id]': cid })).filter(
        (co) => co.contract_id === undefined || co.contract_id === null || procoreId(co.contract_id) === cid,
      );

      let contractId: string;
      let refreshed = false;
      try {
        const lines = readLines(lineRows);
        const originalAmount = lines.reduce((total, l) => total + l.scheduledValue, 0);
        if (lines.length === 0 || originalAmount <= 0) throw new UserError('It has no schedule of values with a positive total in Procore, so there is nothing to bill against.');

        const hasRetainage = detail.retainage_percent !== null && detail.retainage_percent !== undefined && detail.retainage_percent !== '';
        const retainageBps = hasRetainage ? toHundredths(detail.retainage_percent) : null;
        if (hasRetainage && (retainageBps === null || retainageBps < 0 || retainageBps > 5000)) {
          throw new UserError(`Its retainage in Procore (${String(detail.retainage_percent)}%) is outside the 0–50% this product supports.`);
        }
        const title = clip(text(detail.title) ?? vendor.name);
        const subcontractorId = await ensureSubcontractor(vendor);

        const [existing] = await db.select().from(contracts).where(and(eq(contracts.orgId, ctx.orgId), eq(contracts.externalSource, SOURCE), eq(contracts.externalId, cid)));
        let retainageUnset: boolean;
        if (!existing) {
          contractId = await createContract(
            db,
            ctx,
            {
              projectId: project.id,
              subcontractorId,
              number,
              title,
              originalAmount,
              retainageWorkBps: retainageBps ?? 0,
              retainageStoredBps: retainageBps ?? 0,
              schedule: lines.map((l) => ({ itemNo: l.itemNo, description: l.description, scheduledValue: l.scheduledValue, externalId: l.externalId })),
            },
            { source: SOURCE, id: cid },
          );
          result.created.contracts += 1;
          result.created.scheduleLines += lines.length;
          retainageUnset = retainageBps === null;
        } else {
          contractId = existing.id;
          refreshed = await refreshContract(db, ctx, existing, { number, title, originalAmount, retainageBps, lines }, result, skip);
          retainageUnset = retainageBps === null && existing.retainageWorkBps === 0 && existing.retainageStoredBps === 0;
        }
        if (retainageUnset) skip(`${label}: retainage`, 'Procore has no retainage percentage for this subcontract, so it is held at 0% here. Set the retainage on the contract before reviewing applications against it.');
      } catch (err) {
        if (!isRecordProblem(err)) throw err;
        skip(label, err.message);
        continue;
      }

      const changeOrdersChanged = await syncChangeOrders(db, ctx, contractId, number, changeOrderRows, result, skip);
      if (refreshed || changeOrdersChanged) result.updated.contracts += 1;
    }

    for (const vendor of vendors.values()) {
      if (!vendor.active && !linked.has(vendor.id)) skip(`Vendor ${vendor.name}`, 'It is inactive in Procore and holds no approved subcontract on this project.');
    }

    const now = new Date();
    await updateIntegration(db, ctx.orgId, { lastSyncAt: now, lastError: null });
    const c = result.created;
    await recordAudit(db, {
      orgId: ctx.orgId,
      actor: ctx,
      action: 'integration.procore_imported',
      entityType: 'project',
      entityId: project.id,
      summary:
        `Imported project ${project.name} from Procore: created ${pluralize(c.subcontractors, 'subcontractor')}, ${pluralize(c.contracts, 'subcontract')}, ` +
        `${pluralize(c.scheduleLines, 'schedule line')} and ${pluralize(c.changeOrders, 'change order')}; updated ${pluralize(result.updated.contracts, 'subcontract')}; ` +
        `${pluralize(result.skipped.length, 'item')} skipped or needing attention`,
      data: { source: SOURCE, procoreProjectId: pid, created: c, updated: result.updated, skipped: result.skipped },
      at: now,
    });
    return result;
  });
}

/** Bring an already-imported contract up to date. Returns whether anything changed. Never removes a line. */
async function refreshContract(
  db: DB,
  ctx: Ctx,
  existing: typeof contracts.$inferSelect,
  remote: { number: string; title: string; originalAmount: number; retainageBps: number | null; lines: RemoteLine[] },
  result: ProcoreImportResult,
  skip: (what: string, reason: string) => void,
): Promise<boolean> {
  let changed = false;

  // Retainage follows Procore only when Procore states one and it differs from the rate on completed work here.
  const adoptRetainage = remote.retainageBps !== null && remote.retainageBps !== existing.retainageWorkBps;
  const next = {
    number: remote.number,
    title: remote.title,
    originalAmount: remote.originalAmount,
    retainageWorkBps: adoptRetainage ? remote.retainageBps! : existing.retainageWorkBps,
    retainageStoredBps: adoptRetainage ? remote.retainageBps! : existing.retainageStoredBps,
    executedOn: existing.executedOn,
  };
  if (next.number !== existing.number || next.title !== existing.title || next.originalAmount !== existing.originalAmount || adoptRetainage) {
    await updateContract(db, ctx, existing.id, next);
    changed = true;
  }

  const base = (await db.select().from(sovLines).where(and(eq(sovLines.orgId, ctx.orgId), eq(sovLines.contractId, existing.id))).orderBy(asc(sovLines.sortOrder))).filter((l) => !l.changeOrderId);
  const merged: ScheduleLineInput[] = base.map((l) => ({ id: l.id, itemNo: l.itemNo, description: l.description, scheduledValue: l.scheduledValue }));
  const taken = new Set(base.map((l) => l.itemNo.toLowerCase()));
  const remoteIds = new Set(remote.lines.map((l) => l.externalId));
  let added = 0;
  let edited = false;
  for (const line of remote.lines) {
    const mine = base.find((l) => l.externalId === line.externalId);
    if (mine) {
      const target = merged.find((m) => m.id === mine.id)!;
      if (target.description !== line.description || target.scheduledValue !== line.scheduledValue) {
        target.description = line.description;
        target.scheduledValue = line.scheduledValue;
        edited = true;
      }
      continue;
    }
    let itemNo = line.itemNo;
    for (let n = merged.length + 1; taken.has(itemNo.toLowerCase()); n++) itemNo = String(n);
    taken.add(itemNo.toLowerCase());
    merged.push({ itemNo, description: line.description, scheduledValue: line.scheduledValue, externalId: line.externalId });
    added += 1;
  }
  if (added > 0 || edited) {
    await saveSchedule(db, ctx, existing.id, merged);
    result.created.scheduleLines += added;
    changed = true;
  }
  for (const l of base) {
    if (l.externalId && !remoteIds.has(l.externalId)) skip(`Subcontract ${remote.number}: line ${l.itemNo} “${l.description}”`, 'It no longer exists in Procore. It was kept here; remove it from the schedule by hand if it should not be billed.');
  }
  return changed;
}

/** Create or update the contract's change orders. Returns whether an existing one changed. */
async function syncChangeOrders(
  db: DB,
  ctx: Ctx,
  contractId: string,
  contractNumber: string,
  rows: Raw[],
  result: ProcoreImportResult,
  skip: (what: string, reason: string) => void,
): Promise<boolean> {
  if (rows.length === 0) return false;
  const existing = await db.select().from(changeOrders).where(and(eq(changeOrders.orgId, ctx.orgId), eq(changeOrders.contractId, contractId)));
  let changed = false;
  for (const row of rows) {
    const coId = procoreId(row.id);
    if (!coId) continue;
    const number = clip(text(row.number) ?? `PROCORE-${coId}`);
    const label = `Subcontract ${contractNumber}: change order ${number}`;
    const amount = toHundredths(row.grand_total);
    if (amount === null) {
      skip(label, 'Its amount could not be read exactly from Procore’s response.');
      continue;
    }
    if (amount === 0) {
      skip(label, 'It has a zero amount in Procore, so it does not change the contract value.');
      continue;
    }
    const input: ChangeOrderInput = { number, title: clip(text(row.title) ?? `Change order ${number}`), amount, status: changeOrderStatus(text(row.status)) };
    try {
      const mine = existing.find((e) => e.externalId === coId);
      if (!mine) {
        await createChangeOrder(db, ctx, contractId, input, { id: coId });
        result.created.changeOrders += 1;
      } else if (mine.number !== input.number || mine.title !== input.title || mine.amount !== input.amount || mine.status !== input.status) {
        await updateChangeOrder(db, ctx, mine.id, input);
        changed = true;
      }
    } catch (err) {
      if (!isRecordProblem(err)) throw err;
      skip(label, err.message);
    }
  }
  return changed;
}
