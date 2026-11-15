import { eq } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import { auditEvents, documents, payApplications, transfers } from '@/db/schema';
import { PermissionError } from '@/server/auth/permissions';
import { readPdfText } from '@/server/documents/pdf-text';
import { renderPackage } from '@/server/samples/pdf';
import { createBatchExport, createExport, getTransferFile, listAwaitingTransfer, renderLineCsv, renderSummaryCsv } from '@/server/services/exports';
import { InboundRejected, parseInboundJson, parseInboundMime, receiveInboundEmail } from '@/server/services/inbound';
import { processApplication } from '@/server/services/intake';
import { approveApplication, reopenApplication, voidApplication } from '@/server/services/review';
import { createWorld, getApp, packageFor, stateAfter, submit, type World } from './helpers/world';

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
    await expect(receiveInboundEmail(w.db, 'not-a-token', 'test-inbound-secret', parseInboundJson(postmark()))).rejects.toMatchObject({ status: 404 });
  });

  it('turns the attachments of a provider webhook into a billing package', async () => {
    const result = await receiveInboundEmail(w.db, token, 'test-inbound-secret', parseInboundJson(postmark()));
    expect(result.files).toEqual(['PayApp-01.pdf']);
    expect(result.ignored).toEqual(['logo.png']); // signature images are not billing documents

    const app = await getApp(w, result.id);
    expect(app).toMatchObject({ status: 'processing', receivedVia: 'email', senderEmail: 'billing@lonestarelectric.example', submittedBy: null, orgId: w.orgId });
    await processApplication(w.db, w.orgId, result.id);
    const processed = await getApp(w, result.id);
    expect(processed).toMatchObject({ status: 'needs_review', contractId: w.contractId, applicationNumber: 1, openBlocking: 0 });
    const docs = await w.db.select().from(documents).where(eq(documents.payApplicationId, result.id));
    expect(docs).toHaveLength(1);
    expect(docs[0]).toMatchObject({ source: 'email', filename: 'PayApp-01.pdf' });
  });

  it('accepts a raw message as well', async () => {
    const boundary = 'b0undary';
    const eml = [
      'From: "Maria Alvarez" <billing@lonestarelectric.example>',
      'To: intake@example.test',
      'Subject: Pay application',
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
    expect(message.attachments).toHaveLength(1);
    expect(message.attachments[0]!.bytes.byteLength).toBe(pdf.byteLength);
  });

  it('refuses a message with nothing to process', async () => {
    const empty = parseInboundJson({ From: 'a@b.example', Subject: 'hello', Attachments: [] });
    await expect(receiveInboundEmail(w.db, token, 'test-inbound-secret', empty)).rejects.toBeInstanceOf(InboundRejected);
    await expect(receiveInboundEmail(w.db, token, 'test-inbound-secret', empty)).rejects.toMatchObject({ status: 422 });
    expect(() => parseInboundJson('nope')).toThrow(InboundRejected);
  });
});
