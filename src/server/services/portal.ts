/**
 * The subcontractor portal.
 *
 * Each subcontract can have one link, `/portal/<token>`, that the main
 * contractor gives to the subcontractor. Without an account, whoever holds it
 * can do two things and nothing else:
 *
 *   - upload a billing package for that subcontract, which arrives exactly as
 *     an upload would, already matched to the subcontract;
 *   - see what happened to every application on that subcontract: received,
 *     in review, waiting on them (with the messages the team sent them),
 *     approved or rejected.
 *
 * What the link shows is limited to what the subcontractor already knows or
 * was meant to be told: their own submissions, the figures they asked for, the
 * approved amount, and the messages the team addressed to them. Findings,
 * comments, notes on a decision, other subcontracts and anything else about
 * the main contractor stay inside the product.
 *
 * The token is 256 random bits. Requests are looked up by its SHA-256; the
 * token itself is kept encrypted with RCM_SECRET_KEY so the team can copy the
 * link again and reminders can carry it. Replacing or turning off a link stops
 * it working at once. Guesses at tokens are counted per network address.
 *
 * Reminders: once a day the scheduler (/api/jobs/run) emails each live link
 * whose subcontract is due this month on the billing board (the same rule as
 * the board: it has started billing, is active, is not fully billed, and
 * nothing has arrived for the month) once in the REMINDER_LEAD_DAYS before the
 * organisation's due day and once after it. One reminder of each kind per
 * subcontract and month, whatever happens; delivery is recorded as it really
 * went. With no email provider configured, none are sent and the product says so.
 */
import { and, asc, desc, eq, gt, inArray, isNotNull, isNull, lt, ne, sql } from 'drizzle-orm';
import type { DB } from '@/db';
import { withOrgLock } from '@/db/tx';
import { communications, contracts, documents, organizations, payApplications, portalEmails, portalLinks, portalUploadParts, projects, subcontractors, users } from '@/db/schema';
import { recordAudit } from '@/server/audit';
import { assertCan, can, UserError, type Ctx } from '@/server/auth/permissions';
import { ipSubject, type Limit } from '@/server/auth/throttle';
import { appUrl } from '@/server/config';
import { decryptJson, encryptJson } from '@/server/crypto';
import { emailDeliveryConfigured, sendEmail, type EmailResult, type OutgoingEmail } from '@/server/email';
import { newId, randomToken, sha256Hex } from '@/server/ids';
import { resolveSettings, type AppStatus } from '@/server/types';
import { boardForOrg, monthOf, shiftMonth, type CellState } from './billing';
import { createApplication, sniffMime, type IncomingFile } from './intake';
import { notifyUsers } from './notify';
import { MAX_PARTS, MAX_STAGED_BYTES, PART_TTL_MS, parseStaged, UPLOAD_PART_BYTES, isUploadId, type StagedFile } from './uploads';

/** randomToken(32): 43 base64url characters. Anything else is not a link we made. */
const TOKEN = /^[A-Za-z0-9_-]{43}$/;
/** Reminders go out on these days before the due day (and on it). */
export const REMINDER_LEAD_DAYS = 5;
/** Packages one subcontract may send through its link in a day. */
export const PORTAL_SUBMISSIONS_PER_DAY = 10;
/** How many of a subcontract's applications the link shows, newest first. */
const SHOWN = 24;
/** A package still being read, or whose period could not be read, counts as this month's for this long, so nobody is reminded about what they just sent. */
const UNREAD_GRACE_MS = 35 * 86_400_000;
/** Failed guesses at a link allowed from one network address in GUESS_WINDOW_MS. */
export const PORTAL_GUESSES_PER_IP = 20;
export const PORTAL_GUESS_WINDOW_MS = 15 * 60_000;
const DUPLICATE_WINDOW_MS = 10 * 60_000;
const READABLE = new Set(['application/pdf', 'image/png', 'image/jpeg', 'image/webp']);

const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

export const portalUrl = (token: string) => `${appUrl()}/portal/${token}`;

/** The link from its stored token, or null if it can no longer be decrypted (RCM_SECRET_KEY changed): the link then has to be replaced. */
function storedUrl(tokenEnc: string): string | null {
  try {
    return portalUrl(decryptJson<string>(tokenEnc));
  } catch {
    return null;
  }
}
const hashToken = (token: string) => sha256Hex(`portal:${token}`);
/** "2026-11" → "November 2026" */
export const longMonth = (month: string) => `${MONTHS[Number(month.slice(5, 7)) - 1]} ${month.slice(0, 4)}`;
/** The due date of a month's billing: "2026-11", 25 → "2026-11-25". */
export const dueDateOf = (month: string, dueDay: number) => `${month}-${String(dueDay).padStart(2, '0')}`;
/** "2026-11-25" → "25 November 2026" */
const longDate = (iso: string) => `${Number(iso.slice(8, 10))} ${longMonth(iso.slice(0, 7))}`;

