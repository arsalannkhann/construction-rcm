/**
 * The synthetic evaluation corpus: billing documents printed by this
 * project's own renderer in many layouts, each with the ground truth of what
 * it says. Generated on the fly, so it never drifts from the renderer.
 *
 * This is a regression signal for the document readers and nothing more. It
 * is our idea of what messy documents look like; real subcontractor packages
 * are messier in ways we have not thought of. See docs/extraction-evaluation.md.
 */
import { PDFDocument } from 'pdf-lib';
import { readPdfText } from '@/server/documents/pdf-text';
import type { Truth, TruthLine, TruthPayApp, TruthWaiver } from '@/server/documents/evaluation/truth';
import { CLAIMED_FIELDS, LINE_AMOUNT_FIELDS, type ClaimedField, type DocType, type LineAmountField } from '@/server/types';
import {
  AIA_COLUMNS,
  G702_STYLE,
  G703_STYLE,
  renderLayout,
  type CustomWaiver,
  type LayoutOptions,
  type PayAppStyle,
  type RenderedLayout,
  type Section,
  type SheetColumn,
  type SheetStyle,
} from './layouts';
import { renderPackage, type SampleLine, type SamplePackage, type SampleWaiver } from './pdf';
import { encodePng, inkCorrection, inkSignature, pagePicture, type PlacedText } from './raster';
import { buildPackage, stateAfter, type BillingContract, type Parties } from './scenario';

export type CorpusFile = { filename: string; mimeType: string; bytes: Uint8Array };
export type CorpusCase = { id: string; file: CorpusFile; truth: Truth };
export type SyntheticCase = { id: string; title: string; build: () => Promise<CorpusCase> };

const D = (n: number) => Math.round(n * 100);
const clone = <T>(x: T): T => structuredClone(x);

// ── Packages ────────────────────────────────────────────────────────────────

const ELECTRIC: Parties = {
  gc: { name: 'Northline Constructors, Inc.', address: '4100 Guadalupe St, Suite 300, Austin, TX 78751' },
  owner: 'Riverside Health Partners',
  project: { name: 'Riverside Medical Office Building', number: '2301', address: '880 Riverside Dr, Austin, TX 78704', state: 'TX' },
  sub: { name: 'Lone Star Electric, LLC', address: '2210 Industrial Blvd, Austin, TX 78745', signer: 'Maria Alvarez', signerTitle: 'Controller' },
};
const MECHANICAL: Parties = {
  gc: { name: 'Bayview Builders Group', address: '300 Frank H Ogawa Plaza, Oakland, CA 94612' },
  owner: 'Harbor Point Holdings LLC',
  project: { name: 'Harbor Point Lab Building', number: 'HP-118', address: '1500 Shoreline Way, Oakland, CA 94607', state: 'CA' },
  sub: { name: 'Pacific Air & Plumbing, Inc.', address: '77 Mariner Sq, Alameda, CA 94501', signer: 'Kenji Watanabe', signerTitle: 'Project Accountant' },
};
const CONCRETE: Parties = {
  gc: { name: 'Gulf Coast Construction Co.', address: '601 N Ashley Dr, Tampa, FL 33602' },
  owner: 'Bayshore Medical Partners',
  project: { name: 'Bayshore Clinic Expansion', number: '24-031', address: '2100 Bayshore Blvd, Tampa, FL 33606', state: 'FL' },
  sub: { name: 'Suncoast Concrete Works, LLC', address: '4810 N Armenia Ave, Tampa, FL 33603', signer: 'Rosa Delgado', signerTitle: 'Vice President' },
};
const DRYWALL: Parties = {
  gc: { name: 'Front Range Builders, Inc.', address: '1801 California St, Denver, CO 80202' },
  owner: 'Larimer Square Partners',
  project: { name: 'Larimer Lofts', number: 'LL-07', address: '1430 Larimer St, Denver, CO 80202', state: 'CO' },
  sub: { name: 'Summit Drywall & Framing Co.', address: '5200 Brighton Blvd, Denver, CO 80216', signer: 'Evan Brooks', signerTitle: 'Owner' },
};

/** Three lines, whole dollars, stored material on one line. The same numbers as the test-suite sample. */
function electric(): SamplePackage {
  const contract: BillingContract = {
    number: 'SC-2301-16',
    date: '2026-03-02',
    description: 'Electrical',
    originalAmount: D(500000),
    retainageWorkBps: 1000,
    retainageStoredBps: 1000,
    sov: [
      { itemNo: '1', description: 'Mobilization', scheduledValue: D(50000) },
      { itemNo: '2', description: 'Rough-in, levels 1-3', scheduledValue: D(300000) },
      { itemNo: '3', description: 'Fixtures and trim', scheduledValue: D(150000) },
    ],
    changeOrders: [],
  };
  const first = buildPackage(ELECTRIC, contract, null, { applicationNumber: 1, periodTo: '2026-09-30', applicationDate: '2026-09-28', progress: { '1': { work: D(50000) }, '2': { work: D(60000) } } });
  return buildPackage(ELECTRIC, contract, stateAfter(first), { applicationNumber: 2, periodTo: '2026-10-31', applicationDate: '2026-10-28', progress: { '2': { work: D(90000) }, '3': { work: D(15000), stored: D(10000) } } });
}

const MECH_SOV: Array<[string, string, number]> = [
  ['22-010', 'Plumbing mobilization', 18500],
  ['22-020', 'Underground sanitary waste', 64250.5],
  ['22-030', 'Domestic water mains', 88900],
  ['22-040', 'Lab waste and vent piping', 121300.75],
  ['22-050', 'Natural gas distribution', 42750],
  ['22-060', 'Compressed air and vacuum', 57600],
  ['22-070', 'RO/DI water system', 96420],
  ['22-080', 'Plumbing fixtures, levels 1-2', 73180.25],
  ['22-090', 'Plumbing fixtures, levels 3-4', 69840],
  ['22-100', 'Emergency showers and eyewash', 31275],
  ['22-110', 'Water heaters and pumps', 48600],
  ['22-120', 'Pipe insulation', 38920.4],
  ['22-130', 'Testing and disinfection', 12400],
  ['23-010', 'HVAC mobilization', 22500],
  ['23-020', 'Air handling units AHU-1 to AHU-4', 412800],
  ['23-030', 'Exhaust fans and fume hood exhaust', 186350],
  ['23-040', 'Supply ductwork, levels 1-2', 142975.6],
  ['23-050', 'Supply ductwork, levels 3-4', 138410],
  ['23-060', 'Return and exhaust ductwork', 121640],
  ['23-070', 'VAV boxes and reheat coils', 98760],
  ['23-080', 'Hydronic piping', 156240.8],
  ['23-090', 'Boilers and chillers', 284500],
  ['23-100', 'Building automation controls', 176300],
  ['23-110', 'Duct insulation', 54810],
  ['23-120', 'Test, adjust and balance', 41200],
  ['23-130', 'Commissioning support', 18650],
];

