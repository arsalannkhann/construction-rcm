/**
 * The owner application as a PDF: a summary page laid out like a G702
 * (application and certificate for payment) and continuation sheets laid out
 * like a G703. Rendered from the submitted record, so the file always matches
 * what was frozen; a draft is rendered from the figures as they stand and
 * marked as a draft on every page.
 *
 * This is the main contractor's document for the owner, so it carries none of
 * our internal checks or sources. It is not an AIA document and carries no AIA
 * wording; it uses the industry's standard line numbers and column letters.
 */
import { PDFDocument, StandardFonts, degrees, rgb, type PDFFont, type PDFPage } from 'pdf-lib';
import { formatBps, formatMoney, sum } from '@/lib/money';
import { formatDate } from '@/lib/utils';
import type { ClaimedField, OwnerApplicationRecord } from '@/server/types';
import { CLAIMED_FIELD_LABEL, CLAIMED_FIELD_LINE } from '@/server/types';
import { pdfText as ansi, pdfWrap as wrapText } from './exports';

const INK = rgb(0.1, 0.1, 0.09);
const GREY = rgb(0.42, 0.42, 0.4);
const RULE = rgb(0.82, 0.82, 0.79);
const SHADE = rgb(0.955, 0.955, 0.945);
const WATERMARK = rgb(0.86, 0.86, 0.84);

type Pen = { font?: PDFFont; size?: number; color?: ReturnType<typeof rgb> };