function cleanEmail(value: string | null | undefined): string | null {
  const v = value?.trim().toLowerCase() ?? '';
  if (!v) return null;
  if (!EMAIL.test(v) || v.length > 254) throw new UserError('Enter a valid email address, or leave it blank.');
  return v;
}

// ── Managing links (members) ────────────────────────────────────────────────

export type PortalEmailRow = {
  id: string;
  kind: 'link' | 'due_soon' | 'overdue';
  period: string | null;
  toEmail: string;
  status: string;
  error: string | null;
  createdAt: Date;
  createdByName: string | null;
};

export type PortalLinkView = {
  id: string;
  /** The link itself: only for members who may manage links, and null if it can no longer be decrypted. */
  url: string | null;
  email: string | null;
  reminders: boolean;
  createdAt: Date;
  createdByName: string | null;
  lastUsedAt: Date | null;
};

export type PortalPanel = {
  link: PortalLinkView | null;
  emails: PortalEmailRow[];
  dueDay: number;
  emailConfigured: boolean;
  canManage: boolean;
  /** The subcontractor's contact address on file, offered when creating a link. */
  contactEmail: string | null;
  contractOpen: boolean;
};

async function loadContract(db: DB, orgId: string, contractId: string) {
  const [row] = await db
    .select({ contract: contracts, project: projects, sub: subcontractors })
    .from(contracts)
    .innerJoin(projects, and(eq(projects.id, contracts.projectId), eq(projects.orgId, contracts.orgId)))
    .innerJoin(subcontractors, and(eq(subcontractors.id, contracts.subcontractorId), eq(subcontractors.orgId, contracts.orgId)))
    .where(and(eq(contracts.orgId, orgId), eq(contracts.id, contractId)));
  return row ?? null;
}

/** "for Lone Star Electric, LLC on SC-2301-16 (Riverside Medical Office Building)", for audit sentences. */
async function linkPhrase(db: DB, orgId: string, contractId: string): Promise<string> {
  const found = await loadContract(db, orgId, contractId);
  return found ? `for ${found.sub.name} on ${found.contract.number} (${found.project.name})` : `on subcontract ${contractId}`;
}

async function loadLink(db: DB, ctx: Ctx, linkId: string) {
  const [link] = await db.select().from(portalLinks).where(and(eq(portalLinks.orgId, ctx.orgId), eq(portalLinks.id, linkId)));
  if (!link) throw new UserError('That portal link no longer exists.');
  return link;
}

/** What the subcontract page shows about its portal link. */
export async function getPortalPanel(db: DB, ctx: Ctx, contractId: string): Promise<PortalPanel | null> {
  const found = await loadContract(db, ctx.orgId, contractId);
  if (!found) return null;
  const canManage = can(ctx.role, 'application:review');
  const [org] = await db.select({ settings: organizations.settings }).from(organizations).where(eq(organizations.id, ctx.orgId));
  const [row] = await db
    .select({ link: portalLinks, createdByName: users.name })
    .from(portalLinks)
    .leftJoin(users, eq(users.id, portalLinks.createdBy))
    .where(and(eq(portalLinks.orgId, ctx.orgId), eq(portalLinks.contractId, contractId), isNull(portalLinks.revokedAt)));
  const emails = await db
    .select({
      id: portalEmails.id,
      kind: portalEmails.kind,
      period: portalEmails.period,
      toEmail: portalEmails.toEmail,
      status: portalEmails.status,
      error: portalEmails.error,
      createdAt: portalEmails.createdAt,
      createdByName: users.name,
    })
    .from(portalEmails)
    .leftJoin(users, eq(users.id, portalEmails.createdBy))
    .where(and(eq(portalEmails.orgId, ctx.orgId), eq(portalEmails.contractId, contractId)))
    .orderBy(desc(portalEmails.createdAt))
    .limit(8);
  return {
    link: row
      ? {
          id: row.link.id,
          url: canManage ? storedUrl(row.link.tokenEnc) : null,
          email: row.link.email,
          reminders: row.link.reminders,
          createdAt: row.link.createdAt,
          createdByName: row.createdByName,
          lastUsedAt: row.link.lastUsedAt,
        }
      : null,
    emails: emails.map((e) => ({ ...e, kind: e.kind as PortalEmailRow['kind'] })),
    dueDay: resolveSettings(org?.settings).portalDueDay,
    emailConfigured: emailDeliveryConfigured(),
    canManage,
    contactEmail: found.sub.contactEmail,
    contractOpen: found.contract.status === 'active' && found.project.status === 'active',
  };
}

