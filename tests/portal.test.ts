/**
 * The subcontractor portal: a link per subcontract that lets the subcontractor
 * send billing and follow it without an account. The link must reach that one
 * subcontract of that one organisation and nothing else, stop working the
 * moment it is replaced or turned off, show only what was meant for the
 * subcontractor, and remind them exactly once per kind and month.
 */
import { and, eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { POST as postApplication } from '@/app/api/portal/[token]/applications/route';
import { auditEvents, contracts, notifications, organizations, payApplications, portalEmails, portalLinks } from '@/db/schema';
import { PermissionError, UserError } from '@/server/auth/permissions';
import type { EmailResult, OutgoingEmail } from '@/server/email';
import { lookUpPortal } from '@/server/portal-http';
import { processApplication } from '@/server/services/intake';
import {
  PORTAL_GUESSES_PER_IP,
  PORTAL_SUBMISSIONS_PER_DAY,
  createPortalLink,
  emailPortalLink,
  getPortalPanel,
  getPortalView,
  portalFilesFromForm,
  resolvePortalToken,
  revokePortalLink,
  sendDueReminders,
  stagePortalPart,
  submitThroughPortal,
  updatePortalLink,
} from '@/server/services/portal';
import { createContract, createSubcontractor } from '@/server/services/records';
import { addComment, approveApplication, sendSubcontractorMessage } from '@/server/services/review';
import { updatePolicy } from '@/server/services/team';
import { renderPackage } from '@/server/samples/pdf';
import { resolveSettings } from '@/server/types';
import { createWorld, getApp, packageFor, stateAfter, submit, type World } from './helpers/world';

const tokenOf = (url: string) => url.split('/portal/')[1]!;
/** A tiny file that sniffs as a PDF: enough for intake, which reads it later. */
const pdf = (name: string) => ({ filename: name, bytes: new TextEncoder().encode(`%PDF-1.4\n% ${name} ${Math.random()}\n`) });

function fakeSender(outcome: EmailResult = { status: 'sent', provider: 'resend', providerRef: 'ref_1' }) {
  const sent: OutgoingEmail[] = [];
  const send = async (m: OutgoingEmail) => {
    sent.push(m);
    return outcome;
  };
  return { sent, send };
}

async function linkFor(w: World, email = 'billing@lonestarelectric.example') {
  const { id, url } = await createPortalLink(w.db, w.accountant, w.contractId, { email });
  return { id, url, token: tokenOf(url) };
}

/** A second subcontract in the same organisation, for a different subcontractor. */
async function otherContract(w: World) {
  const subId = await createSubcontractor(w.db, w.owner, { name: 'Capitol Concrete Co.', trade: 'Concrete', contactEmail: 'ap@capitolconcrete.example' });
  return createContract(w.db, w.owner, { projectId: w.projectId, subcontractorId: subId, number: 'SC-2301-03', title: 'Concrete', originalAmount: 40_000_000, retainageWorkBps: 1000, retainageStoredBps: 1000, executedOn: '2026-02-01', schedule: [] });
}

describe('portal links', () => {
  it('are made by reviewers only, open exactly one subcontract, and stop working once replaced or turned off', async () => {
    const w = await createWorld();
    await expect(createPortalLink(w.db, w.pm, w.contractId, {})).rejects.toBeInstanceOf(PermissionError);
    await expect(createPortalLink(w.db, w.viewer, w.contractId, {})).rejects.toBeInstanceOf(PermissionError);
    await expect(createPortalLink(w.db, w.accountant, w.contractId, { email: 'not an address' })).rejects.toThrow('valid email');

    const first = await linkFor(w);
    expect(first.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const access = await resolvePortalToken(w.db, first.token);
    expect(access).toMatchObject({ orgId: w.orgId, contractId: w.contractId, contractNumber: 'SC-2301-16', subcontractorName: 'Lone Star Electric, LLC', open: true, dueDay: 25 });

    // Neither column holds the token as it appears in the link.
    const [row] = await w.db.select().from(portalLinks).where(eq(portalLinks.id, first.id));
    expect(row!.tokenHash).not.toContain(first.token);
    expect(row!.tokenEnc).not.toContain(first.token);

    // Replacing: the old link is dead at once, the new one works, and there is only ever one live link.
    const second = await linkFor(w);
    expect(await resolvePortalToken(w.db, first.token)).toBeNull();
    expect(await resolvePortalToken(w.db, second.token)).not.toBeNull();
    const live = await w.db.select().from(portalLinks).where(and(eq(portalLinks.contractId, w.contractId)));
    expect(live.filter((l) => !l.revokedAt)).toHaveLength(1);

    await updatePortalLink(w.db, w.accountant, second.id, { reminders: false });
    await revokePortalLink(w.db, w.accountant, second.id);
    expect(await resolvePortalToken(w.db, second.token)).toBeNull();

    for (const junk of ['', 'abc', `${second.token}x`, second.token.slice(0, 42), '../../etc/passwd']) expect(await resolvePortalToken(w.db, junk)).toBeNull();

    const audit = await w.db.select({ action: auditEvents.action, summary: auditEvents.summary }).from(auditEvents).where(eq(auditEvents.orgId, w.orgId));
    expect(audit.map((a) => a.action)).toEqual(expect.arrayContaining(['portal.link_created', 'portal.link_replaced', 'portal.link_updated', 'portal.link_revoked']));
    // Every entry says which subcontract the link belongs to.
    for (const a of audit.filter((x) => x.action.startsWith('portal.link_'))) expect(a.summary).toContain('Lone Star Electric, LLC on SC-2301-16');
    expect(audit.find((a) => a.action === 'portal.link_updated')?.summary).toContain('billing reminders turned off');
  });

  it('cannot be seen, changed or turned off from another organisation, and only reviewers see the link itself', async () => {
    const a = await createWorld();
    const b = await createWorld();
    const link = await linkFor(a);
    await expect(updatePortalLink(b.db, b.owner, link.id, { reminders: false })).rejects.toThrow('no longer exists');
    await expect(revokePortalLink(b.db, b.owner, link.id)).rejects.toThrow('no longer exists');
    await expect(emailPortalLink(b.db, b.owner, link.id, { send: fakeSender().send })).rejects.toThrow('no longer exists');
    await expect(createPortalLink(b.db, b.owner, a.contractId, {})).rejects.toThrow('no longer exists');
    expect(await getPortalPanel(b.db, b.owner, a.contractId)).toBeNull();
    expect(await resolvePortalToken(a.db, link.token)).not.toBeNull();

    expect((await getPortalPanel(a.db, a.accountant, a.contractId))!.link!.url).toBe(link.url);
    const pmView = await getPortalPanel(a.db, a.pm, a.contractId);
    expect(pmView!.link).not.toBeNull();
    expect(pmView!.link!.url).toBeNull();
    expect(pmView!.canManage).toBe(false);
  });

  it('are not made for a closed subcontract, and a closed one takes no billing through an existing link', async () => {
    const w = await createWorld();
    const link = await linkFor(w);
    await w.db.update(contracts).set({ status: 'closed' }).where(eq(contracts.id, w.contractId));
    const access = (await resolvePortalToken(w.db, link.token))!;
    expect(access.open).toBe(false);
    await expect(submitThroughPortal(w.db, access, [pdf('a.pdf')], { defer: true })).rejects.toThrow('closed');
    await expect(stagePortalPart(w.db, access, 'abcdefghijklmnop1234', 0, new Uint8Array([1]))).rejects.toThrow('closed');
    await expect(createPortalLink(w.db, w.accountant, w.contractId, {})).rejects.toThrow('closed');
  });
});

describe('what the link shows', () => {
  it('shows this subcontract’s applications with their status and the messages sent to the subcontractor, and nothing internal', async () => {
    const w = await createWorld();
    const link = await linkFor(w);
    const access = (await resolvePortalToken(w.db, link.token))!;

    // Through the link: arrives matched to the subcontract, like an upload.
    const pkg1 = packageFor(w, 0, null);
    const { id: viaPortal, files } = await submitThroughPortal(w.db, access, [{ filename: 'payapp-1.pdf', bytes: await renderPackage(pkg1) }], { defer: true });
    expect(files).toEqual(['payapp-1.pdf']);
    let app = await getApp(w, viaPortal);
    expect(app).toMatchObject({ contractId: w.contractId, receivedVia: 'portal', submittedBy: null, status: 'processing' });
    let view = await getPortalView(w.db, access);
    expect(view.submissions).toHaveLength(1);
    expect(view.submissions[0]).toMatchObject({ status: 'received', requested: null, approved: null, via: 'portal', files: ['payapp-1.pdf'] });

    await processApplication(w.db, w.orgId, viaPortal);
    app = await getApp(w, viaPortal);
    expect(app.status).toBe('needs_review');
    const [received] = await w.db.select().from(auditEvents).where(and(eq(auditEvents.payApplicationId, viaPortal), eq(auditEvents.action, 'application.received')));
    expect(received!.summary).toContain('through the subcontractor portal for SC-2301-16');
    expect(received!.data).toMatchObject({ via: 'portal', portalLinkId: link.id });

    // Internal notes the subcontractor must never see.
    await addComment(w.db, w.accountant, viaPortal, 'INTERNAL-NOTE: their PM is slow, chase hard');
    // Something on another subcontract in the same organisation, and in another organisation.
    const other = await otherContract(w);
    const elsewhere = await submit(w, packageFor(w, 1, stateAfter(pkg1)), { contractId: other });
    const b = await createWorld();
    await submit(b, packageFor(b, 0, null));

    // A correction request with a hold: the subcontractor sees the message as the reason.
    await sendSubcontractorMessage(w.db, w.accountant, viaPortal, { to: 'maria@lonestarelectric.example', subject: 'Missing conditional waiver', body: 'Please send the conditional waiver for this payment so we can continue.', hold: true });
    view = await getPortalView(w.db, access);
    expect(view.submissions.map((s) => s.key)).toEqual([viaPortal]);
    expect(view.submissions[0]).toMatchObject({ status: 'waiting_on_you', applicationNumber: 1, periodTo: '2026-09-30' });
    expect(view.submissions[0]!.requested).toBe(app.claimedAmount);
    expect(view.submissions[0]!.messages).toEqual([expect.objectContaining({ subject: 'Missing conditional waiver', body: 'Please send the conditional waiver for this payment so we can continue.' })]);
    const json = JSON.stringify(view);
    expect(json).not.toContain('INTERNAL-NOTE');
    expect(json).not.toContain(elsewhere.id);
    expect(json).not.toContain('Capitol');

    // Approved: the amount shows; the approver's note does not.
    const { resumeReview } = await import('@/server/services/review');
    await resumeReview(w.db, w.accountant, viaPortal);
    await approveApplication(w.db, w.controller, viaPortal, { note: 'APPROVER-NOTE: pay late', acknowledgeWarnings: true });
    view = await getPortalView(w.db, access);
    app = await getApp(w, viaPortal);
    expect(view.submissions[0]).toMatchObject({ status: 'approved', approved: app.approvedAmount });
    expect(app.approvedAmount).toBeGreaterThan(0);
    expect(JSON.stringify(view)).not.toContain('APPROVER-NOTE');
  });

  it('says what is due this month the way the billing board does', async () => {
    const w = await createWorld();
    const link = await linkFor(w);
    const access = (await resolvePortalToken(w.db, link.token))!;
    // Nothing billed yet: not expected.
    expect((await getPortalView(w.db, access, new Date('2026-11-10T12:00:00Z'))).current).toMatchObject({ month: '2026-11', state: 'not_started', dueOn: '2026-11-25' });
    // Once billing has started, November is due and October (nothing sent) is missing.
    await submit(w, packageFor(w, 0, null));
    const view = await getPortalView(w.db, access, new Date('2026-11-10T12:00:00Z'));
    expect(view.current).toMatchObject({ month: '2026-11', state: 'due' });
    expect(view.previous).toMatchObject({ month: '2026-10', state: 'missing' });
  });
});

describe('uploading through the link', () => {
  it('takes PDFs and images only, up to the daily limit, and refuses once the link is turned off', async () => {
    const w = await createWorld();
    const link = await linkFor(w);
    const access = (await resolvePortalToken(w.db, link.token))!;
    await expect(submitThroughPortal(w.db, access, [{ filename: 'invoice.docx', bytes: new TextEncoder().encode('PK\u0003\u0004 not a pdf') }], { defer: true })).rejects.toThrow('not a PDF or an image');

    const now = new Date('2026-11-20T10:00:00Z');
    for (let i = 0; i < PORTAL_SUBMISSIONS_PER_DAY; i++) await submitThroughPortal(w.db, access, [pdf(`p${i}.pdf`)], { defer: true, now });
    await expect(submitThroughPortal(w.db, access, [pdf('one-more.pdf')], { defer: true, now })).rejects.toThrow('limit');
    // A day later there is room again.
    await submitThroughPortal(w.db, access, [pdf('next-day.pdf')], { defer: true, now: new Date('2026-11-21T10:30:00Z') });

    await revokePortalLink(w.db, w.accountant, link.id);
    await expect(submitThroughPortal(w.db, access, [pdf('late.pdf')], { defer: true })).rejects.toThrow('turned off');
  });

  it('joins a large file from its parts, and one link cannot claim another link’s parts', async () => {
    const w = await createWorld();
    const mine = (await resolvePortalToken(w.db, (await linkFor(w)).token))!;
    const other = await otherContract(w);
    const theirs = (await resolvePortalToken(w.db, tokenOf((await createPortalLink(w.db, w.accountant, other, {})).url)))!;

    const bytes = new TextEncoder().encode(`%PDF-1.4\n${'x'.repeat(5000)}`);
    const uploadId = 'upl_abcdefghijklmnop';
    await stagePortalPart(w.db, mine, uploadId, 0, bytes.slice(0, 3000));
    await stagePortalPart(w.db, mine, uploadId, 1, bytes.slice(3000));
    const form = () => {
      const f = new FormData();
      f.append('staged', JSON.stringify({ uploadId, name: 'big.pdf', type: 'application/pdf', size: bytes.byteLength }));
      return f;
    };
    await expect(portalFilesFromForm(w.db, theirs, form())).rejects.toThrow('did not arrive completely');
    const { files, staged } = await portalFilesFromForm(w.db, mine, form());
    expect(files[0]!.bytes).toEqual(bytes);
    const { id } = await submitThroughPortal(w.db, mine, files, { staged, defer: true });
    expect((await getApp(w, id)).contractId).toBe(w.contractId);
    // The parts are gone once the documents are stored.
    await expect(portalFilesFromForm(w.db, mine, form())).rejects.toThrow('did not arrive completely');
  });

  it('accepts a package over the API with the link as the only credential, and counts wrong links per address', async () => {
    const w = await createWorld();
    const link = await linkFor(w);
    const form = new FormData();
    form.append('files', new File([pdf('payapp.pdf').bytes], 'payapp.pdf', { type: 'application/pdf' }));
    const res = await postApplication(new Request(`https://zephric.example/api/portal/${link.token}/applications`, { method: 'POST', body: form, headers: { 'x-forwarded-for': '198.51.100.7' } }), { params: Promise.resolve({ token: link.token }) });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ received: true, files: ['payapp.pdf'] });
    const apps = await w.db.select().from(payApplications).where(and(eq(payApplications.orgId, w.orgId), eq(payApplications.receivedVia, 'portal')));
    expect(apps).toHaveLength(1);

    const cross = await postApplication(new Request(`https://zephric.example/api/portal/${link.token}/applications`, { method: 'POST', body: new FormData(), headers: { origin: 'https://evil.example', host: 'zephric.example' } }), { params: Promise.resolve({ token: link.token }) });
    expect(cross.status).toBe(403);

    // Wrong links from one address: after the limit, even a right link is refused from there for a while.
    const ip = { get: (n: string) => (n === 'x-forwarded-for' ? '203.0.113.9' : null) };
    for (let i = 0; i < PORTAL_GUESSES_PER_IP; i++) expect(await lookUpPortal(`${'a'.repeat(42)}${i % 10}`, ip)).toEqual({ ok: false, reason: 'not_found' });
    expect(await lookUpPortal(link.token, ip)).toEqual({ ok: false, reason: 'limited' });
    // Another address is unaffected.
    expect((await lookUpPortal(link.token, { get: (n: string) => (n === 'x-forwarded-for' ? '203.0.113.10' : null) })).ok).toBe(true);
  });
});

