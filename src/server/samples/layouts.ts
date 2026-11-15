/**
 * Layout variants for the sample billing documents.
 *
 * `renderPackage` in ./pdf.ts draws one clean layout, and the demo workspace,
 * the downloadable samples and most tests depend on it staying exactly as it
 * is. Everything here is separate and opt-in: the same package data printed
 * the many other ways real subcontractors print it — reworded labels, a
 * contractor's own requisition form, schedules with reordered or extra
 * columns, wrapped descriptions, page subtotals, other amount formats, pages
 * in another order, rotated pages, and so on.
 *
 * These exist to test the document readers (see docs/extraction-evaluation.md).
 * They are still our own renderer's idea of a messy document, not real ones.
 */
import { PDFDocument, degrees, rgb, type PDFPage } from 'pdf-lib';
import { formatBps } from '@/lib/money';
import type { ClaimedField, DocType, LineAmountField, WaiverType } from '@/server/types';
import {
  GREY,
  INK,
  RULE,
  SHADE,
  countyFor,
  drawContinuationSheets,
  drawPayApplication,
  drawWaiver,
  fonts,
  footer,
  hline,
  longDate,
  ordinalDay,
  paragraph,
  signatureStamp,
  stateName,
  text,
  textCenter,
  textRight,
  usDate,
  vline,
  wrap,
  type Fonts,
  type SampleLine,
  type SamplePackage,
  type SampleWaiver,
} from './pdf';

// ── Amount formats ──────────────────────────────────────────────────────────

export type AmountFormat = {
  /** false prints whole dollars only. */
  cents: boolean;
  /** `european` prints 1.234,56. */
  grouping: 'comma' | 'none' | 'european';
  negative: 'parens' | 'leading' | 'trailing';
  /** `tight` prints $1,234.56 and `spaced` prints $ 1,234.56, as one run of text. */
  dollar: 'none' | 'tight' | 'spaced';
  /** How a zero is printed in a table cell. */
  zero: 'print' | 'dash' | 'blank';
};

export const US_AMOUNTS: AmountFormat = { cents: true, grouping: 'comma', negative: 'parens', dollar: 'none', zero: 'print' };

export function formatAmount(cents: number | null, f: AmountFormat = US_AMOUNTS): string {
  if (cents === null) return '';
  if (cents === 0 && f.zero === 'blank') return '';
  if (cents === 0 && f.zero === 'dash') return '-';
  const abs = Math.abs(cents);
  if (!f.cents && abs % 100 !== 0) throw new Error(`Cannot print ${cents} cents in a whole-dollar format`);
  let digits = String(Math.floor(abs / 100));
  if (f.grouping !== 'none') digits = digits.replace(/\B(?=(\d{3})+(?!\d))/g, f.grouping === 'comma' ? ',' : '.');
  let body = f.cents ? `${digits}${f.grouping === 'european' ? ',' : '.'}${String(abs % 100).padStart(2, '0')}` : digits;
  if (f.dollar === 'tight') body = `$${body}`;
  else if (f.dollar === 'spaced') body = `$ ${body}`;
  if (cents < 0) body = f.negative === 'parens' ? `(${body})` : f.negative === 'leading' ? `-${body}` : `${body}-`;
  return body;
}

const ONES = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten', 'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen'];
const TENS = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];

function wordsUnder1000(n: number): string {
  const parts: string[] = [];
  if (n >= 100) parts.push(`${ONES[Math.floor(n / 100)]} Hundred`);
  const rest = n % 100;
  if (rest >= 20) parts.push(rest % 10 ? `${TENS[Math.floor(rest / 10)]}-${ONES[rest % 10]}` : TENS[Math.floor(rest / 10)]!);
  else if (rest > 0) parts.push(ONES[rest]!);
  return parts.join(' ');
}

/** 10350000 → "One Hundred Three Thousand Five Hundred and 00/100 Dollars", as written on cheques and waivers. */
export function amountInWords(cents: number): string {
  const dollars = Math.floor(Math.abs(cents) / 100);
  const groups: string[] = [];
  const millions = Math.floor(dollars / 1_000_000);
  const thousands = Math.floor((dollars % 1_000_000) / 1000);
  const units = dollars % 1000;
  if (millions) groups.push(`${wordsUnder1000(millions)} Million`);
  if (thousands) groups.push(`${wordsUnder1000(thousands)} Thousand`);
  if (units || groups.length === 0) groups.push(units ? wordsUnder1000(units) : 'Zero');
  return `${groups.join(' ')} and ${String(Math.abs(cents) % 100).padStart(2, '0')}/100 Dollars`;
}

export type DateStyle = 'us' | 'long' | 'iso' | 'abbrev';
const MONTH_ABBR = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function formatDate(iso: string, style: DateStyle): string {
  if (style === 'us') return usDate(iso);
  if (style === 'long') return longDate(iso);
  if (style === 'iso') return iso;
  const [y, m, d] = iso.split('-').map(Number);
  return `${MONTH_ABBR[m! - 1]} ${d}, ${y}`;
}

const firstOfMonth = (iso: string) => `${iso.slice(0, 8)}01`;

// ── Styles ──────────────────────────────────────────────────────────────────

export type G702Wording = 'aia' | 'aia_upper' | 'aia_lower' | 'alternate' | 'terse';
export type PageLabelStyle = 'pages' | 'x_of_y' | 'sheet_x_of_y' | 'none';

export type PayAppStyle = {
  /** `g702` is the numbered-lines form; `own` is a contractor's own requisition with a summary table. */
  form: 'g702' | 'own';
  wording: G702Wording;
  numbered: boolean;
  /** Print the "(Line 1 + 2)" remarks beside the labels. */
  lineNotes: boolean;
  /** Print retainage on completed work and on stored material separately (lines 5a and 5b). */
  retainageSplit: boolean;
  /** Print 5a and 5b in an inner column, left of the main amount column, as the paper form does. */
  retainageInnerColumn: boolean;
  /** Print the remark and the amount on a second line under the label. */
  amountBelowLabel: boolean;
  /** Include the change order summary table of the paper form. */
  changeOrderSummary: boolean;
  headerLabels: 'aia' | 'alternate';
  dateStyle: DateStyle;
  /** Print the billing period as "from – to" instead of a single "period to" date. */
  periodAsRange: boolean;
  amounts: AmountFormat;
  /** Print a separate "$" in front of each amount. */
  dollarSign: boolean;
  orientation: 'portrait' | 'landscape';
  pageLabel: PageLabelStyle;
};

export const G702_STYLE: PayAppStyle = {
  form: 'g702',
  wording: 'aia',
  numbered: true,
  lineNotes: true,
  retainageSplit: true,
  retainageInnerColumn: false,
  amountBelowLabel: false,
  changeOrderSummary: false,
  headerLabels: 'aia',
  dateStyle: 'us',
  periodAsRange: false,
  amounts: US_AMOUNTS,
  dollarSign: true,
  orientation: 'portrait',
  pageLabel: 'pages',
};

export type SheetColumn = 'itemNo' | 'description' | LineAmountField | 'percent' | 'originalValue' | 'changes';

export type SheetStyle = {
  title: string;
  columns: SheetColumn[];
  headings: 'aia' | 'alternate';
  /** Column letters under the headings: none, the standard form's (C = scheduled value …), or simply A, B, C … left to right. */
  letters: 'none' | 'aia' | 'positional';
  /** Wrap long descriptions over several lines; the amounts stay on the first line. */
  wrap: boolean;
  rowsPerPage: number;
  /** `page`: a subtotal of each page. `running`: a carried-forward row at the foot and a brought-forward row at the top of the next page. */
  pageSubtotals: 'none' | 'page' | 'running';
  /** Print "CONTINUED ON NEXT PAGE" at the foot of every page but the last. */
  continuedNote: boolean;
  /** Label of the grand-total row, or null to print none. */
  grandTotalLabel: string | null;
  /** Division headings, each followed by its lines and a section subtotal. `from` is the item number the section starts at. */
  sections: Array<{ title: string; from: string }>;
  pageLabel: PageLabelStyle;
  /** Print the application number, dates and project number in the page header. */
  headerMeta: boolean;
  orientation: 'landscape' | 'portrait';
  amounts: AmountFormat;
};