/** Make the subcontract's link, replacing the live one if there is one (the old link stops working). */
export async function createPortalLink(db: DB, ctx: Ctx, contractId: string, input: { email?: string | null; now?: Date }): Promise<{ id: string; url: string }> {
  return withOrgLock(db, ctx.orgId, async (tx) => {
    assertCan(ctx, 'application:review');
    const found = await loadContract(tx, ctx.orgId, contractId);
    if (!found) throw new UserError('That subcontract no longer exists.');
    const { contract, project, sub } = found;
    if (contract.status !== 'active' || project.status !== 'active') throw new UserError('This subcontract is closed. A portal link is only for subcontracts that are still billing.');
    const email = cleanEmail(input.email);
    const now = input.now ?? new Date();

    const [live] = await tx.select().from(portalLinks).where(and(eq(portalLinks.orgId, ctx.orgId), eq(portalLinks.contractId, contractId), isNull(portalLinks.revokedAt)));
    if (live) await tx.update(portalLinks).set({ revokedAt: now, revokedBy: ctx.userId }).where(eq(portalLinks.id, live.id));

    const token = randomToken(32);
    const id = newId('prt');
    await tx.insert(portalLinks).values({ id, orgId: ctx.orgId, contractId, tokenHash: hashToken(token), tokenEnc: encryptJson(token), email, reminders: true, createdBy: ctx.userId, createdAt: now });
    await recordAudit(tx, {
      orgId: ctx.orgId,
      actor: ctx,
      action: live ? 'portal.link_replaced' : 'portal.link_created',
      entityType: 'contract',
      entityId: contractId,
      summary: `${live ? 'Replaced the subcontractor portal link' : 'Created a subcontractor portal link'} for ${sub.name} on ${contract.number} (${project.name})${live ? '; the previous link no longer works' : ''}. Reminders go to ${email ?? 'nobody (no address given)'}.`,
      data: { linkId: id, replaced: live?.id ?? null, email },
      at: now,
    });
    return { id, url: portalUrl(token) };
  });
}

/** Change where reminders go, or turn them on or off. */
export async function updatePortalLink(db: DB, ctx: Ctx, linkId: string, input: { email?: string | null; reminders?: boolean }): Promise<void> {
  await withOrgLock(db, ctx.orgId, async (tx) => {
    assertCan(ctx, 'application:review');
    const link = await loadLink(tx, ctx, linkId);
    if (link.revokedAt) throw new UserError('That portal link has been turned off.');
    const email = input.email === undefined ? link.email : cleanEmail(input.email);
    const reminders = input.reminders === undefined ? link.reminders : !!input.reminders;
    if (email === link.email && reminders === link.reminders) return;
    await tx.update(portalLinks).set({ email, reminders }).where(eq(portalLinks.id, link.id));
    const parts: string[] = [];
    if (reminders !== link.reminders) parts.push(reminders ? 'billing reminders turned on' : 'billing reminders turned off');
    if (email !== link.email) parts.push(`reminders and the link now go to ${email ?? 'nobody'} (was ${link.email ?? 'nobody'})`);
    await recordAudit(tx, { orgId: ctx.orgId, actor: ctx, action: 'portal.link_updated', entityType: 'contract', entityId: link.contractId, summary: `Changed the subcontractor portal link ${await linkPhrase(tx, ctx.orgId, link.contractId)}: ${parts.join('; ')}`, data: { linkId, email, reminders } });
  });
}

/** Turn the link off. It stops working at once; what was sent through it stays. */
export async function revokePortalLink(db: DB, ctx: Ctx, linkId: string): Promise<void> {
  await withOrgLock(db, ctx.orgId, async (tx) => {
    assertCan(ctx, 'application:review');
    const link = await loadLink(tx, ctx, linkId);
    if (link.revokedAt) return;
    await tx.update(portalLinks).set({ revokedAt: new Date(), revokedBy: ctx.userId }).where(eq(portalLinks.id, link.id));
    await tx.delete(portalUploadParts).where(eq(portalUploadParts.linkId, link.id));
    await recordAudit(tx, { orgId: ctx.orgId, actor: ctx, action: 'portal.link_revoked', entityType: 'contract', entityId: link.contractId, summary: `Turned off the subcontractor portal link ${await linkPhrase(tx, ctx.orgId, link.contractId)}; it no longer works`, data: { linkId } });
  });
}

type Sender = (message: OutgoingEmail) => Promise<EmailResult>;

function linkEmail(o: { orgName: string; contactName: string | null; subName: string; projectName: string; contractNumber: string; contractTitle: string; url: string; dueDay: number; senderName: string }) {
  return {
    subject: `${o.orgName}: upload your billing for ${o.projectName} here`,
    text: [
      `Hello ${o.contactName?.trim() || o.subName},`,
      '',
      `${o.orgName} has set up a page for your billing on ${o.projectName} (${o.contractNumber}, ${o.contractTitle}).`,
      '',
      `Upload each month’s application for payment there, with your lien waivers, by day ${o.dueDay} of the month. The same page shows where each application stands and any question about it. You do not need an account.`,
      '',
      o.url,
      '',
      'Keep this link to yourself: anyone who has it can upload billing for this subcontract and see its status.',
      '',
      o.senderName,
      o.orgName,
    ].join('\n'),
  };
}

