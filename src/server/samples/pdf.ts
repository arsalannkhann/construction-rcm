/**
 * Renders subcontractor billing documents as real PDFs: an application and
 * certificate for payment, its continuation sheet, and a lien waiver on the
 * Texas, California or Florida statutory wording (or a non-statutory one).
 *
 * Used for the demo workspace, the downloadable sample packages and the test
 * suite. Everything downstream (storage, text extraction, reconciliation)
 * treats these exactly like a file a subcontractor emailed in.
 *
 * The renderer prints whatever numbers it is given — including wrong ones.
 * That is the point: discrepancies in sample packages are in the documents.
 */
import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from 'pdf-lib';
import { formatBps, formatMoney } from '@/lib/money';
import type { ClaimedHeader, WaiverType } from '@/server/types';

export type SampleLine = {
  itemNo: string;
  description: string;
  scheduledValue: number;
  previous: number;
  thisPeriod: number;
  stored: number;
  total: number;
  balance: number;
  retainage: number;
};

export type SampleWaiver = {
  /** Which wording to print. `generic` is a non-statutory one-paragraph waiver. */
  form: 'TX' | 'CA' | 'FL' | 'generic';
  type: Exclude<WaiverType, 'unknown'>;
  amount: number | null;
  throughDate: string | null;
  claimant: string;
  signed: boolean;
  exceptions?: string | null;
};

export type SamplePackage = {
  gc: { name: string; address: string };
  owner: string;
  project: { name: string; number: string; address: string; state: string };
  sub: { name: string; address: string; signer: string; signerTitle: string };
  contract: { number: string; date: string; description: string };
  applicationNumber: number;
  applicationDate: string;
  periodTo: string;
  retainageWorkBps: number;
  retainageStoredBps: number;
  header: ClaimedHeader;
  lines: SampleLine[];
  signed: boolean;
  notarized: boolean;
  waiver: SampleWaiver | null;
};

export const INK = rgb(0.1, 0.1, 0.1);
export const GREY = rgb(0.42, 0.42, 0.42);
export const RULE = rgb(0.7, 0.7, 0.7);
export const SHADE = rgb(0.94, 0.94, 0.93);

export const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
export const longDate = (iso: string) => {
  const [y, m, d] = iso.split('-').map(Number);
  return `${MONTHS[m! - 1]} ${d}, ${y}`;
};
export const usDate = (iso: string) => {
  const [y, m, d] = iso.split('-');
  return `${m}/${d}/${y}`;
};
export const money = (n: number | null) => (n === null ? '' : formatMoney(n, { symbol: false }));

export type Fonts = { regular: PDFFont; bold: PDFFont; italic: PDFFont; script: PDFFont };

export async function fonts(doc: PDFDocument): Promise<Fonts> {
  return {
    regular: await doc.embedFont(StandardFonts.Helvetica),
    bold: await doc.embedFont(StandardFonts.HelveticaBold),
    italic: await doc.embedFont(StandardFonts.HelveticaOblique),
    script: await doc.embedFont(StandardFonts.TimesRomanItalic),
  };
}

export function text(page: PDFPage, s: string, x: number, y: number, font: PDFFont, size = 9, color = INK) {
  if (s) page.drawText(s, { x, y, size, font, color });
}
export function textRight(page: PDFPage, s: string, right: number, y: number, font: PDFFont, size = 9, color = INK) {
  if (s) page.drawText(s, { x: right - font.widthOfTextAtSize(s, size), y, size, font, color });
}
export function textCenter(page: PDFPage, s: string, cx: number, y: number, font: PDFFont, size = 9, color = INK) {
  if (s) page.drawText(s, { x: cx - font.widthOfTextAtSize(s, size) / 2, y, size, font, color });
}
export function hline(page: PDFPage, x1: number, x2: number, y: number, thickness = 0.5, color = RULE) {
  page.drawLine({ start: { x: x1, y }, end: { x: x2, y }, thickness, color });
}
export function vline(page: PDFPage, x: number, y1: number, y2: number, thickness = 0.5, color = RULE) {
  page.drawLine({ start: { x, y: y1 }, end: { x, y: y2 }, thickness, color });
}

export function wrap(s: string, font: PDFFont, size: number, width: number): string[] {
  const out: string[] = [];
  for (const para of s.split('\n')) {
    let line = '';
    for (const word of para.split(/\s+/)) {
      const next = line ? `${line} ${word}` : word;
      if (font.widthOfTextAtSize(next, size) > width && line) {
        out.push(line);
        line = word;
      } else {
        line = next;
      }
    }
    out.push(line);
  }
  return out;
}