/** Twenty-eight lines in two divisions, amounts with cents, an added and a deductive change order. */
function mechanical(): SamplePackage {
  const contract: BillingContract = {
    number: 'SC-118-23',
    date: '2026-02-16',
    description: 'Mechanical and plumbing',
    originalAmount: MECH_SOV.reduce((a, [, , v]) => a + D(v), 0),
    retainageWorkBps: 1000,
    retainageStoredBps: 1000,
    sov: MECH_SOV.map(([itemNo, description, v]) => ({ itemNo, description, scheduledValue: D(v) })),
    changeOrders: [
      { number: 'CO-1', title: 'Added lab gas outlets', amount: D(18750) },
      { number: 'CO-2', title: 'Deduct: owner-furnished fixtures', amount: -D(6420.5) },
    ],
  };
  const firstProgress: Record<string, { work?: number; stored?: number }> = {};
  const secondProgress: Record<string, { work?: number; stored?: number }> = {};
  MECH_SOV.forEach(([itemNo, , v], i) => {
    if (i % 3 !== 2) firstProgress[itemNo] = { work: D(Math.round(v * 0.25 * 100) / 100) };
    if (i % 4 !== 3) secondProgress[itemNo] = { work: D(Math.round(v * 0.15 * 100) / 100), ...(i % 5 === 0 ? { stored: D(Math.round(v * 0.05 * 100) / 100) } : {}) };
  });
  secondProgress['CO-1'] = { work: D(9375) };
  const first = buildPackage(MECHANICAL, contract, null, { applicationNumber: 3, periodTo: '2026-08-31', applicationDate: '2026-08-27', progress: firstProgress });
  return buildPackage(MECHANICAL, contract, stateAfter(first), { applicationNumber: 4, periodTo: '2026-09-30', applicationDate: '2026-09-28', progress: secondProgress });
}

/** Six lines plus an added change order and a deductive one credited this period. */
function concrete(): SamplePackage {
  const contract: BillingContract = {
    number: 'GCC-24031-03',
    date: '2026-04-06',
    description: 'Cast-in-place concrete',
    originalAmount: D(612400),
    retainageWorkBps: 1000,
    retainageStoredBps: 500,
    sov: [
      { itemNo: '1', description: 'General conditions', scheduledValue: D(38400) },
      { itemNo: '2', description: 'Footings and grade beams', scheduledValue: D(146250) },
      { itemNo: '3', description: 'Slab on grade', scheduledValue: D(118900) },
      { itemNo: '4', description: 'Elevated deck, level 2', scheduledValue: D(172600) },
      { itemNo: '5', description: 'Columns and shear walls', scheduledValue: D(98750) },
      { itemNo: '6', description: 'Reinforcing steel (stored)', scheduledValue: D(37500) },
    ],
    changeOrders: [
      { number: 'CO-1', title: 'Added equipment pads', amount: D(12500) },
      { number: 'CO-2', title: 'Deduct: thinner topping slab', amount: -D(8000) },
    ],
  };
  const first = buildPackage(CONCRETE, contract, null, { applicationNumber: 4, periodTo: '2026-08-31', applicationDate: '2026-08-29', progress: { '1': { work: D(19200) }, '2': { work: D(146250) }, '3': { work: D(59450) } } });
  return buildPackage(CONCRETE, contract, stateAfter(first), {
    applicationNumber: 5,
    periodTo: '2026-09-30',
    applicationDate: '2026-09-29',
    progress: { '1': { work: D(6400) }, '3': { work: D(59450) }, '4': { work: D(43150) }, '6': { stored: D(18000) }, 'CO-1': { work: D(12500) }, 'CO-2': { work: -D(8000) } },
  });
}

/** Five lines on a project in a state with no statutory waiver form. */
function drywall(): SamplePackage {
  const contract: BillingContract = {
    number: 'FRB-0712',
    date: '2026-05-11',
    description: 'Framing and drywall',
    originalAmount: D(284000),
    retainageWorkBps: 500,
    retainageStoredBps: 500,
    sov: [
      { itemNo: '1', description: 'Metal stud framing', scheduledValue: D(96000) },
      { itemNo: '2', description: 'Drywall hang', scheduledValue: D(84000) },
      { itemNo: '3', description: 'Tape and finish', scheduledValue: D(62000) },
      { itemNo: '4', description: 'Acoustic ceilings', scheduledValue: D(30000) },
      { itemNo: '5', description: 'Insulation', scheduledValue: D(12000) },
    ],
    changeOrders: [],
  };
  const first = buildPackage(DRYWALL, contract, null, { applicationNumber: 1, periodTo: '2026-09-30', applicationDate: '2026-09-25', progress: { '1': { work: D(38400) }, '5': { work: D(6000) } } });
  return buildPackage(DRYWALL, contract, stateAfter(first), { applicationNumber: 2, periodTo: '2026-10-31', applicationDate: '2026-10-27', progress: { '1': { work: D(28800) }, '2': { work: D(25200) }, '5': { work: D(6000) } } });
}

function withLongDescriptions(pkg: SamplePackage): SamplePackage {
  const extra = ['including hangers, supports, sleeves and seismic bracing', 'complete with fittings, valves and specialties as scheduled', 'per drawings M-201 through M-208 and addendum 3'];
  const out = clone(pkg);
  out.lines.forEach((l, i) => {
    if (i % 2 === 0) l.description = `${l.description}, ${extra[i % 3]}`;
  });
  return out;
}

