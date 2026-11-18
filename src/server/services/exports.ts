/**
 * File exports of approved applications.
 *
 * Every export is rendered from the immutable approved record, stored, and
 * logged as a transfer with a checksum, so what left the system can always be
 * reproduced and compared with what was approved.
 */
import { and, desc, eq, inArray } from 'drizzle-orm';
import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from 'pdf-lib';
import { centsToDecimalString, formatBps, formatMoney, percentOf } from '@/lib/money';
import { formatDate } from '@/lib/utils';
import type { DB } from '@/db';
import { locked } from '@/db/tx';
import { payApplications, transfers, users, nextVersion } from '@/db/schema';
import { recordAudit } from '@/server/audit';
import { assertCan, UserError, type Ctx } from '@/server/auth/permissions';
import { newId } from '@/server/ids';
import { getObject, putObject } from '@/server/storage';
import type { ApprovedRecord, ClaimedField } from '@/server/types';
import { CLAIMED_FIELD_LABEL, CLAIMED_FIELD_LINE, CLAIMED_FIELDS, WAIVER_TYPE_LABEL } from '@/server/types';

export type ExportKind = 'csv' | 'json' | 'pdf';

// ── CSV ─────────────────────────────────────────────────────────────────────

/** Quote as needed, and neutralise spreadsheet formula injection in text cells. A plain negative amount stays a number. */
function cell(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'number') return String(value);
  let s = value;
  if (/^[=+\-@\t\r]/.test(s) && !/^-\d+(\.\d+)?$/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
const row = (cells: Array<string | number | null | undefined>) => cells.map(cell).join(',');
const amount = (cents: number | null | undefined) => (cents === null || cents === undefined ? '' : centsToDecimalString(cents));

const LINE_COLUMNS = [
  'Project', 'Project No', 'Subcontractor', 'Contract No', 'Application No', 'Period To', 'Approved On',
  'Item No', 'Description', 'Scheduled Value', 'Previous Work', 'Work This Period', 'Stored Materials',
  'Total Completed And Stored', 'Percent Complete', 'Balance To Finish', 'Retainage', 'Adjusted By Reviewer', 'Adjustment Note',
];

/** One row per schedule-of-values line, as approved. */
export function renderLineCsv(record: ApprovedRecord): string {
  const head = [record.project.name, record.project.number, record.subcontractor.name, record.contract.number, record.application.number, record.application.periodTo, record.approvedAt.slice(0, 10)];
  const out = [LINE_COLUMNS.join(',')];
  for (const l of record.lines) {
    out.push(
      row([
        ...head,
        l.itemNo,
        l.description,
        amount(l.scheduledValue),
        amount(l.previous),
        amount(l.thisPeriod),
        amount(l.stored),
        amount(l.total),
        percentOf(l.total, l.scheduledValue)?.toFixed(1) ?? '',
        amount(l.balance),
        amount(l.retainage),
        l.adjusted ? 'Yes' : 'No',
        l.adjustmentNote,
      ]),
    );
  }
  return `${out.join('\r\n')}\r\n`;
}

const SUMMARY_COLUMNS = [
  'Project', 'Project No', 'Subcontractor', 'Contract No', 'Application No', 'Period To', 'Approved On', 'Approved By',
  'Original Contract Sum', 'Net Change Orders', 'Contract Sum To Date', 'Total Completed And Stored', 'Retainage Held',
  'Total Earned Less Retainage', 'Less Previous Certificates', 'Approved Payment', 'Requested Payment', 'Variance From Requested',
  'Balance To Finish', 'Record Id',
];

/** One row per application: the shape an accounts-payable import expects. */
export function renderSummaryCsv(records: ApprovedRecord[]): string {
  const out = [SUMMARY_COLUMNS.join(',')];
  for (const r of records) {
    const a = r.approved;
    out.push(
      row([
        r.project.name, r.project.number, r.subcontractor.name, r.contract.number, r.application.number, r.application.periodTo, r.approvedAt.slice(0, 10), r.approvedBy.name,
        amount(a.originalContractSum), amount(a.netChangeOrders), amount(a.contractSumToDate), amount(a.totalCompletedStored), amount(a.retainageTotal),
        amount(a.totalEarnedLessRetainage), amount(a.lessPreviousCertificates), amount(a.currentPaymentDue), amount(r.claimed.currentPaymentDue), amount(r.varianceFromClaimed),
        amount(a.balanceToFinish), r.application.id,
      ]),
    );
  }
  return `${out.join('\r\n')}\r\n`;
}

/** The approved record with amounts as decimal strings, for systems that want JSON. */
export function renderJson(record: ApprovedRecord): string {
  const money = (o: Record<string, unknown>, keys: string[]) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, keys.includes(k) && typeof v === 'number' ? centsToDecimalString(v) : v]));
  const fields = [...CLAIMED_FIELDS] as string[];
  return JSON.stringify(
    {
      schemaVersion: record.schemaVersion,
      currency: 'USD',
      approvedAt: record.approvedAt,
      approvedBy: record.approvedBy,
      note: record.note,
      organization: record.organization,
      project: record.project,
      subcontractor: record.subcontractor,
      contract: { ...record.contract, originalAmount: centsToDecimalString(record.contract.originalAmount) },
      application: record.application,
      requested: money(record.claimed, fields),
      approved: money(record.approved, fields),
      varianceFromRequested: record.varianceFromClaimed === null ? null : centsToDecimalString(record.varianceFromClaimed),
      lines: record.lines.map((l) => money(l, ['scheduledValue', 'previous', 'thisPeriod', 'stored', 'total', 'balance', 'retainage'])),
      changeOrders: record.changeOrders.map((c) => ({ ...c, amount: centsToDecimalString(c.amount) })),
      acceptedFindings: record.acceptedFindings,
      lienWaivers: record.waivers.map((w) => ({ ...w, amount: w.amount === null ? null : centsToDecimalString(w.amount) })),
      documents: record.documents,
    },
    null,
    2,
  );
}

