import { eq } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import { auditEvents, documents, payApplications, transfers } from '@/db/schema';
import { PermissionError } from '@/server/auth/permissions';
import { readPdfText } from '@/server/documents/pdf-text';
import { renderPackage } from '@/server/samples/pdf';
import { createBatchExport, createExport, getTransferFile, listAwaitingTransfer, renderLineCsv, renderSummaryCsv } from '@/server/services/exports';
import { InboundRejected, listInboundMessages, parseInboundJson, parseInboundMime, presentedSecret, receiveInboundEmail } from '@/server/services/inbound';
import { processApplication } from '@/server/services/intake';
import { updateSubcontractor } from '@/server/services/records';
import { acceptFinding, approveApplication, reopenApplication, voidApplication } from '@/server/services/review';
import { updatePolicy } from '@/server/services/team';
import { createWorld, getApp, openFindings, packageFor, stateAfter, submit, type World } from './helpers/world';

describe('exports', () => {
  let w: World;
  let appId: string;
  beforeAll(async () => {
    w = await createWorld();
    const app = await submit(w, packageFor(w, 0, null));
    await approveApplication(w.db, w.controller, app.id, { note: 'OK to pay' });
    appId = app.id;
  });

  it('only exports approved applications, and only for roles that may', async () => {
    const pending = await submit(w, packageFor(w, 1, null));
    await expect(createExport(w.db, w.controller, pending.id, 'csv')).rejects.toThrow(/Only approved applications/);
    await expect(createExport(w.db, w.pm, appId, 'csv')).rejects.toBeInstanceOf(PermissionError);
    await expect(createExport(w.db, w.viewer, appId, 'pdf')).rejects.toBeInstanceOf(PermissionError);
  });

  it('lists approved applications until they have been transferred', async () => {
    expect((await listAwaitingTransfer(w.db, w.controller)).map((r) => r.id)).toEqual([appId]);
  });

  it('writes a line-level CSV from the approved record', async () => {
    const { transferId, filename } = await createExport(w.db, w.accountant, appId, 'csv');
    expect(filename).toBe('Lone-Star-Electric-LLC-app-1-2026-09-30-lines.csv');
    const file = await getTransferFile(w.db, w.accountant, transferId);
    const rows = file.bytes.toString('utf8').trim().split('\r\n');
    expect(rows[0]).toContain('Item No,Description,Scheduled Value,Previous Work,Work This Period');
    expect(rows).toHaveLength(4);
    expect(rows[1]).toContain(',1,Mobilization,50000.00,0.00,50000.00,0.00,50000.00,100.0,0.00,5000.00,No,');
    expect(rows[2]).toContain('"Rough-in, levels 1-3",300000.00,0.00,60000.00');

    expect((await getApp(w, appId)).transferStatus).toBe('exported');
    expect(await listAwaitingTransfer(w.db, w.controller)).toEqual([]);
    const [row] = await w.db.select().from(transfers).where(eq(transfers.id, transferId));
    expect(row).toMatchObject({ kind: 'csv', status: 'completed', createdBy: w.accountant.userId });
    expect(row!.sha256).toMatch(/^[a-f0-9]{64}$/);
    const events = await w.db.select().from(auditEvents).where(eq(auditEvents.payApplicationId, appId));
    expect(events.some((e) => e.action === 'transfer.exported' && e.summary.includes(filename))).toBe(true);
  });

  it('writes the full record as JSON with decimal-string amounts', async () => {
    const { transferId } = await createExport(w.db, w.controller, appId, 'json');
    const json = JSON.parse((await getTransferFile(w.db, w.controller, transferId)).bytes.toString('utf8'));
    expect(json).toMatchObject({
      currency: 'USD',
      approvedBy: { name: 'Carlos Controller', role: 'controller' },
      note: 'OK to pay',
      approved: { currentPaymentDue: '99000.00', retainageTotal: '11000.00', totalCompletedStored: '110000.00' },
      requested: { currentPaymentDue: '99000.00' },
      varianceFromRequested: '0.00',
    });
    expect(json.lines[0]).toMatchObject({ itemNo: '1', thisPeriod: '50000.00', adjusted: false });
    expect(json.documents[0].sha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it('writes a readable PDF approval record', async () => {
    const { transferId } = await createExport(w.db, w.controller, appId, 'pdf');
    const file = await getTransferFile(w.db, w.controller, transferId);
    expect(file.contentType).toBe('application/pdf');
    const text = (await readPdfText(new Uint8Array(file.bytes))).pages.map((p) => p.text).join('\n');
    expect(text).toContain('Payment application approval record');
    expect(text).toContain('APPROVED FOR PAYMENT');
    expect(text).toContain('$99,000.00');
    expect(text).toContain('Carlos Controller');
    expect(text).toContain('Lone Star Electric, LLC');
    expect(text).toContain('SHA-256');
  });

  it('exports several applications as one accounts-payable summary', async () => {
    const batch = await createBatchExport(w.db, w.controller, [appId]);
    expect(batch.count).toBe(1);
    const csv = (await getTransferFile(w.db, w.controller, batch.transferId)).bytes.toString('utf8');
    expect(csv.split('\r\n')[0]).toContain('Approved Payment,Requested Payment,Variance From Requested');
    expect(csv).toContain(',99000.00,99000.00,0.00,');
  });

  it('never serves one organisation’s export to another', async () => {
    const other = await createWorld();
    const [mine] = await w.db.select().from(transfers).where(eq(transfers.payApplicationId, appId));
    await expect(getTransferFile(other.db, other.owner, mine!.id)).rejects.toThrow(/not available/);
    await expect(createExport(other.db, other.owner, appId, 'csv')).rejects.toThrow('Application not found.');
  });

  it('neutralises spreadsheet formulas in exported text', async () => {
    const [app] = await w.db.select().from(payApplications).where(eq(payApplications.id, appId));
    const record = structuredClone(app!.approvedRecord!);
    record.lines[0]!.description = '=HYPERLINK("http://evil.example","x")';
    record.subcontractor.name = '+1 (555) 010-0000';
    const lines = renderLineCsv(record);
    expect(lines).toContain(`"'=HYPERLINK(""http://evil.example"",""x"")"`);
    expect(renderSummaryCsv([record])).toContain(`'+1 (555) 010-0000`);
  });

  it('resets the transfer status when an exported approval is withdrawn', async () => {
    // The application #2 submitted earlier in this file was built without billing history; replace it.
    const stale = (await w.db.select().from(payApplications).where(eq(payApplications.orgId, w.orgId))).find((a) => a.applicationNumber === 2)!;
    await voidApplication(w.db, w.controller, stale.id, 'Built without billing history');
    const second = await submit(w, packageFor(w, 1, stateAfter(packageFor(w, 0, null))));
    await approveApplication(w.db, w.controller, second.id);
    await createExport(w.db, w.controller, second.id, 'csv');
    expect((await getApp(w, second.id)).transferStatus).toBe('exported');

    await reopenApplication(w.db, w.controller, second.id, 'Approved in error');
    expect(await getApp(w, second.id)).toMatchObject({ status: 'needs_review', transferStatus: 'none', approvedRecord: null });
    const events = await w.db.select().from(auditEvents).where(eq(auditEvents.payApplicationId, second.id));
    expect(events.find((e) => e.action === 'application.reopened')!.summary).toContain('Files exported earlier are now out of date');
  });
});

describe('email intake', () => {
  let w: World;
  let token: string;
  let pdf: Uint8Array;
  beforeAll(async () => {
    w = await createWorld();
    const { organizations } = await import('@/db/schema');
    const [org] = await w.db.select().from(organizations).where(eq(organizations.id, w.orgId));
    token = org!.intakeToken;
    pdf = await renderPackage(packageFor(w, 0, null));
  });

  const postmark = () => ({
    From: 'Maria Alvarez <billing@lonestarelectric.example>',
    Subject: 'Pay App 1 - Riverside MOB',
    TextBody: 'Attached.',
    Attachments: [
      { Name: 'PayApp-01.pdf', ContentType: 'application/pdf', Content: Buffer.from(pdf).toString('base64') },
      { Name: 'logo.png', ContentType: 'image/png', Content: Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]).toString('base64') },
    ],
  });

  it('is closed until a shared secret is configured', async () => {
    delete process.env.INBOUND_EMAIL_SECRET;
    await expect(receiveInboundEmail(w.db, token, 'anything', parseInboundJson(postmark()))).rejects.toMatchObject({ status: 503 });
  });

  it('rejects a wrong secret and an unknown address', async () => {
    process.env.INBOUND_EMAIL_SECRET = 'test-inbound-secret';
    await expect(receiveInboundEmail(w.db, token, 'nope', parseInboundJson(postmark()))).rejects.toMatchObject({ status: 401 });
    await expect(receiveInboundEmail(w.db, token, null, parseInboundJson(postmark()))).rejects.toMatchObject({ status: 401 });
    // Final: Postmark stops retrying on 403. A wrong secret (401) is retried, giving the owner time to fix it.
    await expect(receiveInboundEmail(w.db, 'not-a-token', 'test-inbound-secret', parseInboundJson(postmark()))).rejects.toMatchObject({ status: 403 });
  });

  it('turns the attachments of a provider webhook into a billing package', async () => {
    const result = await receiveInboundEmail(w.db, token, 'test-inbound-secret', parseInboundJson({ ...postmark(), MessageID: 'pm-0001' }));
    if (result.outcome !== 'accepted') throw new Error(`expected the message to be accepted, got ${result.outcome}`);
    expect(result.files).toEqual(['PayApp-01.pdf']);
    expect(result.ignored).toEqual(['logo.png']); // signature images are not billing documents

    const app = await getApp(w, result.id);
    expect(app).toMatchObject({ status: 'processing', receivedVia: 'email', senderEmail: 'billing@lonestarelectric.example', submittedBy: null, orgId: w.orgId });
    await processApplication(w.db, w.orgId, result.id);
    const processed = await getApp(w, result.id);
    // billing@ is on the same company domain as the contact on file, so the sender is accepted as known.
    expect(processed).toMatchObject({ status: 'needs_review', contractId: w.contractId, applicationNumber: 1, openBlocking: 0 });
    const docs = await w.db.select().from(documents).where(eq(documents.payApplicationId, result.id));
    expect(docs).toHaveLength(1);
    expect(docs[0]).toMatchObject({ source: 'email', filename: 'PayApp-01.pdf' });
  });

  it('processes a message once, however many times the provider delivers it', async () => {
    const before = await w.db.select().from(payApplications).where(eq(payApplications.orgId, w.orgId));
    // The provider retries the same webhook, twice at the same moment.
    const again = await Promise.all([
      receiveInboundEmail(w.db, token, 'test-inbound-secret', parseInboundJson({ ...postmark(), MessageID: 'pm-0001' })),
      receiveInboundEmail(w.db, token, 'test-inbound-secret', parseInboundJson({ ...postmark(), MessageID: 'pm-0001' })),
    ]);
    expect(again.map((r) => r.outcome)).toEqual(['duplicate', 'duplicate']);
    expect(await w.db.select().from(payApplications).where(eq(payApplications.orgId, w.orgId))).toHaveLength(before.length);

    // The sender's own Message-ID header wins over the provider's id, so a re-delivery under a new provider id is still caught.
    const withHeader = (pmId: string) => parseInboundJson({ ...postmark(), MessageID: pmId, Headers: [{ Name: 'Message-ID', Value: '<abc123@lonestarelectric.example>' }] });
    expect((await receiveInboundEmail(w.db, token, 'test-inbound-secret', withHeader('pm-0002'))).outcome).toBe('accepted');
    expect((await receiveInboundEmail(w.db, token, 'test-inbound-secret', withHeader('pm-0003'))).outcome).toBe('duplicate');

    // With no id at all, identical sender, subject and attachments is the same message.
    const bare = () => parseInboundJson({ ...postmark(), Subject: 'Pay App 1 (no id)' });
    expect((await receiveInboundEmail(w.db, token, 'test-inbound-secret', bare())).outcome).toBe('accepted');
    expect((await receiveInboundEmail(w.db, token, 'test-inbound-secret', bare())).outcome).toBe('duplicate');
  });

  it('accepts a package from an unknown address but blocks its approval until someone vouches for it', async () => {
    const w2 = await createWorld();
    const { organizations } = await import('@/db/schema');
    const [org] = await w2.db.select().from(organizations).where(eq(organizations.id, w2.orgId));
    const bytes = await renderPackage(packageFor(w2, 0, null));
    const message = parseInboundJson({ From: 'someone@elsewhere.example', Subject: 'Pay app', MessageID: 'x-1', Attachments: [{ Name: 'payapp.pdf', ContentType: 'application/pdf', Content: Buffer.from(bytes).toString('base64') }] });
    const result = await receiveInboundEmail(w2.db, org!.intakeToken, 'test-inbound-secret', message);
    if (result.outcome !== 'accepted') throw new Error('expected accepted');
    await processApplication(w2.db, w2.orgId, result.id);

    const open = await openFindings(w2, result.id);
    expect(open.map((f) => f.code)).toEqual(['intake.sender']);
    expect(open[0]).toMatchObject({ severity: 'blocking' });
    await expect(approveApplication(w2.db, w2.controller, result.id)).rejects.toThrow(/blocking finding/);
    // An accountant cannot wave it through; it takes an approver, with a reason.
    await expect(acceptFinding(w2.db, w2.accountant, open[0]!.id, 'Looks fine to me')).rejects.toBeInstanceOf(PermissionError);

    // Putting the address on the subcontractor's record clears it without anyone overriding anything.
    await updateSubcontractor(w2.db, w2.owner, w2.subcontractorId, { name: w2.parties.sub.name, trade: 'Electrical', contactName: 'Maria Alvarez', contactEmail: 'someone@elsewhere.example' });
    expect(await openFindings(w2, result.id)).toEqual([]);
  });

  it('turns unknown senders away under the strict policy, logs it and tells the team', async () => {
    const w3 = await createWorld();
    const { organizations, inboundMessages, notifications } = await import('@/db/schema');
    const [org] = await w3.db.select().from(organizations).where(eq(organizations.id, w3.orgId));
    await updatePolicy(w3.db, w3.owner, { unknownSenderPolicy: 'reject' });
    const bytes = Buffer.from(await renderPackage(packageFor(w3, 0, null))).toString('base64');
    const from = (address: string, id: string) => parseInboundJson({ From: address, Subject: 'Pay app', MessageID: id, Attachments: [{ Name: 'payapp.pdf', ContentType: 'application/pdf', Content: bytes }] });

    const stranger = await receiveInboundEmail(w3.db, org!.intakeToken, 'test-inbound-secret', from('someone@elsewhere.example', 's-1'));
    expect(stranger).toMatchObject({ outcome: 'rejected', reason: expect.stringContaining('not on file') });
    await receiveInboundEmail(w3.db, org!.intakeToken, 'test-inbound-secret', from('someone@elsewhere.example', 's-2'));
    expect(await w3.db.select().from(payApplications).where(eq(payApplications.orgId, w3.orgId))).toHaveLength(0);

    const log = await listInboundMessages(w3.db, w3.owner);
    expect(log.map((m) => m.outcome)).toEqual(['rejected', 'rejected']);
    expect(log[0]).toMatchObject({ fromEmail: 'someone@elsewhere.example', payApplicationId: null });
    // Two rejections from the same address in a day produce one round of notifications, not two.
    const notes = await w3.db.select().from(notifications).where(eq(notifications.type, 'intake.sender_rejected'));
    const mine = notes.filter((n) => n.orgId === w3.orgId);
    expect(new Set(mine.map((n) => n.userId)).size).toBe(mine.length);
    expect(mine.length).toBeGreaterThan(0);

    // The contact on file, and a member of the team forwarding a package, still get through.
    expect((await receiveInboundEmail(w3.db, org!.intakeToken, 'test-inbound-secret', from('Maria <maria@lonestarelectric.example>', 's-3'))).outcome).toBe('accepted');
    expect((await receiveInboundEmail(w3.db, org!.intakeToken, 'test-inbound-secret', from(w3.accountant.userEmail, 's-4'))).outcome).toBe('accepted');
    // Another organisation's log does not show any of this.
    expect((await w3.db.select().from(inboundMessages).where(eq(inboundMessages.orgId, w.orgId))).some((m) => m.messageId.startsWith('s-'))).toBe(false);
  });

  it('accepts a raw message as well', async () => {
    const boundary = 'b0undary';
    const eml = [
      'From: "Maria Alvarez" <billing@lonestarelectric.example>',
      'To: intake@example.test',
      'Subject: Pay application',
      'Received-SPF: Pass (sender SPF authorized) identity=mailfrom; client-ip=203.0.113.5',
      'X-Spam-Status: No, score=0.4',
      'MIME-Version: 1.0',
      `Content-Type: multipart/mixed; boundary="${boundary}"`,
      '',
      `--${boundary}`,
      'Content-Type: text/plain',
      '',
      'See attached.',
      `--${boundary}`,
      'Content-Type: application/pdf; name="PayApp.pdf"',
      'Content-Disposition: attachment; filename="PayApp.pdf"',
      'Content-Transfer-Encoding: base64',
      '',
      Buffer.from(pdf).toString('base64').replace(/(.{76})/g, '$1\r\n'),
      `--${boundary}--`,
      '',
    ].join('\r\n');
    const message = await parseInboundMime(new TextEncoder().encode(eml));
    expect(message.from).toBe('billing@lonestarelectric.example');
    expect(message.spf).toBe('pass');
    expect(message.spam).toEqual({ flagged: false, score: '0.4' });
    expect(message.attachments).toHaveLength(1);
    expect(message.attachments[0]!.bytes.byteLength).toBe(pdf.byteLength);
  });

  it('logs a message with nothing to process instead of asking the provider to retry it', async () => {
    const empty = parseInboundJson({ From: 'a@b.example', Subject: 'hello', MessageID: 'empty-1', Attachments: [] });
    const result = await receiveInboundEmail(w.db, token, 'test-inbound-secret', empty);
    expect(result).toEqual({ outcome: 'rejected', reason: 'The message had no attachments.' });
    const log = await listInboundMessages(w.db, w.owner, 100);
    expect(log.find((m) => m.messageId === 'empty-1')).toMatchObject({ outcome: 'rejected', fromEmail: 'a@b.example', subject: 'hello' });
    expect(() => parseInboundJson('nope')).toThrow(InboundRejected);
  });

  it('reads the shared secret from basic auth, a bearer token or a header, never from the address', () => {
    const req = (headers: Record<string, string>, url = 'https://rcm.example.test/api/inbound/email/tok') => new Request(url, { method: 'POST', headers });
    expect(presentedSecret(req({ 'x-inbound-secret': 'a-secret' }))).toBe('a-secret');
    expect(presentedSecret(req({ authorization: 'Bearer b-secret' }))).toBe('b-secret');
    expect(presentedSecret(req({ authorization: `Basic ${Buffer.from('postmark:c-secret').toString('base64')}` }))).toBe('c-secret');
    // Addresses end up in access logs, so a secret in the query string is not accepted.
    expect(presentedSecret(req({}, 'https://rcm.example.test/api/inbound/email/tok?secret=d-secret'))).toBeNull();
    expect(presentedSecret(req({}))).toBeNull();
  });

  it('checks the secret and the address before reading the body, and tells the provider which refusals are final', async () => {
    const { POST } = await import('@/app/api/inbound/email/[token]/route');
    let read = false;
    // highWaterMark 0: the stream is pulled only when someone reads it.
    const body = () =>
      new ReadableStream(
        {
          pull() {
            read = true;
            throw new Error('the body was read');
          },
        },
        { highWaterMark: 0 },
      );
    const call = (tok: string, headers: Record<string, string>, payload: BodyInit | ReadableStream = body()) =>
      POST(new Request(`https://rcm.example.test/api/inbound/email/${tok}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: payload, duplex: 'half' } as RequestInit), { params: Promise.resolve({ token: tok }) });
    const basic = (secret: string) => ({ authorization: `Basic ${Buffer.from(`postmark:${secret}`).toString('base64')}` });

    expect((await call(token, basic('wrong'))).status).toBe(401);
    expect((await call('not-a-token', basic('test-inbound-secret'))).status).toBe(403);
    expect(read).toBe(false);
    expect((await call(token, { ...basic('test-inbound-secret'), 'content-length': String(60 * 1024 * 1024) })).status).toBe(403);
    expect(read).toBe(false);
    expect((await call(token, basic('test-inbound-secret'), '{not json')).status).toBe(403);
    const ok = await call(token, basic('test-inbound-secret'), JSON.stringify({ From: 'a@b.example', Subject: 'empty', MessageID: 'route-1', Attachments: [] }));
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ outcome: 'rejected', reason: 'The message had no attachments.' });
  });

  it('turns away mail the provider marked as spam, without telling anyone', async () => {
    const spam = parseInboundJson({
      ...postmark(),
      MessageID: 'spam-1',
      Headers: [
        { Name: 'X-Spam-Status', Value: 'Yes' },
        { Name: 'X-Spam-Score', Value: '7.2' },
      ],
    });
    expect(spam.spam).toEqual({ flagged: true, score: '7.2' });
    const result = await receiveInboundEmail(w.db, token, 'test-inbound-secret', spam);
    expect(result).toEqual({ outcome: 'rejected', reason: 'The email provider marked it as spam (score 7.2).' });
    const log = await listInboundMessages(w.db, w.owner, 100);
    expect(log.find((m) => m.messageId === 'spam-1')).toMatchObject({ outcome: 'rejected', payApplicationId: null });
    // A message the provider scored as not spam goes through as usual.
    expect(parseInboundJson({ ...postmark(), Headers: [{ Name: 'X-Spam-Status', Value: 'No' }] }).spam).toEqual({ flagged: false, score: null });
  });

  it('turns away mail that failed its SPF check and tells the team once, but lets a soft fail through', async () => {
    const w4 = await createWorld();
    const { organizations, notifications } = await import('@/db/schema');
    const [org] = await w4.db.select().from(organizations).where(eq(organizations.id, w4.orgId));
    const bytes = Buffer.from(await renderPackage(packageFor(w4, 0, null))).toString('base64');
    const message = (id: string, spf: string) =>
      parseInboundJson({
        From: 'Maria <maria@lonestarelectric.example>',
        Subject: 'Pay app',
        MessageID: id,
        Headers: [{ Name: 'Received-SPF', Value: `${spf} (domain of lonestarelectric.example does not designate 203.0.113.9 as permitted sender) identity=mailfrom;` }],
        Attachments: [{ Name: 'payapp.pdf', ContentType: 'application/pdf', Content: bytes }],
      });
    expect(message('x', 'Fail').spf).toBe('fail');

    for (const id of ['spf-1', 'spf-2']) {
      const r = await receiveInboundEmail(w4.db, org!.intakeToken, 'test-inbound-secret', message(id, 'Fail'));
      expect(r).toMatchObject({ outcome: 'rejected', reason: expect.stringContaining('the SPF check failed') });
    }
    expect(await w4.db.select().from(payApplications).where(eq(payApplications.orgId, w4.orgId))).toHaveLength(0);
    const notes = (await w4.db.select().from(notifications).where(eq(notifications.type, 'intake.sender_rejected'))).filter((n) => n.orgId === w4.orgId);
    expect(notes.length).toBeGreaterThan(0);
    expect(new Set(notes.map((n) => n.userId)).size).toBe(notes.length); // once per person, not once per message
    expect(notes[0]!.body).toContain('may be forged');

    // A soft fail is common with forwarding and is not proof of forgery: accepted, and checked like any other sender.
    expect((await receiveInboundEmail(w4.db, org!.intakeToken, 'test-inbound-secret', message('spf-3', 'Softfail'))).outcome).toBe('accepted');
  });
});