// ── Ground truth from what was printed ──────────────────────────────────────

type PayAppPrint = { form: 'legacy' | 'g702' | 'own'; retainageSplit: boolean; signed: 'yes' | 'no'; signatureMark: 'electronic' | 'ink' | null };

function payAppPrint(sec: Extract<Section, { kind: 'pay_application' }>): PayAppPrint {
  const style = { ...G702_STYLE, ...sec.style };
  return {
    form: sec.legacy ? 'legacy' : style.form,
    retainageSplit: sec.legacy ? true : style.form === 'g702' && style.retainageSplit,
    signed: sec.pkg.signed ? 'yes' : 'no',
    signatureMark: sec.pkg.signed ? 'electronic' : null,
  };
}

function payAppTruth(pkg: SamplePackage, print: PayAppPrint): TruthPayApp {
  const amounts = {} as Record<ClaimedField, number | null>;
  for (const f of CLAIMED_FIELDS) amounts[f] = pkg.header[f];
  if (!print.retainageSplit) {
    amounts.retainageWork = null;
    amounts.retainageStored = null;
  }
  return {
    applicationNumber: pkg.applicationNumber,
    periodTo: pkg.periodTo,
    applicationDate: pkg.applicationDate,
    projectName: pkg.project.name,
    projectNumber: pkg.project.number,
    contractorName: pkg.sub.name,
    toName: pkg.gc.name,
    contractNumber: pkg.contract.number,
    contractDate: pkg.contract.date,
    amounts,
    signed: print.signed,
    signatureMark: print.signatureMark,
    // The contractor's own form has no notary block.
    notarized: print.form !== 'own' && pkg.notarized ? 'yes' : 'no',
  };
}

const SHEET_FIELD: Partial<Record<SheetColumn, LineAmountField>> = { scheduledValue: 'scheduledValue', previous: 'previous', thisPeriod: 'thisPeriod', stored: 'stored', total: 'total', balance: 'balance', retainage: 'retainage' };

function sheetTruth(sec: Extract<Section, { kind: 'continuation_sheet' }>, linePages: Array<number | null>, abstain: string[], lineOffset: number): { lines: TruthLine[]; totals: TruthLine | null } {
  const style: SheetStyle = sec.legacy ? G703_STYLE : { ...G703_STYLE, ...sec.style };
  const printed = new Set(style.columns.map((c) => SHEET_FIELD[c]).filter(Boolean) as LineAmountField[]);
  const lines: TruthLine[] = [];
  sec.pkg.lines.forEach((l, i) => {
    const page = linePages[i];
    if (page === null || page === undefined) return; // on a page that is not in the file
    const t: TruthLine = { itemNo: l.itemNo, description: l.description, page };
    for (const f of LINE_AMOUNT_FIELDS) {
      const v = printed.has(f) ? l[f] : null;
      if (v === 0 && style.amounts.zero === 'blank') t[f] = null;
      else {
        t[f] = v;
        if (v === 0 && style.amounts.zero === 'dash') abstain.push(`lines.${lineOffset + lines.length}.${f}`);
      }
    }
    lines.push(t);
  });
  let totals: TruthLine | null = null;
  if (style.grandTotalLabel) {
    totals = {};
    for (const f of LINE_AMOUNT_FIELDS) totals[f] = printed.has(f) ? sec.pkg.lines.reduce((a, l) => a + l[f], 0) : null;
  }
  return { lines, totals };
}

function statutoryWaiverTruth(pkg: SamplePackage, w: SampleWaiver, page: number): TruthWaiver {
  const progress = w.type.endsWith('progress');
  const through = w.form === 'TX' ? null : w.form === 'generic' ? w.throughDate : progress ? w.throughDate : null;
  return {
    page,
    waiverType: w.type,
    formState: w.form === 'generic' ? null : w.form,
    claimant: w.claimant,
    customer: pkg.gc.name,
    owner: w.form === 'generic' ? null : pkg.owner,
    throughDate: through,
    amount: w.amount,
    exceptions: w.exceptions ? [w.exceptions] : null,
    signed: w.signed ? 'yes' : 'no',
    signatureMark: w.signed ? 'electronic' : null,
  };
}

function customWaiverTruth(pkg: SamplePackage, w: CustomWaiver, page: number): TruthWaiver {
  return {
    page,
    waiverType: w.type,
    formState: null,
    claimant: w.claimant,
    customer: pkg.gc.name,
    owner: pkg.owner,
    throughDate: w.throughDate,
    amount: w.amount,
    exceptions: Array.isArray(w.exceptions) ? w.exceptions : null,
    signed: w.signature === 'blank' ? 'no' : 'yes',
    signatureMark: w.signature === 'esign' ? 'electronic' : w.signature === 'ink' ? 'ink' : null,
  };
}

function documentRanges(types: DocType[]): NonNullable<Truth['documents']> {
  const out: NonNullable<Truth['documents']> = [];
  types.forEach((type, i) => {
    const last = out[out.length - 1];
    if (last && last.type === type && type !== 'lien_waiver' && last.pageEnd === i) last.pageEnd = i + 1;
    else out.push({ type, pageStart: i + 1, pageEnd: i + 1 });
  });
  return out;
}

type Extra = Partial<Pick<Truth, 'expect' | 'package' | 'description'>> & { tags?: string[]; inkSignatures?: Array<'payApp' | 'waiver'> };