// ── PDF approval record ─────────────────────────────────────────────────────

const INK = rgb(0.1, 0.1, 0.09);
const GREY = rgb(0.42, 0.42, 0.4);
const RULE = rgb(0.82, 0.82, 0.79);
const SHADE = rgb(0.955, 0.955, 0.945);

/** pdf-lib's standard fonts are WinAnsi; replace anything outside it rather than throw. */
function ansi(s: string): string {
  return s
    .replace(/[−]/g, '-')
    .replace(/[→]/g, '->')
    .replace(/[^\x09\x0a\x0d\x20-\x7e -ÿ–—‘’“”•…]/g, '?');
}

function wrapText(s: string, font: PDFFont, size: number, width: number): string[] {
  const out: string[] = [];
  for (const para of ansi(s).split('\n')) {
    let line = '';
    for (const word of para.split(/\s+/)) {
      const next = line ? `${line} ${word}` : word;
      if (font.widthOfTextAtSize(next, size) > width && line) {
        out.push(line);
        line = word;
      } else line = next;
    }
    out.push(line);
  }
  return out;
}

export async function renderApprovalPdf(record: ApprovedRecord): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.setTitle(`Approval record - ${record.subcontractor.name} - Application ${record.application.number}`);
  doc.setProducer('Zephric');
  const regular = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const W = 612;
  const H = 792;
  const L = 48;
  const R = W - 48;
  let page: PDFPage = doc.addPage([W, H]);
  let y = H - 52;

  const text = (s: string, x: number, yy: number, opts: { font?: PDFFont; size?: number; color?: ReturnType<typeof rgb> } = {}) => page.drawText(ansi(s), { x, y: yy, size: opts.size ?? 9, font: opts.font ?? regular, color: opts.color ?? INK });
  const right = (s: string, x: number, yy: number, opts: { font?: PDFFont; size?: number; color?: ReturnType<typeof rgb> } = {}) => {
    const font = opts.font ?? regular;
    const size = opts.size ?? 9;
    text(s, x - font.widthOfTextAtSize(ansi(s), size), yy, opts);
  };
  const rule = (yy: number, color = RULE, thickness = 0.6) => page.drawLine({ start: { x: L, y: yy }, end: { x: R, y: yy }, thickness, color });
  const need = (space: number) => {
    if (y - space < 60) {
      page = doc.addPage([W, H]);
      y = H - 52;
    }
  };
  const heading = (s: string) => {
    need(40);
    y -= 10;
    text(s.toUpperCase(), L, y, { font: bold, size: 7.5, color: GREY });
    y -= 6;
    rule(y);
    y -= 14;
  };

  // Title block
  text('Payment application approval record', L, y, { font: bold, size: 15 });
  y -= 16;
  text(record.organization.name, L, y, { size: 9.5, color: GREY });
  y -= 22;

  const meta: Array<[string, string]> = [
    ['Subcontractor', record.subcontractor.name],
    ['Project', `${record.project.name}${record.project.number ? ` (${record.project.number})` : ''}`],
    ['Subcontract', `${record.contract.number} - ${record.contract.title}`],
    ['Application', `#${record.application.number}, period to ${formatDate(record.application.periodTo)}`],
    ['Approved by', `${record.approvedBy.name} on ${formatDate(record.approvedAt.slice(0, 10))}`],
    ['Retainage terms', `${formatBps(record.contract.retainageWorkBps)} on completed work, ${formatBps(record.contract.retainageStoredBps)} on stored material`],
  ];
  for (const [k, v] of meta) {
    text(k, L, y, { color: GREY, size: 8.5 });
    text(v, L + 96, y, { size: 9.5 });
    y -= 14;
  }
  y -= 6;

  // The decision
  page.drawRectangle({ x: L, y: y - 40, width: R - L, height: 46, color: SHADE });
  text('APPROVED FOR PAYMENT', L + 12, y - 12, { font: bold, size: 7.5, color: GREY });
  text(formatMoney(record.approved.currentPaymentDue), L + 12, y - 30, { font: bold, size: 16 });
  if (record.varianceFromClaimed) {
    right(`Requested ${formatMoney(record.claimed.currentPaymentDue)}`, R - 12, y - 14, { size: 9, color: GREY });
    right(`${formatMoney(Math.abs(record.varianceFromClaimed))} ${record.varianceFromClaimed < 0 ? 'less' : 'more'} than requested`, R - 12, y - 28, { font: bold, size: 9 });
  } else {
    right('Equal to the amount requested', R - 12, y - 22, { size: 9, color: GREY });
  }
  y -= 58;
  if (record.note) {
    for (const line of wrapText(`Approver's note: ${record.note}`, regular, 9, R - L)) {
      text(line, L, y, { size: 9 });
      y -= 12;
    }
    y -= 4;
  }

  // Summary: requested vs approved
  heading('Application summary');
  text('Line', L, y, { font: bold, size: 8 });
  right('As submitted', R - 200, y, { font: bold, size: 8 });
  right('Approved', R - 100, y, { font: bold, size: 8 });
  right('Difference', R, y, { font: bold, size: 8 });
  y -= 13;
  for (const field of CLAIMED_FIELDS as readonly ClaimedField[]) {
    const submitted = record.claimed[field];
    const approved = record.approved[field];
    const diff = submitted === null ? null : approved - submitted;
    const emphasise = field === 'currentPaymentDue';
    text(`${CLAIMED_FIELD_LINE[field]}.`, L, y, { size: 8.5, color: GREY });
    text(CLAIMED_FIELD_LABEL[field], L + 22, y, { font: emphasise ? bold : regular });
    right(submitted === null ? '-' : formatMoney(submitted), R - 200, y, { color: GREY });
    right(formatMoney(approved), R - 100, y, { font: emphasise ? bold : regular });
    right(diff === null || diff === 0 ? '-' : formatMoney(diff), R, y, { color: diff ? INK : GREY });
    y -= 13.5;
  }

  // Findings accepted
  heading('Findings accepted at approval');
  if (record.acceptedFindings.length === 0) {
    text('None. Every check passed.', L, y, { color: GREY });
    y -= 14;
  } else {
    for (const f of record.acceptedFindings) {
      const lines = wrapText(`${f.severity === 'blocking' ? 'Override' : 'Accepted'}: ${f.title}`, bold, 9, R - L);
      const noteLines = wrapText(`${f.note ?? 'No note'}${f.by ? ` (${f.by}${f.at ? `, ${formatDate(f.at.slice(0, 10))}` : ''})` : ''}`, regular, 8.5, R - L - 10);
      need(lines.length * 12 + noteLines.length * 11 + 6);
      for (const l of lines) {
        text(l, L, y, { font: bold });
        y -= 12;
      }
      for (const l of noteLines) {
        text(l, L + 10, y, { size: 8.5, color: GREY });
        y -= 11;
      }
      y -= 4;
    }
  }

  // Line items
  heading('Schedule of values as approved');
  // Seven right-aligned amount columns of equal width, ending at the right margin.
  const firstEdge = L + 204;
  const edges = Array.from({ length: 7 }, (_, i) => firstEdge + ((R - firstEdge) / 6) * i);
  const tableHeader = () => {
    text('Item', L, y, { font: bold, size: 7.5 });
    text('Description', L + 28, y, { font: bold, size: 7.5 });
    ['Scheduled', 'Previous', 'This period', 'Stored', 'Total', 'Balance', 'Retainage'].forEach((h, i) => right(h, edges[i]!, y, { font: bold, size: 7.5 }));
    y -= 5;
    rule(y);
    y -= 11;
  };
  tableHeader();
  const m = (c: number) => formatMoney(c, { symbol: false });
  for (const l of record.lines) {
    if (y < 72) {
      page = doc.addPage([W, H]);
      y = H - 52;
      tableHeader();
    }
    text(l.itemNo ?? '', L, y, { size: 7.5 });
    const desc = wrapText(`${l.description ?? ''}${l.adjusted ? ' *' : ''}`, regular, 7.5, 116)[0] ?? '';
    text(desc, L + 28, y, { size: 7.5 });
    [l.scheduledValue, l.previous, l.thisPeriod, l.stored, l.total, l.balance, l.retainage].forEach((v, i) => right(m(v), edges[i]!, y, { size: 7.5 }));
    y -= 12;
  }
  rule(y + 4, INK, 0.8);
  y -= 8;
  const sum = (k: 'scheduledValue' | 'previous' | 'thisPeriod' | 'stored' | 'total' | 'balance' | 'retainage') => record.lines.reduce((a, l) => a + l[k], 0);
  text('Total', L + 28, y, { font: bold, size: 7.5 });
  (['scheduledValue', 'previous', 'thisPeriod', 'stored', 'total', 'balance'] as const).forEach((k, i) => right(m(sum(k)), edges[i]!, y, { font: bold, size: 7.5 }));
  right(m(record.approved.retainageTotal), edges[6]!, y, { font: bold, size: 7.5 });
  y -= 14;
  const adjusted = record.lines.filter((l) => l.adjusted);
  for (const l of adjusted) {
    for (const line of wrapText(`* ${l.itemNo ?? ''} ${l.description ?? ''}: adjusted by reviewer. ${l.adjustmentNote ?? ''}`, regular, 8, R - L)) {
      need(12);
      text(line, L, y, { size: 8, color: GREY });
      y -= 11;
    }
  }

  // Waivers and documents
  heading('Lien waivers on file (pre-screened, not a legal determination)');
  if (record.waivers.length === 0) {
    text('None.', L, y, { color: GREY });
    y -= 14;
  }
  for (const w of record.waivers) {
    need(14);
    text(`${WAIVER_TYPE_LABEL[w.type]}: ${w.amount === null ? 'amount not stated' : formatMoney(w.amount)}${w.throughDate ? `, through ${formatDate(w.throughDate)}` : ''}${w.signed ? `, signed: ${w.signed}` : ''}`, L, y);
    y -= 13;
  }
  heading('Source documents');
  for (const d of record.documents) {
    need(24);
    text(`${d.filename}${d.pages ? ` (${d.pages} page${d.pages === 1 ? '' : 's'})` : ''}`, L, y);
    y -= 11;
    text(`SHA-256 ${d.sha256}`, L + 10, y, { size: 7, color: GREY });
    y -= 14;
  }

  const pages = doc.getPages();
  pages.forEach((p, i) => {
    p.drawText(ansi(`Record ${record.application.id} - generated from the approved record of ${record.approvedAt}`), { x: L, y: 30, size: 7, font: regular, color: GREY });
    const label = `Page ${i + 1} of ${pages.length}`;
    p.drawText(label, { x: R - regular.widthOfTextAtSize(label, 7), y: 30, size: 7, font: regular, color: GREY });
  });
  return doc.save();
}

