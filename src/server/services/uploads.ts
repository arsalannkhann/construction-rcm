/**
 * Files larger than one request may carry.
 *
 * Serverless hosting caps a request body (Vercel: 4.5 MB), while a scanned
 * billing package is often bigger. The browser therefore sends a large file in
 * parts of UPLOAD_PART_BYTES to /api/uploads/<uploadId>/parts/<n>, which are
 * kept in `upload_parts`, and then names the staged file in the request that
 * creates the application or adds documents. That request joins the parts,
 * checks they are complete and add up to the declared size, and deletes them
 * once the documents are stored. Small packages skip all of this.
 *
 * Parts belong to the member who sent them, in the organisation they were
 * signed in to, and nobody else can add to, read or claim them. Unclaimed parts
 * are deleted after PART_TTL_MS.
 */
import { and, asc, eq, inArray, lt, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { DB } from '@/db';
import { uploadParts } from '@/db/schema';
import { assertCan, UserError, type Ctx } from '@/server/auth/permissions';
import { MAX_FILE_BYTES, type IncomingFile } from './intake';

/** Size of every part but the last. Under Vercel's 4.5 MB request limit with room for headers. */
export const UPLOAD_PART_BYTES = 4 * 1024 * 1024;
export const MAX_PARTS = Math.ceil(MAX_FILE_BYTES / UPLOAD_PART_BYTES);
/** Parts nobody claimed are deleted after this long. */
export const PART_TTL_MS = 6 * 60 * 60 * 1000;
/** Most a member may have staged and not yet claimed: a full package of large files, with room to retry. */
export const MAX_STAGED_BYTES = 200 * 1024 * 1024;

const UPLOAD_ID = /^[A-Za-z0-9_-]{16,64}$/;

export function isUploadId(value: string): boolean {
  return UPLOAD_ID.test(value);
}

/** Store one part. Sending the same part again replaces it, so a retried request is harmless. */
export async function stagePart(db: DB, ctx: Ctx, uploadId: string, part: number, bytes: Uint8Array, now = new Date()): Promise<void> {
  assertCan(ctx, 'application:upload');
  if (!isUploadId(uploadId)) throw new UserError('That upload is not valid. Start it again.');
  if (!Number.isInteger(part) || part < 0 || part >= MAX_PARTS) throw new UserError('That part of the file is out of range. Start the upload again.');
  if (bytes.byteLength === 0 || bytes.byteLength > UPLOAD_PART_BYTES) throw new UserError(`A part of a file must be between 1 byte and ${UPLOAD_PART_BYTES / 1024 / 1024} MB.`);

  await db.delete(uploadParts).where(lt(uploadParts.createdAt, new Date(now.getTime() - PART_TTL_MS)));
  const [{ staged }] = await db
    .select({ staged: sql<number>`coalesce(sum(octet_length(${uploadParts.bytes})), 0)::bigint` })
    .from(uploadParts)
    .where(and(eq(uploadParts.userId, ctx.userId), sql`not (${uploadParts.uploadId} = ${uploadId} and ${uploadParts.part} = ${part})`));
  if (Number(staged) + bytes.byteLength > MAX_STAGED_BYTES) {
    throw new UserError('Too much is waiting to be uploaded. Finish or cancel the uploads in progress, or wait a few hours, and try again.');
  }
  await db
    .insert(uploadParts)
    .values({ userId: ctx.userId, orgId: ctx.orgId, uploadId, part, bytes, createdAt: now })
    .onConflictDoUpdate({ target: [uploadParts.userId, uploadParts.uploadId, uploadParts.part], set: { bytes, orgId: ctx.orgId, createdAt: now } });
}

export const stagedSchema = z.object({
  uploadId: z.string().regex(UPLOAD_ID),
  name: z.string().trim().min(1).max(255),
  type: z.string().max(200).optional().default(''),
  size: z.number().int().positive().max(MAX_FILE_BYTES),
});
export type StagedFile = z.infer<typeof stagedSchema>;

/** The `staged` entries of an upload form. Each is the JSON of a StagedFile. */
export function parseStaged(entries: FormDataEntryValue[]): StagedFile[] {
  const out: StagedFile[] = [];
  for (const entry of entries) {
    if (typeof entry !== 'string') throw new UserError('The upload was not understood. Try again.');
    let value: unknown;
    try {
      value = JSON.parse(entry);
    } catch {
      throw new UserError('The upload was not understood. Try again.');
    }
    const parsed = stagedSchema.safeParse(value);
    if (!parsed.success) throw new UserError('The upload was not understood. Try again.');
    out.push(parsed.data);
  }
  if (new Set(out.map((f) => f.uploadId)).size !== out.length) throw new UserError('The same file was named twice. Try again.');
  return out;
}

/** Join each staged file's parts. Every part from 0 to the last must be there, and they must add up to the declared size. */
export async function readStaged(db: DB, ctx: Ctx, files: StagedFile[]): Promise<IncomingFile[]> {
  assertCan(ctx, 'application:upload');
  const out: IncomingFile[] = [];
  for (const file of files) {
    const parts = await db
      .select({ part: uploadParts.part, bytes: uploadParts.bytes })
      .from(uploadParts)
      .where(and(eq(uploadParts.userId, ctx.userId), eq(uploadParts.orgId, ctx.orgId), eq(uploadParts.uploadId, file.uploadId)))
      .orderBy(asc(uploadParts.part));
    const complete = parts.length > 0 && parts.every((p, i) => p.part === i) && parts.reduce((n, p) => n + p.bytes.byteLength, 0) === file.size;
    if (!complete) throw new UserError(`“${file.name}” did not arrive completely. Upload it again.`);
    out.push({ filename: file.name, mimeType: file.type || null, bytes: new Uint8Array(Buffer.concat(parts.map((p) => p.bytes))) });
  }
  return out;
}

/** Delete staged parts once their files are stored. */
export async function discardStaged(db: DB, ctx: Ctx, uploadIds: string[]): Promise<void> {
  if (uploadIds.length === 0) return;
  await db.delete(uploadParts).where(and(eq(uploadParts.userId, ctx.userId), inArray(uploadParts.uploadId, uploadIds)));
}

/**
 * The files of an upload form: those sent whole (`files`) and those staged in
 * parts beforehand (`staged`). `done` deletes the staged parts; call it once
 * the documents are stored.
 */
export async function filesFromForm(db: DB, ctx: Ctx, form: FormData): Promise<{ files: IncomingFile[]; done: () => Promise<void> }> {
  const files: IncomingFile[] = [];
  for (const entry of form.getAll('files')) {
    if (typeof entry === 'string') continue;
    files.push({ filename: entry.name, mimeType: entry.type, bytes: new Uint8Array(await entry.arrayBuffer()) });
  }
  const staged = parseStaged(form.getAll('staged'));
  files.push(...(await readStaged(db, ctx, staged)));
  return { files, done: () => discardStaged(db, ctx, staged.map((f) => f.uploadId)) };
}
