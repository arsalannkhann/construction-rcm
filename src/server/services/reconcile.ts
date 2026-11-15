/**
 * Runs the reconciliation engine for an application and persists the result.
 *
 * Called after every change that could affect the answer: processing, any edit
 * to the application, a change to its contract, change orders or schedule of
 * values, and a decision on an earlier application on the same contract.
 */
import { and, asc, eq, inArray, ne } from 'drizzle-orm';
import type { DB } from '@/db';
import { locked } from '@/db/tx';
import {
  changeOrders,
  contracts,
  documents,
  findings,
  lienWaivers,
  organizations,
  payAppLines,
  payApplications,
  projects,
  sovLines,
  subcontractors,
  nextVersion,
  memberships,
  retainageReleases,
  users,
} from '@/db/schema';
import { recordAudit, type AuditActor } from '@/server/audit';
import { newId, sha256Hex } from '@/server/ids';
import { reconcile, type CheckResult, type ReconInput, type ReconOutput, type ReconPrior } from '@/server/recon/engine';
import type { ApprovedRecord, ContractBaseline, FindingCategory, Tri, WaiverType } from '@/server/types';
import { FINDING_CATEGORIES, OPEN_STATUSES, resolveSettings } from '@/server/types';
import { notifyPermission } from './notify';

export type ReconSummary = { opened: number; openBlocking: number; openWarnings: number; passed: number };

const SEVERITY_ORDER = { blocking: 0, warning: 1, info: 2 } as const;

/** JSON with keys in a fixed order, for comparing a stored value (jsonb reorders keys) with a fresh one. */
function stable(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stable(obj[k])}`)
    .join(',')}}`;
}

function fingerprint(c: CheckResult): string {
  return sha256Hex(
    JSON.stringify([c.severity, c.title, c.data?.expected ?? null, c.data?.actual ?? null, c.data?.expectedText ?? null, c.data?.actualText ?? null]),
  ).slice(0, 32);
}

export function priorFromApproved(record: ApprovedRecord): ReconPrior {
  const workToDate: Record<string, number> = {};
  for (const line of record.lines) {
    if (line.sovLineId) workToDate[line.sovLineId] = (workToDate[line.sovLineId] ?? 0) + line.previous + line.thisPeriod;
  }
  return {
    kind: 'application',
    applicationNumber: record.application.number,
    periodTo: record.application.periodTo,
    totalEarnedLessRetainage: record.approved.totalEarnedLessRetainage,
    retainageTotal: record.approved.retainageTotal,
    currentPaymentDue: record.approved.currentPaymentDue,
    workToDate,
  };
}

function priorFromBaseline(b: ContractBaseline): ReconPrior {
  return {
    kind: 'baseline',
    applicationNumber: b.asOfApplicationNumber,
    periodTo: null,
    totalEarnedLessRetainage: b.previousCertificates,
    retainageTotal: b.retainageHeld,
    currentPaymentDue: null,
    workToDate: b.workToDate,
  };
}

/** Mail providers anyone can sign up to. Sharing one of these domains with the contact on file proves nothing. */
const PUBLIC_MAIL_DOMAINS = new Set([
  'gmail.com', 'googlemail.com', 'yahoo.com', 'ymail.com', 'outlook.com', 'hotmail.com', 'live.com', 'msn.com', 'aol.com', 'icloud.com', 'me.com', 'mac.com',
  'proton.me', 'protonmail.com', 'gmx.com', 'mail.com', 'zoho.com', 'comcast.net', 'att.net', 'sbcglobal.net', 'bellsouth.net', 'verizon.net', 'cox.net', 'charter.net',
]);

/** Who an emailed package came from, relative to what is on file. */
export function classifySender(senderEmail: string | null, contactEmail: string | null, teamEmails: string[]): 'contact' | 'domain' | 'team' | 'unknown' {
  const sender = senderEmail?.trim().toLowerCase() ?? '';
  if (!sender.includes('@')) return 'unknown';
  const contact = contactEmail?.trim().toLowerCase() ?? '';
  if (contact && sender === contact) return 'contact';
  if (teamEmails.some((e) => e.trim().toLowerCase() === sender)) return 'team';
  const domain = sender.slice(sender.lastIndexOf('@') + 1);
  if (contact && domain === contact.slice(contact.lastIndexOf('@') + 1) && !PUBLIC_MAIL_DOMAINS.has(domain)) return 'domain';
  return 'unknown';
}

