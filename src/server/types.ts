/**
 * Shared domain types. Pure data shapes only; no runtime dependencies, so this
 * file can be imported from client components as well as the server.
 */

// ── Roles ───────────────────────────────────────────────────────────────────

export const ROLES = ['owner', 'admin', 'controller', 'accountant', 'project_manager', 'viewer'] as const;
export type Role = (typeof ROLES)[number];

// ── Organisation policy ─────────────────────────────────────────────────────

export type OrgSettings = {
  /** Differences up to this many cents are treated as rounding, not discrepancies. */
  toleranceCents: number;
  /** A conditional progress waiver covering the current payment must be in the package. */
  requireConditionalWaiver: boolean;
  /** From application #2 onward, expect an unconditional waiver for the previous payment. */
  requirePriorUnconditionalWaiver: boolean;
  /** The pay application must carry the subcontractor's signature. */
  requireSignature: boolean;
  /** The pay application must be notarised. */
  requireNotarization: boolean;
  /** Extracted values below this confidence are flagged for a human look. */
  lowConfidenceThreshold: number;
  /** Every member must set up two-step verification before they can work in this organisation. */
  requireMfa: boolean;
  /**
   * Email from an address that is not on file for a subcontractor or a team member:
   * `flag` accepts it with a blocking finding, `reject` turns it away.
   */
  unknownSenderPolicy: 'flag' | 'reject';
};

export const DEFAULT_ORG_SETTINGS: OrgSettings = {
  toleranceCents: 100,
  requireConditionalWaiver: true,
  requirePriorUnconditionalWaiver: false,
  requireSignature: true,
  requireNotarization: false,
  lowConfidenceThreshold: 0.75,
  requireMfa: false,
  unknownSenderPolicy: 'flag',
};

/** Settings saved before a field existed do not have it; always read through this. */
export function resolveSettings(stored: Partial<OrgSettings> | null | undefined): OrgSettings {
  return { ...DEFAULT_ORG_SETTINGS, ...(stored ?? {}) };
}

/** Agreed changes to the retainage rate on completed work as the contract progresses. */
export type RetainageTerms = {
  reduction: {
    /** Share of the contract sum to date that must be complete (work in place, not stored material) before the rate changes, in basis points. */
    atPercentBps: number;
    /** The rate on completed work from that point on, in basis points. */
    toBps: number;
    /** `future_work`: only work beyond the threshold is at the new rate. `all_work`: the new rate applies to everything, releasing the difference. */
    appliesTo: 'future_work' | 'all_work';
  } | null;
};

/** For each corrected summary value: what was read from the document and what the reviewer changed it to. */
export type HeaderCorrections = Record<string, { from: number | string | null; to: number | string | null }>;

// ── Documents & extraction ──────────────────────────────────────────────────

export const DOC_TYPES = [
  'pay_application',
  'continuation_sheet',
  'lien_waiver',
  'invoice',
  'change_order',
  'contract',
  'insurance',
  'other',
] as const;
export type DocType = (typeof DOC_TYPES)[number];

export const DOC_TYPE_LABEL: Record<DocType, string> = {
  pay_application: 'Pay application (G702)',
  continuation_sheet: 'Schedule of values (G703)',
  lien_waiver: 'Lien waiver',
  invoice: 'Invoice',
  change_order: 'Change order',
  contract: 'Contract',
  insurance: 'Insurance certificate',
  other: 'Other',
};

export type DocumentSegment = {
  type: DocType;
  pageStart: number;
  pageEnd: number;
  confidence: number;
};

/** x, y, width, height as fractions of the page, origin top-left. */
export type BBox = [number, number, number, number];

export type Extracted<T> = {
  value: T | null;
  /** 0..1. Engines must report low confidence rather than guess. */
  confidence: number;
  page: number | null;
  bbox?: BBox | null;
  /** The literal text the value was read from. */
  source?: string | null;
};

export type Tri = 'yes' | 'no' | 'unclear';

/** The nine G702 summary lines, with retainage split into its parts. */
export const CLAIMED_FIELDS = [
  'originalContractSum',
  'netChangeOrders',
  'contractSumToDate',
  'totalCompletedStored',
  'retainageWork',
  'retainageStored',
  'retainageTotal',
  'totalEarnedLessRetainage',
  'lessPreviousCertificates',
  'currentPaymentDue',
  'balanceToFinish',
] as const;
export type ClaimedField = (typeof CLAIMED_FIELDS)[number];

export const CLAIMED_FIELD_LABEL: Record<ClaimedField, string> = {
  originalContractSum: 'Original contract sum',
  netChangeOrders: 'Net change by change orders',
  contractSumToDate: 'Contract sum to date',
  totalCompletedStored: 'Total completed & stored to date',
  retainageWork: 'Retainage on completed work',
  retainageStored: 'Retainage on stored material',
  retainageTotal: 'Total retainage',
  totalEarnedLessRetainage: 'Total earned less retainage',
  lessPreviousCertificates: 'Less previous certificates',
  currentPaymentDue: 'Current payment due',
  balanceToFinish: 'Balance to finish, incl. retainage',
};