describe('reminders', () => {
  /** A subcontract that has started billing (September is in) and has a live link. */
  async function billingWorld() {
    const w = await createWorld();
    await submit(w, packageFor(w, 0, null));
    const link = await linkFor(w);
    return { w, link };
  }
  const at = (iso: string) => new Date(`${iso}T03:00:00Z`);
  const remindersOf = (w: World) => w.db.select().from(portalEmails).where(eq(portalEmails.contractId, w.contractId));

  it('go once in the days before the due day and once after it, with the link, and never twice', async () => {
    const { w, link } = await billingWorld();
    const { sent, send } = fakeSender();

    expect(await sendDueReminders(w.db, { now: at('2026-11-10'), send, orgId: w.orgId })).toMatchObject({ sent: 0 });
    const soon = await sendDueReminders(w.db, { now: at('2026-11-21'), send, orgId: w.orgId });
    expect(soon.sent).toBe(1);
    expect(sent[0]).toMatchObject({ to: 'billing@lonestarelectric.example', replyTo: w.accountant.userEmail });
    expect(sent[0]!.subject).toContain('November 2026');
    expect(sent[0]!.subject).toContain('25 November 2026');
    expect(sent[0]!.text).toContain(link.url);
    expect(sent[0]!.idempotencyKey).toMatch(/^pem_/);

    expect((await sendDueReminders(w.db, { now: at('2026-11-22'), send, orgId: w.orgId })).sent).toBe(0);
    expect((await sendDueReminders(w.db, { now: at('2026-11-25'), send, orgId: w.orgId })).sent).toBe(0);
    const late = await sendDueReminders(w.db, { now: at('2026-11-26'), send, orgId: w.orgId });
    expect(late.sent).toBe(1);
    expect(sent[1]!.subject).toMatch(/^Overdue/);
    expect((await sendDueReminders(w.db, { now: at('2026-11-28'), send, orgId: w.orgId })).sent).toBe(0);

    const rows = await remindersOf(w);
    expect(rows.map((r) => [r.kind, r.period, r.status]).sort()).toEqual([
      ['due_soon', '2026-11', 'sent'],
      ['overdue', '2026-11', 'sent'],
    ]);
    const panel = await getPortalPanel(w.db, w.accountant, w.contractId);
    expect(panel!.emails.map((e) => e.kind).sort()).toEqual(['due_soon', 'overdue']);
    const audit = await w.db.select().from(auditEvents).where(and(eq(auditEvents.orgId, w.orgId), eq(auditEvents.action, 'portal.reminder_sent')));
    expect(audit).toHaveLength(2);
  });

  it('do not go when the month’s billing is in, still being read, or reminders are off', async () => {
    const { send, sent } = fakeSender();

    // November's application has arrived.
    const a = await billingWorld();
    const s1 = stateAfter(packageFor(a.w, 0, null));
    const s2 = stateAfter(packageFor(a.w, 1, s1));
    await submit(a.w, packageFor(a.w, 2, s2));
    expect((await sendDueReminders(a.w.db, { now: at('2026-11-21'), send, orgId: a.w.orgId })).sent).toBe(0);

    // Something arrived that has not been read yet: it may be November's.
    const b = await billingWorld();
    const access = (await resolvePortalToken(b.w.db, b.link.token))!;
    await submitThroughPortal(b.w.db, access, [pdf('scan.pdf')], { defer: true, now: at('2026-11-19') });
    expect((await sendDueReminders(b.w.db, { now: at('2026-11-21'), send, orgId: b.w.orgId })).sent).toBe(0);

    // Reminders turned off, or no address.
    const c = await billingWorld();
    await updatePortalLink(c.w.db, c.w.accountant, c.link.id, { reminders: false });
    const d = await billingWorld();
    await updatePortalLink(d.w.db, d.w.accountant, d.link.id, { email: '' });
    expect((await sendDueReminders(c.w.db, { now: at('2026-11-21'), send, orgId: c.w.orgId })).sent).toBe(0);
    expect((await sendDueReminders(d.w.db, { now: at('2026-11-21'), send, orgId: d.w.orgId })).sent).toBe(0);
    expect(sent).toHaveLength(0);

    // A subcontract that has not started billing is not expected to.
    const e = await createWorld();
    await linkFor(e);
    expect((await sendDueReminders(e.db, { now: at('2026-11-21'), send, orgId: e.orgId })).sent).toBe(0);
    expect(sent).toHaveLength(0);
  });

  it('follow the organisation’s due day, and are not sent at all without an email provider', async () => {
    const { w } = await billingWorld();
    await expect(updatePolicy(w.db, w.owner, { portalDueDay: 29 })).rejects.toBeInstanceOf(UserError);
    await expect(updatePolicy(w.db, w.owner, { portalDueDay: 0 })).rejects.toBeInstanceOf(UserError);
    await updatePolicy(w.db, w.owner, { portalDueDay: 10 });
    const [org] = await w.db.select().from(organizations).where(eq(organizations.id, w.orgId));
    expect(resolveSettings(org!.settings).portalDueDay).toBe(10);
    const [changed] = await w.db.select().from(auditEvents).where(and(eq(auditEvents.orgId, w.orgId), eq(auditEvents.action, 'policy.updated')));
    expect(changed!.summary).toBe('Subcontractor billing is now due on day 10 of each month (was day 25)');

    // With no provider configured (as in tests) nothing is attempted or recorded.
    expect(await sendDueReminders(w.db, { now: at('2026-11-07'), orgId: w.orgId })).toMatchObject({ skipped: 'not_configured', sent: 0 });
    expect(await remindersOf(w)).toHaveLength(0);

    const { sent, send } = fakeSender();
    expect((await sendDueReminders(w.db, { now: at('2026-11-07'), send, orgId: w.orgId })).sent).toBe(1);
    expect(sent[0]!.subject).toContain('10 November 2026');
  });

  it('record a failed send as failed, tell whoever made the link, and do not retry it', async () => {
    const { w } = await billingWorld();
    const failing = fakeSender({ status: 'failed', provider: 'resend', error: 'Email provider returned HTTP 422 validation_error' });
    expect(await sendDueReminders(w.db, { now: at('2026-11-21'), send: failing.send, orgId: w.orgId })).toMatchObject({ sent: 0, failed: 1 });
    const [row] = await remindersOf(w);
    expect(row).toMatchObject({ kind: 'due_soon', status: 'failed', error: 'Email provider returned HTTP 422 validation_error' });
    const note = await w.db.select().from(notifications).where(and(eq(notifications.userId, w.accountant.userId), eq(notifications.type, 'portal.reminder_failed')));
    expect(note).toHaveLength(1);
    expect((await sendDueReminders(w.db, { now: at('2026-11-22'), send: fakeSender().send, orgId: w.orgId })).sent).toBe(0);
  });
});