/** Email the link to the address on it. Refused when email delivery is not set up: copy the link instead. */
export async function emailPortalLink(db: DB, ctx: Ctx, linkId: string, opts: { now?: Date; send?: Sender } = {}): Promise<{ status: EmailResult['status']; detail: string | null }> {
  const send = opts.send ?? ((m: OutgoingEmail) => sendEmail(m));
  const now = opts.now ?? new Date();
  const prepared = await withOrgLock(db, ctx.orgId, async (tx) => {
    assertCan(ctx, 'application:review');
    if (!opts.send && !emailDeliveryConfigured()) throw new UserError('Email delivery is not set up on this deployment, so nothing can be sent from here. Copy the link and send it yourself.');
    const link = await loadLink(tx, ctx, linkId);
    if (link.revokedAt) throw new UserError('That portal link has been turned off.');
    if (!link.email) throw new UserError('Add the address to send the link to first.');
    const found = await loadContract(tx, ctx.orgId, link.contractId);
    if (!found) throw new UserError('That subcontract no longer exists.');
    const recent = await tx
      .select({ status: portalEmails.status, createdAt: portalEmails.createdAt })
      .from(portalEmails)
      .where(and(eq(portalEmails.linkId, link.id), eq(portalEmails.kind, 'link'), eq(portalEmails.toEmail, link.email), gt(portalEmails.createdAt, new Date(now.getTime() - DUPLICATE_WINDOW_MS))));
    if (recent.some((r) => r.status !== 'failed')) throw new UserError(`The link was already sent to ${link.email} a few minutes ago. It has not been sent again.`);
    const url = storedUrl(link.tokenEnc);
    if (!url) throw new UserError('This link can no longer be shown. Replace it to make a new one.');
    const [org] = await tx.select({ name: organizations.name, settings: organizations.settings }).from(organizations).where(eq(organizations.id, ctx.orgId));
    const message = linkEmail({
      orgName: org?.name ?? ctx.orgName,
      contactName: found.sub.contactName,
      subName: found.sub.name,
      projectName: found.project.name,
      contractNumber: found.contract.number,
      contractTitle: found.contract.title,
      url,
      dueDay: resolveSettings(org?.settings).portalDueDay,
      senderName: ctx.userName,
    });
    const id = newId('pem');
    await tx.insert(portalEmails).values({ id, orgId: ctx.orgId, linkId: link.id, contractId: link.contractId, kind: 'link', period: null, toEmail: link.email, subject: message.subject, body: message.text, status: 'sending', createdBy: ctx.userId, createdAt: now });
    return { id, to: link.email, contractId: link.contractId, ...message };
  });

  // No lock while the provider is called; the record already says "sending".
  const result = await send({ to: prepared.to, subject: prepared.subject, text: prepared.text, replyTo: ctx.userEmail, idempotencyKey: prepared.id });
  const detail = result.status === 'failed' || result.status === 'unconfirmed' ? result.error : result.status === 'not_sent' ? result.reason : null;
  await withOrgLock(db, ctx.orgId, async (tx) => {
    await tx
      .update(portalEmails)
      .set({ status: result.status, provider: result.provider, providerRef: result.status === 'sent' ? result.providerRef : null, error: detail })
      .where(eq(portalEmails.id, prepared.id));
    await recordAudit(tx, {
      orgId: ctx.orgId,
      actor: ctx,
      action: result.status === 'sent' ? 'portal.link_emailed' : 'portal.link_email_failed',
      entityType: 'contract',
      entityId: prepared.contractId,
      summary:
        result.status === 'sent'
          ? `Emailed the subcontractor portal link to ${prepared.to}`
          : result.status === 'unconfirmed'
            ? `Emailing the subcontractor portal link to ${prepared.to} was NOT CONFIRMED by the provider (it may have been sent)`
            : `Emailing the subcontractor portal link to ${prepared.to} FAILED`,
      data: { to: prepared.to, status: result.status },
      at: now,
    });
  });
  return { status: result.status, detail };
}

// ── What the link opens (no account) ────────────────────────────────────────

export type PortalAccess = {
  linkId: string;
  orgId: string;
  orgName: string;
  contractId: string;
  contractNumber: string;
  contractTitle: string;
  projectName: string;
  projectNumber: string | null;
  subcontractorName: string;
  /** Still taking billing: the subcontract and its project are active. */
  open: boolean;
  dueDay: number;
};