/** Assemble everything the engine needs for one application. Returns null if it is not matched to a contract. */
export async function loadReconInput(db: DB, orgId: string, appId: string, today: string): Promise<{ input: ReconInput; app: typeof payApplications.$inferSelect } | null> {
  const [app] = await db.select().from(payApplications).where(and(eq(payApplications.orgId, orgId), eq(payApplications.id, appId)));
  if (!app || !app.contractId) return null;

  const [org] = await db.select().from(organizations).where(eq(organizations.id, orgId));
  const [contract] = await db.select().from(contracts).where(and(eq(contracts.orgId, orgId), eq(contracts.id, app.contractId)));
  if (!org || !contract) return null;
  const [project] = await db.select().from(projects).where(eq(projects.id, contract.projectId));
  const [sub] = await db.select().from(subcontractors).where(eq(subcontractors.id, contract.subcontractorId));

  const cos = await db.select().from(changeOrders).where(eq(changeOrders.contractId, contract.id));
  const releases = await db.select().from(retainageReleases).where(and(eq(retainageReleases.contractId, contract.id), eq(retainageReleases.status, 'approved')));
  const team =
    app.receivedVia === 'email'
      ? await db.select({ email: users.email }).from(memberships).innerJoin(users, eq(users.id, memberships.userId)).where(and(eq(memberships.orgId, orgId), eq(memberships.status, 'active')))
      : [];
  const sov = await db.select().from(sovLines).where(eq(sovLines.contractId, contract.id)).orderBy(asc(sovLines.sortOrder));
  const lines = await db.select().from(payAppLines).where(eq(payAppLines.payApplicationId, appId)).orderBy(asc(payAppLines.sortOrder));
  const waivers = await db.select().from(lienWaivers).where(eq(lienWaivers.payApplicationId, appId));
  const docs = await db.select().from(documents).where(eq(documents.payApplicationId, appId)).orderBy(asc(documents.createdAt));

  const others = await db
    .select()
    .from(payApplications)
    .where(and(eq(payApplications.orgId, orgId), eq(payApplications.contractId, contract.id), ne(payApplications.id, appId), ne(payApplications.status, 'void')));

  // The basis for "previous" is the latest approved application numbered before this one,
  // falling back to the contract's opening balances.
  const approvedBefore = others
    .filter((o) => o.status === 'approved' && o.approvedRecord && o.applicationNumber !== null && (app.applicationNumber === null || o.applicationNumber < app.applicationNumber))
    .sort((a, b) => b.applicationNumber! - a.applicationNumber!);
  const prior: ReconPrior | null = approvedBefore[0]?.approvedRecord
    ? priorFromApproved(approvedBefore[0].approvedRecord)
    : contract.baseline
      ? priorFromBaseline(contract.baseline)
      : null;

  // The same bytes submitted on a different application.
  const shas = docs.map((d) => d.sha256);
  const twins = shas.length
    ? await db
        .select({ sha256: documents.sha256, filename: documents.filename, appId: documents.payApplicationId, number: payApplications.applicationNumber, status: payApplications.status })
        .from(documents)
        .innerJoin(payApplications, eq(payApplications.id, documents.payApplicationId))
        .where(and(eq(documents.orgId, orgId), inArray(documents.sha256, shas), ne(documents.payApplicationId, appId)))
    : [];

  const confidence: Record<string, number> = {};
  for (const [key, ev] of Object.entries(app.evidence ?? {})) confidence[key] = ev.confidence;

  const input: ReconInput = {
    policy: resolveSettings(org.settings),
    today,
    project: { name: project?.name ?? '', state: project?.state ?? null },
    subcontractor: { name: sub?.name ?? '' },
    contract: {
      number: contract.number,
      originalAmount: contract.originalAmount,
      retainageWorkBps: contract.retainageWorkBps,
      retainageStoredBps: contract.retainageStoredBps,
      retainageTerms: contract.retainageTerms,
    },
    retainageReleases: releases.map((r) => ({ id: r.id, amount: r.amount, effectiveOn: r.effectiveOn, note: r.note })),
    intake: { via: app.receivedVia === 'email' ? 'email' : 'upload', senderEmail: app.senderEmail, sender: classifySender(app.senderEmail, sub?.contactEmail ?? null, team.map((t) => t.email)) },
    changeOrders: cos.map((c) => ({ id: c.id, number: c.number, title: c.title, amount: c.amount, status: c.status })),
    sov: sov.map((s) => ({ id: s.id, itemNo: s.itemNo, description: s.description, scheduledValue: s.scheduledValue })),
    prior,
    siblings: others.map((o) => ({ id: o.id, applicationNumber: o.applicationNumber, periodTo: o.periodTo, status: o.status })),
    app: {
      id: app.id,
      applicationNumber: app.applicationNumber,
      periodTo: app.periodTo,
      claimed: app.claimed,
      signed: (app.signed as Tri | null) ?? null,
      signatureConfirmed: !!app.signatureConfirmedAt,
      notarized: (app.notarized as Tri | null) ?? null,
      confidence,
    },
    lines: lines.map((l) => ({
      id: l.id,
      sovLineId: l.sovLineId,
      itemNo: l.itemNo,
      description: l.description,
      scheduledValue: l.scheduledValue,
      previous: l.previous,
      thisPeriod: l.thisPeriod,
      stored: l.stored,
      total: l.total,
      balance: l.balance,
      retainage: l.retainage,
    })),
    documents: docs.map((d) => {
      const twin = twins.find((t) => t.sha256 === d.sha256 && t.status !== 'void' && t.status !== 'rejected');
      return {
        id: d.id,
        filename: d.filename,
        status: d.status,
        statusDetail: d.statusDetail,
        segments: d.segments,
        duplicateOf: twin ? { applicationNumber: twin.number, filename: twin.filename } : null,
      };
    }),
    waivers: waivers.map((w) => ({
      id: w.id,
      waiverType: w.waiverType as WaiverType,
      formState: w.formState,
      claimant: w.claimant,
      throughDate: w.throughDate,
      amount: w.amount,
      exceptions: w.exceptions,
      signed: (w.signed as Tri | null) ?? null,
    })),
  };
  return { input, app };
}