// ── Creating and listing transfers ──────────────────────────────────────────

const CONTENT_TYPE: Record<ExportKind, string> = { csv: 'text/csv; charset=utf-8', json: 'application/json', pdf: 'application/pdf' };
const slug = (s: string) => s.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);

async function approvedApps(db: DB, ctx: Ctx, ids: string[]) {
  if (ids.length === 0) throw new UserError('Choose at least one approved application.');
  const rows = await db.select().from(payApplications).where(and(eq(payApplications.orgId, ctx.orgId), inArray(payApplications.id, ids)));
  if (rows.length !== new Set(ids).size) throw new UserError('Application not found.');
  const notApproved = rows.find((r) => r.status !== 'approved' || !r.approvedRecord);
  if (notApproved) throw new UserError('Only approved applications can be exported.');
  return rows.sort((a, b) => (a.decidedAt?.getTime() ?? 0) - (b.decidedAt?.getTime() ?? 0));
}

async function recordTransfers(db: DB, ctx: Ctx, apps: Array<typeof payApplications.$inferSelect>, kind: ExportKind, filename: string, bytes: Uint8Array, at: Date): Promise<string[]> {
  const stored = await putObject(ctx.orgId, 'exports', bytes);
  const ids: string[] = [];
  for (const app of apps) {
    const id = newId('trf');
    ids.push(id);
    await db.insert(transfers).values({ id, orgId: ctx.orgId, payApplicationId: app.id, kind, status: 'completed', filename, storageKey: stored.key, sha256: stored.sha256, createdBy: ctx.userId, createdAt: at });
    if (app.transferStatus === 'none' || app.transferStatus === 'failed') await db.update(payApplications).set({ version: nextVersion, transferStatus: 'exported', updatedAt: at }).where(eq(payApplications.id, app.id));
    await recordAudit(db, {
      orgId: ctx.orgId,
      actor: ctx,
      action: 'transfer.exported',
      entityType: 'pay_application',
      entityId: app.id,
      payApplicationId: app.id,
      summary: `Exported ${kind.toUpperCase()} “${filename}” for application #${app.applicationNumber} (${formatMoney(app.approvedAmount)})`,
      data: { kind, filename, sha256: stored.sha256, batch: apps.length > 1 ? apps.length : undefined },
      at,
    });
  }
  return ids;
}