/** G702 line number shown next to each field. */
export const CLAIMED_FIELD_LINE: Record<ClaimedField, string> = {
  originalContractSum: '1',
  netChangeOrders: '2',
  contractSumToDate: '3',
  totalCompletedStored: '4',
  retainageWork: '5a',
  retainageStored: '5b',
  retainageTotal: '5',
  totalEarnedLessRetainage: '6',
  lessPreviousCertificates: '7',
  currentPaymentDue: '8',
  balanceToFinish: '9',
};

export type ClaimedHeader = Record<ClaimedField, number | null>;

export type VerifiedHeader = Record<ClaimedField, number> & {
  /** Application number of the approved application these figures build on, if any. */
  priorApplicationNumber: number | null;
  /** Line items excluded from the verified totals because they match nothing in the contract. */
  excludedLines: number;
  /** Recorded retainage releases applied in arriving at the retainage held. Absent on records from before releases existed. */
  retainageReleased?: number;
  /** How the retainage held was calculated, in words. */
  retainageBasis?: string;
};

export const EMPTY_CLAIMED: ClaimedHeader = {
  originalContractSum: null,
  netChangeOrders: null,
  contractSumToDate: null,
  totalCompletedStored: null,
  retainageWork: null,
  retainageStored: null,
  retainageTotal: null,
  totalEarnedLessRetainage: null,
  lessPreviousCertificates: null,
  currentPaymentDue: null,
  balanceToFinish: null,
};

export type StatedParties = {
  projectName: string | null;
  projectNumber: string | null;
  contractorName: string | null;
  toName: string | null;
  contractNumber: string | null;
  contractDate: string | null;
  applicationDate: string | null;
  signerName: string | null;
};

export type ExtractedPayApp = {
  applicationNumber: Extracted<number>;
  periodTo: Extracted<string>;
  applicationDate: Extracted<string>;
  projectName: Extracted<string>;
  projectNumber: Extracted<string>;
  contractorName: Extracted<string>;
  toName: Extracted<string>;
  contractNumber: Extracted<string>;
  contractDate: Extracted<string>;
  amounts: Record<ClaimedField, Extracted<number>>;
  signed: Extracted<Tri>;
  signerName: Extracted<string>;
  notarized: Extracted<Tri>;
};

export const LINE_AMOUNT_FIELDS = [
  'scheduledValue',
  'previous',
  'thisPeriod',
  'stored',
  'total',
  'balance',
  'retainage',
] as const;
export type LineAmountField = (typeof LINE_AMOUNT_FIELDS)[number];

export type ExtractedLine = {
  itemNo: string | null;
  description: string | null;
  page: number;
  /** Bounding box of the whole row. */
  bbox?: BBox | null;
  confidence: number;
} & Record<LineAmountField, number | null>;

export type LineSnapshot = ExtractedLine & { documentId: string };

export const WAIVER_TYPES = [
  'conditional_progress',
  'unconditional_progress',
  'conditional_final',
  'unconditional_final',
  'unknown',
] as const;
export type WaiverType = (typeof WAIVER_TYPES)[number];

export const WAIVER_TYPE_LABEL: Record<WaiverType, string> = {
  conditional_progress: 'Conditional waiver – progress payment',
  unconditional_progress: 'Unconditional waiver – progress payment',
  conditional_final: 'Conditional waiver – final payment',
  unconditional_final: 'Unconditional waiver – final payment',
  unknown: 'Waiver (type not determined)',
};

export type ExtractedWaiver = {
  page: number;
  waiverType: Extracted<WaiverType>;
  /** State whose statutory form wording the document resembles. */
  formState: Extracted<string>;
  title: Extracted<string>;
  claimant: Extracted<string>;
  customer: Extracted<string>;
  owner: Extracted<string>;
  jobDescription: Extracted<string>;
  throughDate: Extracted<string>;
  amount: Extracted<number>;
  exceptions: Extracted<string>;
  signed: Extracted<Tri>;
  signerName: Extracted<string>;
  signerTitle: Extracted<string>;
  signedDate: Extracted<string>;
  notarized: Extracted<Tri>;
};

export type WaiverSnapshot = ExtractedWaiver & { documentId: string };

export type ExtractionResult = {
  engine: string;
  model?: string;
  segments: DocumentSegment[];
  payApp?: ExtractedPayApp;
  lines?: ExtractedLine[];
  /** Column totals printed on the continuation sheet, when present. */
  lineTotals?: Partial<Record<LineAmountField, number | null>>;
  waivers?: ExtractedWaiver[];
  /** Anything the engine could not read or was unsure about, in plain language. */
  notes: string[];
};

export type Evidence = {
  documentId: string;
  page: number;
  bbox?: BBox | null;
  source?: string | null;
  confidence: number;
};
/** Keyed by claimed field name, or `applicationNumber` / `periodTo` / `signed`. */
export type EvidenceMap = Record<string, Evidence>;