export const AIA_COLUMNS: SheetColumn[] = ['itemNo', 'description', 'scheduledValue', 'previous', 'thisPeriod', 'stored', 'total', 'percent', 'balance', 'retainage'];

export const G703_STYLE: SheetStyle = {
  title: 'CONTINUATION SHEET',
  columns: AIA_COLUMNS,
  headings: 'aia',
  letters: 'aia',
  wrap: false,
  rowsPerPage: 24,
  pageSubtotals: 'none',
  continuedNote: false,
  grandTotalLabel: 'GRAND TOTAL',
  sections: [],
  pageLabel: 'pages',
  headerMeta: true,
  orientation: 'landscape',
  amounts: US_AMOUNTS,
};

/** A lien waiver that follows no statutory form. */
export type CustomWaiver = {
  type: Exclude<WaiverType, 'unknown'>;
  /** Overrides the title that would be derived from `type`. */
  title?: string;
  amount: number | null;
  /** How the amount is written in the body. */
  amountStyle: 'figures' | 'words' | 'words_and_figures';
  throughDate: string | null;
  claimant: string;
  /** `esign`: an electronic signature block. `ink`: nothing in the text layer (a picture of a signature is added separately). `blank`: not signed. */
  signature: 'esign' | 'ink' | 'blank';
  /** Listed exceptions. `none_written` prints the heading with "None". null prints no exceptions section at all. */
  exceptions: string[] | 'none_written' | null;
};

export type Section =
  | { kind: 'pay_application'; pkg: SamplePackage; style?: Partial<PayAppStyle>; legacy?: boolean; group?: number }
  | { kind: 'continuation_sheet'; pkg: SamplePackage; style?: Partial<SheetStyle>; legacy?: boolean; group?: number }
  | { kind: 'lien_waiver'; pkg: SamplePackage; waiver?: SampleWaiver; custom?: CustomWaiver }
  | { kind: 'cover_letter'; pkg: SamplePackage }
  | { kind: 'invoice'; pkg: SamplePackage };

export type PageRotation = {
  /** 1-based page of the finished file. */
  page: number;
  /**
   * `flag`: the page is stored upright and carries a rotation flag, so viewers show it turned by `by` degrees clockwise.
   * `content_upright`: the content is stored turned a quarter and a rotation flag turns it back, so viewers show it upright.
   * `content_sideways`: the content is stored turned a quarter with no flag, so viewers show it sideways.
   */
  mode: 'flag' | 'content_upright' | 'content_sideways';
  by?: 90 | 180 | 270;
};

export type LayoutOptions = {
  /** 1-based pages to leave out of the finished file, as if a sheet was lost before scanning. Page labels are printed as if they were there. */
  dropPages?: number[];
  rotate?: PageRotation[];
};

/** Where something was printed, in PDF points with a bottom-left origin. `page` is 1-based in the finished file. */
export type Anchor = { page: number; x: number; y: number; w: number; h: number };

export type RenderedSection = {
  kind: Section['kind'];
  /** 1-based pages of the finished file this section occupies (dropped pages are not listed). */
  pages: number[];
  /** For a schedule: the page each line is printed on, or null if that page was dropped. Aligned with `pkg.lines`. */
  linePages?: Array<number | null>;
};

export type RenderedLayout = {
  bytes: Uint8Array;
  pageCount: number;
  /** Document type of each page of the finished file, the section it came from, and its printed "page x of y" label if it has one. */
  pages: Array<{ type: DocType; section: number; label: { number: number; of: number | null } | null }>;
  sections: RenderedSection[];
  /** Positions of printed values, keyed like `payApp.currentPaymentDue` (first pay application) or `waiver.signature`. */
  anchors: Record<string, Anchor>;
};

type Anchors = Record<string, Anchor>;

// ── Pay application: the numbered-lines form, parametrised ───────────────────

type G702Labels = Record<ClaimedField, string> & { retainage: string };

const AIA_LABELS: G702Labels = {
  originalContractSum: 'ORIGINAL CONTRACT SUM',
  netChangeOrders: 'Net change by Change Orders',
  contractSumToDate: 'CONTRACT SUM TO DATE',
  totalCompletedStored: 'TOTAL COMPLETED & STORED TO DATE',
  retainage: 'RETAINAGE:',
  retainageWork: '{pct} of Completed Work',
  retainageStored: '{pct} of Stored Material',
  retainageTotal: 'Total Retainage',
  totalEarnedLessRetainage: 'TOTAL EARNED LESS RETAINAGE',
  lessPreviousCertificates: 'LESS PREVIOUS CERTIFICATES FOR PAYMENT',
  currentPaymentDue: 'CURRENT PAYMENT DUE',
  balanceToFinish: 'BALANCE TO FINISH, INCLUDING RETAINAGE',
};

const mapLabels = (l: G702Labels, fn: (s: string) => string): G702Labels => Object.fromEntries(Object.entries(l).map(([k, v]) => [k, fn(v).replace(/\{PCT\}/i, '{pct}')])) as G702Labels;

const G702_LABELS: Record<G702Wording, G702Labels> = {
  aia: AIA_LABELS,
  aia_upper: mapLabels(AIA_LABELS, (s) => s.toUpperCase()),
  aia_lower: mapLabels(AIA_LABELS, (s) => s.toLowerCase()),
  alternate: {
    originalContractSum: 'Original Contract Amount',
    netChangeOrders: 'Approved Change Orders (Net)',
    contractSumToDate: 'Revised Contract Amount',
    totalCompletedStored: 'Total Work Completed and Materials Stored to Date',
    retainage: 'Retainage Withheld:',
    retainageWork: 'on Work Completed ({pct})',
    retainageStored: 'on Stored Materials ({pct})',
    retainageTotal: 'Total Retainage Withheld',
    totalEarnedLessRetainage: 'Total Earned to Date Less Retainage',
    lessPreviousCertificates: 'Less Previous Applications for Payment',
    currentPaymentDue: 'Amount Due This Application',
    balanceToFinish: 'Balance to Complete, Including Retainage',
  },
  terse: {
    originalContractSum: 'Contract amount',
    netChangeOrders: 'Change orders',
    contractSumToDate: 'Adjusted contract',
    totalCompletedStored: 'Completed to date',
    retainage: '',
    retainageWork: '',
    retainageStored: '',
    retainageTotal: 'Retention',
    totalEarnedLessRetainage: 'Net earned',
    lessPreviousCertificates: 'Previously billed',
    currentPaymentDue: 'Due this period',
    balanceToFinish: 'Balance remaining',
  },
};

const HEADER_LABELS = {
  aia: { to: 'TO CONTRACTOR:', project: 'PROJECT:', appNo: 'APPLICATION NO:', period: 'PERIOD TO:', appDate: 'APPLICATION DATE:', projectNo: 'PROJECT NO:', from: 'FROM SUBCONTRACTOR:', owner: 'OWNER:', contractNo: 'CONTRACT NO:', contractDate: 'CONTRACT DATE:', contractFor: 'CONTRACT FOR:' },
  alternate: { to: 'TO (GENERAL CONTRACTOR):', project: 'PROJECT NAME:', appNo: 'APPLICATION #:', period: 'PERIOD ENDING:', appDate: 'DATE OF APPLICATION:', projectNo: 'JOB NO:', from: 'FROM (SUBCONTRACTOR):', owner: 'OWNER:', contractNo: 'SUBCONTRACT NO:', contractDate: 'CONTRACT DATE:', contractFor: 'CONTRACT FOR:' },
} as const;