export async function renderOwnerApplicationPdf(record: OwnerApplicationRecord, opts: { draft?: boolean } = {}): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.setTitle(`Application for payment ${record.application.number} - ${record.project.name}`);
  doc.setProducer('Zephric');
  const regular = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const h = record.header;
  const m = (c: number) => formatMoney(c, { symbol: false });

  const draw = (page: PDFPage) => {
    const text = (s: string, x: number, y: number, pen: Pen = {}) => page.drawText(ansi(s), { x, y, size: pen.size ?? 9, font: pen.font ?? regular, color: pen.color ?? INK });
    const right = (s: string, x: number, y: number, pen: Pen = {}) => text(s, x - (pen.font ?? regular).widthOfTextAtSize(ansi(s), pen.size ?? 9), y, pen);
    const rule = (x1: number, x2: number, y: number, color = RULE, thickness = 0.6) => page.drawLine({ start: { x: x1, y }, end: { x: x2, y }, thickness, color });
    return { text, right, rule };
  };

  // ── Summary page (portrait) ──
  {
    const W = 612;
    const H = 792;
    const L = 48;
    const R = W - 48;
    const page = doc.addPage([W, H]);
    const { text, right, rule } = draw(page);
    let y = H - 54;
    text('Application for Payment', L, y, { font: bold, size: 16 });
    right(`Application No. ${record.application.number}`, R, y + 2, { font: bold, size: 11 });
    y -= 16;
    text(record.organization.name, L, y, { size: 10, color: GREY });
    right(`Period to ${formatDate(record.application.periodTo)}`, R, y, { size: 10 });
    y -= 26;

    const location = [record.project.address, record.project.city, record.project.state].filter(Boolean).join(', ');
    const facts: Array<[string, string]> = [
      ['To (owner)', record.project.ownerName ?? '—'],
      ['From (contractor)', record.organization.name],
      ['Project', `${record.project.name}${record.project.number ? ` (No. ${record.project.number})` : ''}`],
      ['Project address', location || '—'],
      ['Contract', `${record.primeContract.number ? `No. ${record.primeContract.number}` : 'No number on file'}${record.primeContract.executedOn ? `, dated ${formatDate(record.primeContract.executedOn)}` : ''}`],
      ['Architect', record.primeContract.architectName ?? '—'],
      ['Retainage', `${formatBps(record.primeContract.retainageWorkBps)} of completed work, ${formatBps(record.primeContract.retainageStoredBps)} of stored material`],
    ];
    for (const [k, v] of facts) {
      text(k, L, y, { size: 8.5, color: GREY });
      text(v, L + 110, y, { size: 9.5 });
      y -= 14;
    }
    y -= 8;

    text('CONTRACTOR’S APPLICATION FOR PAYMENT', L, y, { font: bold, size: 7.5, color: GREY });
    y -= 6;
    rule(L, R, y);
    y -= 16;
    const rows: Array<{ field: ClaimedField; indent?: boolean; emphasise?: boolean }> = [
      { field: 'originalContractSum' },
      { field: 'netChangeOrders' },
      { field: 'contractSumToDate' },
      { field: 'totalCompletedStored' },
      { field: 'retainageWork', indent: true },
      { field: 'retainageStored', indent: true },
      { field: 'retainageTotal' },
      { field: 'totalEarnedLessRetainage' },
      { field: 'lessPreviousCertificates' },
      { field: 'currentPaymentDue', emphasise: true },
      { field: 'balanceToFinish' },
    ];
    for (const r of rows) {
      if (r.emphasise) {
        page.drawRectangle({ x: L - 4, y: y - 6, width: R - L + 8, height: 20, color: SHADE });
      }
      const pen: Pen = r.emphasise ? { font: bold, size: 10.5 } : { size: 9.5 };
      text(`${CLAIMED_FIELD_LINE[r.field]}.`, L + (r.indent ? 22 : 0), y, { size: 9, color: GREY });
      text(CLAIMED_FIELD_LABEL[r.field], L + (r.indent ? 44 : 22), y, pen);
      right(formatMoney(h[r.field]), R - (r.indent ? 90 : 0), y, pen);
      y -= r.emphasise ? 22 : 16;
    }
    y -= 6;

    // Change orders
    text('CHANGE ORDER SUMMARY', L, y, { font: bold, size: 7.5, color: GREY });
    y -= 6;
    rule(L, R, y);
    y -= 14;
    const additions = sum(record.changeOrders.filter((c) => c.amount > 0).map((c) => c.amount));
    const deductions = sum(record.changeOrders.filter((c) => c.amount < 0).map((c) => c.amount));
    text(`Approved change orders: ${record.changeOrders.length}`, L, y);
    right(`Additions ${formatMoney(additions)}`, R - 160, y);
    right(`Deductions ${formatMoney(deductions)}`, R, y);
    y -= 13;
    text('Net change by change orders', L, y, { color: GREY });
    right(formatMoney(additions + deductions), R, y, { font: bold });
    y -= 26;

    // Signatures
    const half = (R - L - 24) / 2;
    const box = (x: number, title: string, lines: string[]) => {
      page.drawRectangle({ x, y: y - 112, width: half, height: 120, borderColor: RULE, borderWidth: 0.8 });
      text(title, x + 10, y - 8, { font: bold, size: 7.5, color: GREY });
      let yy = y - 30;
      for (const l of lines) {
        text(l, x + 10, yy, { size: 8.5, color: GREY });
        page.drawLine({ start: { x: x + 90, y: yy - 2 }, end: { x: x + half - 10, y: yy - 2 }, thickness: 0.5, color: RULE });
        yy -= 22;
      }
    };
    box(L, 'CONTRACTOR', ['Signed', 'Name and title', 'Date', 'Notarised (if required)']);
    box(L + half + 24, 'CERTIFIED FOR PAYMENT (OWNER OR ARCHITECT)', ['Amount certified', 'Signed', 'Name and title', 'Date']);
    y -= 132;
    for (const line of wrapText('If the amount certified differs from the amount applied for, attach an explanation and initial the figures on this page and the continuation sheets that were changed.', regular, 8, R - L)) {
      text(line, L, y, { size: 8, color: GREY });
      y -= 11;
    }
  }

  // ── Continuation sheets (landscape) ──
  {
    const W = 792;
    const H = 612;
    const L = 36;
    const R = W - 36;
    // Column right edges for C..I and the percent column, laid out from the right margin so
    // amounts up to $99,999,999.99 fit with room between them. Labels go on two lines.
    const MONEY = 62;
    const PCT = 38;
    const spec: Array<{ key: string; label: [string, string]; width: number }> = [
      { key: 'C', label: ['Scheduled', 'value'], width: MONEY },
      { key: 'D', label: ['From', 'previous'], width: MONEY },
      { key: 'E', label: ['This', 'period'], width: MONEY },
      { key: 'F', label: ['Stored', 'now'], width: MONEY },
      { key: 'G', label: ['Completed', 'and stored'], width: MONEY },
      { key: '%', label: ['G ÷ C', ''], width: PCT },
      { key: 'H', label: ['Balance', 'to finish'], width: MONEY },
      { key: 'I', label: ['Retainage', ''], width: MONEY },
    ];
    const cols: Array<{ key: string; label: [string, string]; edge: number }> = [];
    {
      let edge = R;
      for (const c of [...spec].reverse()) {
        cols.unshift({ key: c.key, label: c.label, edge });
        edge -= c.width;
      }
    }
    // The description runs from its column to just short of where the first amount can reach.
    const DESC_X = L + 40;
    const DESC_W = cols[0]!.edge - MONEY - 6 - DESC_X;
    const LINE = 9;
    let page: PDFPage;
    let y = 0;
    let pen = draw(doc.addPage([W, H]));
    page = doc.getPages()[doc.getPageCount() - 1]!;
    const header = (first: boolean) => {
      y = H - 44;
      pen.text(first ? 'Continuation Sheet' : 'Continuation Sheet (continued)', L, y, { font: bold, size: 13 });
      pen.right(`Application No. ${record.application.number} · Period to ${formatDate(record.application.periodTo)}`, R, y + 1, { size: 9.5 });
      y -= 14;
      pen.text(`${record.project.name}${record.project.number ? ` (No. ${record.project.number})` : ''} · ${record.organization.name}`, L, y, { size: 9, color: GREY });
      y -= 20;
      pen.text('A', L, y, { font: bold, size: 7, color: GREY });
      pen.text('B', DESC_X, y, { font: bold, size: 7, color: GREY });
      for (const c of cols) pen.right(c.key, c.edge, y, { font: bold, size: 7, color: GREY });
      y -= 10;
      for (const c of cols) pen.right(c.label[0], c.edge, y, { font: bold, size: 7 });
      y -= 9;
      pen.text('Item', L, y, { font: bold, size: 7.5 });
      pen.text('Description of work', DESC_X, y, { font: bold, size: 7.5 });
      for (const c of cols) if (c.label[1]) pen.right(c.label[1], c.edge, y, { font: bold, size: 7 });
      y -= 6;
      pen.rule(L, R, y, INK, 0.8);
      y -= 12;
    };
    header(true);
    for (const l of record.lines) {
      // Up to three lines of description; anything longer is cut with an ellipsis.
      let desc = wrapText(`${l.description}${l.changeOrderNumber ? ' (change order)' : ''}`, regular, 7.5, DESC_W);
      if (desc.length > 3) desc = [...desc.slice(0, 2), `${desc[2]!.replace(/\s*\S*$/, '')}...`];
      if (y - (desc.length - 1) * LINE < 64) {
        page = doc.addPage([W, H]);
        pen = draw(page);
        header(false);
      }
      pen.text(l.itemNo, L, y, { size: 7.5 });
      desc.forEach((d, i) => pen.text(d, DESC_X, y - i * LINE, { size: 7.5 }));
      const values = [m(l.scheduledValue), m(l.previous), m(l.thisPeriod), m(l.stored), m(l.total), l.percent === null ? '-' : `${l.percent}%`, m(l.balance), m(l.retainage)];
      cols.forEach((c, i) => pen.right(values[i]!, c.edge, y, { size: 7.5 }));
      y -= (desc.length - 1) * LINE + 4;
      pen.rule(L, R, y);
      y -= 9;
    }
    if (y < 64) {
      page = doc.addPage([W, H]);
      pen = draw(page);
      header(false);
    }
    y -= 2;
    const total = (k: 'scheduledValue' | 'previous' | 'thisPeriod' | 'stored' | 'total' | 'balance' | 'retainage') => sum(record.lines.map((l) => l[k]));
    const grand = total('scheduledValue');
    const totals = [m(grand), m(total('previous')), m(total('thisPeriod')), m(total('stored')), m(total('total')), grand ? `${Math.round((total('total') / grand) * 1000) / 10}%` : '-', m(total('balance')), m(total('retainage'))];
    pen.text('Grand total', DESC_X, y, { font: bold, size: 7.5 });
    cols.forEach((c, i) => pen.right(totals[i]!, c.edge, y, { font: bold, size: 7.5 }));
    y -= 6;
    pen.rule(L, R, y, INK, 0.8);
  }

  const pages = doc.getPages();
  // Times are stated in UTC: the PDF has no reader's time zone to go by.
  const at = `${formatDate(record.submittedAt.slice(0, 10))} at ${record.submittedAt.slice(11, 16)} UTC`;
  const stamp = opts.draft ? `DRAFT, not submitted. Figures as they stood on ${at}.` : `Submitted ${at} by ${record.submittedBy.name}. Record ${record.application.id}, ${record.fingerprint}.`;
  pages.forEach((p, i) => {
    const { width } = p.getSize();
    if (opts.draft) p.drawText('DRAFT', { x: width / 2 - 150, y: p.getSize().height / 2 - 60, size: 120, font: bold, color: WATERMARK, rotate: degrees(30), opacity: 0.5 });
    p.drawText(ansi(stamp), { x: 36, y: 24, size: 7, font: regular, color: GREY });
    const label = `Page ${i + 1} of ${pages.length}`;
    p.drawText(label, { x: width - 36 - regular.widthOfTextAtSize(label, 7), y: 24, size: 7, font: regular, color: GREY });
  });
  return doc.save();
}