/** Export one approved application in the chosen format. */
export const createExport = locked(async function createExport(db: DB, ctx: Ctx, appId: string, kind: ExportKind, opts: { now?: Date } = {}): Promise<{ transferId: string; filename: string }> {
  assertCan(ctx, 'export:run');
  const [app] = await approvedApps(db, ctx, [appId]);
  const record = app!.approvedRecord!;
  const base = `${slug(record.subcontractor.name)}-app-${record.application.number}-${record.application.periodTo}`;
  const bytes = kind === 'csv' ? new TextEncoder().encode(renderLineCsv(record)) : kind === 'json' ? new TextEncoder().encode(renderJson(record)) : await renderApprovalPdf(record);
  const filename = `${base}${kind === 'pdf' ? '-approval-record' : kind === 'csv' ? '-lines' : ''}.${kind}`;
  const [transferId] = await recordTransfers(db, ctx, [app!], kind, filename, bytes, opts.now ?? new Date());
  return { transferId: transferId!, filename };
});

/** Export several approved applications as one accounts-payable summary CSV. */
export const createBatchExport = locked(async function createBatchExport(db: DB, ctx: Ctx, appIds: string[], opts: { now?: Date } = {}): Promise<{ transferId: string; filename: string; count: number }> {
  assertCan(ctx, 'export:run');
  const apps = await approvedApps(db, ctx, appIds);
  const at = opts.now ?? new Date();
  const filename = `approved-applications-${at.toISOString().slice(0, 10)}-${apps.length}.csv`;
  const bytes = new TextEncoder().encode(renderSummaryCsv(apps.map((a) => a.approvedRecord!)));
  const ids = await recordTransfers(db, ctx, apps, 'csv', filename, bytes, at);
  return { transferId: ids[0]!, filename, count: apps.length };
});

