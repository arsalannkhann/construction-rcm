/**
 * Database schema.
 *
 * Conventions
 * - Every tenant-owned row carries `orgId`; every query must filter on it.
 * - Money is stored as integer cents (bigint). Rates are basis points (1% = 100).
 * - `jsonb` columns hold either immutable snapshots (extractions, approved
 *   records) or small structured blobs that are never aggregated in SQL.
 */
import {
  bigint,
  boolean,
  customType,
  date,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import type {
  ApprovedRecord,
  ClaimedHeader,
  ContractBaseline,
  DocumentSegment,
  EvidenceMap,
  ExtractionResult,
  FindingData,
  FindingRefs,
  HeaderCorrections,
  LineSnapshot,
  MatchCandidate,
  MemberOnboarding,
  OrgSettings,
  OwnerApplicationRecord,
  OwnerEntry,
  RetainageTerms,
  StatedParties,
  VerifiedHeader,
  WaiverSnapshot,
} from '@/server/types';

const cents = (name: string) => bigint(name, { mode: 'number' });
const ts = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });
const createdAt = () => ts('created_at').notNull().defaultNow();
/** Raw bytes. node-postgres hands back a Buffer, PGlite a Uint8Array; both come out as a Buffer. */
const bytea = customType<{ data: Uint8Array; driverData: Uint8Array | string }>({
  dataType: () => 'bytea',
  toDriver: (value) => Buffer.from(value),
  fromDriver: (value) => (typeof value === 'string' ? Buffer.from(value.replace(/^\\x/, ''), 'hex') : Buffer.from(value)),
});

// ── Identity & tenancy ──────────────────────────────────────────────────────

export const organizations = pgTable('organizations', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  isDemo: boolean('is_demo').notNull().default(false),
  /** Random token that addresses this org's inbound-email intake endpoint. */
  intakeToken: text('intake_token').notNull().unique(),
  settings: jsonb('settings').$type<OrgSettings>().notNull(),
  createdAt: createdAt(),
});

export const users = pgTable('users', {
  id: text('id').primaryKey(),
  email: text('email').notNull().unique(),
  name: text('name').notNull(),
  passwordHash: text('password_hash').notNull(),
  passwordChangedAt: ts('password_changed_at'),
  /** Two-step verification (TOTP). The secret is AES-256-GCM encrypted; it is only "on" once mfaEnabledAt is set. */
  mfaSecret: text('mfa_secret'),
  mfaEnabledAt: ts('mfa_enabled_at'),
  /** sha256 hashes of the unused one-time recovery codes. */
  mfaRecoveryCodes: jsonb('mfa_recovery_codes').$type<string[]>(),
  /** The last TOTP time-step that was accepted, so a code cannot be replayed. */
  mfaLastCounter: integer('mfa_last_counter'),
  createdAt: createdAt(),
  lastLoginAt: ts('last_login_at'),
});

export const memberships = pgTable(
  'memberships',
  {
    id: text('id').primaryKey(),
    orgId: text('org_id').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
    userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    role: text('role').notNull(),
    status: text('status').notNull().default('active'), // active | deactivated
    /** This member's welcome answers and tour progress in this organisation. Null until they have any. */
    onboarding: jsonb('onboarding').$type<MemberOnboarding>(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('memberships_org_user').on(t.orgId, t.userId)],
);

export const invitations = pgTable(
  'invitations',
  {
    id: text('id').primaryKey(),
    orgId: text('org_id').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
    email: text('email').notNull(),
    role: text('role').notNull(),
    tokenHash: text('token_hash').notNull().unique(),
    invitedBy: text('invited_by').notNull().references(() => users.id),
    expiresAt: ts('expires_at').notNull(),
    acceptedAt: ts('accepted_at'),
    revokedAt: ts('revoked_at'),
    createdAt: createdAt(),
  },
  (t) => [index('invitations_org').on(t.orgId)],
);

export const sessions = pgTable('sessions', {
  /** sha256 of the cookie token; the raw token is never stored. */
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  orgId: text('org_id').references(() => organizations.id, { onDelete: 'set null' }),
  createdAt: createdAt(),
  expiresAt: ts('expires_at').notNull(),
  lastSeenAt: ts('last_seen_at'),
  userAgent: text('user_agent'),
  ipAddress: text('ip_address'),
  /** Set when this session passed two-step verification. */
  mfaVerifiedAt: ts('mfa_verified_at'),
});

/** A password was accepted and a second step is still owed. Short-lived; the id is the sha256 of the cookie token. */
export const loginChallenges = pgTable('login_challenges', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  /**
   * Set when the sign-in is accepting an invitation for an account with
   * two-step verification: the membership is only created once the second
   * step passes, never on the password alone.
   */
  invitationId: text('invitation_id').references(() => invitations.id, { onDelete: 'cascade' }),
  attempts: integer('attempts').notNull().default(0),
  expiresAt: ts('expires_at').notNull(),
  createdAt: createdAt(),
});