/** Ground truth for a rendered layout. The first pay application in the file is the one reported. */
function truthFor(sections: Section[], out: RenderedLayout, extra: Extra = {}): Truth {
  const abstain: string[] = [...(extra.expect?.abstain ?? [])];
  let payApp: TruthPayApp | null = null;
  let firstPayGroup: number | null = null;
  const lines: TruthLine[] = [];
  let lineTotals: TruthLine | null = null;
  let sawSheet = false;
  const waivers: TruthWaiver[] = [];
  sections.forEach((sec, si) => {
    const rendered = out.sections[si]!;
    if (sec.kind === 'pay_application' && payApp === null && rendered.pages.length > 0) {
      payApp = payAppTruth(sec.pkg, payAppPrint(sec));
      firstPayGroup = sec.group ?? 0;
      if (extra.inkSignatures?.includes('payApp')) {
        payApp.signed = 'yes';
        payApp.signatureMark = 'ink';
      }
    }
    if (sec.kind === 'continuation_sheet' && (firstPayGroup === null || (sec.group ?? 0) === firstPayGroup) && !sawSheet) {
      sawSheet = true;
      const t = sheetTruth(sec, rendered.linePages!, abstain, lines.length);
      lines.push(...t.lines);
      lineTotals = t.totals;
    }
    if (sec.kind === 'lien_waiver' && rendered.pages.length > 0) {
      const w = sec.custom ? customWaiverTruth(sec.pkg, sec.custom, rendered.pages[0]!) : statutoryWaiverTruth(sec.pkg, (sec.waiver ?? sec.pkg.waiver)!, rendered.pages[0]!);
      if (extra.inkSignatures?.includes('waiver')) {
        w.signed = 'yes';
        w.signatureMark = 'ink';
      }
      waivers.push(w);
    }
  });
  const expect = extra.expect ? { ...extra.expect, ...(abstain.length ? { abstain } : {}) } : abstain.length ? { abstain } : undefined;
  return {
    version: 1,
    ...(extra.description ? { description: extra.description } : {}),
    tags: ['synthetic', ...(extra.tags ?? [])],
    ...(extra.package ? { package: extra.package } : {}),
    pageCount: out.pageCount,
    documents: documentRanges(out.pages.map((p) => p.type)),
    payApp,
    lines: sawSheet ? lines : null,
    lineTotals: sawSheet ? lineTotals : null,
    waivers,
    pageNumbering: out.pages.flatMap((p, i) => (p.label ? [{ page: i + 1, number: p.label.number, of: p.label.of }] : [])),
    ...(expect ? { expect } : {}),
  };
}

// ── Building cases ──────────────────────────────────────────────────────────

const pdfFile = (name: string, bytes: Uint8Array): CorpusFile => ({ filename: `${name}.pdf`, mimeType: 'application/pdf', bytes });