/** The link behind a token, or null for a token that is malformed, unknown, replaced or turned off. */
export async function resolvePortalToken(db: DB, token: string): Promise<PortalAccess | null> {
  if (!TOKEN.test(token)) return null;
  const [row] = await db
    .select({ link: portalLinks, contract: contracts, project: projects, sub: subcontractors, org: organizations })
    .from(portalLinks)
    // Every join is held to the link's organisation, so a link can only ever reach its own organisation's records.
    .innerJoin(contracts, and(eq(contracts.id, portalLinks.contractId), eq(contracts.orgId, portalLinks.orgId)))
    .innerJoin(projects, and(eq(projects.id, contracts.projectId), eq(projects.orgId, portalLinks.orgId)))
    .innerJoin(subcontractors, and(eq(subcontractors.id, contracts.subcontractorId), eq(subcontractors.orgId, portalLinks.orgId)))
    .innerJoin(organizations, eq(organizations.id, portalLinks.orgId))
    .where(and(eq(portalLinks.tokenHash, hashToken(token)), isNull(portalLinks.revokedAt)));
  if (!row) return null;
  return {
    linkId: row.link.id,
    orgId: row.link.orgId,
    orgName: row.org.name,
    contractId: row.contract.id,
    contractNumber: row.contract.number,
    contractTitle: row.contract.title,
    projectName: row.project.name,
    projectNumber: row.project.number,
    subcontractorName: row.sub.name,
    open: row.contract.status === 'active' && row.project.status === 'active',
    dueDay: resolveSettings(row.org.settings).portalDueDay,
  };
}

/** Guesses from this address are used up: refuse before looking anything up. */
export function portalGuessLimit(ip: string | null): Limit {
  return { subject: ipSubject(ip ?? 'unknown'), max: PORTAL_GUESSES_PER_IP, windowMs: PORTAL_GUESS_WINDOW_MS, count: 'failures' };
}

export type PortalStatus = 'received' | 'in_review' | 'waiting_on_you' | 'approved' | 'rejected' | 'replaced' | 'withdrawn';

export const PORTAL_STATUS_LABEL: Record<PortalStatus, string> = {
  received: 'Received, being read',
  in_review: 'In review',
  waiting_on_you: 'Waiting on you',
  approved: 'Approved',
  rejected: 'Rejected',
  replaced: 'Replaced by a later submission',
  withdrawn: 'Withdrawn',
};

function portalStatus(status: AppStatus, supersededById: string | null): PortalStatus {
  switch (status) {
    case 'processing':
      return 'received';
    case 'on_hold':
      return 'waiting_on_you';
    case 'approved':
      return 'approved';
    case 'rejected':
      return 'rejected';
    case 'void':
      return supersededById ? 'replaced' : 'withdrawn';
    default:
      return 'in_review';
  }
}

export type PortalSubmission = {
  key: string;
  applicationNumber: number | null;
  periodTo: string | null;
  receivedAt: Date;
  via: string;
  status: PortalStatus;
  /** What the package asks for this period, once it has been read. */
  requested: number | null;
  /** Approved for this period. Only once approved. */
  approved: number | null;
  decidedAt: Date | null;
  files: string[];
  /** Messages the team addressed to the subcontractor about this application. */
  messages: Array<{ subject: string; body: string; at: Date }>;
};

export type PortalPeriod = { month: string; state: CellState; dueOn: string };

export type PortalView = { access: PortalAccess; submissions: PortalSubmission[]; current: PortalPeriod; previous: PortalPeriod };

/** Everything the link shows. Only this subcontract, only this organisation. */
export async function getPortalView(db: DB, access: PortalAccess, now: Date = new Date()): Promise<PortalView> {
  const apps = await db
    .select({
      id: payApplications.id,
      applicationNumber: payApplications.applicationNumber,
      periodTo: payApplications.periodTo,
      receivedAt: payApplications.receivedAt,
      receivedVia: payApplications.receivedVia,
      status: payApplications.status,
      supersededById: payApplications.supersededById,
      claimedAmount: payApplications.claimedAmount,
      approvedAmount: payApplications.approvedAmount,
      decidedAt: payApplications.decidedAt,
    })
    .from(payApplications)
    .where(and(eq(payApplications.orgId, access.orgId), eq(payApplications.contractId, access.contractId)))
    .orderBy(desc(payApplications.receivedAt))
    .limit(SHOWN);
  const ids = apps.map((a) => a.id);
  const [docs, messages] = ids.length
    ? await Promise.all([
        db
          .select({ appId: documents.payApplicationId, filename: documents.filename })
          .from(documents)
          .where(and(eq(documents.orgId, access.orgId), inArray(documents.payApplicationId, ids)))
          .orderBy(asc(documents.createdAt)),
        db
          .select({ appId: communications.payApplicationId, subject: communications.subject, body: communications.body, at: communications.createdAt })
          .from(communications)
          .where(and(eq(communications.orgId, access.orgId), inArray(communications.payApplicationId, ids)))
          .orderBy(asc(communications.createdAt)),
      ])
    : [[], []];

  const current = monthOf(now);
  const previous = shiftMonth(current, -1);
  const board = await boardForOrg(db, access.orgId, { months: [previous, current], current, contractIds: [access.contractId] });
  const row = board.sections.flatMap((s) => s.rows).find((r) => r.id === access.contractId);
  const stateIn = (i: number): CellState => row?.cells[i]?.state ?? (access.open ? 'not_started' : 'closed');

  return {
    access,
    submissions: apps.map((a) => {
      const status = portalStatus(a.status as AppStatus, a.supersededById);
      const seen = new Set<string>();
      return {
        key: a.id,
        applicationNumber: a.applicationNumber,
        periodTo: a.periodTo,
        receivedAt: a.receivedAt,
        via: a.receivedVia,
        status,
        requested: status === 'received' ? null : a.claimedAmount,
        approved: status === 'approved' ? a.approvedAmount : null,
        decidedAt: status === 'approved' || status === 'rejected' ? a.decidedAt : null,
        files: docs.filter((d) => d.appId === a.id).map((d) => d.filename),
        // The same message saved twice (a retry after a failed send) is shown once.
        messages: messages
          .filter((m) => m.appId === a.id)
          .filter((m) => {
            const k = `${m.subject}\n${m.body}`;
            if (seen.has(k)) return false;
            seen.add(k);
            return true;
          })
          .map((m) => ({ subject: m.subject, body: m.body, at: m.at })),
      };
    }),
    current: { month: current, state: stateIn(1), dueOn: dueDateOf(current, access.dueDay) },
    previous: { month: previous, state: stateIn(0), dueOn: dueDateOf(previous, access.dueDay) },
  };
}