/** Draws wrapped text and returns the y of the next line. */
export function paragraph(page: PDFPage, s: string, x: number, y: number, width: number, font: PDFFont, size = 9, leading = 1.35, color = INK): number {
  for (const line of wrap(s, font, size, width)) {
    text(page, line, x, y, font, size, color);
    y -= size * leading;
  }
  return y;
}

export function footer(page: PDFPage, f: Fonts, label: string) {
  const { width } = page.getSize();
  text(page, label, 36, 22, f.regular, 6.5, GREY);
  textRight(page, 'Sample document with fictitious parties and amounts', width - 36, 22, f.italic, 6.5, GREY);
}

export function signatureStamp(page: PDFPage, f: Fonts, x: number, y: number, name: string, title: string, date: string) {
  // A typical e-signature rendering: script name over a provenance line.
  text(page, name, x + 4, y + 9, f.script, 15, rgb(0.08, 0.16, 0.45));
  text(page, `Electronically signed by ${name}, ${title} on ${usDate(date)}`, x, y - 2, f.regular, 6.5, GREY);
}

// ── Application and certificate for payment ─────────────────────────────────

export function drawPayApplication(doc: PDFDocument, f: Fonts, p: SamplePackage, totalPages: number) {
  const page = doc.addPage([612, 792]);
  const L = 40;
  const R = 572;
  let y = 752;

  text(page, 'APPLICATION AND CERTIFICATE FOR PAYMENT', L, y, f.bold, 13);
  textRight(page, `PAGE 1 OF ${totalPages} PAGES`, R, y + 2, f.regular, 7.5, GREY);
  y -= 10;
  hline(page, L, R, y, 1, INK);
  y -= 16;

  const col2 = 240;
  const col3 = 410;
  const label = (s: string, x: number, yy: number) => text(page, s, x, yy, f.bold, 7, GREY);

  label('TO CONTRACTOR:', L, y);
  label('PROJECT:', col2, y);
  label('APPLICATION NO:', col3, y);
  text(page, String(p.applicationNumber), col3 + 82, y, f.bold, 9);
  y -= 12;
  text(page, p.gc.name, L, y, f.regular, 9);
  text(page, p.project.name, col2, y, f.regular, 9);
  label('PERIOD TO:', col3, y);
  text(page, usDate(p.periodTo), col3 + 82, y, f.regular, 9);
  y -= 11;
  const gcAddr = wrap(p.gc.address, f.regular, 8, 180);
  const prAddr = wrap(p.project.address, f.regular, 8, 160);
  text(page, gcAddr[0] ?? '', L, y, f.regular, 8, GREY);
  text(page, prAddr[0] ?? '', col2, y, f.regular, 8, GREY);
  label('APPLICATION DATE:', col3, y);
  text(page, usDate(p.applicationDate), col3 + 82, y, f.regular, 9);
  y -= 10;
  text(page, gcAddr[1] ?? '', L, y, f.regular, 8, GREY);
  text(page, prAddr[1] ?? '', col2, y, f.regular, 8, GREY);
  label('PROJECT NO:', col3, y);
  text(page, p.project.number, col3 + 82, y, f.regular, 9);
  y -= 18;

  label('FROM SUBCONTRACTOR:', L, y);
  label('OWNER:', col2, y);
  label('CONTRACT NO:', col3, y);
  text(page, p.contract.number, col3 + 82, y, f.regular, 9);
  y -= 12;
  text(page, p.sub.name, L, y, f.regular, 9);
  text(page, p.owner, col2, y, f.regular, 9);
  label('CONTRACT DATE:', col3, y);
  text(page, usDate(p.contract.date), col3 + 82, y, f.regular, 9);
  y -= 11;
  const subAddr = wrap(p.sub.address, f.regular, 8, 180);
  text(page, subAddr[0] ?? '', L, y, f.regular, 8, GREY);
  label('CONTRACT FOR:', col3, y);
  text(page, p.contract.description, col3 + 82, y, f.regular, 9);
  y -= 10;
  text(page, subAddr[1] ?? '', L, y, f.regular, 8, GREY);
  y -= 14;
  hline(page, L, R, y);
  y -= 16;

  text(page, "CONTRACTOR'S APPLICATION FOR PAYMENT", L, y, f.bold, 9.5);
  y -= 12;
  y = paragraph(page, 'Application is made for payment, as shown below, in connection with the Contract. The Continuation Sheet is attached.', L, y, R - L, f.regular, 8, 1.3, GREY);
  y -= 8;

  const amountRight = R;
  const h = p.header;
  const row = (no: string, title: string, value: number | null, opts: { bold?: boolean; indent?: number; note?: string } = {}) => {
    const font = opts.bold ? f.bold : f.regular;
    const x = L + (opts.indent ?? 0);
    text(page, no, x, y, font, 9);
    text(page, title, x + 18, y, font, 9);
    const titleEnd = x + 18 + font.widthOfTextAtSize(title, 9);
    if (opts.note) text(page, opts.note, titleEnd + 5, y, f.regular, 7, GREY);
    if (value !== null) {
      const amount = money(value);
      const amountStart = amountRight - f.regular.widthOfTextAtSize(amount, 9.5);
      const leaderStart = titleEnd + (opts.note ? f.regular.widthOfTextAtSize(opts.note, 7) + 10 : 6);
      const dollarX = amountRight - 96;
      if (leaderStart < dollarX - 6) page.drawLine({ start: { x: leaderStart, y: y + 1 }, end: { x: dollarX - 6, y: y + 1 }, thickness: 0.4, color: RULE, dashArray: [1, 2] });
      text(page, '$', dollarX, y, f.regular, 9.5);
      text(page, amount, amountStart, y, opts.bold ? f.bold : f.regular, 9.5);
    }
    y -= 17;
  };

  row('1.', 'ORIGINAL CONTRACT SUM', h.originalContractSum);
  row('2.', 'Net change by Change Orders', h.netChangeOrders);
  row('3.', 'CONTRACT SUM TO DATE', h.contractSumToDate, { note: '(Line 1 + 2)' });
  row('4.', 'TOTAL COMPLETED & STORED TO DATE', h.totalCompletedStored, { note: '(Column G on Continuation Sheet)' });
  row('5.', 'RETAINAGE:', null);
  row('a.', `${formatBps(p.retainageWorkBps)} of Completed Work`, h.retainageWork, { indent: 18, note: '(Columns D + E)' });
  row('b.', `${formatBps(p.retainageStoredBps)} of Stored Material`, h.retainageStored, { indent: 18, note: '(Column F)' });
  row('', 'Total Retainage', h.retainageTotal, { indent: 18, note: '(Lines 5a + 5b)' });
  row('6.', 'TOTAL EARNED LESS RETAINAGE', h.totalEarnedLessRetainage, { note: '(Line 4 less Line 5 Total)' });
  row('7.', 'LESS PREVIOUS CERTIFICATES FOR PAYMENT', h.lessPreviousCertificates, { note: '(Line 6 from prior Certificate)' });
  y -= 2;
  page.drawRectangle({ x: L - 4, y: y - 5, width: R - L + 8, height: 18, color: SHADE });
  row('8.', 'CURRENT PAYMENT DUE', h.currentPaymentDue, { bold: true });
  y -= 2;
  row('9.', 'BALANCE TO FINISH, INCLUDING RETAINAGE', h.balanceToFinish, { note: '(Line 3 less Line 6)' });

  y -= 6;
  hline(page, L, R, y);
  y -= 16;

  // Certification and signature
  const leftW = 300;
  let cy = y;
  cy = paragraph(
    page,
    "The undersigned Contractor certifies that to the best of the Contractor's knowledge, information and belief the Work covered by this Application for Payment has been completed in accordance with the Contract Documents, that all amounts have been paid by the Contractor for Work for which previous Certificates for Payment were issued and payments received, and that current payment shown herein is now due.",
    L,
    cy,
    leftW,
    f.regular,
    7.5,
    1.35,
    GREY,
  );
  cy -= 10;
  text(page, 'CONTRACTOR:', L, cy, f.bold, 7.5, GREY);
  text(page, p.sub.name, L + 62, cy, f.regular, 9);
  cy -= 30;
  text(page, 'By:', L, cy, f.bold, 8);
  hline(page, L + 18, L + 200, cy - 2, 0.6, INK);
  text(page, 'Date:', L + 210, cy, f.bold, 8);
  hline(page, L + 234, L + leftW, cy - 2, 0.6, INK);
  if (p.signed) {
    signatureStamp(page, f, L + 22, cy + 2, p.sub.signer, p.sub.signerTitle, p.applicationDate);
    text(page, usDate(p.applicationDate), L + 238, cy + 1, f.regular, 9);
  }

  // Notary block
  const nx = L + leftW + 24;
  let ny = y;
  text(page, 'State of:', nx, ny, f.bold, 7.5, GREY);
  text(page, p.notarized ? stateName(p.project.state) : '', nx + 40, ny, f.regular, 9);
  ny -= 14;
  text(page, 'County of:', nx, ny, f.bold, 7.5, GREY);
  text(page, p.notarized ? countyFor(p.project.state) : '', nx + 46, ny, f.regular, 9);
  ny -= 16;
  if (p.notarized) {
    ny = paragraph(page, `Subscribed and sworn to before me this ${ordinalDay(p.applicationDate)}.`, nx, ny, R - nx, f.regular, 8);
  } else {
    ny = paragraph(page, 'Subscribed and sworn to before me this ______ day of ______________, ________.', nx, ny, R - nx, f.regular, 8);
  }
  ny -= 14;
  text(page, 'Notary Public:', nx, ny, f.bold, 7.5, GREY);
  hline(page, nx + 58, R, ny - 2, 0.6, INK);
  if (p.notarized) text(page, 'Dana R. Whitfield', nx + 62, ny + 2, f.script, 13, rgb(0.08, 0.16, 0.45));
  ny -= 16;
  text(page, 'My Commission expires:', nx, ny, f.bold, 7.5, GREY);
  if (p.notarized) text(page, '03/14/2029', nx + 96, ny, f.regular, 9);

  footer(page, f, `${p.sub.name} · Application ${p.applicationNumber}`);
}