function pageLabelText(style: PageLabelStyle, n: number, total: number): string | null {
  if (style === 'pages') return `PAGE ${n} OF ${total} PAGES`;
  if (style === 'x_of_y') return `Page ${n} of ${total}`;
  if (style === 'sheet_x_of_y') return `Sheet ${n} of ${total}`;
  return null;
}

function drawCertification(page: PDFPage, f: Fonts, p: SamplePackage, x: number, top: number, width: number, anchors: Anchors, pageNo: number): number {
  let cy = paragraph(
    page,
    "The undersigned Contractor certifies that to the best of the Contractor's knowledge, information and belief the Work covered by this Application for Payment has been completed in accordance with the Contract Documents, that all amounts have been paid by the Contractor for Work for which previous Certificates for Payment were issued and payments received, and that current payment shown herein is now due.",
    x,
    top,
    width,
    f.regular,
    7.5,
    1.35,
    GREY,
  );
  cy -= 10;
  text(page, 'CONTRACTOR:', x, cy, f.bold, 7.5, GREY);
  text(page, p.sub.name, x + 62, cy, f.regular, 9);
  cy -= 30;
  text(page, 'By:', x, cy, f.bold, 8);
  hline(page, x + 18, x + Math.min(200, width - 100), cy - 2, 0.6, INK);
  text(page, 'Date:', x + Math.min(210, width - 90), cy, f.bold, 8);
  hline(page, x + Math.min(234, width - 66), x + width, cy - 2, 0.6, INK);
  anchors['payApp.signature'] ??= { page: pageNo, x: x + 22, y: cy, w: 150, h: 22 };
  if (p.signed) {
    signatureStamp(page, f, x + 22, cy + 2, p.sub.signer, p.sub.signerTitle, p.applicationDate);
    text(page, usDate(p.applicationDate), x + Math.min(238, width - 62), cy + 1, f.regular, 9);
  }
  return cy - 14;
}

function drawNotary(page: PDFPage, f: Fonts, p: SamplePackage, nx: number, top: number, right: number): number {
  let ny = top;
  text(page, 'State of:', nx, ny, f.bold, 7.5, GREY);
  text(page, p.notarized ? stateName(p.project.state) : '', nx + 40, ny, f.regular, 9);
  ny -= 14;
  text(page, 'County of:', nx, ny, f.bold, 7.5, GREY);
  text(page, p.notarized ? countyFor(p.project.state) : '', nx + 46, ny, f.regular, 9);
  ny -= 16;
  ny = paragraph(
    page,
    p.notarized ? `Subscribed and sworn to before me this ${ordinalDay(p.applicationDate)}.` : 'Subscribed and sworn to before me this ______ day of ______________, ________.',
    nx,
    ny,
    right - nx,
    f.regular,
    8,
  );
  ny -= 14;
  text(page, 'Notary Public:', nx, ny, f.bold, 7.5, GREY);
  hline(page, nx + 58, right, ny - 2, 0.6, INK);
  if (p.notarized) text(page, 'Dana R. Whitfield', nx + 62, ny + 2, f.script, 13, rgb(0.08, 0.16, 0.45));
  ny -= 16;
  text(page, 'My Commission expires:', nx, ny, f.bold, 7.5, GREY);
  if (p.notarized) text(page, '03/14/2029', nx + 96, ny, f.regular, 9);
  return ny - 12;
}