export async function getTransferFile(db: DB, ctx: Ctx, transferId: string): Promise<{ filename: string; contentType: string; bytes: Buffer }> {
  const [t] = await db.select().from(transfers).where(and(eq(transfers.orgId, ctx.orgId), eq(transfers.id, transferId)));
  if (!t || !t.storageKey || !t.filename) throw new UserError('That export is not available.');
  return { filename: t.filename, contentType: CONTENT_TYPE[t.kind as ExportKind] ?? 'application/octet-stream', bytes: await getObject(t.storageKey) };
}

export async function listTransfers(db: DB, ctx: Ctx, limit = 200) {
  return db
    .select({
      id: transfers.id,
      kind: transfers.kind,
      status: transfers.status,
      filename: transfers.filename,
      externalRef: transfers.externalRef,
      error: transfers.error,
      sha256: transfers.sha256,
      createdAt: transfers.createdAt,
      userName: users.name,
      applicationId: payApplications.id,
      applicationNumber: payApplications.applicationNumber,
      approvedAmount: payApplications.approvedAmount,
      record: payApplications.approvedRecord,
    })
    .from(transfers)
    .innerJoin(payApplications, eq(payApplications.id, transfers.payApplicationId))
    .leftJoin(users, eq(users.id, transfers.createdBy))
    .where(eq(transfers.orgId, ctx.orgId))
    .orderBy(desc(transfers.createdAt))
    .limit(limit);
}

/** Approved applications that have not left the system yet. */
export async function listAwaitingTransfer(db: DB, ctx: Ctx) {
  const rows = await db
    .select({ id: payApplications.id, applicationNumber: payApplications.applicationNumber, periodTo: payApplications.periodTo, approvedAmount: payApplications.approvedAmount, decidedAt: payApplications.decidedAt, transferStatus: payApplications.transferStatus, record: payApplications.approvedRecord })
    .from(payApplications)
    .where(and(eq(payApplications.orgId, ctx.orgId), eq(payApplications.status, 'approved'), inArray(payApplications.transferStatus, ['none', 'failed'])))
    .orderBy(desc(payApplications.decidedAt));
  return rows.map((r) => ({ id: r.id, applicationNumber: r.applicationNumber, periodTo: r.periodTo, approvedAmount: r.approvedAmount, decidedAt: r.decidedAt, transferStatus: r.transferStatus, subcontractor: r.record?.subcontractor.name ?? '', project: r.record?.project.name ?? '', approvedBy: r.record?.approvedBy.name ?? '' }));
}

/** The CSV helpers, for other reports built from approved records. */
export { row as csvRow, amount as csvAmount, ansi as pdfText, wrapText as pdfWrap };