// ── Continuation sheet ──────────────────────────────────────────────────────

const SHEET_COLS: Array<{ key: string; right: number; head: string[] }> = [
  { key: 'A', right: 66, head: ['ITEM', 'NO.'] },
  { key: 'B', right: 282, head: ['DESCRIPTION OF WORK'] },
  { key: 'C', right: 350, head: ['SCHEDULED', 'VALUE'] },
  { key: 'D', right: 420, head: ['FROM PREVIOUS', 'APPLICATION', '(D + E)'] },
  { key: 'E', right: 482, head: ['THIS PERIOD'] },
  { key: 'F', right: 542, head: ['MATERIALS', 'PRESENTLY', 'STORED'] },
  { key: 'G', right: 614, head: ['TOTAL COMPLETED', 'AND STORED', 'TO DATE (D+E+F)'] },
  { key: '%', right: 646, head: ['%', '(G / C)'] },
  { key: 'H', right: 706, head: ['BALANCE', 'TO FINISH', '(C - G)'] },
  { key: 'I', right: 760, head: ['RETAINAGE'] },
];

export function drawContinuationSheets(doc: PDFDocument, f: Fonts, p: SamplePackage, firstPageNo: number, totalPages: number) {
  const perPage = 24;
  const chunks: SampleLine[][] = [];
  for (let i = 0; i < p.lines.length; i += perPage) chunks.push(p.lines.slice(i, i + perPage));
  if (chunks.length === 0) chunks.push([]);

  const cols = SHEET_COLS;
  const left = 32;
  const edges = [left, ...cols.map((c) => c.right + 4)];

  chunks.forEach((rows, index) => {
    const page = doc.addPage([792, 612]);
    let y = 574;
    text(page, 'CONTINUATION SHEET', left, y, f.bold, 13);
    textRight(page, `PAGE ${firstPageNo + index} OF ${totalPages} PAGES`, 764, y + 2, f.regular, 7.5, GREY);
    y -= 14;
    text(page, 'Application and Certificate for Payment, containing Contractor’s signed certification, is attached.', left, y, f.regular, 7.5, GREY);
    const meta: Array<[string, string]> = [
      ['APPLICATION NO:', String(p.applicationNumber)],
      ['APPLICATION DATE:', usDate(p.applicationDate)],
      ['PERIOD TO:', usDate(p.periodTo)],
      ['PROJECT NO:', p.project.number],
    ];
    let my = 574;
    for (const [k, v] of meta) {
      my -= 11;
      textRight(page, k, 690, my, f.bold, 7, GREY);
      text(page, v, 696, my, f.regular, 8.5);
    }
    y -= 12;
    text(page, `${p.project.name}  ·  ${p.sub.name}  ·  Contract ${p.contract.number}`, left, y, f.regular, 8.5);
    y = 520;

    // Header band
    const headTop = y;
    const headBottom = y - 50;
    page.drawRectangle({ x: left, y: headBottom, width: edges[edges.length - 1]! - left, height: headTop - headBottom, color: SHADE });
    text(page, 'WORK COMPLETED', (edges[3]! + edges[5]!) / 2 - f.bold.widthOfTextAtSize('WORK COMPLETED', 6.5) / 2, headTop - 9, f.bold, 6.5, GREY);
    cols.forEach((c, i) => {
      const cx = (edges[i]! + edges[i + 1]!) / 2;
      const startY = headTop - (c.key === 'D' || c.key === 'E' ? 19 : 12);
      c.head.forEach((line, n) => textCenter(page, line, cx, startY - n * 8, f.bold, 6.2, GREY));
      // Column letters, as on the standard form.
      if (c.key !== '%') textCenter(page, c.key, cx, headBottom + 4, f.bold, 7.5);
    });
    hline(page, left, edges[edges.length - 1]!, headTop, 0.8, INK);
    hline(page, left, edges[edges.length - 1]!, headBottom, 0.8, INK);
    y = headBottom - 13;

    const drawRow = (r: SampleLine | null, totals?: SampleLine) => {
      const src = r ?? totals!;
      const font = totals ? f.bold : f.regular;
      if (totals) {
        hline(page, left, edges[edges.length - 1]!, y + 10, 0.8, INK);
        text(page, 'GRAND TOTAL', edges[1]! + 4, y, f.bold, 8);
      } else {
        textCenter(page, src.itemNo, (edges[0]! + edges[1]!) / 2, y, font, 8);
        const desc = wrap(src.description, font, 8, edges[2]! - edges[1]! - 8)[0] ?? '';
        text(page, desc, edges[1]! + 4, y, font, 8);
      }
      const pct = src.scheduledValue ? `${((src.total / src.scheduledValue) * 100).toFixed(1)}%` : '';
      const cells = [money(src.scheduledValue), money(src.previous), money(src.thisPeriod), money(src.stored), money(src.total), pct, money(src.balance), money(src.retainage)];
      cells.forEach((cell, i) => textRight(page, cell, cols[i + 2]!.right, y, font, 8));
      y -= 15;
      if (!totals) hline(page, left, edges[edges.length - 1]!, y + 10, 0.3);
    };

    rows.forEach((r) => drawRow(r));

    if (index === chunks.length - 1) {
      const t = (k: keyof SampleLine) => p.lines.reduce((acc, l) => acc + (l[k] as number), 0);
      drawRow(null, {
        itemNo: '',
        description: '',
        scheduledValue: t('scheduledValue'),
        previous: t('previous'),
        thisPeriod: t('thisPeriod'),
        stored: t('stored'),
        total: t('total'),
        balance: t('balance'),
        retainage: t('retainage'),
      });
    }
    const tableBottom = y + 10;
    edges.forEach((x) => vline(page, x, headTop, tableBottom));
    hline(page, left, edges[edges.length - 1]!, tableBottom, 0.8, INK);
    footer(page, f, `${p.sub.name} · Application ${p.applicationNumber} · Continuation sheet`);
  });
  return chunks.length;
}