function drawG702Variant(doc: PDFDocument, f: Fonts, p: SamplePackage, s: PayAppStyle, label: string | null, anchors: Anchors) {
  const landscape = s.orientation === 'landscape';
  const [W, H] = landscape ? [792, 612] : [612, 792];
  const page = doc.addPage([W, H]);
  const pageNo = doc.getPageCount();
  const L = 40;
  const R = W - 40;
  let y = H - 40;
  const hl = HEADER_LABELS[s.headerLabels];
  const date = (iso: string) => formatDate(iso, s.dateStyle);

  text(page, s.headerLabels === 'aia' ? 'APPLICATION AND CERTIFICATE FOR PAYMENT' : 'APPLICATION FOR PAYMENT', L, y, f.bold, 13);
  if (label && s.pageLabel === 'pages') textRight(page, label, R, y + 2, f.regular, 7.5, GREY);
  y -= 10;
  hline(page, L, R, y, 1, INK);
  y -= 16;

  const col2 = L + 200;
  const col3 = landscape ? L + 480 : L + 362;
  const valueX = col3 + 98;
  const lab = (t: string, x: number, yy: number) => text(page, t, x, yy, f.bold, 7, GREY);

  lab(hl.to, L, y);
  lab(hl.project, col2, y);
  lab(hl.appNo, col3, y);
  text(page, String(p.applicationNumber), valueX, y, f.bold, 9);
  y -= 12;
  text(page, p.gc.name, L, y, f.regular, 9);
  text(page, p.project.name, col2, y, f.regular, 9);
  lab(s.periodAsRange ? 'BILLING PERIOD:' : hl.period, col3, y);
  text(page, s.periodAsRange ? `${date(firstOfMonth(p.periodTo))} - ${date(p.periodTo)}` : date(p.periodTo), s.periodAsRange ? col3 + 70 : valueX, y, f.regular, s.periodAsRange ? 8 : 9);
  y -= 11;
  const gcAddr = wrap(p.gc.address, f.regular, 8, 180);
  const prAddr = wrap(p.project.address, f.regular, 8, 150);
  text(page, gcAddr[0] ?? '', L, y, f.regular, 8, GREY);
  text(page, prAddr[0] ?? '', col2, y, f.regular, 8, GREY);
  lab(hl.appDate, col3, y);
  text(page, date(p.applicationDate), valueX, y, f.regular, 9);
  y -= 10;
  text(page, gcAddr[1] ?? '', L, y, f.regular, 8, GREY);
  text(page, prAddr[1] ?? '', col2, y, f.regular, 8, GREY);
  lab(hl.projectNo, col3, y);
  text(page, p.project.number, valueX, y, f.regular, 9);
  y -= 18;

  lab(hl.from, L, y);
  lab(hl.owner, col2, y);
  lab(hl.contractNo, col3, y);
  text(page, p.contract.number, valueX, y, f.regular, 9);
  y -= 12;
  text(page, p.sub.name, L, y, f.regular, 9);
  text(page, p.owner, col2, y, f.regular, 9);
  lab(hl.contractDate, col3, y);
  text(page, date(p.contract.date), valueX, y, f.regular, 9);
  y -= 11;
  const subAddr = wrap(p.sub.address, f.regular, 8, 180);
  text(page, subAddr[0] ?? '', L, y, f.regular, 8, GREY);
  lab(hl.contractFor, col3, y);
  text(page, p.contract.description, valueX, y, f.regular, 9);
  y -= 10;
  text(page, subAddr[1] ?? '', L, y, f.regular, 8, GREY);
  y -= 14;
  hline(page, L, R, y);
  y -= 16;

  const summaryTop = y;
  const amountRight = landscape ? L + 440 : R;
  text(page, "CONTRACTOR'S APPLICATION FOR PAYMENT", L, y, f.bold, 9.5);
  y -= 12;
  y = paragraph(page, 'Application is made for payment, as shown below, in connection with the Contract. The Continuation Sheet is attached.', L, y, amountRight - L, f.regular, 8, 1.3, GREY);
  y -= 8;

  const labels = G702_LABELS[s.wording];
  const rowH = landscape ? 14 : 17;
  const amounts: AmountFormat = { ...s.amounts, zero: 'print' };
  const row = (no: string, title: string, field: ClaimedField | null, opts: { bold?: boolean; indent?: number; note?: string; inner?: boolean } = {}) => {
    const font = opts.bold ? f.bold : f.regular;
    const x = L + (opts.indent ?? 0);
    const tx = s.numbered ? x + 18 : x;
    if (s.numbered) text(page, no, x, y, font, 9);
    text(page, title, tx, y, font, 9);
    const titleEnd = tx + font.widthOfTextAtSize(title, 9);
    const note = s.lineNotes ? opts.note : undefined;
    let amountY = y;
    if (note && s.amountBelowLabel) {
      y -= 10;
      amountY = y;
      text(page, note, tx, y, f.regular, 7, GREY);
    } else if (note) {
      text(page, note, titleEnd + 5, y, f.regular, 7, GREY);
    }
    const value = field ? p.header[field] : null;
    if (field && value !== null) {
      const amount = formatAmount(value, amounts);
      const right = opts.inner ? amountRight - 112 : amountRight;
      const size = 9.5;
      const amountFont = opts.bold ? f.bold : f.regular;
      const width = amountFont.widthOfTextAtSize(amount, size);
      if (s.dollarSign) text(page, '$', right - 96, amountY, f.regular, size);
      text(page, amount, right - width, amountY, amountFont, size);
      anchors[`payApp.${field}`] ??= { page: pageNo, x: right - width, y: amountY, w: width, h: size };
    }
    y -= rowH;
  };

  row('1.', labels.originalContractSum, 'originalContractSum');
  row('2.', labels.netChangeOrders, 'netChangeOrders');
  row('3.', labels.contractSumToDate, 'contractSumToDate', { note: '(Line 1 + 2)' });
  row('4.', labels.totalCompletedStored, 'totalCompletedStored', { note: '(Column G on Continuation Sheet)' });
  if (s.retainageSplit) {
    row('5.', labels.retainage, null);
    row('a.', labels.retainageWork.replace('{pct}', formatBps(p.retainageWorkBps)), 'retainageWork', { indent: 18, note: '(Columns D + E)', inner: s.retainageInnerColumn });
    row('b.', labels.retainageStored.replace('{pct}', formatBps(p.retainageStoredBps)), 'retainageStored', { indent: 18, note: '(Column F)', inner: s.retainageInnerColumn });
    row('', labels.retainageTotal, 'retainageTotal', { indent: 18, note: '(Lines 5a + 5b)' });
  } else {
    row('5.', labels.retainageTotal, 'retainageTotal', { note: `(${formatBps(p.retainageWorkBps)} of Line 4)` });
  }
  row('6.', labels.totalEarnedLessRetainage, 'totalEarnedLessRetainage', { note: '(Line 4 less Line 5 Total)' });
  row('7.', labels.lessPreviousCertificates, 'lessPreviousCertificates', { note: '(Line 6 from prior Certificate)' });
  y -= 2;
  page.drawRectangle({ x: L - 4, y: y - 5, width: amountRight - L + 8, height: rowH + 1, color: SHADE });
  row('8.', labels.currentPaymentDue, 'currentPaymentDue', { bold: true });
  y -= 2;
  row('9.', labels.balanceToFinish, 'balanceToFinish', { note: '(Line 3 less Line 6)' });

  if (s.changeOrderSummary) {
    // The change order summary of the paper form. Its last row repeats line 2.
    const net = p.header.netChangeOrders ?? 0;
    const add = Math.max(net, 0);
    const ded = Math.max(-net, 0);
    const c1 = L + 250;
    const c2 = L + 340;
    y -= 4;
    hline(page, L, c2 + 4, y + 9);
    text(page, 'CHANGE ORDER SUMMARY', L, y, f.bold, 7.5);
    textRight(page, 'ADDITIONS', c1, y, f.bold, 7);
    textRight(page, 'DEDUCTIONS', c2, y, f.bold, 7);
    const line = (t: string, a: number | null, d: number | null, bold = false) => {
      y -= 11;
      text(page, t, L, y, bold ? f.bold : f.regular, 7.5);
      if (a !== null) textRight(page, formatAmount(a, amounts), c1, y, f.regular, 7.5);
      if (d !== null) textRight(page, formatAmount(d, amounts), c2, y, f.regular, 7.5);
    };
    line('Total changes approved in previous months by Owner', add, ded);
    line('Total approved this Month', 0, 0);
    line('TOTALS', add, ded, true);
    line('NET CHANGES by Change Order', null, net, true);
    y -= 8;
  }

  if (landscape) {
    const cx = amountRight + 36;
    const after = drawCertification(page, f, p, cx, summaryTop, R - cx, anchors, pageNo);
    drawNotary(page, f, p, cx, after - 8, R);
  } else {
    y -= 6;
    hline(page, L, R, y);
    y -= 16;
    drawCertification(page, f, p, L, y, 300, anchors, pageNo);
    drawNotary(page, f, p, L + 324, y, R);
  }
  if (label && s.pageLabel !== 'pages') textCenter(page, label, W / 2, 34, f.regular, 7.5, GREY);
  footer(page, f, `${p.sub.name} · Application ${p.applicationNumber}`);
}

// ── Pay application: a contractor's own requisition form ─────────────────────