/** One-time links for setting a new password. Only the hash of the token is stored. */
export const passwordResets = pgTable(
  'password_resets',
  {
    id: text('id').primaryKey(),
    userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    tokenHash: text('token_hash').notNull().unique(),
    /** The administrator who issued the link, or null when the user asked for it themselves. */
    issuedBy: text('issued_by').references(() => users.id, { onDelete: 'set null' }),
    expiresAt: ts('expires_at').notNull(),
    usedAt: ts('used_at'),
    createdAt: createdAt(),
  },
  (t) => [index('password_resets_user').on(t.userId)],
);

/** Sign-in, second-step and reset attempts, kept so throttling survives restarts and works across instances. */
export const authAttempts = pgTable(
  'auth_attempts',
  {
    id: text('id').primaryKey(),
    /** What is being throttled: a lower-cased email address, `ip:<address>`, `<email>|ip:<address>` or `<email>|reauth`. */
    subject: text('subject').notNull(),
    kind: text('kind').notNull(), // password | mfa | reset | signup
    succeeded: boolean('succeeded').notNull(),
    createdAt: createdAt(),
  },
  (t) => [index('auth_attempts_subject').on(t.subject, t.createdAt)],
);

// ── Projects, subcontractors, contracts ─────────────────────────────────────

export const projects = pgTable(
  'projects',
  {
    id: text('id').primaryKey(),
    orgId: text('org_id').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    number: text('number'),
    address: text('address'),
    city: text('city'),
    /** Two-letter US state; drives jurisdiction-specific waiver pre-screening. */
    state: text('state'),
    ownerName: text('owner_name'),
    /**
     * What the main contractor has set aside for this project's subcontracted work, as one figure. Optional;
     * compared with committed and pending changes. Once the project has budget lines this is cleared and the
     * budget is the total of its lines.
     */
    budget: cents('budget'),
    /** Set while the budget lines are locked: their original amounts are frozen and money moves by budget changes. */
    budgetLockedAt: ts('budget_locked_at'),
    budgetLockedBy: text('budget_locked_by').references(() => users.id),
    status: text('status').notNull().default('active'), // active | closed
    externalSource: text('external_source'),
    externalId: text('external_id'),
    createdBy: text('created_by'),
    createdAt: createdAt(),
  },
  (t) => [index('projects_org').on(t.orgId)],
);

export const subcontractors = pgTable(
  'subcontractors',
  {
    id: text('id').primaryKey(),
    orgId: text('org_id').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    trade: text('trade'),
    contactName: text('contact_name'),
    contactEmail: text('contact_email'),
    phone: text('phone'),
    address: text('address'),
    externalSource: text('external_source'),
    externalId: text('external_id'),
    createdAt: createdAt(),
  },
  (t) => [index('subcontractors_org').on(t.orgId)],
);

