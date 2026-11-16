/**
 * Intake and processing of billing packages.
 *
 *   receive files  →  store originals  →  read each document  →  merge into one
 *   application    →  match to a contract  →  reconcile  →  ready for review
 *
 * Originals are stored before anything else happens and are never modified.
 */
import path from 'node:path';
import { and, asc, eq } from 'drizzle-orm';
import type { DB } from '@/db';
import { locked, withOrgLock } from '@/db/tx';
import { contracts, documents, extractions, lienWaivers, payAppLines, payApplications, projects, sovLines, subcontractors, nextVersion } from '@/db/schema';
import { recordAudit, type AuditActor } from '@/server/audit';
import { assertCan, UserError, type Ctx } from '@/server/auth/permissions';
import { extractDocument, type ExtractOptions } from '@/server/documents/extract';
import { newId } from '@/server/ids';
import { enqueueJob, MAX_ATTEMPTS, registerJobHandler } from '@/server/jobs';
import { confidentMatch, mapLinesToSov, rankContracts } from '@/server/recon/matching';
import { getObject, putObject } from '@/server/storage';
import type { ClaimedField, ClaimedHeader, DocumentSegment, EvidenceMap, ExtractedLine, ExtractedWaiver, ExtractionResult, HeaderCorrections, StatedParties } from '@/server/types';
import { CLAIMED_FIELDS, EMPTY_CLAIMED } from '@/server/types';
import { notifyPermission, notifyUsers } from './notify';
import { rereconcileContract, runReconciliation } from './reconcile';

export const MAX_FILE_BYTES = 25 * 1024 * 1024;
export const MAX_FILES = 20;

export type IncomingFile = { filename: string; mimeType?: string | null; bytes: Uint8Array };
export type IntakeActor = Ctx | { system: true; orgId: string; name: string };

const isSystem = (a: IntakeActor): a is { system: true; orgId: string; name: string } => 'system' in a;
const auditActor = (a: IntakeActor): AuditActor => (isSystem(a) ? { system: true, name: a.name } : a);