function drawOwnPayApp(doc: PDFDocument, f: Fonts, p: SamplePackage, s: PayAppStyle, label: string | null, anchors: Anchors) {
  const landscape = s.orientation === 'landscape';
  const [W, H] = landscape ? [792, 612] : [612, 792];
  const page = doc.addPage([W, H]);
  const pageNo = doc.getPageCount();
  const L = 54;
  const R = W - 54;
  let y = H - 54;
  const date = (iso: string) => formatDate(iso, s.dateStyle);
  const amounts: AmountFormat = { ...s.amounts, zero: 'print' };
  const h = p.header;

  text(page, p.sub.name.toUpperCase(), L, y, f.bold, 14);
  textRight(page, 'PAYMENT REQUISITION', R, y, f.bold, 14);
  y -= 13;
  text(page, p.sub.address, L, y, f.regular, 8.5, GREY);
  y -= 8;
  hline(page, L, R, y, 1.2, INK);
  y -= 20;

  const mid = L + (R - L) / 2 + 20;
  const pair = (k: string, v: string, x: number, yy: number, gap = 92) => {
    text(page, k, x, yy, f.bold, 8.5);
    text(page, v, x + gap, yy, f.regular, 9);
  };
  pair('Bill To:', p.gc.name, L, y, 52);
  pair('Requisition No.:', String(p.applicationNumber), mid, y);
  y -= 13;
  text(page, p.gc.address, L + 52, y, f.regular, 8, GREY);
  pair('Date:', date(p.applicationDate), mid, y);
  y -= 13;
  pair('Job:', p.project.name, L, y, 52);
  if (s.periodAsRange) pair('Billing Period:', `${date(firstOfMonth(p.periodTo))} - ${date(p.periodTo)}`, mid, y);
  else pair('Period Ending:', date(p.periodTo), mid, y);
  y -= 13;
  pair('Job No.:', p.project.number, L, y, 52);
  pair('Subcontract No.:', p.contract.number, mid, y);
  y -= 13;
  pair('Owner:', p.owner, L, y, 52);
  pair('Subcontract Date:', date(p.contract.date), mid, y);
  y -= 13;
  pair('Scope:', p.contract.description, L, y, 52);
  y -= 26;

  const tableRight = landscape ? L + 470 : R;
  const band = (title: string) => {
    page.drawRectangle({ x: L, y: y - 5, width: tableRight - L, height: 16, color: SHADE });
    text(page, title, L + 6, y, f.bold, 8.5);
    textRight(page, 'AMOUNT', tableRight - 6, y, f.bold, 8);
    y -= 20;
  };
  const line = (title: string, field: ClaimedField, bold = false) => {
    const font = bold ? f.bold : f.regular;
    text(page, title, L + 6, y, font, 9.5);
    const amount = formatAmount(h[field], amounts);
    const width = font.widthOfTextAtSize(amount, 9.5);
    if (s.dollarSign) text(page, '$', tableRight - 100, y, f.regular, 9.5);
    text(page, amount, tableRight - 6 - width, y, font, 9.5);
    anchors[`payApp.${field}`] ??= { page: pageNo, x: tableRight - 6 - width, y, w: width, h: 9.5 };
    hline(page, L, tableRight, y - 5, 0.3);
    y -= 18;
  };

  // Billing first, contract status second: the reverse of the numbered form.
  band('BILLING SUMMARY');
  line('Work completed to date', 'totalCompletedStored');
  line(`Less retention (${formatBps(p.retainageWorkBps)})`, 'retainageTotal');
  line('Net earned to date', 'totalEarnedLessRetainage');
  line('Less prior payments', 'lessPreviousCertificates');
  line('Payment requested this period', 'currentPaymentDue', true);
  y -= 10;
  band('CONTRACT STATUS');
  line('Original subcontract amount', 'originalContractSum');
  line('Approved change orders', 'netChangeOrders');
  line('Revised subcontract amount', 'contractSumToDate');
  line('Remaining balance including retention', 'balanceToFinish');
  y -= 16;

  const sx = landscape ? tableRight + 30 : L;
  let sy = landscape ? H - 190 : y;
  sy = paragraph(page, 'The undersigned certifies that the work billed above has been performed and that the amount requested is due under the subcontract.', sx, sy, landscape ? R - sx : R - L, f.regular, 8.5, 1.35, GREY);
  sy -= 30;
  text(page, 'Submitted by:', sx, sy, f.bold, 8.5);
  hline(page, sx + 64, sx + 240, sy - 2, 0.6, INK);
  anchors['payApp.signature'] ??= { page: pageNo, x: sx + 68, y: sy, w: 150, h: 22 };
  if (p.signed) signatureStamp(page, f, sx + 68, sy + 2, p.sub.signer, p.sub.signerTitle, p.applicationDate);

  if (label) textCenter(page, label, W / 2, 34, f.regular, 7.5, GREY);
  footer(page, f, `${p.sub.name} · Requisition ${p.applicationNumber}`);
}

// ── Schedule of values, parametrised ─────────────────────────────────────────

type Sums = Record<LineAmountField | 'originalValue' | 'changes', number>;
const ZERO_SUMS: Sums = { scheduledValue: 0, previous: 0, thisPeriod: 0, stored: 0, total: 0, balance: 0, retainage: 0, originalValue: 0, changes: 0 };

const isChangeOrderItem = (itemNo: string) => /^co\b|^co[-\s]?\d/i.test(itemNo);

function valuesOf(l: SampleLine): Sums {
  const co = isChangeOrderItem(l.itemNo);
  return { scheduledValue: l.scheduledValue, previous: l.previous, thisPeriod: l.thisPeriod, stored: l.stored, total: l.total, balance: l.balance, retainage: l.retainage, originalValue: co ? 0 : l.scheduledValue, changes: co ? l.scheduledValue : 0 };
}

function addSums(a: Sums, b: Sums): Sums {
  const out = { ...a };
  for (const k of Object.keys(out) as Array<keyof Sums>) out[k] = a[k] + b[k];
  return out;
}

const SHEET_HEADS: Record<SheetStyle['headings'], Record<SheetColumn, string[]>> = {
  aia: {
    itemNo: ['ITEM', 'NO.'],
    description: ['DESCRIPTION OF WORK'],
    scheduledValue: ['SCHEDULED', 'VALUE'],
    previous: ['FROM PREVIOUS', 'APPLICATION', '(D + E)'],
    thisPeriod: ['THIS PERIOD'],
    stored: ['MATERIALS', 'PRESENTLY', 'STORED'],
    total: ['TOTAL COMPLETED', 'AND STORED', 'TO DATE (D+E+F)'],
    percent: ['%', '(G / C)'],
    balance: ['BALANCE', 'TO FINISH', '(C - G)'],
    retainage: ['RETAINAGE'],
    originalValue: ['ORIGINAL', 'VALUE'],
    changes: ['APPROVED', 'CHANGES'],
  },
  alternate: {
    itemNo: ['ITEM'],
    description: ['DESCRIPTION'],
    scheduledValue: ['CONTRACT', 'VALUE'],
    previous: ['PREVIOUSLY', 'BILLED'],
    thisPeriod: ['CURRENT', 'BILLING'],
    stored: ['STORED', 'MATERIAL'],
    total: ['COMPLETED', 'TO DATE'],
    percent: ['%', 'COMPL.'],
    balance: ['BALANCE', 'REMAINING'],
    retainage: ['RETENTION'],
    originalValue: ['ORIGINAL', 'VALUE'],
    changes: ['CHANGE', 'ORDERS'],
  },
};

const AIA_LETTER: Partial<Record<SheetColumn, string>> = { itemNo: 'A', description: 'B', scheduledValue: 'C', previous: 'D', thisPeriod: 'E', stored: 'F', total: 'G', balance: 'H', retainage: 'I' };

type SheetRow =
  | { kind: 'line'; index: number; values: Sums; itemNo: string; desc: string[] }
  | { kind: 'heading'; title: string }
  | { kind: 'sum'; label: string; values: Sums }
  | { kind: 'note'; text: string };