export async function computeReconciliation(db: DB, orgId: string, appId: string, now: Date = new Date()): Promise<ReconOutput | null> {
  const loaded = await loadReconInput(db, orgId, appId, now.toISOString().slice(0, 10));
  return loaded ? reconcile(loaded.input) : null;
}

/**
 * Recompute and store findings + verified figures for one application.
 * A finding a person accepted stays accepted only while the facts behind it are unchanged.
 */
export const runReconciliation = locked(async function runReconciliation(db: DB, orgId: string, appId: string, opts: { now?: Date; actor?: AuditActor } = {}): Promise<ReconSummary | null> {
  const now = opts.now ?? new Date();
  const loaded = await loadReconInput(db, orgId, appId, now.toISOString().slice(0, 10));
  if (!loaded) {
    await db.delete(findings).where(and(eq(findings.orgId, orgId), eq(findings.payApplicationId, appId)));
    await db
      .update(payApplications)
      .set({ version: nextVersion, verified: null, verifiedAmount: null, openBlocking: 0, openWarnings: 0, updatedAt: now })
      .where(and(eq(payApplications.orgId, orgId), eq(payApplications.id, appId)));
    return null;
  }
  const { app } = loaded;
  const out = reconcile(loaded.input);

  const existing = await db.select().from(findings).where(eq(findings.payApplicationId, appId));
  const byKey = new Map(existing.map((f) => [`${f.code}|${f.subjectKey}`, f]));
  const seen = new Set<string>();
  let opened = 0;
  let reopened = 0;
  // Did anything a reviewer or approver would see actually change? If not, the application's
  // version stays put, so someone part-way through a decision is not told to start again for nothing.
  let changed = false;

  const ordered = [...out.checks].sort(
    (a, b) =>
      FINDING_CATEGORIES.indexOf(a.category as FindingCategory) - FINDING_CATEGORIES.indexOf(b.category as FindingCategory) ||
      SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity],
  );

  for (const [index, check] of ordered.entries()) {
    const key = `${check.code}|${check.subjectKey}`;
    if (seen.has(key)) continue; // defensive: a check must not emit the same subject twice
    seen.add(key);
    const prev = byKey.get(key);
    const fp = fingerprint(check);
    const keepAccepted = check.outcome === 'fail' && prev?.status === 'accepted' && prev.fingerprint === fp;
    const status = check.outcome === 'pass' ? 'passed' : keepAccepted ? 'accepted' : 'open';
    if (!prev || prev.status !== status || prev.fingerprint !== fp || prev.detail !== check.detail) changed = true;
    if (status === 'open' && prev?.status !== 'open') {
      opened++;
      if (prev?.status === 'accepted') reopened++;
    }
    const values = {
      category: check.category,
      severity: check.severity,
      status,
      title: check.title,
      detail: check.detail,
      action: check.action ?? null,
      needsQualifiedReview: check.needsQualifiedReview ?? false,
      data: check.data ?? null,
      refs: check.refs ?? null,
      fingerprint: fp,
      sortOrder: index,
      updatedAt: now,
      ...(keepAccepted ? {} : { resolvedBy: null, resolvedAt: null, resolutionNote: null }),
    };
    if (prev) {
      await db.update(findings).set(values).where(eq(findings.id, prev.id));
    } else {
      await db.insert(findings).values({ id: newId('fnd'), orgId, payApplicationId: appId, code: check.code, subjectKey: check.subjectKey, createdAt: now, ...values });
    }
  }

  const stale = existing.filter((f) => !seen.has(`${f.code}|${f.subjectKey}`));
  if (stale.length > 0) {
    await db.delete(findings).where(inArray(findings.id, stale.map((f) => f.id)));
    changed = true;
  }

  const current = await db.select({ status: findings.status, severity: findings.severity }).from(findings).where(eq(findings.payApplicationId, appId));
  const openBlocking = current.filter((f) => f.status === 'open' && f.severity === 'blocking').length;
  const openWarnings = current.filter((f) => f.status === 'open' && f.severity === 'warning').length;
  const passed = current.filter((f) => f.status === 'passed').length;

  // An application already waiting for approval goes back to review if something new blocks it.
  const bounce = app.status === 'pending_approval' && openBlocking > 0 && opened > 0;
  if (
    bounce ||
    app.openBlocking !== openBlocking ||
    app.openWarnings !== openWarnings ||
    app.claimedAmount !== app.claimed.currentPaymentDue ||
    stable(app.verified) !== stable(out.verified)
  ) {
    changed = true;
  }
  if (changed) {
    await db
      .update(payApplications)
      .set({
        version: nextVersion,
        verified: out.verified,
        verifiedAmount: out.verified.currentPaymentDue,
        claimedAmount: app.claimed.currentPaymentDue,
        openBlocking,
        openWarnings,
        updatedAt: now,
        ...(bounce ? { status: 'needs_review', submittedForApprovalAt: null, submittedForApprovalBy: null } : {}),
      })
      .where(eq(payApplications.id, appId));
  }

  if (reopened > 0) {
    await recordAudit(db, {
      orgId,
      actor: opts.actor ?? { system: true },
      action: 'finding.reopened',
      entityType: 'pay_application',
      entityId: appId,
      payApplicationId: appId,
      summary: `${reopened} previously accepted finding${reopened === 1 ? '' : 's'} reopened because the underlying figures changed`,
      at: now,
    });
  }
  if (bounce) {
    await recordAudit(db, {
      orgId,
      actor: opts.actor ?? { system: true },
      action: 'application.returned_to_review',
      entityType: 'pay_application',
      entityId: appId,
      payApplicationId: appId,
      summary: 'Returned to review: new blocking findings appeared after it was submitted for approval',
      at: now,
    });
    await notifyPermission(db, orgId, 'application:review', {
      type: 'application.returned_to_review',
      title: `Application #${app.applicationNumber ?? '?'} needs review again`,
      body: 'New blocking findings appeared after it was submitted for approval.',
      href: `/applications/${appId}`,
    }, { at: now });
  }

  return { opened, openBlocking, openWarnings, passed };
});

/** Re-check every undecided application on a contract, oldest first. */
export const rereconcileContract = locked(async function rereconcileContract(db: DB, orgId: string, contractId: string, opts: { now?: Date; actor?: AuditActor; except?: string } = {}): Promise<void> {
  const open = await db
    .select({ id: payApplications.id, n: payApplications.applicationNumber })
    .from(payApplications)
    .where(and(eq(payApplications.orgId, orgId), eq(payApplications.contractId, contractId), inArray(payApplications.status, OPEN_STATUSES)));
  open.sort((a, b) => (a.n ?? 1e9) - (b.n ?? 1e9));
  for (const row of open) {
    if (row.id === opts.except) continue;
    await runReconciliation(db, orgId, row.id, opts);
  }
});