// ── Uploading through the link ──────────────────────────────────────────────

/** Store one part of a large file sent through the link. Sending the same part again replaces it. */
export async function stagePortalPart(db: DB, access: PortalAccess, uploadId: string, part: number, bytes: Uint8Array, now = new Date()): Promise<void> {
  if (!access.open) throw new UserError(closedMessage(access));
  if (!isUploadId(uploadId)) throw new UserError('That upload is not valid. Start it again.');
  if (!Number.isInteger(part) || part < 0 || part >= MAX_PARTS) throw new UserError('That part of the file is out of range. Start the upload again.');
  if (bytes.byteLength === 0 || bytes.byteLength > UPLOAD_PART_BYTES) throw new UserError(`A part of a file must be between 1 byte and ${UPLOAD_PART_BYTES / 1024 / 1024} MB.`);
  await db.delete(portalUploadParts).where(lt(portalUploadParts.createdAt, new Date(now.getTime() - PART_TTL_MS)));
  const [{ staged }] = await db
    .select({ staged: sql<number>`coalesce(sum(octet_length(${portalUploadParts.bytes})), 0)::bigint` })
    .from(portalUploadParts)
    .where(and(eq(portalUploadParts.linkId, access.linkId), sql`not (${portalUploadParts.uploadId} = ${uploadId} and ${portalUploadParts.part} = ${part})`));
  if (Number(staged) + bytes.byteLength > MAX_STAGED_BYTES) throw new UserError('Too much is waiting to be uploaded through this link. Wait a few hours and try again.');
  await db
    .insert(portalUploadParts)
    .values({ linkId: access.linkId, orgId: access.orgId, uploadId, part, bytes, createdAt: now })
    .onConflictDoUpdate({ target: [portalUploadParts.linkId, portalUploadParts.uploadId, portalUploadParts.part], set: { bytes, createdAt: now } });
}

async function readPortalStaged(db: DB, access: PortalAccess, files: StagedFile[]): Promise<IncomingFile[]> {
  const out: IncomingFile[] = [];
  for (const file of files) {
    const parts = await db
      .select({ part: portalUploadParts.part, bytes: portalUploadParts.bytes })
      .from(portalUploadParts)
      .where(and(eq(portalUploadParts.linkId, access.linkId), eq(portalUploadParts.orgId, access.orgId), eq(portalUploadParts.uploadId, file.uploadId)))
      .orderBy(asc(portalUploadParts.part));
    const complete = parts.length > 0 && parts.every((p, i) => p.part === i) && parts.reduce((n, p) => n + p.bytes.byteLength, 0) === file.size;
    if (!complete) throw new UserError(`“${file.name}” did not arrive completely. Upload it again.`);
    out.push({ filename: file.name, mimeType: file.type || null, bytes: new Uint8Array(Buffer.concat(parts.map((p) => p.bytes))) });
  }
  return out;
}

/** The files of a portal upload form: sent whole (`files`) or staged in parts first (`staged`). */
export async function portalFilesFromForm(db: DB, access: PortalAccess, form: FormData): Promise<{ files: IncomingFile[]; staged: string[] }> {
  const files: IncomingFile[] = [];
  for (const entry of form.getAll('files')) {
    if (typeof entry === 'string') continue;
    files.push({ filename: entry.name, mimeType: entry.type, bytes: new Uint8Array(await entry.arrayBuffer()) });
  }
  const staged = parseStaged(form.getAll('staged'));
  files.push(...(await readPortalStaged(db, access, staged)));
  return { files, staged: staged.map((f) => f.uploadId) };
}

const closedMessage = (access: PortalAccess) => `This subcontract is closed, so ${access.orgName} is not taking billing for it here. Contact them directly.`;