function drawSheetVariant(doc: PDFDocument, f: Fonts, p: SamplePackage, s: SheetStyle, labelFor: (pageIndex: number, pages: number) => string | null): { pages: number; linePages: number[] } {
  const landscape = s.orientation === 'landscape';
  const [W, H] = landscape ? [792, 612] : [612, 792];
  const left = landscape ? 32 : 28;
  const size = landscape ? 8 : 7;
  const moneyCount = s.columns.filter((c) => c !== 'itemNo' && c !== 'description' && c !== 'percent').length;
  const moneyW = landscape ? (moneyCount <= 7 ? 64 : 56) : 48;
  const widthOf = (c: SheetColumn) => (c === 'itemNo' ? (landscape ? 38 : 30) : c === 'percent' ? (landscape ? 34 : 28) : c === 'description' ? 0 : moneyW);
  const descW = W - 2 * left - s.columns.reduce((a, c) => a + widthOf(c), 0);
  if (descW < 80) throw new Error('Too many columns for the page');
  let cursor = left;
  const geo = s.columns.map((key) => {
    const w = key === 'description' ? descW : widthOf(key);
    const g = { key, left: cursor, right: cursor + w };
    cursor += w;
    return g;
  });
  const tableRight = cursor;
  const amounts = s.amounts;
  const sectionStart = new Map(s.sections.map((sec) => [sec.from, sec.title]));

  // Plan the rows of every page first, so page labels can say "x of y".
  const chunks: SampleLine[][] = [];
  for (let i = 0; i < p.lines.length; i += s.rowsPerPage) chunks.push(p.lines.slice(i, i + s.rowsPerPage));
  if (chunks.length === 0) chunks.push([]);
  const grand = p.lines.reduce((a, l) => addSums(a, valuesOf(l)), ZERO_SUMS);
  const linePages: number[] = [];
  const plan: SheetRow[][] = [];
  let running = ZERO_SUMS;
  let section: { title: string; sums: Sums } | null = null;
  let lineIndex = 0;
  chunks.forEach((chunk, pi) => {
    const rows: SheetRow[] = [];
    const last = pi === chunks.length - 1;
    if (pi > 0 && s.pageSubtotals === 'running') rows.push({ kind: 'sum', label: 'BROUGHT FORWARD', values: running });
    let pageSums = ZERO_SUMS;
    chunk.forEach((l, li) => {
      const startsSection = sectionStart.get(l.itemNo);
      if (startsSection) {
        if (section) rows.push({ kind: 'sum', label: `Subtotal ${section.title}`, values: section.sums });
        section = { title: startsSection, sums: ZERO_SUMS };
        rows.push({ kind: 'heading', title: startsSection });
      }
      const desc = wrap(l.description, f.regular, size, descW - 8);
      if (desc.length > 1 && !s.wrap) throw new Error(`Description of item ${l.itemNo} does not fit on one line; use wrap`);
      const values = valuesOf(l);
      rows.push({ kind: 'line', index: lineIndex, values, itemNo: l.itemNo, desc });
      linePages[lineIndex++] = pi;
      pageSums = addSums(pageSums, values);
      if (section) section.sums = addSums(section.sums, values);
      const isLastLine = last && li === chunk.length - 1;
      if (isLastLine && section) rows.push({ kind: 'sum', label: `Subtotal ${section.title}`, values: section.sums });
    });
    running = addSums(running, pageSums);
    if (s.pageSubtotals === 'page') rows.push({ kind: 'sum', label: 'PAGE SUBTOTAL', values: pageSums });
    if (s.pageSubtotals === 'running' && !last) rows.push({ kind: 'sum', label: 'CARRIED FORWARD', values: running });
    if (!last && s.continuedNote) rows.push({ kind: 'note', text: 'CONTINUED ON NEXT PAGE' });
    if (last && s.grandTotalLabel) rows.push({ kind: 'sum', label: s.grandTotalLabel, values: grand });
    plan.push(rows);
  });

  const date = (iso: string) => usDate(iso);
  const cell = (key: SheetColumn, v: Sums, isLine: boolean): string => {
    if (key === 'itemNo' || key === 'description') return '';
    if (key === 'percent') return v.scheduledValue > 0 ? `${((v.total / v.scheduledValue) * 100).toFixed(1)}%` : '';
    // A blank or dash stands for zero only on line items; totals always print their figure.
    return formatAmount(v[key], isLine ? amounts : { ...amounts, zero: 'print' });
  };

  plan.forEach((rows, pi) => {
    const page = doc.addPage([W, H]);
    let y = H - 38;
    text(page, s.title, left, y, f.bold, 13);
    const label = labelFor(pi, plan.length);
    if (label && s.pageLabel === 'pages') textRight(page, label, W - left, y + 2, f.regular, 7.5, GREY);
    y -= 14;
    if (s.headings === 'aia') text(page, 'Application and Certificate for Payment, containing Contractor’s signed certification, is attached.', left, y, f.regular, 7.5, GREY);
    if (s.headerMeta) {
      const meta: Array<[string, string]> =
        s.headings === 'aia'
          ? [
              ['APPLICATION NO:', String(p.applicationNumber)],
              ['APPLICATION DATE:', date(p.applicationDate)],
              ['PERIOD TO:', date(p.periodTo)],
              ['PROJECT NO:', p.project.number],
            ]
          : [
              ['Application #:', String(p.applicationNumber)],
              ['Period Ending:', date(p.periodTo)],
              ['Job No.:', p.project.number],
            ];
      let my = H - 38;
      for (const [k, v] of meta) {
        my -= 11;
        textRight(page, k, W - left - 72, my, f.bold, 7, GREY);
        text(page, v, W - left - 66, my, f.regular, 8.5);
      }
    }
    y -= 12;
    text(page, `${p.project.name}  ·  ${p.sub.name}  ·  Contract ${p.contract.number}`, left, y, f.regular, 8.5);

    // Header band, repeated on every page.
    const headTop = H - 92;
    const headLines = Math.max(...s.columns.map((c) => SHEET_HEADS[s.headings][c].length));
    const headBottom = headTop - (headLines * 8 + (s.letters === 'none' ? 12 : 24));
    page.drawRectangle({ x: left, y: headBottom, width: tableRight - left, height: headTop - headBottom, color: SHADE });
    const prevIdx = s.columns.indexOf('previous');
    const thisIdx = s.columns.indexOf('thisPeriod');
    const spanning = s.headings === 'aia' && prevIdx >= 0 && Math.abs(prevIdx - thisIdx) === 1;
    if (spanning) {
      const a = geo[Math.min(prevIdx, thisIdx)]!;
      const b = geo[Math.max(prevIdx, thisIdx)]!;
      textCenter(page, 'WORK COMPLETED', (a.left + b.right) / 2, headTop - 9, f.bold, 6.5, GREY);
    }
    let letterIndex = 0;
    geo.forEach((g) => {
      const cx = (g.left + g.right) / 2;
      let head = SHEET_HEADS[s.headings][g.key];
      if (g.key === 'scheduledValue' && s.columns.includes('originalValue')) head = ['REVISED', 'VALUE'];
      const startY = headTop - (spanning && (g.key === 'previous' || g.key === 'thisPeriod') ? 19 : 12);
      head.forEach((line, n) => textCenter(page, line, cx, startY - n * 8, f.bold, 6.2, GREY));
      if (s.letters === 'aia' && AIA_LETTER[g.key]) textCenter(page, AIA_LETTER[g.key]!, cx, headBottom + 4, f.bold, 7.5);
      if (s.letters === 'positional' && g.key !== 'percent') textCenter(page, String.fromCharCode(65 + letterIndex++), cx, headBottom + 4, f.bold, 7.5);
    });
    hline(page, left, tableRight, headTop, 0.8, INK);
    hline(page, left, tableRight, headBottom, 0.8, INK);
    y = headBottom - (size + 5);

    for (const r of rows) {
      if (r.kind === 'heading') {
        text(page, r.title, geo.find((g) => g.key === 'description')!.left + 4, y, f.bold, size);
        y -= size + 7;
        continue;
      }
      if (r.kind === 'note') {
        textCenter(page, r.text, (left + tableRight) / 2, y, f.italic, size, GREY);
        y -= size + 7;
        continue;
      }
      const isLine = r.kind === 'line';
      const font = isLine ? f.regular : f.bold;
      if (!isLine) hline(page, left, tableRight, y + size + 2, r.label === s.grandTotalLabel ? 0.8 : 0.4, INK);
      for (const g of geo) {
        if (g.key === 'itemNo') {
          if (isLine) textCenter(page, r.itemNo, (g.left + g.right) / 2, y, font, size);
        } else if (g.key === 'description') {
          if (isLine) r.desc.forEach((d, n) => text(page, d, g.left + 4, y - n * (size + 1.2), font, size));
          else text(page, r.label, g.left + 4, y, font, size);
        } else {
          textRight(page, cell(g.key, r.values, isLine), g.right - 3, y, font, size);
        }
      }
      const extra = isLine ? (r.desc.length - 1) * (size + 1.2) : 0;
      y -= size + 7 + extra;
      if (isLine) hline(page, left, tableRight, y + size + 2, 0.3);
    }
    const tableBottom = y + size + 2;
    if (tableBottom < 44) throw new Error('Schedule page overflows; lower rowsPerPage');
    for (const g of geo) vline(page, g.left, headTop, tableBottom);
    vline(page, tableRight, headTop, tableBottom);
    hline(page, left, tableRight, tableBottom, 0.8, INK);
    if (label && s.pageLabel !== 'pages') textCenter(page, label, W / 2, 34, f.regular, 7.5, GREY);
    footer(page, f, `${p.sub.name} · Application ${p.applicationNumber} · Schedule of values`);
  });
  return { pages: plan.length, linePages };
}