// ── Lien waivers ────────────────────────────────────────────────────────────

export function drawWaiver(doc: PDFDocument, f: Fonts, p: SamplePackage, w: SampleWaiver) {
  const page = doc.addPage([612, 792]);
  const L = 72;
  const W = 468;
  let y = 720;
  const amount = w.amount === null ? '____________' : formatMoney(w.amount);
  const through = w.throughDate ? longDate(w.throughDate) : '____________';
  const progress = w.type.endsWith('progress');
  const conditional = w.type.startsWith('conditional');
  const field = (label: string, value: string) => {
    text(page, label, L, y, f.bold, 9.5);
    const lx = L + f.bold.widthOfTextAtSize(label, 9.5) + 6;
    text(page, value, lx, y, f.regular, 9.5);
    hline(page, lx - 2, L + W, y - 3, 0.4);
    y -= 19;
  };
  const para = (s: string, size = 9.5, font = f.regular) => {
    y = paragraph(page, s, L, y, W, font, size, 1.45) - 8;
  };
  const title = (s: string) => {
    for (const line of wrap(s, f.bold, 13, W)) {
      textCenter(page, line, 306, y, f.bold, 13);
      y -= 17;
    }
    y -= 10;
  };
  const signBlock = (labels: { name: string; sig: string; title: string; date: string }) => {
    y -= 6;
    const signedOn = p.applicationDate;
    if (labels.date) {
      text(page, labels.date, L, y, f.bold, 9.5);
      const dx = L + f.bold.widthOfTextAtSize(labels.date, 9.5) + 6;
      hline(page, dx - 2, L + 230, y - 3, 0.4);
      if (w.signed) text(page, longDate(signedOn), dx, y, f.regular, 9.5);
      y -= 24;
    }
    if (labels.name) {
      text(page, w.claimant, L, y, f.regular, 9.5);
      hline(page, L, L + 280, y - 3, 0.4);
      text(page, labels.name, L + 288, y, f.regular, 8, GREY);
      y -= 34;
    }
    text(page, labels.sig, L, y, f.bold, 9.5);
    const sx = L + f.bold.widthOfTextAtSize(labels.sig, 9.5) + 6;
    hline(page, sx - 2, L + 320, y - 3, 0.5, INK);
    if (w.signed) signatureStamp(page, f, sx + 2, y + 2, p.sub.signer, p.sub.signerTitle, signedOn);
    y -= 26;
    text(page, labels.title, L, y, f.bold, 9.5);
    const tx = L + f.bold.widthOfTextAtSize(labels.title, 9.5) + 6;
    hline(page, tx - 2, L + 320, y - 3, 0.4);
    if (w.signed) text(page, p.sub.signerTitle, tx, y, f.regular, 9.5);
    y -= 20;
  };

  if (w.form === 'CA') {
    title(`${conditional ? 'CONDITIONAL' : 'UNCONDITIONAL'} WAIVER AND RELEASE ON ${progress ? 'PROGRESS' : 'FINAL'} PAYMENT`);
    para(
      conditional
        ? 'NOTICE: THIS DOCUMENT WAIVES THE CLAIMANT’S LIEN, STOP PAYMENT NOTICE, AND PAYMENT BOND RIGHTS EFFECTIVE ON RECEIPT OF PAYMENT. A PERSON SHOULD NOT RELY ON THIS DOCUMENT UNLESS SATISFIED THAT THE CLAIMANT HAS RECEIVED PAYMENT.'
        : 'NOTICE TO CLAIMANT: THIS DOCUMENT WAIVES AND RELEASES LIEN, STOP PAYMENT NOTICE, AND PAYMENT BOND RIGHTS UNCONDITIONALLY AND STATES THAT YOU HAVE BEEN PAID FOR GIVING UP THOSE RIGHTS. THIS DOCUMENT IS ENFORCEABLE AGAINST YOU IF YOU SIGN IT, EVEN IF YOU HAVE NOT BEEN PAID. IF YOU HAVE NOT BEEN PAID, USE A CONDITIONAL WAIVER AND RELEASE FORM.',
      8.5,
      f.bold,
    );
    text(page, 'Identifying Information', L, y, f.bold, 10.5);
    y -= 20;
    field('Name of Claimant:', w.claimant);
    field('Name of Customer:', p.gc.name);
    field('Job Location:', p.project.address);
    field('Owner:', p.owner);
    if (progress) field('Through Date:', through);
    y -= 4;
    text(page, `${conditional ? 'Conditional' : 'Unconditional'} Waiver and Release`, L, y, f.bold, 10.5);
    y -= 18;
    if (conditional) {
      para(
        `This document waives and releases lien, stop payment notice, and payment bond rights the claimant has for labor and service provided, and equipment and material delivered, to the customer on this job${progress ? ' through the Through Date of this document' : ''}. Rights based upon labor or service provided, or equipment or material delivered, pursuant to a written change order that has been fully executed by the parties prior to the date that this document is signed by the claimant, are waived and released by this document, unless listed as an Exception below. This document is effective only on the claimant’s receipt of payment from the financial institution on which the following check is drawn:`,
        9,
      );
      field('Maker of Check:', p.gc.name);
      field('Amount of Check: $', w.amount === null ? '' : money(w.amount));
      field('Check Payable to:', w.claimant);
    } else {
      para(
        `This document waives and releases lien, stop payment notice, and payment bond rights the claimant has for labor and service provided, and equipment and material delivered, to the customer on this job${progress ? ' through the Through Date of this document' : ''}. The claimant has received the following ${progress ? 'progress ' : 'final '}payment: $ ${w.amount === null ? '________' : money(w.amount)}`,
        9,
      );
    }
    y -= 4;
    text(page, 'Exceptions', L, y, f.bold, 10.5);
    y -= 18;
    para(`This document does not affect any of the following: ${progress ? '(1) Retentions. (2) Extras for which the claimant has not received payment. (3) Contract rights, including a right based on rescission, abandonment, or breach of contract, and the right to recover compensation for work not compensated by the payment.' : 'Disputed claims for extras in the amount of: $ 0.00'}`, 9);
    if (w.exceptions) para(`Additional exceptions: ${w.exceptions}`, 9);
    text(page, 'Signature', L, y, f.bold, 10.5);
    y -= 26;
    signBlock({ name: '', sig: "Claimant's Signature:", title: "Claimant's Title:", date: '' });
    text(page, 'Date of Signature:', L, y, f.bold, 9.5);
    if (w.signed) text(page, longDate(p.applicationDate), L + 92, y, f.regular, 9.5);
    hline(page, L + 90, L + 320, y - 3, 0.4);
  } else if (w.form === 'TX') {
    title(`${conditional ? 'CONDITIONAL' : 'UNCONDITIONAL'} WAIVER AND RELEASE ON ${progress ? 'PROGRESS' : 'FINAL'} PAYMENT`);
    field('Project', p.project.name);
    field('Job No.', p.project.number);
    y -= 4;
    if (conditional) {
      para(
        `On receipt by the signer of this document of a check from ${p.gc.name} (maker of check) in the sum of ${amount} payable to ${w.claimant} (payee or payees of check) and when the check has been properly endorsed and has been paid by the bank on which it is drawn, this document becomes effective to release any mechanic’s lien right, any right arising from a payment bond that complies with a state or federal statute, any common law payment bond right, any claim for payment, and any rights under any similar ordinance, rule, or statute related to claim or payment rights for persons in the signer’s position that the signer has on the property of ${p.owner} (owner) located at ${p.project.address} (location) to the following extent: ${p.contract.description} (job description).`,
      );
    } else {
      para(
        `The signer of this document has been paid and has received a progress payment in the sum of ${amount} for all labor, services, equipment, or materials furnished to the property or to ${p.gc.name} (person with whom signer contracted) on the property of ${p.owner} (owner) located at ${p.project.address} (location) to the following extent: ${p.contract.description} (job description). The signer therefore waives and releases any mechanic’s lien right, any right arising from a payment bond that complies with a state or federal statute, any common law payment bond right, any claim for payment, and any rights under any similar ordinance, rule, or statute related to claim or payment rights for persons in the signer’s position that the signer has on the above referenced project to the following extent:`,
      );
    }
    para(
      `This release covers ${progress ? 'a progress payment' : 'the final payment'} for all labor, services, equipment, or materials furnished to the property or to ${p.gc.name} (person with whom signer contracted) as indicated in the attached statement(s) or progress payment request(s), except for unpaid retention, pending modifications and changes, or other items furnished.${w.exceptions ? ` Exceptions: ${w.exceptions}` : ''}`,
    );
    para('Before any recipient of this document relies on this document, the recipient should verify evidence of payment to the signer.');
    para(
      'The signer warrants that the signer has already paid or will use the funds received from this progress payment to promptly pay in full all of the signer’s laborers, subcontractors, materialmen, and suppliers for all work, materials, equipment, or services provided for or to the above referenced project in regard to the attached statement(s) or progress payment request(s).',
    );
    signBlock({ date: 'Date', name: '(Company name)', sig: 'By', title: 'Title' });
  } else if (w.form === 'FL') {
    title(`WAIVER AND RELEASE OF LIEN UPON ${progress ? 'PROGRESS' : 'FINAL'} PAYMENT`);
    y -= 6;
    para(
      progress
        ? `The undersigned lienor, in consideration of the sum of ${amount}, hereby waives and releases its lien and right to claim a lien for labor, services, or materials furnished through ${through} to ${p.gc.name} on the job of ${p.owner} to the following property:`
        : `The undersigned lienor, in consideration of the final payment in the amount of ${amount}, hereby waives and releases its lien and right to claim a lien for labor, services, or materials furnished to ${p.gc.name} on the job of ${p.owner} to the following property:`,
      10,
    );
    para(`${p.project.name}, ${p.project.address}`, 10, f.bold);
    if (progress) para('This waiver and release does not cover any retention or labor, services, or materials furnished after the date specified.', 10);
    if (conditional) para('This waiver and release is conditioned upon payment of the check given in exchange for it, as permitted by section 713.20(7), Florida Statutes.', 10);
    if (w.exceptions) para(`Exceptions: ${w.exceptions}`, 10);
    y -= 10;
    text(page, w.signed ? `DATED on ${longDate(p.applicationDate)}.` : 'DATED on ______________, ________.', L, y, f.regular, 10);
    y -= 40;
    text(page, w.claimant, L, y, f.regular, 10);
    hline(page, L, L + 280, y - 3, 0.4);
    text(page, '(Lienor)', L + 288, y, f.regular, 8, GREY);
    y -= 34;
    signBlock({ date: '', name: '', sig: 'By:', title: 'Title:' });
  } else {
    title(progress ? 'PARTIAL LIEN WAIVER' : 'FINAL LIEN WAIVER');
    field('Subcontractor:', w.claimant);
    field('Project:', p.project.name);
    field('Contractor:', p.gc.name);
    field('Amount:', amount);
    field('Through:', through);
    y -= 6;
    para(
      `In consideration of the amount stated above, the undersigned ${conditional ? 'conditionally waives, upon receipt of the progress payment described,' : 'unconditionally waives'} any and all lien rights against the above project for work performed through the date stated. The undersigned certifies that all labor, materials and equipment furnished through that date have been or will be paid from the proceeds of this ${progress ? 'progress payment' : 'final payment'}.`,
      10,
    );
    if (w.exceptions) para(`Exceptions: ${w.exceptions}`, 10);
    signBlock({ date: 'Date:', name: '', sig: 'Signed:', title: 'Title:' });
  }

  footer(page, f, `${p.sub.name} · Lien waiver`);
}