/** A package sent through the link: stored, matched to the subcontract and queued to be read, exactly like an upload. */
export async function submitThroughPortal(
  db: DB,
  access: PortalAccess,
  files: IncomingFile[],
  opts: { staged?: string[]; now?: Date; defer?: boolean } = {},
): Promise<{ id: string; files: string[] }> {
  if (!access.open) throw new UserError(closedMessage(access));
  // Only what can be read as a billing document: anyone holding the link can send to it.
  for (const f of files) if (!READABLE.has(sniffMime(f))) throw new UserError(`“${f.filename}” is not a PDF or an image (PNG, JPEG or WebP). Send the application and waivers as PDFs or photos.`);
  const now = opts.now ?? new Date();
  return withOrgLock(db, access.orgId, async (tx) => {
    // Checked again inside the lock: the link may have been turned off a moment ago.
    const [live] = await tx.select({ id: portalLinks.id }).from(portalLinks).where(and(eq(portalLinks.id, access.linkId), eq(portalLinks.orgId, access.orgId), isNull(portalLinks.revokedAt)));
    if (!live) throw new UserError('This link has been turned off. Ask the contractor who sent it for a new one.');
    const [{ n }] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(payApplications)
      .where(and(eq(payApplications.orgId, access.orgId), eq(payApplications.contractId, access.contractId), eq(payApplications.receivedVia, 'portal'), gt(payApplications.receivedAt, new Date(now.getTime() - 86_400_000))));
    if (n >= PORTAL_SUBMISSIONS_PER_DAY) throw new UserError(`${PORTAL_SUBMISSIONS_PER_DAY} packages have been sent through this link in the last day, which is the limit. Try again tomorrow, or contact ${access.orgName}.`);
    const { id } = await createApplication(tx, { system: true, orgId: access.orgId, name: 'Subcontractor portal' }, { files, contractId: access.contractId, receivedVia: 'portal', portalLinkId: access.linkId, receivedAt: now, defer: opts.defer });
    await tx.update(portalLinks).set({ lastUsedAt: now }).where(eq(portalLinks.id, access.linkId));
    if (opts.staged?.length) await tx.delete(portalUploadParts).where(and(eq(portalUploadParts.linkId, access.linkId), inArray(portalUploadParts.uploadId, opts.staged)));
    return { id, files: files.map((f) => f.filename) };
  });
}

// ── Reminders (the scheduler) ───────────────────────────────────────────────

export type ReminderRun = { sent: number; failed: number; considered: number; skipped: null | 'not_configured' };

function reminderEmail(o: { kind: 'due_soon' | 'overdue'; orgName: string; contactName: string | null; subName: string; projectName: string; contractNumber: string; month: string; dueOn: string; url: string }) {
  const period = `the period ending ${longMonth(o.month)}`;
  return {
    subject: o.kind === 'overdue' ? `Overdue: your ${longMonth(o.month)} billing for ${o.projectName}` : `Reminder: your ${longMonth(o.month)} billing for ${o.projectName} is due ${longDate(o.dueOn)}`,
    text: [
      `Hello ${o.contactName?.trim() || o.subName},`,
      '',
      o.kind === 'overdue'
        ? `${o.orgName} has not received your application for payment for ${period} on ${o.projectName} (${o.contractNumber}). It was due on ${longDate(o.dueOn)}.`
        : `Your application for payment for ${period} on ${o.projectName} (${o.contractNumber}) is due on ${longDate(o.dueOn)}. ${o.orgName} has not received it yet.`,
      '',
      'Upload it here, with your lien waivers:',
      o.url,
      '',
      'The same page shows where each of your applications stands.',
      '',
      `This reminder was sent automatically for ${o.orgName}. If you have already sent it another way, you can ignore this message.`,
    ].join('\n'),
  };
}

/**
 * Send the reminders that are due today, across every organisation. Called by
 * the scheduler once a day. Stops starting new emails after `deadline`.
 */