// ── Lien waiver that follows no statutory form ───────────────────────────────

function drawCustomWaiver(doc: PDFDocument, f: Fonts, p: SamplePackage, w: CustomWaiver, anchors: Anchors) {
  const page = doc.addPage([612, 792]);
  const pageNo = doc.getPageCount();
  const L = 72;
  const W = 468;
  let y = 716;
  const progress = w.type.endsWith('progress');
  const conditional = w.type.startsWith('conditional');
  const para = (t: string, size = 10, font = f.regular) => {
    y = paragraph(page, t, L, y, W, font, size, 1.45) - 9;
  };

  textCenter(page, w.title ?? (progress ? 'PARTIAL LIEN RELEASE' : 'FINAL LIEN RELEASE'), 306, y, f.bold, 14);
  y -= 34;
  for (const [k, v] of [
    ['Project:', `${p.project.name}, ${p.project.address}`],
    ['Owner:', p.owner],
    ['General Contractor:', p.gc.name],
  ] as const) {
    text(page, k, L, y, f.bold, 9.5);
    text(page, v, L + f.bold.widthOfTextAtSize(k, 9.5) + 6, y, f.regular, 9.5);
    y -= 15;
  }
  y -= 10;

  const figures = w.amount === null ? '$____________' : formatAmount(w.amount, { ...US_AMOUNTS, dollar: 'tight' });
  const amount = w.amount === null ? figures : w.amountStyle === 'figures' ? figures : w.amountStyle === 'words' ? amountInWords(w.amount) : `${amountInWords(w.amount)} (${figures})`;
  const through = w.throughDate ? longDate(w.throughDate) : '____________';
  para(
    `The undersigned, ${w.claimant} (“Subcontractor”), ${conditional ? `upon receipt of payment in the amount of ${amount},` : `having received payment in the amount of ${amount},`} hereby ${conditional ? 'conditionally' : 'unconditionally'} waives and releases any and all liens, lien rights and claims against the Project and the Owner for labor, materials and equipment furnished through ${through}.`,
  );
  para(
    progress
      ? 'This is a partial release. It covers the progress payment described above and does not cover retention or work furnished after the date stated.'
      : 'This is a final release. It covers the final payment described above and all work furnished to the Project.',
  );
  para('The undersigned warrants that all laborers, subcontractors and suppliers have been or will be paid from the proceeds of this payment.');

  if (w.exceptions !== null) {
    text(page, 'EXCEPTIONS (if none, write “None”):', L, y, f.bold, 9.5);
    y -= 15;
    if (w.exceptions === 'none_written') {
      text(page, 'None', L + 14, y, f.regular, 10);
      y -= 15;
    } else {
      w.exceptions.forEach((e, i) => {
        y = paragraph(page, `${i + 1}. ${e}`, L + 14, y, W - 14, f.regular, 10, 1.4);
      });
    }
    y -= 12;
  }

  text(page, 'Dated:', L, y, f.bold, 9.5);
  if (w.signature !== 'blank') text(page, longDate(p.applicationDate), L + 40, y, f.regular, 9.5);
  hline(page, L + 38, L + 220, y - 3, 0.4);
  y -= 34;
  text(page, w.claimant.toUpperCase(), L, y, f.bold, 9.5);
  y -= 32;
  text(page, 'By:', L, y, f.bold, 9.5);
  hline(page, L + 20, L + 300, y - 3, 0.5, INK);
  anchors['waiver.signature'] ??= { page: pageNo, x: L + 26, y: y - 2, w: 170, h: 26 };
  if (w.signature === 'esign') signatureStamp(page, f, L + 24, y + 2, p.sub.signer, p.sub.signerTitle, p.applicationDate);
  y -= 24;
  text(page, 'Name:', L, y, f.bold, 9.5);
  if (w.signature !== 'blank') text(page, p.sub.signer, L + 40, y, f.regular, 9.5);
  hline(page, L + 38, L + 300, y - 3, 0.4);
  y -= 20;
  text(page, 'Title:', L, y, f.bold, 9.5);
  if (w.signature !== 'blank') text(page, p.sub.signerTitle, L + 40, y, f.regular, 9.5);
  hline(page, L + 38, L + 300, y - 3, 0.4);

  footer(page, f, `${p.sub.name} · Lien release`);
}

// ── Pages that are neither a pay application, a schedule nor a waiver ────────

function drawCoverLetter(doc: PDFDocument, f: Fonts, p: SamplePackage) {
  const page = doc.addPage([612, 792]);
  const L = 72;
  let y = 720;
  text(page, p.sub.name, L, y, f.bold, 12);
  y -= 14;
  text(page, p.sub.address, L, y, f.regular, 9, GREY);
  y -= 36;
  text(page, longDate(p.applicationDate), L, y, f.regular, 10);
  y -= 28;
  text(page, p.gc.name, L, y, f.regular, 10);
  y -= 14;
  text(page, p.gc.address, L, y, f.regular, 10);
  y -= 30;
  text(page, `Re: ${p.project.name} - Pay Application No. ${p.applicationNumber}`, L, y, f.bold, 10);
  y -= 26;
  y = paragraph(
    page,
    `Enclosed please find our Application for Payment No. ${p.applicationNumber} for the period ending ${longDate(p.periodTo)}, in the amount of ${formatAmount(p.header.currentPaymentDue, { ...US_AMOUNTS, dollar: 'tight' })}, together with the continuation sheet and our conditional lien waiver for this progress payment.`,
    L,
    y,
    468,
    f.regular,
    10,
    1.5,
  );
  y -= 10;
  y = paragraph(page, 'Please call our office with any questions.', L, y, 468, f.regular, 10, 1.5);
  y -= 26;
  text(page, 'Sincerely,', L, y, f.regular, 10);
  y -= 40;
  text(page, `${p.sub.signer}, ${p.sub.signerTitle}`, L, y, f.regular, 10);
  footer(page, f, `${p.sub.name} · Transmittal`);
}

function drawInvoice(doc: PDFDocument, f: Fonts, p: SamplePackage) {
  const page = doc.addPage([612, 792]);
  const L = 60;
  const R = 552;
  let y = 724;
  text(page, 'INVOICE', L, y, f.bold, 20);
  textRight(page, p.sub.name, R, y + 4, f.bold, 11);
  y -= 14;
  textRight(page, p.sub.address, R, y + 4, f.regular, 8.5, GREY);
  y -= 30;
  text(page, 'Invoice No:', L, y, f.bold, 9);
  text(page, String(1040 + p.applicationNumber), L + 70, y, f.regular, 9.5);
  text(page, 'Invoice Date:', L + 250, y, f.bold, 9);
  text(page, usDate(p.applicationDate), L + 320, y, f.regular, 9.5);
  y -= 16;
  text(page, 'Bill To:', L, y, f.bold, 9);
  text(page, p.gc.name, L + 70, y, f.regular, 9.5);
  y -= 16;
  text(page, 'Project:', L, y, f.bold, 9);
  text(page, p.project.name, L + 70, y, f.regular, 9.5);
  y -= 30;
  page.drawRectangle({ x: L, y: y - 5, width: R - L, height: 16, color: SHADE });
  text(page, 'DESCRIPTION', L + 6, y, f.bold, 8);
  textRight(page, 'AMOUNT', R - 6, y, f.bold, 8);
  y -= 22;
  const due = formatAmount(p.header.currentPaymentDue, { ...US_AMOUNTS, dollar: 'tight' });
  text(page, `Progress billing per Application No. ${p.applicationNumber}, ${p.contract.description}`, L + 6, y, f.regular, 9.5);
  textRight(page, due, R - 6, y, f.regular, 9.5);
  y -= 24;
  hline(page, L, R, y + 12);
  text(page, 'Amount Due', L + 6, y, f.bold, 10);
  textRight(page, due, R - 6, y, f.bold, 10);
  y -= 30;
  text(page, 'Terms: per subcontract.', L, y, f.regular, 9, GREY);
  footer(page, f, `${p.sub.name} · Invoice`);
}