export const contracts = pgTable(
  'contracts',
  {
    id: text('id').primaryKey(),
    orgId: text('org_id').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
    projectId: text('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
    subcontractorId: text('subcontractor_id').notNull().references(() => subcontractors.id),
    number: text('number').notNull(),
    title: text('title').notNull(),
    originalAmount: cents('original_amount').notNull(),
    /** Retainage withheld on completed work, in basis points. */
    retainageWorkBps: integer('retainage_work_bps').notNull().default(1000),
    /** Retainage withheld on stored materials, in basis points. */
    retainageStoredBps: integer('retainage_stored_bps').notNull().default(1000),
    /** Agreed changes to the rate as the work progresses (for example 10% until 50% complete, then none). */
    retainageTerms: jsonb('retainage_terms').$type<RetainageTerms>(),
    executedOn: date('executed_on'),
    status: text('status').notNull().default('active'), // active | closed
    /**
     * Opening balances for a contract that was already being billed before it
     * was set up here. Used as the "previous" basis until an application is approved.
     */
    baseline: jsonb('baseline').$type<ContractBaseline>(),
    /** The line of the project's budget this subcontract's cost counts against. A line on the same project. */
    budgetLineId: text('budget_line_id').references(() => budgetLines.id, { onDelete: 'set null' }),
    externalSource: text('external_source'),
    externalId: text('external_id'),
    createdAt: createdAt(),
  },
  (t) => [index('contracts_org_project').on(t.orgId, t.projectId)],
);

// ── Budget by cost code ─────────────────────────────────────────────────────

/**
 * A line of a project's budget for subcontracted work, by cost code. Its
 * budget is the original amount plus the budget changes into it, less those
 * out of it. Subcontracts are assigned to a line; what is still to be
 * committed on it is a forecast, made by the method chosen for the line.
 */
export const budgetLines = pgTable(
  'budget_lines',
  {
    id: text('id').primaryKey(),
    orgId: text('org_id').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
    projectId: text('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
    costCode: text('cost_code').notNull(),
    description: text('description').notNull(),
    /** The budget as first set. Frozen while the project's budget is locked. */
    originalAmount: cents('original_amount').notNull(),
    /** How the cost still to be committed is forecast: remaining | entered | none (see FORECAST_METHOD_LABEL). */
    forecastMethod: text('forecast_method').notNull().default('remaining'),
    /** For `entered`: the cost still expected beyond what is committed and pending. */
    forecastAmount: cents('forecast_amount'),
    forecastNote: text('forecast_note'),
    forecastBy: text('forecast_by').references(() => users.id),
    forecastAt: ts('forecast_at'),
    sortOrder: integer('sort_order').notNull().default(0),
    createdBy: text('created_by').references(() => users.id),
    createdAt: createdAt(),
  },
  (t) => [index('budget_lines_org_project').on(t.orgId, t.projectId), uniqueIndex('budget_lines_code').on(t.projectId, t.costCode)],
);

/**
 * Money moved between budget lines (from contingency, say), added to the
 * budget (no `from`) or taken out of it (no `to`). Voided rather than deleted.
 */
export const budgetChanges = pgTable(
  'budget_changes',
  {
    id: text('id').primaryKey(),
    orgId: text('org_id').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
    projectId: text('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
    fromLineId: text('from_line_id').references(() => budgetLines.id),
    toLineId: text('to_line_id').references(() => budgetLines.id),
    /** Always above zero; the direction is from → to. */
    amount: cents('amount').notNull(),
    reason: text('reason').notNull(),
    status: text('status').notNull().default('approved'), // approved | void
    createdBy: text('created_by').references(() => users.id),
    voidedBy: text('voided_by').references(() => users.id),
    voidedAt: ts('voided_at'),
    createdAt: createdAt(),
  },
  (t) => [index('budget_changes_org_project').on(t.orgId, t.projectId)],
);

export const changeOrders = pgTable(
  'change_orders',
  {
    id: text('id').primaryKey(),
    orgId: text('org_id').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
    contractId: text('contract_id').notNull().references(() => contracts.id, { onDelete: 'cascade' }),
    number: text('number').notNull(),
    title: text('title').notNull(),
    amount: cents('amount').notNull(),
    status: text('status').notNull().default('pending'), // pending | approved | rejected | void
    approvedOn: date('approved_on'),
    externalId: text('external_id'),
    createdAt: createdAt(),
  },
  (t) => [index('change_orders_contract').on(t.contractId)],
);

/** Retainage the contractor has agreed to pay out early. Reduces the retainage held from `effectiveOn` onward. */
export const retainageReleases = pgTable(
  'retainage_releases',
  {
    id: text('id').primaryKey(),
    orgId: text('org_id').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
    contractId: text('contract_id').notNull().references(() => contracts.id, { onDelete: 'cascade' }),
    amount: cents('amount').notNull(),
    /** Applies to applications whose period ends on or after this date. */
    effectiveOn: date('effective_on').notNull(),
    note: text('note'),
    status: text('status').notNull().default('approved'), // approved | void
    createdBy: text('created_by').references(() => users.id),
    voidedBy: text('voided_by').references(() => users.id),
    voidedAt: ts('voided_at'),
    createdAt: createdAt(),
  },
  (t) => [index('retainage_releases_contract').on(t.contractId)],
);

export const sovLines = pgTable(
  'sov_lines',
  {
    id: text('id').primaryKey(),
    orgId: text('org_id').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
    contractId: text('contract_id').notNull().references(() => contracts.id, { onDelete: 'cascade' }),
    itemNo: text('item_no').notNull(),
    description: text('description').notNull(),
    scheduledValue: cents('scheduled_value').notNull(),
    sortOrder: integer('sort_order').notNull().default(0),
    /** Set when this line exists because of an approved change order. */
    changeOrderId: text('change_order_id').references(() => changeOrders.id, { onDelete: 'cascade' }),
    externalId: text('external_id'),
    createdAt: createdAt(),
  },
  (t) => [index('sov_lines_contract').on(t.contractId)],
);

// ── Owner billing: the prime contract and the main contractor's own applications ──

/** The main contractor's contract with the project owner. At most one per project. */
export const primeContracts = pgTable(
  'prime_contracts',
  {
    id: text('id').primaryKey(),
    orgId: text('org_id').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
    projectId: text('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
    number: text('number'),
    architectName: text('architect_name'),
    originalAmount: cents('original_amount').notNull(),
    retainageWorkBps: integer('retainage_work_bps').notNull().default(1000),
    retainageStoredBps: integer('retainage_stored_bps').notNull().default(1000),
    executedOn: date('executed_on'),
    createdBy: text('created_by').references(() => users.id),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('prime_contracts_project').on(t.projectId), index('prime_contracts_org').on(t.orgId)],
);

export const primeChangeOrders = pgTable(
  'prime_change_orders',
  {
    id: text('id').primaryKey(),
    orgId: text('org_id').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
    primeContractId: text('prime_contract_id').notNull().references(() => primeContracts.id, { onDelete: 'cascade' }),
    number: text('number').notNull(),
    title: text('title').notNull(),
    amount: cents('amount').notNull(),
    status: text('status').notNull().default('pending'), // pending | approved | rejected | void
    approvedOn: date('approved_on'),
    createdAt: createdAt(),
  },
  (t) => [index('prime_change_orders_contract').on(t.primeContractId)],
);

/** A line of the schedule of values the owner is billed against. */
export const primeLines = pgTable(
  'prime_lines',
  {
    id: text('id').primaryKey(),
    orgId: text('org_id').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
    primeContractId: text('prime_contract_id').notNull().references(() => primeContracts.id, { onDelete: 'cascade' }),
    itemNo: text('item_no').notNull(),
    description: text('description').notNull(),
    scheduledValue: cents('scheduled_value').notNull(),
    sortOrder: integer('sort_order').notNull().default(0),
    /** How the line is billed each period: subcontracts | overall | manual (see PRIME_LINE_BASIS_LABEL). */
    basis: text('basis').notNull().default('manual'),
    /** The subcontracts whose approved progress this line follows, when the basis is `subcontracts`. */
    contractIds: jsonb('contract_ids').$type<string[]>().notNull().default([]),
    /** Set when this line exists because of an approved owner change order. */
    changeOrderId: text('change_order_id').references(() => primeChangeOrders.id, { onDelete: 'cascade' }),
    createdAt: createdAt(),
  },
  (t) => [index('prime_lines_contract').on(t.primeContractId)],
);

/**
 * The main contractor's application for payment to the owner. While it is a
 * draft its figures are worked out afresh from the approved subcontractor
 * billing each time it is read, except for the lines someone typed over
 * (`entries`). Submitting freezes everything into `record`.
 */
export const ownerApplications = pgTable(
  'owner_applications',
  {
    id: text('id').primaryKey(),
    orgId: text('org_id').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
    projectId: text('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
    primeContractId: text('prime_contract_id').notNull().references(() => primeContracts.id, { onDelete: 'cascade' }),
    applicationNumber: integer('application_number').notNull(),
    periodTo: date('period_to').notNull(),
    status: text('status').notNull().default('draft'), // draft | submitted | certified
    /** Figures typed over the worked-out ones, by prime line id. */
    entries: jsonb('entries').$type<Record<string, OwnerEntry>>().notNull().default({}),
    /** Incremented by every change, so an edit made on stale figures is refused. */
    version: integer('version').notNull().default(0),
    preparedBy: text('prepared_by').references(() => users.id),
    submittedAt: ts('submitted_at'),
    submittedBy: text('submitted_by').references(() => users.id),
    /** Immutable snapshot written at submission; the PDF is rendered from it. */
    record: jsonb('record').$type<OwnerApplicationRecord>(),
    /** Line 8 (current payment due) as submitted. */
    amountDue: cents('amount_due'),
    /** What the owner or architect certified for payment, when it has been recorded. */
    certifiedAmount: cents('certified_amount'),
    certifiedOn: date('certified_on'),
    certificationNote: text('certification_note'),
    certifiedBy: text('certified_by').references(() => users.id),
    certifiedAt: ts('certified_at'),
    createdAt: createdAt(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [uniqueIndex('owner_applications_number').on(t.primeContractId, t.applicationNumber), index('owner_applications_org_project').on(t.orgId, t.projectId)],
);

// ── Pay applications ────────────────────────────────────────────────────────

export const payApplications = pgTable(
  'pay_applications',
  {
    id: text('id').primaryKey(),
    orgId: text('org_id').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
    projectId: text('project_id').references(() => projects.id),
    contractId: text('contract_id').references(() => contracts.id),
    subcontractorId: text('subcontractor_id').references(() => subcontractors.id),
    applicationNumber: integer('application_number'),
    periodTo: date('period_to'),
    /** processing | needs_matching | needs_review | pending_approval | on_hold | approved | rejected | void */
    status: text('status').notNull().default('processing'),
    receivedAt: ts('received_at').notNull().defaultNow(),
    receivedVia: text('received_via').notNull().default('upload'), // upload | email
    senderEmail: text('sender_email'),
    submittedBy: text('submitted_by').references(() => users.id),
    assigneeId: text('assignee_id').references(() => users.id),

    /** Which engine produced the current working values, and how many times we have extracted. */
    engine: text('engine'),
    revision: integer('revision').notNull().default(0),
    processingError: text('processing_error'),
    /**
     * Incremented by every change to the application, its lines, waivers or findings.
     * A decision carries the version the person was looking at, so nobody approves figures they have not seen.
     */
    version: integer('version').notNull().default(0),
    /** Summary values a reviewer corrected, with what was originally read, so a re-read can keep them. */
    headerCorrections: jsonb('header_corrections').$type<HeaderCorrections>(),
    /** Set on an application that was replaced by a corrected resubmission. */
    supersededById: text('superseded_by_id'),

    /** What the documents say about who/what this is (before matching to our records). */
    stated: jsonb('stated').$type<StatedParties>(),
    matchCandidates: jsonb('match_candidates').$type<MatchCandidate[]>(),

    /** The G702 summary exactly as the subcontractor submitted it (after any extraction corrections). */
    claimed: jsonb('claimed').$type<ClaimedHeader>().notNull(),
    /** Field-level provenance for `claimed`: where on which page each value was read. */
    evidence: jsonb('evidence').$type<EvidenceMap>().notNull(),
    /** Our independent computation from contract, change orders, prior approvals and line items. */
    verified: jsonb('verified').$type<VerifiedHeader>(),

    signed: text('signed'), // yes | no | unclear
    notarized: text('notarized'), // yes | no | unclear
    signatureConfirmedBy: text('signature_confirmed_by').references(() => users.id),
    signatureConfirmedAt: ts('signature_confirmed_at'),

    // Denormalised for list views and dashboard aggregation.
    claimedAmount: cents('claimed_amount'),
    verifiedAmount: cents('verified_amount'),
    openBlocking: integer('open_blocking').notNull().default(0),
    openWarnings: integer('open_warnings').notNull().default(0),

    submittedForApprovalAt: ts('submitted_for_approval_at'),
    submittedForApprovalBy: text('submitted_for_approval_by').references(() => users.id),
    holdSince: ts('hold_since'),

    decidedAt: ts('decided_at'),
    decidedBy: text('decided_by').references(() => users.id),
    decisionNote: text('decision_note'),
    approvedAmount: cents('approved_amount'),
    approvedRetainage: cents('approved_retainage'),
    /** Immutable snapshot written at approval; every export is rendered from this. */
    approvedRecord: jsonb('approved_record').$type<ApprovedRecord>(),

    transferStatus: text('transfer_status').notNull().default('none'), // none | exported | synced | failed

    createdAt: createdAt(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [
    index('pay_apps_org_status').on(t.orgId, t.status),
    index('pay_apps_contract').on(t.contractId),
  ],
);

/** `set({ version: nextVersion })` on any change to an application or what hangs off it. */
export const nextVersion = sql<number>`${payApplications.version} + 1`;

export const payAppLines = pgTable(
  'pay_app_lines',
  {
    id: text('id').primaryKey(),
    orgId: text('org_id').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
    payApplicationId: text('pay_application_id').notNull().references(() => payApplications.id, { onDelete: 'cascade' }),
    sovLineId: text('sov_line_id').references(() => sovLines.id, { onDelete: 'set null' }),
    sortOrder: integer('sort_order').notNull().default(0),
    itemNo: text('item_no'),
    description: text('description'),
    scheduledValue: cents('scheduled_value'), // column C
    previous: cents('previous'), // column D
    thisPeriod: cents('this_period'), // column E
    stored: cents('stored'), // column F
    total: cents('total'), // column G as stated
    balance: cents('balance'), // column H as stated
    retainage: cents('retainage'), // column I as stated
    /** Values exactly as extracted, with page/bbox evidence. Never mutated. */
    extracted: jsonb('extracted').$type<LineSnapshot>(),
    /** null | correction (document was misread) | adjustment (reviewer changed the approved amount) */
    editKind: text('edit_kind'),
    editNote: text('edit_note'),
    editedBy: text('edited_by').references(() => users.id),
    editedAt: ts('edited_at'),
  },
  (t) => [index('pay_app_lines_app').on(t.payApplicationId)],
);

export const documents = pgTable(
  'documents',
  {
    id: text('id').primaryKey(),
    orgId: text('org_id').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
    payApplicationId: text('pay_application_id').references(() => payApplications.id, { onDelete: 'cascade' }),
    filename: text('filename').notNull(),
    mimeType: text('mime_type').notNull(),
    size: integer('size').notNull(),
    sha256: text('sha256').notNull(),
    storageKey: text('storage_key').notNull(),
    pageCount: integer('page_count'),
    hasTextLayer: boolean('has_text_layer'),
    /** uploaded | processed | unreadable | failed */
    status: text('status').notNull().default('uploaded'),
    statusDetail: text('status_detail'),
    segments: jsonb('segments').$type<DocumentSegment[]>().notNull(),
    source: text('source').notNull().default('upload'), // upload | email
    uploadedBy: text('uploaded_by').references(() => users.id),
    createdAt: createdAt(),
  },
  (t) => [index('documents_app').on(t.payApplicationId), index('documents_org_sha').on(t.orgId, t.sha256)],
);

export const extractions = pgTable(
  'extractions',
  {
    id: text('id').primaryKey(),
    orgId: text('org_id').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
    documentId: text('document_id').notNull().references(() => documents.id, { onDelete: 'cascade' }),
    payApplicationId: text('pay_application_id').references(() => payApplications.id, { onDelete: 'cascade' }),
    engine: text('engine').notNull(),
    model: text('model'),
    status: text('status').notNull(), // succeeded | failed
    result: jsonb('result').$type<ExtractionResult>(),
    error: text('error'),
    durationMs: integer('duration_ms'),
    createdAt: createdAt(),
  },
  (t) => [index('extractions_document').on(t.documentId)],
);

export const lienWaivers = pgTable(
  'lien_waivers',
  {
    id: text('id').primaryKey(),
    orgId: text('org_id').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
    payApplicationId: text('pay_application_id').notNull().references(() => payApplications.id, { onDelete: 'cascade' }),
    documentId: text('document_id').notNull().references(() => documents.id, { onDelete: 'cascade' }),
    page: integer('page').notNull().default(1),
    /** conditional_progress | unconditional_progress | conditional_final | unconditional_final | unknown */
    waiverType: text('waiver_type').notNull(),
    /** State whose statutory form the document's wording resembles, if any. */
    formState: text('form_state'),
    title: text('title'),
    claimant: text('claimant'),
    customer: text('customer'),
    owner: text('owner'),
    jobDescription: text('job_description'),
    throughDate: date('through_date'),
    amount: cents('amount'),
    exceptions: text('exceptions'),
    signed: text('signed'), // yes | no | unclear
    signerName: text('signer_name'),
    signerTitle: text('signer_title'),
    signedDate: date('signed_date'),
    notarized: text('notarized'),
    extracted: jsonb('extracted').$type<WaiverSnapshot>(),
    editedBy: text('edited_by').references(() => users.id),
    editedAt: ts('edited_at'),
  },
  (t) => [index('lien_waivers_app').on(t.payApplicationId)],
);

export const findings = pgTable(
  'findings',
  {
    id: text('id').primaryKey(),
    orgId: text('org_id').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
    payApplicationId: text('pay_application_id').notNull().references(() => payApplications.id, { onDelete: 'cascade' }),
    code: text('code').notNull(),
    /** Distinguishes multiple results of the same check (e.g. one per line). */
    subjectKey: text('subject_key').notNull().default(''),
    category: text('category').notNull(),
    severity: text('severity').notNull(), // blocking | warning | info
    /** open | passed | accepted */
    status: text('status').notNull(),
    title: text('title').notNull(),
    detail: text('detail').notNull(),
    action: text('action'),
    /** True when resolving this is a legally consequential judgement call. */
    needsQualifiedReview: boolean('needs_qualified_review').notNull().default(false),
    data: jsonb('data').$type<FindingData>(),
    refs: jsonb('refs').$type<FindingRefs>(),
    /** Hash of the facts behind the finding. An accepted finding reopens if this changes. */
    fingerprint: text('fingerprint').notNull(),
    resolvedBy: text('resolved_by').references(() => users.id),
    resolvedAt: ts('resolved_at'),
    resolutionNote: text('resolution_note'),
    sortOrder: integer('sort_order').notNull().default(0),
    createdAt: createdAt(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('findings_app_code_subject').on(t.payApplicationId, t.code, t.subjectKey),
    index('findings_org_status').on(t.orgId, t.status),
  ],
);

export const comments = pgTable(
  'comments',
  {
    id: text('id').primaryKey(),
    orgId: text('org_id').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
    payApplicationId: text('pay_application_id').notNull().references(() => payApplications.id, { onDelete: 'cascade' }),
    userId: text('user_id').notNull().references(() => users.id),
    body: text('body').notNull(),
    createdAt: createdAt(),
  },
  (t) => [index('comments_app').on(t.payApplicationId)],
);

/** Messages to subcontractors. `status` is the literal delivery outcome, never optimistic. */
export const communications = pgTable(
  'communications',
  {
    id: text('id').primaryKey(),
    orgId: text('org_id').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
    payApplicationId: text('pay_application_id').notNull().references(() => payApplications.id, { onDelete: 'cascade' }),
    kind: text('kind').notNull(), // correction_request | decision_notice | general
    toEmail: text('to_email'),
    subject: text('subject').notNull(),
    body: text('body').notNull(),
    /** sent (provider accepted) | not_sent (no provider configured; drafted only) | failed | unconfirmed (no answer from the provider: may have been sent) */
    status: text('status').notNull(),
    provider: text('provider'),
    providerRef: text('provider_ref'),
    error: text('error'),
    createdBy: text('created_by').notNull().references(() => users.id),
    createdAt: createdAt(),
  },
  (t) => [index('communications_app').on(t.payApplicationId)],
);

export const notifications = pgTable(
  'notifications',
  {
    id: text('id').primaryKey(),
    orgId: text('org_id').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
    userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    type: text('type').notNull(),
    title: text('title').notNull(),
    body: text('body'),
    href: text('href'),
    readAt: ts('read_at'),
    createdAt: createdAt(),
  },
  (t) => [index('notifications_user').on(t.orgId, t.userId, t.readAt)],
);

/** Append-only, hash-chained per organisation. Never updated or deleted by application code. */
export const auditEvents = pgTable(
  'audit_events',
  {
    id: text('id').primaryKey(),
    orgId: text('org_id').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
    seq: integer('seq').notNull(),
    actorType: text('actor_type').notNull(), // user | system
    actorId: text('actor_id'),
    actorName: text('actor_name').notNull(),
    action: text('action').notNull(),
    entityType: text('entity_type').notNull(),
    entityId: text('entity_id'),
    payApplicationId: text('pay_application_id'),
    summary: text('summary').notNull(),
    data: jsonb('data').$type<Record<string, unknown>>(),
    prevHash: text('prev_hash').notNull(),
    hash: text('hash').notNull(),
    createdAt: ts('created_at').notNull(),
  },
  (t) => [
    uniqueIndex('audit_org_seq').on(t.orgId, t.seq),
    index('audit_app').on(t.payApplicationId),
  ],
);

export const integrations = pgTable(
  'integrations',
  {
    id: text('id').primaryKey(),
    orgId: text('org_id').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
    provider: text('provider').notNull(), // procore
    status: text('status').notNull(), // connected | error
    config: jsonb('config').$type<Record<string, unknown>>().notNull(),
    /** AES-256-GCM encrypted JSON (tokens). */
    credentials: text('credentials'),
    lastSyncAt: ts('last_sync_at'),
    lastError: text('last_error'),
    connectedBy: text('connected_by').references(() => users.id),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('integrations_org_provider').on(t.orgId, t.provider)],
);

/** One row per export or integration push of an approved application. */
export const transfers = pgTable(
  'transfers',
  {
    id: text('id').primaryKey(),
    orgId: text('org_id').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
    payApplicationId: text('pay_application_id').notNull().references(() => payApplications.id, { onDelete: 'cascade' }),
    kind: text('kind').notNull(), // csv | json | pdf | procore
    status: text('status').notNull(), // completed | failed
    filename: text('filename'),
    storageKey: text('storage_key'),
    sha256: text('sha256'),
    externalRef: text('external_ref'),
    error: text('error'),
    createdBy: text('created_by').references(() => users.id),
    createdAt: createdAt(),
  },
  (t) => [index('transfers_org').on(t.orgId), index('transfers_app').on(t.payApplicationId)],
);

/** Durable work queue for document processing. */
export const jobs = pgTable(
  'jobs',
  {
    id: text('id').primaryKey(),
    orgId: text('org_id').notNull(),
    type: text('type').notNull(),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
    status: text('status').notNull().default('queued'), // queued | running | succeeded | failed
    attempts: integer('attempts').notNull().default(0),
    error: text('error'),
    /** Not before this time (set when a failed attempt is waiting to be retried). */
    runAfter: ts('run_after'),
    /** Which runner claimed it, for diagnosing a job stuck in `running`. */
    lockedBy: text('locked_by'),
    createdAt: createdAt(),
    startedAt: ts('started_at'),
    finishedAt: ts('finished_at'),
  },
  (t) => [index('jobs_status').on(t.status), index('jobs_org').on(t.orgId)],
);

/**
 * Document and export bytes, when they are kept in the database instead of on
 * local disk. Content-addressed: the key ends in the sha256 of the bytes.
 */
export const storedObjects = pgTable(
  'stored_objects',
  {
    key: text('key').primaryKey(),
    orgId: text('org_id').notNull(),
    sha256: text('sha256').notNull(),
    size: integer('size').notNull(),
    bytes: bytea('bytes').notNull(),
    createdAt: createdAt(),
  },
  (t) => [index('stored_objects_org').on(t.orgId)],
);

/**
 * Pieces of a file on its way in, for hosting that caps the size of a single
 * request (Vercel: 4.5 MB). The browser sends a large file in parts; the
 * request that creates the application, or adds documents to one, joins them,
 * checks that they add up, and deletes them. Parts nobody claimed are removed
 * after a few hours. Each part belongs to the member who sent it.
 */
export const uploadParts = pgTable(
  'upload_parts',
  {
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    orgId: text('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    /** Chosen by the browser: random, and only meaningful together with the user. */
    uploadId: text('upload_id').notNull(),
    part: integer('part').notNull(),
    bytes: bytea('bytes').notNull(),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.uploadId, t.part] }), index('upload_parts_created').on(t.createdAt)],
);

// ── Subcontractor portal ────────────────────────────────────────────────────

/**
 * A link a subcontractor uses, without an account, to upload billing for one
 * subcontract and follow what happened to it. Whoever holds the link can do
 * exactly that and nothing else. At most one link per subcontract is live; a
 * replaced or turned-off link stops working at once.
 */
export const portalLinks = pgTable(
  'portal_links',
  {
    id: text('id').primaryKey(),
    orgId: text('org_id').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
    contractId: text('contract_id').notNull().references(() => contracts.id, { onDelete: 'cascade' }),
    /** SHA-256 of the token in the link: what a request is looked up by. */
    tokenHash: text('token_hash').notNull().unique(),
    /** The token itself, encrypted with RCM_SECRET_KEY, so the team can copy the link again and reminders can carry it. */
    tokenEnc: text('token_enc').notNull(),
    /** Where reminders and the link itself are emailed. */
    email: text('email'),
    reminders: boolean('reminders').notNull().default(true),
    createdBy: text('created_by').notNull().references(() => users.id),
    createdAt: createdAt(),
    lastUsedAt: ts('last_used_at'),
    revokedAt: ts('revoked_at'),
    revokedBy: text('revoked_by').references(() => users.id),
  },
  (t) => [index('portal_links_org_contract').on(t.orgId, t.contractId), uniqueIndex('portal_links_live').on(t.contractId).where(sql`revoked_at is null`)],
);

/** Parts of a large file sent through a portal link (the portal's counterpart of `upload_parts`). */
export const portalUploadParts = pgTable(
  'portal_upload_parts',
  {
    linkId: text('link_id')
      .notNull()
      .references(() => portalLinks.id, { onDelete: 'cascade' }),
    orgId: text('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    uploadId: text('upload_id').notNull(),
    part: integer('part').notNull(),
    bytes: bytea('bytes').notNull(),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.linkId, t.uploadId, t.part] }), index('portal_upload_parts_created').on(t.createdAt)],
);

/** Every email about a portal link: the link itself, and the reminders when a period is due. `status` is the literal delivery outcome. */
export const portalEmails = pgTable(
  'portal_emails',
  {
    id: text('id').primaryKey(),
    orgId: text('org_id').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
    linkId: text('link_id')
      .notNull()
      .references(() => portalLinks.id, { onDelete: 'cascade' }),
    contractId: text('contract_id').notNull().references(() => contracts.id, { onDelete: 'cascade' }),
    /** link | due_soon | overdue */
    kind: text('kind').notNull(),
    /** The billing month a reminder is about ("2026-11"); null for the link itself. */
    period: text('period'),
    toEmail: text('to_email').notNull(),
    subject: text('subject').notNull(),
    body: text('body').notNull(),
    /** sending | sent | not_sent | failed | unconfirmed, as for `communications`. */
    status: text('status').notNull(),
    provider: text('provider'),
    providerRef: text('provider_ref'),
    error: text('error'),
    /** Null when the scheduler sent it. */
    createdBy: text('created_by').references(() => users.id),
    createdAt: createdAt(),
  },
  (t) => [
    index('portal_emails_org_contract').on(t.orgId, t.contractId, t.createdAt),
    // One reminder of each kind per subcontract and month, whichever link was live.
    uniqueIndex('portal_emails_reminder_once').on(t.contractId, t.kind, t.period),
  ],
);

/** Every message that reached the email-intake address, including the ones that were turned away. */
export const inboundMessages = pgTable(
  'inbound_messages',
  {
    id: text('id').primaryKey(),
    orgId: text('org_id').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
    /** The Message-ID header, or a hash of the content when the message has none. */
    messageId: text('message_id').notNull(),
    fromEmail: text('from_email'),
    subject: text('subject'),
    /** accepted | duplicate | rejected */
    outcome: text('outcome').notNull(),
    reason: text('reason'),
    attachments: integer('attachments').notNull().default(0),
    payApplicationId: text('pay_application_id'),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('inbound_messages_org_message').on(t.orgId, t.messageId), index('inbound_messages_org_created').on(t.orgId, t.createdAt)],
);

/**
 * Messages sent through the "design partner" form on the public website. They
 * belong to no organisation: they are for the people who run Zephric, and no
 * page in the app shows them (read them in the database; see docs/operations.md).
 */
export const inquiries = pgTable(
  'inquiries',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    email: text('email').notNull(),
    company: text('company').notNull(),
    country: text('country').notNull(),
    role: text('role').notNull(),
    challenge: text('challenge').notNull(),
    /** Which version of the privacy notice the sender agreed to. */
    consentVersion: text('consent_version').notNull(),
    /** Keyed hash of the sender's network address, to limit repeated submissions without keeping the address. */
    senderHash: text('sender_hash'),
    createdAt: createdAt(),
  },
  (t) => [index('inquiries_sender_created').on(t.senderHash, t.createdAt), index('inquiries_created').on(t.createdAt)],
);

/**
 * Each run of the scheduled endpoint (/api/jobs/run), so that it can be shown
 * the scheduler is really calling it: on Vercel's Hobby plan its own logs last
 * one hour. The newest runs are kept; health reports when the last one was.
 */
export const scheduledRuns = pgTable(
  'scheduled_runs',
  {
    id: text('id').primaryKey(),
    startedAt: ts('started_at').notNull(),
    finishedAt: ts('finished_at').notNull(),
    /** Jobs this run processed. */
    ran: integer('ran').notNull(),
    queued: integer('queued').notNull(),
    failed: integer('failed').notNull(),
  },
  (t) => [index('scheduled_runs_started').on(t.startedAt)],
);