describe('emailing the link', () => {
  it('is refused without email delivery or an address, sent and recorded with them, and not sent twice in a row', async () => {
    const w = await createWorld();
    const link = await linkFor(w);
    await expect(emailPortalLink(w.db, w.accountant, link.id)).rejects.toThrow('not set up');
    await expect(emailPortalLink(w.db, w.pm, link.id, { send: fakeSender().send })).rejects.toBeInstanceOf(PermissionError);

    const { sent, send } = fakeSender();
    expect(await emailPortalLink(w.db, w.accountant, link.id, { send })).toEqual({ status: 'sent', detail: null });
    expect(sent[0]).toMatchObject({ to: 'billing@lonestarelectric.example', replyTo: w.accountant.userEmail });
    expect(sent[0]!.text).toContain(link.url);
    await expect(emailPortalLink(w.db, w.accountant, link.id, { send })).rejects.toThrow('already sent');
    const rows = await w.db.select().from(portalEmails).where(eq(portalEmails.linkId, link.id));
    expect(rows).toEqual([expect.objectContaining({ kind: 'link', status: 'sent', providerRef: 'ref_1', createdBy: w.accountant.userId })]);

    await updatePortalLink(w.db, w.accountant, link.id, { email: '' });
    await expect(emailPortalLink(w.db, w.accountant, link.id, { send })).rejects.toThrow('Add the address');
  });
});