/** Decide the type from the bytes; the name and declared type are only hints. */
export function sniffMime(file: IncomingFile): string {
  const b = file.bytes;
  const starts = (...sig: number[]) => sig.every((v, i) => b[i] === v);
  if (starts(0x25, 0x50, 0x44, 0x46)) return 'application/pdf';
  if (starts(0x89, 0x50, 0x4e, 0x47)) return 'image/png';
  if (starts(0xff, 0xd8, 0xff)) return 'image/jpeg';
  if (starts(0x47, 0x49, 0x46, 0x38)) return 'image/gif';
  if (starts(0x52, 0x49, 0x46, 0x46) && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return 'image/webp';
  return file.mimeType || 'application/octet-stream';
}

function cleanFilename(name: string): string {
  const base = path.basename(name.replace(/\\/g, '/')).replace(/[\u0000-\u001f\u007f]/g, '').trim();
  return (base || 'document').slice(0, 180);
}

function validateFiles(files: IncomingFile[]): void {
  if (files.length === 0) throw new UserError('Add at least one document.');
  if (files.length > MAX_FILES) throw new UserError(`A submission can contain at most ${MAX_FILES} files.`);
  for (const f of files) {
    if (f.bytes.byteLength === 0) throw new UserError(`“${f.filename}” is empty.`);
    if (f.bytes.byteLength > MAX_FILE_BYTES) throw new UserError(`“${f.filename}” is larger than 25 MB.`);
  }
}

async function storeDocuments(db: DB, orgId: string, appId: string, files: IncomingFile[], source: 'upload' | 'email', uploadedBy: string | null, at: Date) {
  const stored: Array<{ id: string; filename: string }> = [];
  for (const file of files) {
    const object = await putObject(orgId, 'documents', file.bytes);
    const id = newId('doc');
    const filename = cleanFilename(file.filename);
    await db.insert(documents).values({
      id,
      orgId,
      payApplicationId: appId,
      filename,
      mimeType: sniffMime(file),
      size: object.size,
      sha256: object.sha256,
      storageKey: object.key,
      segments: [],
      source,
      uploadedBy,
      createdAt: at,
    });
    stored.push({ id, filename });
  }
  return stored;
}

export type CreateApplicationInput = {
  files: IncomingFile[];
  contractId?: string | null;
  receivedVia?: 'upload' | 'email';
  senderEmail?: string | null;
  receivedAt?: Date;
  /** Skip the queue; the caller will run processApplication itself (seeding, tests). */
  defer?: boolean;
};

/** Record a new submission and queue it for processing. */
export const createApplication = locked(async function createApplication(db: DB, actor: IntakeActor, input: CreateApplicationInput): Promise<{ id: string }> {
  if (!isSystem(actor)) assertCan(actor, 'application:upload');
  validateFiles(input.files);
  const orgId = actor.orgId;
  const at = input.receivedAt ?? new Date();
  const via = input.receivedVia ?? 'upload';
  const userId = isSystem(actor) ? null : actor.userId;

  let contract: typeof contracts.$inferSelect | undefined;
  if (input.contractId) {
    [contract] = await db.select().from(contracts).where(and(eq(contracts.orgId, orgId), eq(contracts.id, input.contractId)));
    if (!contract) throw new UserError('That contract no longer exists.');
  }

  const id = newId('pa');
  await db.insert(payApplications).values({
    id,
    orgId,
    contractId: contract?.id ?? null,
    projectId: contract?.projectId ?? null,
    subcontractorId: contract?.subcontractorId ?? null,
    status: 'processing',
    receivedAt: at,
    receivedVia: via,
    senderEmail: input.senderEmail ?? null,
    submittedBy: userId,
    claimed: { ...EMPTY_CLAIMED },
    evidence: {},
    createdAt: at,
    updatedAt: at,
  });
  const stored = await storeDocuments(db, orgId, id, input.files, via, userId, at);

  await recordAudit(db, {
    orgId,
    actor: auditActor(actor),
    action: 'application.received',
    entityType: 'pay_application',
    entityId: id,
    payApplicationId: id,
    summary: `Billing package received by ${via === 'email' ? `email${input.senderEmail ? ` from ${input.senderEmail}` : ''}` : 'upload'}: ${stored.map((d) => d.filename).join(', ')}`,
    data: { files: stored.map((d) => d.filename), via, senderEmail: input.senderEmail ?? null },
    at,
  });

  if (!input.defer) await enqueueJob(db, orgId, 'process_application', { applicationId: id });
  return { id };
});

/** Attach further documents (for example a corrected resubmission) and re-read the whole package. */
export const addDocuments = locked(async function addDocuments(db: DB, ctx: Ctx, appId: string, files: IncomingFile[], opts: { defer?: boolean; now?: Date } = {}): Promise<void> {
  assertCan(ctx, 'application:upload');
  validateFiles(files);
  const [app] = await db.select().from(payApplications).where(and(eq(payApplications.orgId, ctx.orgId), eq(payApplications.id, appId)));
  if (!app) throw new UserError('Application not found.');
  if (['approved', 'rejected', 'void'].includes(app.status)) throw new UserError('This application has been decided. Reopen it before adding documents.');
  const at = opts.now ?? new Date();
  const stored = await storeDocuments(db, ctx.orgId, appId, files, 'upload', ctx.userId, at);
  await db.update(payApplications).set({ version: nextVersion, status: 'processing', processingError: null, holdSince: null, updatedAt: at }).where(eq(payApplications.id, appId));
  await recordAudit(db, {
    orgId: ctx.orgId,
    actor: ctx,
    action: 'application.documents_added',
    entityType: 'pay_application',
    entityId: appId,
    payApplicationId: appId,
    summary: `Added ${stored.map((d) => d.filename).join(', ')}; the package will be read again`,
    data: { files: stored.map((d) => d.filename) },
    at,
  });
  if (!opts.defer) await enqueueJob(db, ctx.orgId, 'process_application', { applicationId: appId });
});

export const removeDocument = locked(async function removeDocument(db: DB, ctx: Ctx, documentId: string, opts: { defer?: boolean } = {}): Promise<void> {
  assertCan(ctx, 'application:review');
  const [doc] = await db.select().from(documents).where(and(eq(documents.orgId, ctx.orgId), eq(documents.id, documentId)));
  if (!doc?.payApplicationId) throw new UserError('Document not found.');
  const [app] = await db.select().from(payApplications).where(eq(payApplications.id, doc.payApplicationId));
  if (!app || ['approved', 'rejected', 'void'].includes(app.status)) throw new UserError('This application has been decided and its documents are locked.');
  const remaining = await db.select({ id: documents.id }).from(documents).where(eq(documents.payApplicationId, app.id));
  if (remaining.length <= 1) throw new UserError('An application needs at least one document. Void the application instead.');
  // The stored original is kept (content-addressed); only its link to this application is removed.
  await db.delete(documents).where(eq(documents.id, documentId));
  await db.update(payApplications).set({ version: nextVersion, status: 'processing', processingError: null, updatedAt: new Date() }).where(eq(payApplications.id, app.id));
  await recordAudit(db, {
    orgId: ctx.orgId,
    actor: ctx,
    action: 'application.document_removed',
    entityType: 'pay_application',
    entityId: app.id,
    payApplicationId: app.id,
    summary: `Removed “${doc.filename}” from the package; the package will be read again`,
    data: { filename: doc.filename, sha256: doc.sha256 },
  });
  if (!opts.defer) await enqueueJob(db, ctx.orgId, 'process_application', { applicationId: app.id });
});

// ── Processing ──────────────────────────────────────────────────────────────

function best<T extends { confidence: number }>(items: T[]): T | undefined {
  return [...items].sort((a, b) => b.confidence - a.confidence)[0];
}

export type ProcessOptions = {
  now?: Date;
  extract?: ExtractOptions;
  /** Epoch ms by which processing must be done (the job's time limit). Reading stops early enough to save what was read. */
  finishBy?: number;
};

/** Time kept back from the job's limit for saving the result once reading is over. */
const SAVE_MARGIN_MS = 20_000;

type DocRow = typeof documents.$inferSelect;
type Outcome = Awaited<ReturnType<typeof extractDocument>>;
type Reading = { doc: DocRow; outcome: Outcome };

const LINE_VALUE_FIELDS = ['itemNo', 'description', 'scheduledValue', 'previous', 'thisPeriod', 'stored', 'total', 'balance', 'retainage'] as const;
const WAIVER_VALUE_FIELDS = ['waiverType', 'claimant', 'throughDate', 'amount', 'exceptions', 'signed'] as const;

/** Identifies "the same row of the same document", so a correction can follow it across a re-read. */
function lineIdentity(sha256: string, x: Pick<ExtractedLine, (typeof LINE_VALUE_FIELDS)[number]>): string {
  return JSON.stringify([sha256, ...LINE_VALUE_FIELDS.map((f) => x[f] ?? null)]);
}
function waiverIdentity(sha256: string, w: ExtractedWaiver): string {
  return JSON.stringify([sha256, w.page, ...WAIVER_VALUE_FIELDS.map((f) => w[f].value ?? null)]);
}

/**
 * Documents read at the same time. With AI reading on, a document takes a model
 * call of several seconds to a minute; one after another, a package of a dozen
 * would outlast a serverless function's time limit.
 */
const READ_CONCURRENCY = 4;

/** `fn` over `items` with at most `limit` running at once; results in the order of `items`. */
async function mapInOrder<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

/**
 * Read every document in the package and build (or rebuild) the application from them.
 *
 * Reading is slow (a model call per document when AI reading is on), so it
 * happens with no lock held. The result is then applied in one transaction,
 * which first checks that nothing it depends on changed in the meantime.
 */
export async function processApplication(db: DB, orgId: string, appId: string, opts: ProcessOptions = {}): Promise<void> {
  const now = opts.now ?? new Date();

  const docs = await withOrgLock(db, orgId, async (tx) => {
    const [app] = await tx.select().from(payApplications).where(and(eq(payApplications.orgId, orgId), eq(payApplications.id, appId)));
    if (!app) throw new Error(`Application ${appId} not found`);
    if (['approved', 'rejected', 'void'].includes(app.status)) return null;
    return tx.select().from(documents).where(eq(documents.payApplicationId, appId)).orderBy(asc(documents.createdAt), asc(documents.filename));
  });
  if (!docs) return;

  const extract: ExtractOptions = { ...opts.extract };
  if (opts.finishBy !== undefined) extract.readBy = Math.min(extract.readBy ?? Infinity, opts.finishBy - SAVE_MARGIN_MS);

  try {
    const readings: Reading[] = await mapInOrder(docs, READ_CONCURRENCY, async (doc) => {
      const bytes = await getObject(doc.storageKey);
      return { doc, outcome: await extractDocument({ filename: doc.filename, mimeType: doc.mimeType, bytes }, extract) };
    });
    await withOrgLock(db, orgId, (tx) => applyReading(tx, orgId, appId, readings, now));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await db
      .update(payApplications)
      .set({ version: nextVersion, processingError: message, updatedAt: new Date() })
      .where(and(eq(payApplications.orgId, orgId), eq(payApplications.id, appId), eq(payApplications.status, 'processing')));
    throw err;
  }
}

async function applyReading(db: DB, orgId: string, appId: string, readings: Reading[], now: Date): Promise<void> {
  const [app] = await db.select().from(payApplications).where(and(eq(payApplications.orgId, orgId), eq(payApplications.id, appId)));
  if (!app || ['approved', 'rejected', 'void'].includes(app.status)) return; // decided while we were reading

  // If documents were added or removed while we were reading, this reading is of a package that
  // no longer exists. The change queued its own job; let that one apply.
  const current = await db.select({ id: documents.id }).from(documents).where(eq(documents.payApplicationId, appId));
  const read = new Set(readings.map((r) => r.doc.id));
  if (current.length !== read.size || current.some((d) => !read.has(d.id))) {
    console.info(`[intake] ${appId}: the package changed while it was being read; leaving it to the newer job`);
    return;
  }

  const docs = readings.map((r) => r.doc);
  const shaOf = new Map(docs.map((d) => [d.id, d.sha256]));
  const revision = app.revision + 1;
  const engines = new Set<string>();
  const results: Array<{ doc: DocRow; result: ExtractionResult | null }> = [];

  // What a person had already done to the previous reading.
  const oldLines = await db.select().from(payAppLines).where(eq(payAppLines.payApplicationId, appId)).orderBy(asc(payAppLines.sortOrder));
  const oldWaivers = await db.select().from(lienWaivers).where(eq(lienWaivers.payApplicationId, appId));
  const oldPayAppShas = new Set(docs.filter((d) => d.segments.some((s) => s.type === 'pay_application')).map((d) => d.sha256));

  for (const { doc, outcome } of readings) {
    const segments: DocumentSegment[] = outcome.result?.segments ?? [];
    await db
      .update(documents)
      .set({ status: outcome.status, statusDetail: outcome.detail, pageCount: outcome.pageCount, hasTextLayer: outcome.hasTextLayer, segments })
      .where(eq(documents.id, doc.id));
    await db.insert(extractions).values({
      id: newId('ext'),
      orgId,
      documentId: doc.id,
      payApplicationId: appId,
      engine: outcome.engine ?? 'none',
      model: outcome.model,
      status: outcome.result ? 'succeeded' : 'failed',
      result: outcome.result,
      error: outcome.result ? null : outcome.detail,
      durationMs: outcome.durationMs,
      createdAt: now,
    });
    if (outcome.engine) engines.add(outcome.model ? `${outcome.engine}:${outcome.model}` : outcome.engine);
    results.push({ doc, result: outcome.result });
  }

  // ── Merge the documents into one application ──
  const withPayApp = results.filter((r) => r.result?.payApp);
  const chosen = best(withPayApp.map((r) => ({ r, confidence: r.result!.segments.find((s) => s.type === 'pay_application')?.confidence ?? 0 })))?.r;
  const p = chosen?.result?.payApp;

  const claimed: ClaimedHeader = { ...EMPTY_CLAIMED };
  const evidence: EvidenceMap = {};
  if (p && chosen) {
    for (const field of CLAIMED_FIELDS) {
      const e = p.amounts[field];
      claimed[field] = e.value;
      if (e.value !== null && e.page) evidence[field] = { documentId: chosen.doc.id, page: e.page, bbox: e.bbox ?? null, source: e.source ?? null, confidence: e.confidence };
    }
    for (const key of ['applicationNumber', 'periodTo', 'signed'] as const) {
      const e = p[key];
      if (e.value !== null && e.page) evidence[key] = { documentId: chosen.doc.id, page: e.page, bbox: e.bbox ?? null, source: e.source ?? null, confidence: e.confidence };
    }
  }
  let applicationNumber = p?.applicationNumber.value ?? null;
  let periodTo = p?.periodTo.value ?? null;

  // A summary value the reviewer corrected stays corrected as long as the document still reads the same.
  let kept = 0;
  let dropped = 0;
  const corrections: HeaderCorrections = {};
  for (const [field, c] of Object.entries(app.headerCorrections ?? {})) {
    const readNow = field === 'applicationNumber' ? applicationNumber : field === 'periodTo' ? periodTo : claimed[field as ClaimedField];
    if (readNow !== c.from) {
      dropped++;
      continue;
    }
    if (field === 'applicationNumber') applicationNumber = c.to as number | null;
    else if (field === 'periodTo') periodTo = c.to as string | null;
    else claimed[field as ClaimedField] = c.to as number | null;
    if (evidence[field]) evidence[field] = { ...evidence[field]!, confidence: 1 };
    corrections[field] = c;
    kept++;
  }

  const stated: StatedParties = {
    projectName: p?.projectName.value ?? null,
    projectNumber: p?.projectNumber.value ?? null,
    contractorName: p?.contractorName.value ?? null,
    toName: p?.toName.value ?? null,
    contractNumber: p?.contractNumber.value ?? null,
    contractDate: p?.contractDate.value ?? null,
    applicationDate: p?.applicationDate.value ?? null,
    signerName: p?.signerName.value ?? null,
  };
  // A waiver can supply the subcontractor's name when there is no pay application to read.
  if (!stated.contractorName) {
    stated.contractorName = results.flatMap((r) => r.result?.waivers ?? []).find((w) => w.claimant.value)?.claimant.value ?? null;
  }

  // ── Which contract is this? ──
  let contractId = app.contractId;
  let candidates = app.matchCandidates ?? null;
  let autoMatched = false;
  if (!contractId) {
    const rows = await db
      .select({ contract: contracts, sub: subcontractors, project: projects })
      .from(contracts)
      .innerJoin(subcontractors, eq(subcontractors.id, contracts.subcontractorId))
      .innerJoin(projects, eq(projects.id, contracts.projectId))
      .where(and(eq(contracts.orgId, orgId), eq(contracts.status, 'active')));
    candidates = rankContracts(
      stated,
      claimed.originalContractSum,
      rows.map((r) => ({
        contractId: r.contract.id,
        contractNumber: r.contract.number,
        originalAmount: r.contract.originalAmount,
        subcontractorName: r.sub.name,
        projectName: r.project.name,
        projectNumber: r.project.number,
      })),
    );
    const confident = confidentMatch(candidates);
    if (confident) {
      contractId = confident.contractId;
      autoMatched = true;
    }
  }
  const [contract] = contractId ? await db.select().from(contracts).where(and(eq(contracts.orgId, orgId), eq(contracts.id, contractId))) : [];

  // ── Rewrite lines and waivers from this reading, carrying corrections across ──
  await db.delete(payAppLines).where(eq(payAppLines.payApplicationId, appId));
  await db.delete(lienWaivers).where(eq(lienWaivers.payApplicationId, appId));

  const lineRows = results.flatMap((r) => (r.result?.lines ?? []).map((line) => ({ line, documentId: r.doc.id })));
  const sov = contract ? await db.select().from(sovLines).where(eq(sovLines.contractId, contract.id)).orderBy(asc(sovLines.sortOrder)) : [];
  const sovIds = new Set(sov.map((s) => s.id));
  const mapping = mapLinesToSov(lineRows.map((r) => r.line), sov);

  // Earlier rows by identity. Two identical rows in one document are paired off in order.
  const earlier = new Map<string, Array<(typeof oldLines)[number]>>();
  for (const old of oldLines) {
    const sha = old.extracted ? shaOf.get(old.extracted.documentId) : undefined;
    if (!old.extracted || !sha) continue;
    const key = lineIdentity(sha, old.extracted);
    earlier.set(key, [...(earlier.get(key) ?? []), old]);
  }
  const takenSov = new Set<string>();
  const newLineValues: Array<typeof payAppLines.$inferInsert> = lineRows.map(({ line, documentId }, index) => {
    const old = earlier.get(lineIdentity(shaOf.get(documentId)!, line))?.shift();
    const edited = old?.editKind ? old : null;
    if (edited) kept++;
    // A match a person made (or confirmed by leaving it) wins over a fresh guess, while it is still valid.
    let sovLineId = old?.sovLineId && sovIds.has(old.sovLineId) ? old.sovLineId : (mapping[index] ?? null);
    if (sovLineId && takenSov.has(sovLineId)) sovLineId = null;
    if (sovLineId) takenSov.add(sovLineId);
    const values = edited ?? line;
    return {
      id: newId('pal'),
      orgId,
      payApplicationId: appId,
      sovLineId,
      sortOrder: index,
      itemNo: values.itemNo,
      description: values.description,
      scheduledValue: values.scheduledValue,
      previous: values.previous,
      thisPeriod: values.thisPeriod,
      stored: values.stored,
      total: values.total,
      balance: values.balance,
      retainage: values.retainage,
      extracted: { ...line, documentId },
      editKind: edited?.editKind ?? null,
      editNote: edited?.editNote ?? null,
      editedBy: edited?.editedBy ?? null,
      editedAt: edited?.editedAt ?? null,
    };
  });
  dropped += [...earlier.values()].flat().filter((l) => l.editKind).length;
  // Rows keyed by hand exist because nothing could be read. They stay only while that is still true.
  const handKeyed = oldLines.filter((l) => !l.extracted);
  if (lineRows.length === 0) {
    for (const [i, l] of handKeyed.entries()) {
      const { id: _id, ...rest } = l;
      newLineValues.push({ ...rest, id: newId('pal'), sortOrder: i, sovLineId: l.sovLineId && sovIds.has(l.sovLineId) ? l.sovLineId : null });
      kept++;
    }
  } else dropped += handKeyed.length;
  // A row whose document is no longer in the package cannot keep its correction.
  dropped += oldLines.filter((l) => l.extracted && l.editKind && !shaOf.has(l.extracted.documentId)).length;
  if (newLineValues.length > 0) await db.insert(payAppLines).values(newLineValues);

  const waiverRows = results.flatMap((r) => (r.result?.waivers ?? []).map((w) => ({ w, documentId: r.doc.id })));
  const earlierWaivers = new Map<string, Array<(typeof oldWaivers)[number]>>();
  for (const old of oldWaivers) {
    const sha = old.extracted ? shaOf.get(old.extracted.documentId) : undefined;
    if (!old.extracted || !sha) continue;
    const key = waiverIdentity(sha, old.extracted);
    earlierWaivers.set(key, [...(earlierWaivers.get(key) ?? []), old]);
  }
  const newWaiverValues: Array<typeof lienWaivers.$inferInsert> = waiverRows.map(({ w, documentId }) => {
    const old = earlierWaivers.get(waiverIdentity(shaOf.get(documentId)!, w))?.shift();
    const edited = old?.editedBy ? old : null;
    if (edited) kept++;
    return {
      id: newId('lw'),
      orgId,
      payApplicationId: appId,
      documentId,
      page: w.page,
      waiverType: edited?.waiverType ?? w.waiverType.value ?? 'unknown',
      formState: w.formState.value,
      title: w.title.value,
      claimant: edited ? edited.claimant : w.claimant.value,
      customer: w.customer.value,
      owner: w.owner.value,
      jobDescription: w.jobDescription.value,
      throughDate: edited ? edited.throughDate : w.throughDate.value,
      amount: edited ? edited.amount : w.amount.value,
      exceptions: edited ? edited.exceptions : w.exceptions.value,
      signed: edited ? edited.signed : w.signed.value,
      signerName: w.signerName.value,
      signerTitle: w.signerTitle.value,
      signedDate: w.signedDate.value,
      notarized: w.notarized.value,
      extracted: { ...w, documentId },
      editedBy: edited?.editedBy ?? null,
      editedAt: edited?.editedAt ?? null,
    };
  });
  dropped += [...earlierWaivers.values()].flat().filter((w) => w.editedBy).length;
  // A waiver recorded by hand stays while its document is still here and still yields nothing itself.
  for (const old of oldWaivers.filter((w) => !w.extracted)) {
    const reading = results.find((r) => r.doc.id === old.documentId);
    if (!reading || (reading.result?.waivers?.length ?? 0) > 0) {
      dropped++;
      continue;
    }
    const { id: _id, ...rest } = old;
    newWaiverValues.push({ ...rest, id: newId('lw') });
    const segments = reading.result?.segments ?? [];
    if (!segments.some((s) => s.type === 'lien_waiver')) {
      await db
        .update(documents)
        .set({ segments: [...segments, { type: 'lien_waiver', pageStart: 1, pageEnd: reading.doc.pageCount ?? 1, confidence: 1 }] })
        .where(eq(documents.id, old.documentId));
    }
    kept++;
  }
  if (newWaiverValues.length > 0) await db.insert(lienWaivers).values(newWaiverValues);

  // "I looked and it is signed" stands while the pay application document itself is the same file.
  const keepSignature = !!app.signatureConfirmedAt && !!chosen && oldPayAppShas.has(chosen.doc.sha256);

  const status = contract ? 'needs_review' : 'needs_matching';
  await db
    .update(payApplications)
    .set({
      version: nextVersion,
      contractId: contract?.id ?? null,
      projectId: contract?.projectId ?? null,
      subcontractorId: contract?.subcontractorId ?? null,
      applicationNumber,
      periodTo,
      status,
      engine: [...engines].join(', ') || null,
      revision,
      processingError: null,
      stated,
      matchCandidates: candidates,
      claimed,
      evidence,
      headerCorrections: Object.keys(corrections).length ? corrections : null,
      claimedAmount: claimed.currentPaymentDue,
      signed: p?.signed.value ?? null,
      notarized: p?.notarized.value ?? null,
      signatureConfirmedAt: keepSignature ? app.signatureConfirmedAt : null,
      signatureConfirmedBy: keepSignature ? app.signatureConfirmedBy : null,
      submittedForApprovalAt: null,
      submittedForApprovalBy: null,
      holdSince: null,
      updatedAt: now,
    })
    .where(eq(payApplications.id, appId));

  const summary = contract ? await runReconciliation(db, orgId, appId, { now }) : null;
  // A new submission can change the picture for others on the same contract (duplicates, sequence).
  if (contract) await rereconcileContract(db, orgId, contract.id, { now, except: appId });
  const notes = results.flatMap((r) => r.result?.notes ?? []);
  const unread = results.filter((r) => !r.result).length;
  const who = stated.contractorName ?? 'Unknown subcontractor';
  const label = `${who}${applicationNumber ? ` – application #${applicationNumber}` : ''}`;
  const carried =
    revision === 1
      ? ''
      : kept + dropped === 0
        ? ''
        : ` ${kept} earlier correction${kept === 1 ? '' : 's'} carried over` + (dropped ? `; ${dropped} no longer appl${dropped === 1 ? 'ies' : 'y'} because the document changed and ${dropped === 1 ? 'was' : 'were'} dropped.` : '.');

  await recordAudit(db, {
    orgId,
    actor: { system: true },
    action: revision === 1 ? 'application.processed' : 'application.reprocessed',
    entityType: 'pay_application',
    entityId: appId,
    payApplicationId: appId,
    summary:
      `${revision === 1 ? 'Read' : 'Re-read'} ${docs.length} document${docs.length === 1 ? '' : 's'}` +
      (unread ? ` (${unread} could not be read automatically)` : '') +
      `: ${lineRows.length} line items, ${waiverRows.length} lien waiver${waiverRows.length === 1 ? '' : 's'}. ` +
      (contract
        ? `${autoMatched ? 'Matched automatically' : 'Matched'} to contract ${contract.number}. ${summary?.openBlocking ?? 0} blocking and ${summary?.openWarnings ?? 0} warning findings.`
        : 'Could not be matched to a contract automatically.') +
      carried,
    data: { revision, engines: [...engines], documents: docs.length, lines: lineRows.length, waivers: waiverRows.length, notes, autoMatched, findings: summary, correctionsKept: kept, correctionsDropped: dropped },
    at: now,
  });

  await notifyPermission(
    db,
    orgId,
    'application:review',
    contract
      ? {
          type: 'application.ready',
          title: `${label} is ready for review`,
          body: summary && summary.openBlocking + summary.openWarnings > 0 ? `${summary.openBlocking} blocking, ${summary.openWarnings} warnings` : 'All checks passed',
          href: `/applications/${appId}`,
        }
      : { type: 'application.needs_matching', title: `${label} needs to be matched to a contract`, body: 'The package could not be matched automatically.', href: `/applications/${appId}` },
    { at: now },
  );
  if (app.submittedBy) {
    await notifyUsers(db, orgId, [app.submittedBy], { type: 'application.processed', title: `${label}: processing finished`, href: `/applications/${appId}` }, now);
  }
}

registerJobHandler(
  'process_application',
  async (db, orgId, payload, run) => {
    await processApplication(db, orgId, String(payload.applicationId), { finishBy: run.finishBy });
  },
  {
    // Every automatic attempt failed. Make sure a person finds out.
    onExhausted: async (db, orgId, payload, error) => {
      const appId = String(payload.applicationId);
      await withOrgLock(db, orgId, async (tx) => {
        const [app] = await tx.select().from(payApplications).where(and(eq(payApplications.orgId, orgId), eq(payApplications.id, appId)));
        if (!app || app.status !== 'processing') return;
        await tx.update(payApplications).set({ version: nextVersion, processingError: error, updatedAt: new Date() }).where(eq(payApplications.id, appId));
        await recordAudit(tx, {
          orgId,
          actor: { system: true },
          action: 'application.processing_failed',
          entityType: 'pay_application',
          entityId: appId,
          payApplicationId: appId,
          summary: `Reading the package failed after ${MAX_ATTEMPTS} attempts and has stopped. Nothing was lost: the original documents are stored. Retry, or enter the figures by hand. (${error.slice(0, 300)})`,
          data: { error },
        });
        await notifyPermission(tx, orgId, 'application:review', {
          type: 'application.processing_failed',
          title: 'A billing package could not be read',
          body: 'Automatic reading failed after several attempts. Open it to retry or to enter the figures by hand.',
          href: `/applications/${appId}`,
        });
      });
    },
  },
);

/**
 * Read the package of an undecided application again, because a document in it
 * was not read the way it should have been: its AI read failed or ran out of
 * time (status `failed`), or it was read by the text-layer reader only because
 * the AI read failed. Reviewer corrections are kept, as on any re-read.
 */
export const rereadPackage = locked(async function rereadPackage(db: DB, ctx: Ctx, appId: string): Promise<void> {
  assertCan(ctx, 'application:review');
  const [app] = await db.select().from(payApplications).where(and(eq(payApplications.orgId, ctx.orgId), eq(payApplications.id, appId)));
  if (!app) throw new UserError('Application not found.');
  if (['approved', 'rejected', 'void'].includes(app.status)) throw new UserError('This application has been decided. Reopen it before reading it again.');
  if (app.status === 'processing') throw new UserError('This package is already being read.');
  const docs = await db.select().from(documents).where(eq(documents.payApplicationId, appId));
  const missed = docs.filter(missedByAi);
  if (missed.length === 0) throw new UserError('Every document in this package was read. There is nothing to read again.');
  await db.update(payApplications).set({ version: nextVersion, status: 'processing', processingError: null, holdSince: null, updatedAt: new Date() }).where(eq(payApplications.id, appId));
  await recordAudit(db, {
    orgId: ctx.orgId,
    actor: ctx,
    action: 'application.reread_requested',
    entityType: 'pay_application',
    entityId: appId,
    payApplicationId: appId,
    summary: `Asked for the package to be read again, because ${missed.map((d) => `“${d.filename}”`).join(', ')} ${missed.length === 1 ? 'was' : 'were'} not fully read`,
    data: { documents: missed.map((d) => d.filename) },
  });
  await enqueueJob(db, ctx.orgId, 'process_application', { applicationId: appId });
});

/** A document whose AI read failed: not read at all, or read by the text-layer reader instead. Reading it again may go better. */
export function missedByAi(doc: { status: string; statusDetail: string | null }): boolean {
  return doc.status === 'failed' || (doc.status === 'processed' && doc.statusDetail !== null);
}

/** Put an application whose processing failed back on the queue. */
export const retryProcessing = locked(async function retryProcessing(db: DB, ctx: Ctx, appId: string): Promise<void> {
  assertCan(ctx, 'application:upload');
  const [app] = await db.select().from(payApplications).where(and(eq(payApplications.orgId, ctx.orgId), eq(payApplications.id, appId)));
  if (!app) throw new UserError('Application not found.');
  if (app.status !== 'processing') throw new UserError('This application is not waiting on processing.');
  await db.update(payApplications).set({ version: nextVersion, processingError: null, updatedAt: new Date() }).where(eq(payApplications.id, appId));
  await recordAudit(db, { orgId: ctx.orgId, actor: ctx, action: 'application.processing_retried', entityType: 'pay_application', entityId: appId, payApplicationId: appId, summary: 'Asked for the package to be read again' });
  await enqueueJob(db, ctx.orgId, 'process_application', { applicationId: appId });
});