export type MatchCandidate = {
  contractId: string;
  score: number;
  reasons: string[];
};

/** Billing that happened before the contract was tracked in this system. */
export type ContractBaseline = {
  /** The last application number covered by these opening balances. */
  asOfApplicationNumber: number;
  /** Total earned less retainage certified before tracking began (G702 line 7 of the first application seen). */
  previousCertificates: number;
  /** Retainage held as of the baseline, if known. */
  retainageHeld: number | null;
  /** Work completed to date per schedule-of-values line id. */
  workToDate: Record<string, number>;
  sourceApplicationId: string | null;
  setBy: string;
  setAt: string;
};

// ── Findings ────────────────────────────────────────────────────────────────

export const FINDING_CATEGORIES = [
  'documents',
  'math',
  'contract',
  'change_orders',
  'schedule',
  'prior_billing',
  'retainage',
  'payment',
  'compliance',
  'extraction',
] as const;
export type FindingCategory = (typeof FINDING_CATEGORIES)[number];

export const FINDING_CATEGORY_LABEL: Record<FindingCategory, string> = {
  documents: 'Package completeness',
  math: 'Arithmetic',
  contract: 'Contract value',
  change_orders: 'Change orders',
  schedule: 'Schedule of values',
  prior_billing: 'Prior billing',
  retainage: 'Retainage',
  payment: 'Payment amount',
  compliance: 'Lien waivers',
  extraction: 'Document reading',
};

export type Severity = 'blocking' | 'warning' | 'info';
/** open: needs attention · passed: the check succeeded · accepted: a person signed off on it as-is */
export type FindingStatus = 'open' | 'passed' | 'accepted';

export type FindingData = {
  expected?: number | null;
  actual?: number | null;
  delta?: number | null;
  expectedText?: string | null;
  actualText?: string | null;
};

export type FindingRefs = {
  /** Evidence key to highlight in the document viewer. */
  field?: string;
  lineId?: string;
  sovLineId?: string;
  waiverId?: string;
  documentId?: string;
  page?: number;
  tab?: 'summary' | 'lines' | 'compliance' | 'documents';
};

// ── Approved record (immutable snapshot) ────────────────────────────────────

export type ApprovedLine = {
  itemNo: string | null;
  description: string | null;
  sovLineId: string | null;
  scheduledValue: number;
  previous: number;
  thisPeriod: number;
  stored: number;
  total: number;
  balance: number;
  retainage: number;
  adjusted: boolean;
  adjustmentNote: string | null;
};

export type ApprovedRecord = {
  schemaVersion: 1;
  approvedAt: string;
  approvedBy: { id: string; name: string; role: Role };
  note: string | null;
  organization: { id: string; name: string };
  project: { id: string; name: string; number: string | null; state: string | null; externalId: string | null };
  subcontractor: { id: string; name: string; externalId: string | null };
  contract: {
    id: string;
    number: string;
    title: string;
    originalAmount: number;
    retainageWorkBps: number;
    retainageStoredBps: number;
    /** Stepped-rate terms in force at approval, if any. */
    retainageTerms?: RetainageTerms | null;
    externalId: string | null;
  };
  /** Retainage releases that were counted in this approval. */
  retainageReleases?: { amount: number; effectiveOn: string; note: string | null }[];
  application: { id: string; number: number; periodTo: string; receivedAt: string };
  claimed: ClaimedHeader;
  approved: VerifiedHeader;
  /** Approved payment minus what the subcontractor asked for. Negative means short-paid. */
  varianceFromClaimed: number | null;
  lines: ApprovedLine[];
  changeOrders: { number: string; title: string; amount: number; approvedOn: string | null }[];
  acceptedFindings: {
    code: string;
    severity: Severity;
    title: string;
    note: string | null;
    by: string | null;
    at: string | null;
  }[];
  waivers: { type: WaiverType; amount: number | null; throughDate: string | null; signed: Tri | null }[];
  documents: { id: string; filename: string; sha256: string; pages: number | null }[];
};

// ── Application status ──────────────────────────────────────────────────────

export const APP_STATUSES = [
  'processing',
  'needs_matching',
  'needs_review',
  'pending_approval',
  'on_hold',
  'approved',
  'rejected',
  'void',
] as const;
export type AppStatus = (typeof APP_STATUSES)[number];

export const APP_STATUS_LABEL: Record<AppStatus, string> = {
  processing: 'Processing',
  needs_matching: 'Needs matching',
  needs_review: 'Needs review',
  pending_approval: 'Pending approval',
  on_hold: 'Awaiting subcontractor',
  approved: 'Approved',
  rejected: 'Rejected',
  void: 'Void',
};

/** Statuses in which the working values can still change. */
export const OPEN_STATUSES: AppStatus[] = ['needs_matching', 'needs_review', 'pending_approval', 'on_hold'];