// ── Public API ──────────────────────────────────────────────────────────────

export type PackagePart = 'pay_application' | 'continuation_sheet' | 'lien_waiver';

/** Render the requested parts of a billing package into one PDF. */
export async function renderPackage(p: SamplePackage, parts: PackagePart[] = ['pay_application', 'continuation_sheet', 'lien_waiver']): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.setTitle(`${p.sub.name} - Application ${p.applicationNumber}`);
  doc.setProducer('Construction RCM sample generator');
  // Fixed dates keep the bytes deterministic so identical inputs hash identically.
  const stamp = new Date(`${p.applicationDate}T12:00:00Z`);
  doc.setCreationDate(stamp);
  doc.setModificationDate(stamp);
  const f = await fonts(doc);
  const sheetPages = Math.max(1, Math.ceil(p.lines.length / 24));
  const totalPages = (parts.includes('pay_application') ? 1 : 0) + (parts.includes('continuation_sheet') ? sheetPages : 0);
  let pageNo = 1;
  if (parts.includes('pay_application')) {
    drawPayApplication(doc, f, p, totalPages);
    pageNo++;
  }
  if (parts.includes('continuation_sheet')) drawContinuationSheets(doc, f, p, pageNo, totalPages);
  if (parts.includes('lien_waiver') && p.waiver) drawWaiver(doc, f, p, p.waiver);
  return doc.save({ useObjectStreams: false });
}

/** A PDF page that is one flat image-like shape with no text layer, to exercise the "unreadable" path. */
export async function renderTextlessPdf(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([612, 792]);
  page.drawRectangle({ x: 60, y: 120, width: 492, height: 600, color: rgb(0.93, 0.93, 0.92) });
  for (let i = 0; i < 26; i++) page.drawRectangle({ x: 90, y: 680 - i * 20, width: 300 + ((i * 53) % 130), height: 5, color: rgb(0.6, 0.6, 0.6) });
  return doc.save({ useObjectStreams: false });
}

export function stateName(code: string): string {
  return ({ TX: 'Texas', CA: 'California', FL: 'Florida' } as Record<string, string>)[code] ?? code;
}
export function countyFor(code: string): string {
  return ({ TX: 'Travis', CA: 'Sacramento', FL: 'Hillsborough' } as Record<string, string>)[code] ?? '';
}
export function ordinalDay(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number);
  const suffix = d! % 10 === 1 && d !== 11 ? 'st' : d! % 10 === 2 && d !== 12 ? 'nd' : d! % 10 === 3 && d !== 13 ? 'rd' : 'th';
  return `${d}${suffix} day of ${MONTHS[m! - 1]}, ${y}`;
}