export async function sendDueReminders(db: DB, opts: { now?: Date; send?: Sender; deadline?: number; max?: number; /** Only this organisation's links. */ orgId?: string } = {}): Promise<ReminderRun> {
  const now = opts.now ?? new Date();
  const run: ReminderRun = { sent: 0, failed: 0, considered: 0, skipped: null };
  if (!opts.send && !emailDeliveryConfigured()) return { ...run, skipped: 'not_configured' };
  const send = opts.send ?? ((m: OutgoingEmail) => sendEmail(m));
  const max = opts.max ?? 100;
  const current = monthOf(now);
  const today = now.getUTCDate();

  const links = await db
    .select({ link: portalLinks, contract: contracts, project: projects, sub: subcontractors, org: organizations, creatorEmail: users.email })
    .from(portalLinks)
    .innerJoin(contracts, and(eq(contracts.id, portalLinks.contractId), eq(contracts.orgId, portalLinks.orgId)))
    .innerJoin(projects, and(eq(projects.id, contracts.projectId), eq(projects.orgId, portalLinks.orgId)))
    .innerJoin(subcontractors, and(eq(subcontractors.id, contracts.subcontractorId), eq(subcontractors.orgId, portalLinks.orgId)))
    .innerJoin(organizations, eq(organizations.id, portalLinks.orgId))
    .leftJoin(users, eq(users.id, portalLinks.createdBy))
    .where(and(isNull(portalLinks.revokedAt), eq(portalLinks.reminders, true), isNotNull(portalLinks.email), eq(contracts.status, 'active'), eq(projects.status, 'active'), opts.orgId ? eq(portalLinks.orgId, opts.orgId) : undefined))
    .orderBy(asc(portalLinks.orgId), asc(portalLinks.createdAt));

  const byOrg = new Map<string, typeof links>();
  for (const l of links) byOrg.set(l.link.orgId, [...(byOrg.get(l.link.orgId) ?? []), l]);

  for (const [orgId, rows] of byOrg) {
    const dueDay = resolveSettings(rows[0]!.org.settings).portalDueDay;
    const kind: 'due_soon' | 'overdue' | null = today > dueDay ? 'overdue' : today >= dueDay - REMINDER_LEAD_DAYS ? 'due_soon' : null;
    if (!kind) continue;
    const contractIds = rows.map((r) => r.contract.id);
    const board = await boardForOrg(db, orgId, { months: [current], current, contractIds });
    const due = new Set(board.sections.flatMap((s) => s.rows).filter((r) => r.cells[0]?.state === 'due').map((r) => r.id));
    // A package still being read (or whose period could not be read) may well be this month's.
    const unread = await db
      .select({ contractId: payApplications.contractId })
      .from(payApplications)
      .where(and(eq(payApplications.orgId, orgId), inArray(payApplications.contractId, contractIds), isNull(payApplications.periodTo), ne(payApplications.status, 'void'), gt(payApplications.receivedAt, new Date(now.getTime() - UNREAD_GRACE_MS))));
    for (const u of unread) if (u.contractId) due.delete(u.contractId);

    for (const r of rows) {
      if (!due.has(r.contract.id)) continue;
      if (run.sent + run.failed >= max || (opts.deadline && Date.now() > opts.deadline)) return run;
      run.considered++;
      const url = storedUrl(r.link.tokenEnc);
      if (!url) {
        console.error(`[portal] link ${r.link.id} can no longer be decrypted; no reminder sent`);
        continue;
      }
      const dueOn = dueDateOf(current, dueDay);
      const message = reminderEmail({ kind, orgName: r.org.name, contactName: r.sub.contactName, subName: r.sub.name, projectName: r.project.name, contractNumber: r.contract.number, month: current, dueOn, url });
      const id = newId('pem');
      // The unique index on (subcontract, kind, month) makes this the one reminder of its kind, even if two runs overlap.
      const claimed = await withOrgLock(db, orgId, async (tx) => {
        const inserted = await tx
          .insert(portalEmails)
          .values({ id, orgId, linkId: r.link.id, contractId: r.contract.id, kind, period: current, toEmail: r.link.email!, subject: message.subject, body: message.text, status: 'sending', createdBy: null, createdAt: now })
          .onConflictDoNothing()
          .returning({ id: portalEmails.id });
        return inserted.length > 0;
      });
      if (!claimed) continue;

      const result = await send({ to: r.link.email!, subject: message.subject, text: message.text, replyTo: r.creatorEmail ?? undefined, idempotencyKey: id });
      const detail = result.status === 'failed' || result.status === 'unconfirmed' ? result.error : result.status === 'not_sent' ? result.reason : null;
      if (result.status === 'sent') run.sent++;
      else run.failed++;
      await withOrgLock(db, orgId, async (tx) => {
        await tx
          .update(portalEmails)
          .set({ status: result.status, provider: result.provider, providerRef: result.status === 'sent' ? result.providerRef : null, error: detail })
          .where(eq(portalEmails.id, id));
        const what = `${kind === 'overdue' ? 'overdue' : 'due-date'} reminder for ${longMonth(current)} to ${r.link.email}`;
        await recordAudit(tx, {
          orgId,
          actor: { system: true, name: 'Billing reminders' },
          action: result.status === 'sent' ? 'portal.reminder_sent' : 'portal.reminder_failed',
          entityType: 'contract',
          entityId: r.contract.id,
          summary: result.status === 'sent' ? `Emailed the ${what}` : result.status === 'unconfirmed' ? `The ${what} was NOT CONFIRMED by the provider (it may have been sent)` : `The ${what} FAILED to send`,
          data: { kind, period: current, to: r.link.email, status: result.status },
          at: now,
        });
        if (result.status !== 'sent') {
          await notifyUsers(tx, orgId, [r.link.createdBy], { type: 'portal.reminder_failed', title: `A billing reminder to ${r.sub.name} did not go out`, body: detail ?? undefined, href: `/contracts/${r.contract.id}` }, now);
        }
      });
    }
  }
  return run;
}