function layoutCase(id: string, title: string, sections: () => Section[], opts: LayoutOptions = {}, extra: Extra = {}): SyntheticCase {
  return {
    id,
    title,
    build: async () => {
      const secs = sections();
      const out = await renderLayout(secs, opts);
      return { id, file: pdfFile(id.replace(/\//g, '__'), out.bytes), truth: truthFor(secs, out, { description: title, ...extra }) };
    },
  };
}

const standard = (pkg: SamplePackage, pay: Partial<PayAppStyle> = {}, sheet: Partial<SheetStyle> = {}): Section[] => [
  { kind: 'pay_application', pkg, style: pay },
  { kind: 'continuation_sheet', pkg, style: sheet },
  ...(pkg.waiver ? [{ kind: 'lien_waiver' as const, pkg }] : []),
];
const legacy = (pkg: SamplePackage): Section[] => [
  { kind: 'pay_application', pkg, legacy: true },
  { kind: 'continuation_sheet', pkg, legacy: true },
  ...(pkg.waiver ? [{ kind: 'lien_waiver' as const, pkg }] : []),
];

const MONEY_FIELDS_ABSTAIN = ['payApp.amounts.*', ...LINE_AMOUNT_FIELDS.map((f) => `lines.*.${f}`), ...LINE_AMOUNT_FIELDS.map((f) => `lineTotals.${f}`)];

/** Draw pictures onto pages of a finished PDF. Anchors are in PDF points, bottom-left origin. */
async function overlay(bytes: Uint8Array, marks: Array<{ page: number; png: Uint8Array; x: number; y: number; w: number; h: number }>): Promise<Uint8Array> {
  const doc = await PDFDocument.load(bytes);
  for (const m of marks) {
    const img = await doc.embedPng(m.png);
    doc.getPage(m.page - 1).drawImage(img, { x: m.x, y: m.y, width: m.w, height: m.h });
  }
  return doc.save({ useObjectStreams: false });
}

/** Turn every page of a PDF into a picture of itself with no text layer: a scan. `pages` limits which pages. */
async function scanned(bytes: Uint8Array, opts: { dpi: number; seed: number; speckles?: number; grain?: number; pages?: number[] }): Promise<Uint8Array> {
  const text = await readPdfText(bytes);
  const src = await PDFDocument.load(bytes);
  const out = await PDFDocument.create();
  out.setProducer('Construction RCM sample generator');
  for (const page of text.pages) {
    if (opts.pages && !opts.pages.includes(page.page)) {
      const [copy] = await out.copyPages(src, [page.page - 1]);
      out.addPage(copy!);
      continue;
    }
    const items: PlacedText[] = page.lines.flatMap((l) => l.cells.map((c) => ({ text: c.text, x: c.x, y: c.y, w: c.w, h: c.h })));
    const png = encodePng(pagePicture({ width: page.width, height: page.height, items }, { dpi: opts.dpi, seed: opts.seed + page.page, speckles: opts.speckles, grain: opts.grain }));
    const img = await out.embedPng(png);
    const p = out.addPage([page.width, page.height]);
    p.drawImage(img, { x: 0, y: 0, width: page.width, height: page.height });
  }
  return out.save({ useObjectStreams: false });
}

function waiverFor(pkg: SamplePackage, patch: Partial<SampleWaiver>): SamplePackage {
  const out = clone(pkg);
  out.waiver = { ...out.waiver!, ...patch };
  return out;
}

function custom(pkg: SamplePackage, patch: Partial<CustomWaiver> = {}): CustomWaiver {
  return { type: 'conditional_progress', amount: pkg.header.currentPaymentDue, amountStyle: 'figures', throughDate: pkg.periodTo, claimant: pkg.sub.name, signature: 'esign', exceptions: null, ...patch };
}

export function syntheticCases(): SyntheticCase[] {
  const cases: SyntheticCase[] = [];
  const add = (c: SyntheticCase) => cases.push(c);

  // ── The existing layout, unchanged (what the demo workspace and tests use) ──
  add({ id: 'legacy/package-tx', title: 'Standard layout: G702, G703 and a Texas conditional waiver', build: async () => legacyCase('legacy/package-tx', 'Standard layout: G702, G703 and a Texas conditional waiver', electric()) });
  add({ id: 'legacy/package-ca-two-sheet-pages', title: 'Standard layout: 28-line schedule over two pages, California waiver', build: async () => legacyCase('legacy/package-ca-two-sheet-pages', 'Standard layout: 28-line schedule over two pages, California waiver', mechanical()) });
  add({ id: 'legacy/package-fl-change-orders', title: 'Standard layout: added and deductive change orders, Florida waiver', build: async () => legacyCase('legacy/package-fl-change-orders', 'Standard layout: added and deductive change orders, Florida waiver', concrete()) });
  add({
    id: 'legacy/unsigned-generic-waiver',
    title: 'Standard layout: unsigned, not notarised, unsigned non-statutory waiver',
    build: async () => {
      const pkg = drywall();
      pkg.signed = false;
      pkg.notarized = false;
      pkg.waiver!.signed = false;
      return legacyCase('legacy/unsigned-generic-waiver', 'Standard layout: unsigned, not notarised, unsigned non-statutory waiver', pkg);
    },
  });

  // ── G702 wording and layout ──
  add(layoutCase('g702/labels-upper-case', 'G702 with every label in capitals and no line remarks', () => standard(electric(), { wording: 'aia_upper', lineNotes: false })));
  add(layoutCase('g702/labels-lower-case', 'G702 with every label in lower case', () => standard(drywall(), { wording: 'aia_lower' })));
  add(layoutCase('g702/labels-alternate', 'G702 with alternate wording for every line and header label, long dates', () => standard(concrete(), { wording: 'alternate', headerLabels: 'alternate', dateStyle: 'long' })));
  add(layoutCase('g702/period-range-abbreviated-dates', 'G702 with the billing period as a date range and abbreviated month names', () => standard(electric(), { periodAsRange: true, dateStyle: 'abbrev' })));
  add(layoutCase('g702/terse-unnumbered', 'Unnumbered summary with terse labels, retainage as one line, ISO dates, no dollar signs', () => standard(drywall(), { wording: 'terse', numbered: false, retainageSplit: false, lineNotes: false, dollarSign: false, dateStyle: 'iso' })));
  add(layoutCase('g702/amounts-below-labels', 'G702 with each amount on the line under its label', () => standard(electric(), { amountBelowLabel: true })));
  add(layoutCase('g702/inner-retainage-column-and-co-summary', 'G702 with 5a/5b in an inner column and the change order summary table', () => standard(concrete(), { retainageInnerColumn: true, changeOrderSummary: true })));
  add(layoutCase('g702/landscape', 'G702 printed landscape, certification beside the summary', () => standard(mechanical(), { orientation: 'landscape' })));
  add(layoutCase('own-form/portrait', "Contractor's own requisition form: summary table, different order and labels", () => standard(electric(), { form: 'own', pageLabel: 'x_of_y' })));
  add(layoutCase('own-form/landscape-period-range', "Contractor's own requisition form, landscape, billing period as a range", () => standard(concrete(), { form: 'own', orientation: 'landscape', periodAsRange: true, dateStyle: 'long', pageLabel: 'x_of_y' })));

  // ── G703 layouts ──
  add(layoutCase('g703/no-column-letters', 'Schedule without the A-I column letter row', () => standard(electric(), {}, { letters: 'none' })));
  add(layoutCase('g703/alternate-headings', 'Schedule titled "Schedule of Values" with different column headings and no letters', () => standard(drywall(), {}, { title: 'SCHEDULE OF VALUES', headings: 'alternate', letters: 'none' })));
  const reordered: SheetColumn[] = ['itemNo', 'description', 'scheduledValue', 'total', 'percent', 'previous', 'thisPeriod', 'stored', 'retainage', 'balance'];
  add(layoutCase('g703/reordered-columns', 'Schedule with reordered columns and no letters', () => standard(electric(), {}, { columns: reordered, headings: 'alternate', letters: 'none', title: 'SCHEDULE OF VALUES' })));
  add(layoutCase('g703/reordered-columns-positional-letters', 'Schedule with reordered columns lettered A, B, C... left to right (letters do not mean the AIA columns)', () => standard(concrete(), {}, { columns: reordered, letters: 'positional' })));
  add(layoutCase('g703/extra-columns', 'Schedule with original value and approved changes columns before the revised value', () => standard(concrete(), {}, { columns: ['itemNo', 'description', 'originalValue', 'changes', 'scheduledValue', 'previous', 'thisPeriod', 'stored', 'total', 'percent', 'balance', 'retainage'], letters: 'none' })));
  add(layoutCase('g703/no-stored-or-retainage-columns', 'Schedule without stored-material and retainage columns', () => standard(drywall(), {}, { columns: ['itemNo', 'description', 'scheduledValue', 'previous', 'thisPeriod', 'total', 'percent', 'balance'] })));
  add(layoutCase('g703/wrapped-descriptions', 'Schedule with long descriptions wrapped over two or three lines', () => standard(withLongDescriptions(mechanical()), {}, { wrap: true, rowsPerPage: 12, pageLabel: 'x_of_y' })));
  add(layoutCase('g703/multipage-page-subtotals', 'Three-page schedule with repeated headers, page subtotals, "continued" notes and a grand total', () => standard(mechanical(), {}, { rowsPerPage: 10, pageSubtotals: 'page', continuedNote: true, pageLabel: 'x_of_y' })));
  add(layoutCase('g703/multipage-running-totals', 'Three-page schedule with brought-forward and carried-forward rows, numbered "Sheet x of y"', () => standard(mechanical(), {}, { rowsPerPage: 10, pageSubtotals: 'running', headings: 'alternate', letters: 'none', pageLabel: 'sheet_x_of_y' })));
  add(layoutCase('g703/division-sections', 'Schedule in two divisions, each with a heading and a subtotal; total row labelled "TOTALS"', () => standard(mechanical(), {}, { sections: [{ title: 'DIVISION 22 - PLUMBING', from: '22-010' }, { title: 'DIVISION 23 - HVAC', from: '23-010' }, { title: 'CHANGE ORDERS', from: 'CO-1' }], grandTotalLabel: 'TOTALS', rowsPerPage: 16 })));
  add(layoutCase('g703/no-grand-total', 'Schedule with no grand-total row', () => standard(drywall(), {}, { grandTotalLabel: null })));
  add(layoutCase('g703/portrait', 'Schedule printed portrait in a smaller font', () => standard(drywall(), {}, { orientation: 'portrait' })));

  // ── Package order and splitting ──
  add(layoutCase('package/waiver-first', 'Package with the lien waiver first', () => {
    const pkg = electric();
    return [{ kind: 'lien_waiver', pkg }, { kind: 'pay_application', pkg }, { kind: 'continuation_sheet', pkg }];
  }));
  add(layoutCase('package/schedule-before-summary', 'Package with the schedule before the pay application', () => {
    const pkg = concrete();
    return [{ kind: 'continuation_sheet', pkg }, { kind: 'pay_application', pkg }, { kind: 'lien_waiver', pkg }];
  }));
  add(layoutCase('package/cover-letter-and-invoice', 'Package with a transmittal letter (which mentions the waiver) and an invoice in front', () => {
    const pkg = drywall();
    return [{ kind: 'cover_letter', pkg }, { kind: 'invoice', pkg }, ...standard(pkg)];
  }));
  for (const part of ['pay_application', 'continuation_sheet', 'lien_waiver'] as const) {
    add(layoutCase(`separate/${part.replace('_', '-')}-only`, `The ${part.replace('_', ' ')} of a package sent as its own file`, () => standard(electric()).filter((s) => s.kind === part), {}, { package: 'electric-app-2-separate-files' }));
  }

  // ── Rotation ──
  add({ id: 'rotated/schedule-content-turned-with-flag', title: 'Landscape schedule stored turned a quarter in a portrait page, with a rotation flag (displays upright)', build: async () => legacyCase('rotated/schedule-content-turned-with-flag', 'Landscape schedule stored turned a quarter in a portrait page, with a rotation flag (displays upright)', electric(), { rotate: [{ page: 2, mode: 'content_upright' }] }) });
  add({ id: 'rotated/payapp-flagged-sideways', title: 'G702 with a 90° rotation flag (displays sideways)', build: async () => legacyCase('rotated/payapp-flagged-sideways', 'G702 with a 90° rotation flag (displays sideways)', concrete(), { rotate: [{ page: 1, mode: 'flag', by: 90 }] }) });
  add({ id: 'rotated/waiver-content-sideways', title: 'Lien waiver stored turned a quarter with no rotation flag (displays sideways)', build: async () => legacyCase('rotated/waiver-content-sideways', 'Lien waiver stored turned a quarter with no rotation flag (displays sideways)', electric(), { rotate: [{ page: 3, mode: 'content_sideways' }] }) });

  // ── Amount formats ──
  const wholeDollars = { cents: false, grouping: 'comma', negative: 'parens', dollar: 'none', zero: 'print' } as const;
  add(layoutCase('amounts/whole-dollars', 'Amounts printed in whole dollars, no cents', () => standard(electric(), { amounts: wholeDollars }, { amounts: wholeDollars })));
  add(layoutCase('amounts/dollar-sign-in-cell', 'Dollar sign printed against each amount ($1,234.56)', () => standard(mechanical(), { dollarSign: false, amounts: { cents: true, grouping: 'comma', negative: 'parens', dollar: 'tight', zero: 'print' } }, { amounts: { cents: true, grouping: 'comma', negative: 'parens', dollar: 'tight', zero: 'print' }, rowsPerPage: 16 })));
  add(layoutCase('amounts/dollar-sign-spaced', 'Dollar sign and a space before each amount ($ 1,234.56)', () => standard(concrete(), { dollarSign: false, amounts: { cents: true, grouping: 'comma', negative: 'parens', dollar: 'spaced', zero: 'print' } }, { amounts: { cents: true, grouping: 'comma', negative: 'parens', dollar: 'spaced', zero: 'print' }, columns: AIA_COLUMNS.filter((c) => c !== 'percent') })));
  add(layoutCase('amounts/trailing-minus', 'Negative amounts with a trailing minus (8,000.00-)', () => standard(concrete(), { amounts: { cents: true, grouping: 'comma', negative: 'trailing', dollar: 'none', zero: 'print' } }, { amounts: { cents: true, grouping: 'comma', negative: 'trailing', dollar: 'none', zero: 'print' } })));
  add(layoutCase('amounts/leading-minus', 'Negative amounts with a leading minus (-8,000.00)', () => standard(concrete(), { amounts: { cents: true, grouping: 'comma', negative: 'leading', dollar: 'none', zero: 'print' } }, { amounts: { cents: true, grouping: 'comma', negative: 'leading', dollar: 'none', zero: 'print' } })));
  add(layoutCase('amounts/zero-as-dash', 'Zero amounts on the schedule printed as a dash', () => standard(concrete(), {}, { amounts: { ...G703_STYLE.amounts, zero: 'dash' } })));
  add(layoutCase('amounts/zero-as-blank', 'Zero amounts on the schedule left blank', () => standard(mechanical(), {}, { amounts: { ...G703_STYLE.amounts, zero: 'blank' }, rowsPerPage: 16 })));
  add(layoutCase('amounts/no-thousands-separators', 'Amounts with no thousands separators (500000.00)', () => standard(electric(), { amounts: { cents: true, grouping: 'none', negative: 'parens', dollar: 'none', zero: 'print' } }, { amounts: { cents: true, grouping: 'none', negative: 'parens', dollar: 'none', zero: 'print' } })));
  add(
    layoutCase(
      'amounts/european-separators',
      'Amounts with European separators (1.234,56). A reader must not turn these into wrong US amounts; declining to read them is the expected outcome.',
      () => {
        const pkg = mechanical();
        pkg.waiver = null;
        const eu = { cents: true, grouping: 'european', negative: 'leading', dollar: 'none', zero: 'print' } as const;
        return standard(pkg, { amounts: eu }, { amounts: eu, rowsPerPage: 16 });
      },
      {},
      { expect: { abstain: MONEY_FIELDS_ABSTAIN } },
    ),
  );
  add(layoutCase('change-orders/deductive-line', 'A deductive change order line with a negative scheduled value, credited this period', () => standard(concrete(), { wording: 'aia_upper' }, { letters: 'none' })));

  // ── Integrity: missing pages and conflicting figures ──
  add(
    layoutCase('integrity/missing-schedule-page', 'Four-page package with page 3 (the middle schedule page) missing: rows no longer add up to the printed grand total', () => standard(mechanical(), {}, { rowsPerPage: 10 }).filter((s) => s.kind !== 'lien_waiver'), { dropPages: [3] }, { expect: { flags: ['missing_page'] } }),
  );
  add(
    layoutCase(
      'integrity/total-differs-from-schedule',
      'G702 line 4 differs from the schedule’s grand total in column G',
      () => {
        const pkg = electric();
        const g702 = clone(pkg);
        g702.header.totalCompletedStored = (g702.header.totalCompletedStored ?? 0) + D(9000);
        return [{ kind: 'pay_application', pkg: g702 }, { kind: 'continuation_sheet', pkg }, { kind: 'lien_waiver', pkg }];
      },
      {},
      { expect: { flags: ['total_conflict'] } },
    ),
  );
  add(
    layoutCase(
      'integrity/application-number-differs',
      'The schedule header states application 3; the G702 states application 2',
      () => {
        const pkg = electric();
        return [{ kind: 'pay_application', pkg }, { kind: 'continuation_sheet', pkg: { ...clone(pkg), applicationNumber: 3 } }, { kind: 'lien_waiver', pkg }];
      },
      {},
      { expect: { flags: ['application_number_conflict'] } },
    ),
  );
  add(
    layoutCase(
      'integrity/two-pay-applications',
      'Two different pay applications (applications 1 and 2 of another subcontract) in one file',
      () => {
        const second = drywall();
        const first = clone(second);
        // Application 1 of the same subcontract, as it was submitted a month earlier.
        first.applicationNumber = 1;
        first.periodTo = '2026-09-30';
        first.applicationDate = '2026-09-25';
        first.lines = first.lines.map((l) => ({ ...l, previous: 0, thisPeriod: l.previous, total: l.previous, balance: l.scheduledValue - l.previous, retainage: Math.round(l.previous / 20) }));
        first.header = { ...first.header, totalCompletedStored: first.lines.reduce((a, l) => a + l.total, 0) };
        first.header.retainageWork = Math.round((first.header.totalCompletedStored ?? 0) / 20);
        first.header.retainageStored = 0;
        first.header.retainageTotal = first.header.retainageWork;
        first.header.totalEarnedLessRetainage = (first.header.totalCompletedStored ?? 0) - first.header.retainageTotal;
        first.header.lessPreviousCertificates = 0;
        first.header.currentPaymentDue = first.header.totalEarnedLessRetainage;
        first.header.balanceToFinish = (first.header.contractSumToDate ?? 0) - first.header.totalEarnedLessRetainage;
        return [
          { kind: 'pay_application', pkg: first, group: 1 },
          { kind: 'continuation_sheet', pkg: first, group: 1 },
          { kind: 'pay_application', pkg: second, group: 2 },
          { kind: 'continuation_sheet', pkg: second, group: 2 },
        ];
      },
      {},
      { expect: { flags: ['second_pay_application'] } },
    ),
  );

  // ── Scans: no text layer ──
  const scanTruth = (t: Truth): Truth => ({ ...t, expect: { ...t.expect, outcome: { 'text-layer': 'unreadable' }, flags: ['unreadable_page'] } });
  add({
    id: 'scan/image-only-pdf',
    title: 'The standard package as an image-only scan (no text layer)',
    build: async () => {
      const base = await legacyCase('scan/image-only-pdf', 'The standard package as an image-only scan (no text layer)', electric());
      return { ...base, file: pdfFile('scan__image-only-pdf', await scanned(base.file.bytes, { dpi: 150, seed: 11 })), truth: scanTruth(base.truth) };
    },
  });
  add({
    id: 'scan/low-resolution-noisy-pdf',
    title: 'A low-resolution, noisy scan (72 dpi, speckles and grain)',
    build: async () => {
      const base = await legacyCase('scan/low-resolution-noisy-pdf', 'A low-resolution, noisy scan (72 dpi, speckles and grain)', concrete());
      return { ...base, file: pdfFile('scan__low-resolution-noisy-pdf', await scanned(base.file.bytes, { dpi: 72, seed: 23, speckles: 0.01, grain: 50 })), truth: scanTruth(base.truth) };
    },
  });
  add({
    id: 'scan/photo-png',
    title: 'A photo of the G702 page as a PNG image',
    build: async () => {
      const pkg = electric();
      const secs: Section[] = [{ kind: 'pay_application', pkg, legacy: true }];
      const out = await renderLayout(secs);
      const page = (await readPdfText(out.bytes)).pages[0]!;
      const items: PlacedText[] = page.lines.flatMap((l) => l.cells.map((c) => ({ text: c.text, x: c.x, y: c.y, w: c.w, h: c.h })));
      const png = encodePng(pagePicture({ width: page.width, height: page.height, items }, { dpi: 110, seed: 5, speckles: 0.002, grain: 18 }));
      const truth = truthFor(secs, out, { description: 'A photo of the G702 page as a PNG image', tags: ['scan'] });
      return { id: 'scan/photo-png', file: { filename: 'scan__photo.png', mimeType: 'image/png', bytes: png }, truth: scanTruth(truth) };
    },
  });
  add({
    id: 'scan/one-scanned-page-in-text-pdf',
    title: 'A text PDF whose schedule page is a scanned image',
    build: async () => {
      const base = await legacyCase('scan/one-scanned-page-in-text-pdf', 'A text PDF whose schedule page is a scanned image', electric());
      return { ...base, file: pdfFile('scan__one-scanned-page-in-text-pdf', await scanned(base.file.bytes, { dpi: 150, seed: 31, pages: [2] })), truth: { ...base.truth, expect: { flags: ['unreadable_page'] } } };
    },
  });

  // ── Ink over print ──
  add({
    id: 'ink/handwritten-correction',
    title: 'G702 whose current payment due is struck through and corrected by hand (an image over the printed figure)',
    build: async () => {
      const pkg = electric();
      const secs = standard(pkg).filter((s) => s.kind === 'pay_application');
      const out = await renderLayout(secs);
      const a = out.anchors['payApp.currentPaymentDue']!;
      const corrected = (pkg.header.currentPaymentDue ?? 0) - D(5000);
      const h = 30;
      const w = a.w + 10;
      const png = encodePng(inkCorrection('98,500.00', w, h));
      const bytes = await overlay(out.bytes, [{ page: a.page, png, x: a.x - 5, y: a.y + 3.5 - 0.2 * h, w, h }]);
      const truth = truthFor(secs, out, {
        description: 'G702 whose current payment due is struck through and corrected by hand',
        tags: ['ink'],
        expect: {
          notes: ['drawn over'],
          knownLimitation: 'The text layer still carries the printed figure. A reader of the text layer cannot read the handwritten correction; the most it can do is notice that something is drawn over the figure and decline to vouch for it.',
        },
      });
      truth.payApp!.amounts!.currentPaymentDue = corrected;
      return { id: 'ink/handwritten-correction', file: pdfFile('ink__handwritten-correction', bytes), truth };
    },
  });
  add({
    id: 'ink/payapp-signed-in-ink',
    title: 'G702 signed with a handwritten signature (an image), no electronic signature block',
    build: async () => {
      const pkg = electric();
      pkg.signed = false;
      const secs = standard(pkg).filter((s) => s.kind === 'pay_application');
      const out = await renderLayout(secs);
      const a = out.anchors['payApp.signature']!;
      const bytes = await overlay(out.bytes, [{ page: a.page, png: encodePng(inkSignature(a.w, a.h, 7)), x: a.x, y: a.y, w: a.w, h: a.h }]);
      return { id: 'ink/payapp-signed-in-ink', file: pdfFile('ink__payapp-signed-in-ink', bytes), truth: truthFor(secs, out, { description: 'G702 signed in ink', tags: ['ink'], inkSignatures: ['payApp'] }) };
    },
  });

  // ── Lien waivers ──
  const waiverOnly = (pkg: SamplePackage, w: CustomWaiver): Section[] => [{ kind: 'lien_waiver', pkg, custom: w }];
  add(layoutCase('waiver/non-statutory-conditional', 'A conditional progress waiver on the subcontractor’s own wording', () => waiverOnly(drywall(), custom(drywall()))));
  add(layoutCase('waiver/listed-exceptions', 'A non-statutory waiver listing two exceptions', () => waiverOnly(electric(), custom(electric(), { exceptions: ['Retention of $22,500.00 held to date', 'Pending change order request No. 4 for added receptacles'] }))));
  add(layoutCase('waiver/exceptions-none-written', 'A non-statutory waiver whose exceptions section says "None"', () => waiverOnly(concrete(), custom(concrete(), { exceptions: 'none_written' }))));
  add(layoutCase('waiver/unsigned', 'A non-statutory waiver with a blank signature line', () => waiverOnly(drywall(), custom(drywall(), { signature: 'blank' }))));
  add({
    id: 'waiver/signed-in-ink',
    title: 'A non-statutory waiver signed by hand (an image), no electronic signature block',
    build: async () => {
      const pkg = drywall();
      const secs = waiverOnly(pkg, custom(pkg, { signature: 'ink' }));
      const out = await renderLayout(secs);
      const a = out.anchors['waiver.signature']!;
      const bytes = await overlay(out.bytes, [{ page: a.page, png: encodePng(inkSignature(a.w, a.h, 3)), x: a.x, y: a.y, w: a.w, h: a.h }]);
      return { id: 'waiver/signed-in-ink', file: pdfFile('waiver__signed-in-ink', bytes), truth: truthFor(secs, out, { description: 'A non-statutory waiver signed in ink', tags: ['ink'], inkSignatures: ['waiver'] }) };
    },
  });
  add(layoutCase('waiver/amount-in-words-only', 'A waiver that states its amount in words only', () => waiverOnly(electric(), custom(electric(), { amountStyle: 'words' })), {}, { expect: { abstain: ['waivers.0.amount'] } }));
  add(layoutCase('waiver/amount-in-words-and-figures', 'A waiver that states its amount in words and figures', () => waiverOnly(concrete(), custom(concrete(), { amountStyle: 'words_and_figures' }))));
  add(layoutCase('waiver/unconditional-final', 'A non-statutory unconditional final waiver', () => waiverOnly(drywall(), custom(drywall(), { type: 'unconditional_final', title: 'FINAL LIEN WAIVER AND RELEASE', throughDate: '2026-10-31' }))));
  add(layoutCase('waiver/ca-unconditional-with-exceptions', 'California unconditional progress waiver with additional exceptions', () => [{ kind: 'lien_waiver', pkg: waiverFor(mechanical(), { form: 'CA', type: 'unconditional_progress', exceptions: 'Disputed claim for extra duct rerouting, $12,400.00' }) }]));
  add(layoutCase('waiver/tx-unsigned', 'Texas conditional progress waiver, not signed', () => [{ kind: 'lien_waiver', pkg: waiverFor(electric(), { signed: false }) }]));

  return cases;
}

async function legacyCase(id: string, title: string, pkg: SamplePackage, opts: LayoutOptions = {}): Promise<CorpusCase> {
  const secs = legacy(pkg);
  const out = await renderLayout(secs, opts);
  // With no options the layout module's legacy sections must print exactly what renderPackage prints.
  const bytes = opts.rotate || opts.dropPages ? out.bytes : await renderPackage(pkg);
  return { id, file: pdfFile(id.replace(/\//g, '__'), bytes), truth: truthFor(secs, out, { description: title, tags: ['legacy-layout'] }) };
}

/** Build every synthetic case (or those whose id contains `filter`). */
export async function buildSyntheticCorpus(filter?: string): Promise<CorpusCase[]> {
  const out: CorpusCase[] = [];
  for (const c of syntheticCases()) if (!filter || c.id.includes(filter)) out.push(await c.build());
  return out;
}

export type { SampleLine };