// ── Putting a file together ─────────────────────────────────────────────────

const TYPE_OF: Record<Section['kind'], DocType> = {
  pay_application: 'pay_application',
  continuation_sheet: 'continuation_sheet',
  lien_waiver: 'lien_waiver',
  cover_letter: 'other',
  invoice: 'invoice',
};

function sheetPageCount(sec: Extract<Section, { kind: 'continuation_sheet' }>): number {
  const perPage = sec.legacy ? 24 : { ...G703_STYLE, ...sec.style }.rowsPerPage;
  return Math.max(1, Math.ceil(sec.pkg.lines.length / perPage));
}

/**
 * Render sections into one PDF, in the order given. Pay applications and
 * schedules that share a `group` are numbered together ("page 2 of 3").
 */
export async function renderLayout(sections: Section[], opts: LayoutOptions = {}): Promise<RenderedLayout> {
  const doc = await PDFDocument.create();
  const first = sections[0]?.pkg;
  if (first) {
    doc.setTitle(`${first.sub.name} - Application ${first.applicationNumber}`);
    const stamp = new Date(`${first.applicationDate}T12:00:00Z`);
    doc.setCreationDate(stamp);
    doc.setModificationDate(stamp);
  }
  doc.setProducer('Construction RCM sample generator');
  const f = await fonts(doc);

  // Pages of the numbered set (pay application + schedule) in each group.
  const groupTotal = new Map<number, number>();
  for (const sec of sections) {
    if (sec.kind === 'pay_application') groupTotal.set(sec.group ?? 0, (groupTotal.get(sec.group ?? 0) ?? 0) + 1);
    if (sec.kind === 'continuation_sheet') groupTotal.set(sec.group ?? 0, (groupTotal.get(sec.group ?? 0) ?? 0) + sheetPageCount(sec));
  }
  const groupNext = new Map<number, number>();
  const anchors: Anchors = {};
  const pages: RenderedLayout['pages'] = [];
  const rendered: Array<{ kind: Section['kind']; first: number; count: number; linePages?: number[] }> = [];

  sections.forEach((sec, si) => {
    const before = doc.getPageCount();
    let linePages: number[] | undefined;
    const labels: Array<{ number: number; of: number | null } | null> = [];
    if (sec.kind === 'pay_application') {
      const group = sec.group ?? 0;
      const n = (groupNext.get(group) ?? 0) + 1;
      groupNext.set(group, n);
      const total = groupTotal.get(group)!;
      if (sec.legacy) {
        drawPayApplication(doc, f, sec.pkg, total);
        labels.push({ number: n, of: total });
      } else {
        const style = { ...G702_STYLE, ...sec.style };
        const label = pageLabelText(style.pageLabel, n, total);
        if (style.form === 'own') drawOwnPayApp(doc, f, sec.pkg, style, label, anchors);
        else drawG702Variant(doc, f, sec.pkg, style, label, anchors);
        labels.push(label ? { number: n, of: total } : null);
      }
    } else if (sec.kind === 'continuation_sheet') {
      const group = sec.group ?? 0;
      const start = (groupNext.get(group) ?? 0) + 1;
      const total = groupTotal.get(group)!;
      const count = sheetPageCount(sec);
      groupNext.set(group, start + count - 1);
      if (sec.legacy) {
        drawContinuationSheets(doc, f, sec.pkg, start, total);
        linePages = sec.pkg.lines.map((_, i) => Math.floor(i / 24));
        for (let i = 0; i < count; i++) labels.push({ number: start + i, of: total });
      } else {
        const style = { ...G703_STYLE, ...sec.style };
        const own = style.pageLabel === 'sheet_x_of_y';
        const out = drawSheetVariant(doc, f, sec.pkg, style, (pi, n) => (own ? pageLabelText(style.pageLabel, pi + 1, n) : pageLabelText(style.pageLabel, start + pi, total)));
        if (out.pages !== count) throw new Error('Schedule page count mismatch');
        linePages = out.linePages;
        for (let i = 0; i < count; i++) labels.push(style.pageLabel === 'none' ? null : own ? { number: i + 1, of: count } : { number: start + i, of: total });
      }
    } else if (sec.kind === 'lien_waiver') {
      if (sec.custom) drawCustomWaiver(doc, f, sec.pkg, sec.custom, anchors);
      else {
        const w = sec.waiver ?? sec.pkg.waiver;
        if (!w) throw new Error('No waiver to draw');
        drawWaiver(doc, f, sec.pkg, w);
      }
    } else if (sec.kind === 'cover_letter') {
      drawCoverLetter(doc, f, sec.pkg);
    } else {
      drawInvoice(doc, f, sec.pkg);
    }
    const count = doc.getPageCount() - before;
    for (let i = 0; i < count; i++) pages.push({ type: TYPE_OF[sec.kind], section: si, label: labels[i] ?? null });
    rendered.push({ kind: sec.kind, first: before, count, linePages });
  });

  let bytes = await doc.save({ useObjectStreams: false });

  // Leave pages out, then turn pages. Both work on the finished file.
  const dropped = new Set((opts.dropPages ?? []).map((n) => n - 1));
  const keep = pages.map((_, i) => i).filter((i) => !dropped.has(i));
  const newIndex = new Map(keep.map((old, i) => [old, i]));
  if (dropped.size > 0 || (opts.rotate?.length ?? 0) > 0) {
    const src = await PDFDocument.load(bytes);
    const out = await PDFDocument.create();
    out.setProducer('Construction RCM sample generator');
    if (first) {
      const stamp = new Date(`${first.applicationDate}T12:00:00Z`);
      out.setCreationDate(stamp);
      out.setModificationDate(stamp);
    }
    for (const old of keep) {
      const turn = opts.rotate?.find((r) => r.page === newIndex.get(old)! + 1);
      if (turn && turn.mode !== 'flag') {
        const [embedded] = await out.embedPdf(bytes, [old]);
        const { width, height } = src.getPage(old).getSize();
        const page = out.addPage([height, width]);
        // A quarter turn counter-clockwise about the bottom-right corner of the new page.
        page.drawPage(embedded!, { x: height, y: 0, rotate: degrees(90) });
        if (turn.mode === 'content_upright') page.setRotation(degrees(90));
      } else {
        const [copy] = await out.copyPages(src, [old]);
        if (turn) copy!.setRotation(degrees(turn.by ?? 90));
        out.addPage(copy!);
      }
    }
    bytes = await out.save({ useObjectStreams: false });
  }

  const finalPages = keep.map((old) => pages[old]!);
  for (const a of Object.values(anchors)) a.page = (newIndex.get(a.page - 1) ?? -1) + 1;
  return {
    bytes,
    pageCount: finalPages.length,
    pages: finalPages,
    sections: rendered.map((r) => ({
      kind: r.kind,
      pages: Array.from({ length: r.count }, (_, i) => r.first + i)
        .filter((old) => newIndex.has(old))
        .map((old) => newIndex.get(old)! + 1),
      linePages: r.linePages?.map((offset) => (newIndex.has(r.first + offset) ? newIndex.get(r.first + offset)! + 1 : null)),
    })),
    anchors,
  };
}
