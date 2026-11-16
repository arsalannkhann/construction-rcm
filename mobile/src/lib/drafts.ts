/**
 * Capture drafts, kept in the app's own document folder so nothing is lost
 * if the app is closed, the phone restarts or the connection drops.
 *
 * Each draft has a folder with its files (copied in, so the camera roll or a
 * cleared cache cannot take them away) and a draft.json. A draft belongs to
 * one person in one organisation and is only ever shown to them there.
 *
 * The draft's id is also its client reference on the server: sending it
 * again, after a lost response, returns the application the first attempt
 * made (src/server/services/intake.ts, findByClientRef). It is marked
 * "submitted" only once the server has answered with that application.
 */
import { uuid } from 'expo-modules-core';
import { Directory, File, Paths } from 'expo-file-system';
import { ImageManipulator, SaveFormat } from 'expo-image-manipulator';
import { useSyncExternalStore } from 'react';

export type DraftFileKind = 'photo' | 'pdf' | 'image';

export type DraftFile = {
  id: string;
  name: string;
  type: string;
  size: number;
  kind: DraftFileKind;
  /** The file inside the draft's folder. */
  path: string;
  /** Staging progress on the server for this file. */
  upload?: { uploadId: string; partsDone: number };
};

export type DraftStatus = 'draft' | 'queued' | 'sending' | 'submitted' | 'failed';

export type Draft = {
  id: string;
  owner: { userId: string; orgId: string };
  title: string;
  contract: { id: string; label: string; group: string } | null;
  files: DraftFile[];
  status: DraftStatus;
  /** 0 to 1 while sending. */
  progress: number;
  error: string | null;
  applicationId: string | null;
  createdAt: string;
  updatedAt: string;
  submittedAt: string | null;
};

export type Owner = Draft['owner'];

/** Most files one application takes (MAX_FILES on the server). */
export const MAX_DRAFT_FILES = 20;
/** Largest single file the server accepts (MAX_FILE_BYTES). */
export const MAX_FILE_BYTES = 25 * 1024 * 1024;
/** Photos are scaled so the longer side is at most this, which keeps text legible and uploads small. */
const PHOTO_LONG_EDGE = 2400;

function root(): Directory {
  const dir = new Directory(Paths.document, 'drafts');
  if (!dir.exists) dir.create({ intermediates: true });
  return dir;
}

function folder(id: string): Directory {
  return new Directory(root(), id);
}

// ── A tiny store, so every screen sees the same drafts ─────────────────────

let drafts: Draft[] | null = null;
const listeners = new Set<() => void>();

function load(): Draft[] {
  if (drafts) return drafts;
  const out: Draft[] = [];
  for (const entry of root().list()) {
    if (!(entry instanceof Directory)) continue;
    const meta = new File(entry, 'draft.json');
    if (!meta.exists) continue;
    try {
      const d = JSON.parse(meta.textSync()) as Draft;
      // A send interrupted by the app closing picks up again from where it was.
      if (d.status === 'sending') d.status = 'queued';
      // iOS moves the app's data folder when the app is updated, so a stored
      // absolute path goes stale. Every file lives in its draft's folder under
      // its own generated name; point each one there again.
      d.files = d.files.map((f) => ({ ...f, path: new File(entry, f.path.split('/').pop() ?? '').uri }));
      out.push(d);
    } catch {
      /* An unreadable draft.json is left on disk, not deleted: its files may still matter. */
    }
  }
  drafts = out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return drafts;
}

function emit() {
  drafts = [...load()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  for (const l of listeners) l();
}

function persist(d: Draft): void {
  const dir = folder(d.id);
  if (!dir.exists) dir.create({ intermediates: true });
  const meta = new File(dir, 'draft.json');
  if (!meta.exists) meta.create();
  meta.writeSync(JSON.stringify(d));
}

export function saveDraft(d: Draft): Draft {
  const next = { ...d, updatedAt: new Date().toISOString() };
  persist(next);
  const list = load();
  const i = list.findIndex((x) => x.id === d.id);
  if (i >= 0) list[i] = next;
  else list.unshift(next);
  emit();
  return next;
}

export function getDraft(id: string): Draft | null {
  return load().find((d) => d.id === id) ?? null;
}

export function draftsFor(owner: Owner | null): Draft[] {
  if (!owner) return [];
  return load().filter((d) => d.owner.userId === owner.userId && d.owner.orgId === owner.orgId);
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useDrafts(owner: Owner | null): Draft[] {
  const all = useSyncExternalStore(subscribe, load, load);
  return owner ? all.filter((d) => d.owner.userId === owner.userId && d.owner.orgId === owner.orgId) : [];
}

export function useDraft(id: string | undefined): Draft | null {
  const all = useSyncExternalStore(subscribe, load, load);
  return all.find((d) => d.id === id) ?? null;
}

// ── Making and changing drafts ──────────────────────────────────────────────

export function createDraft(owner: Owner): Draft {
  const now = new Date().toISOString();
  return saveDraft({
    id: uuid.v4(),
    owner,
    title: '',
    contract: null,
    files: [],
    status: 'draft',
    progress: 0,
    error: null,
    applicationId: null,
    createdAt: now,
    updatedAt: now,
    submittedAt: null,
  });
}

function safeName(name: string, fallback: string): string {
  const cleaned = name.replace(/[\\/:*?"<>|\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim();
  return (cleaned || fallback).slice(0, 120);
}

/** A photo, scaled and saved as JPEG inside the draft's folder. */
async function storePhoto(dir: Directory, uri: string, rotate = 0): Promise<{ file: File; width: number; height: number }> {
  const ctx = ImageManipulator.manipulate(uri);
  if (rotate) ctx.rotate(rotate);
  let image = await ctx.renderAsync();
  if (Math.max(image.width, image.height) > PHOTO_LONG_EDGE) {
    const resized = ImageManipulator.manipulate(image);
    if (image.width >= image.height) resized.resize({ width: PHOTO_LONG_EDGE });
    else resized.resize({ height: PHOTO_LONG_EDGE });
    image = await resized.renderAsync();
  }
  const saved = await image.saveAsync({ format: SaveFormat.JPEG, compress: 0.72 });
  const target = new File(dir, `${uuid.v4()}.jpg`);
  new File(saved.uri).moveSync(target);
  return { file: target, width: saved.width, height: saved.height };
}

export type IncomingSource = { uri: string; name?: string | null; mimeType?: string | null; size?: number | null; fromCamera?: boolean };

export class DraftLimitError extends Error {}

/** Add photos or files to a draft. Photos are scaled and re-encoded; PDFs and other files are copied as they are. */
export async function addToDraft(id: string, sources: IncomingSource[]): Promise<Draft> {
  const draft = getDraft(id);
  if (!draft) throw new Error('This draft no longer exists.');
  if (draft.files.length + sources.length > MAX_DRAFT_FILES) throw new DraftLimitError(`A submission can have up to ${MAX_DRAFT_FILES} files.`);
  const dir = folder(id);
  const added: DraftFile[] = [];
  let photoNo = draft.files.filter((f) => f.kind === 'photo').length;
  for (const src of sources) {
    const type = (src.mimeType ?? '').toLowerCase();
    const isPdf = type === 'application/pdf' || /\.pdf$/i.test(src.name ?? '');
    const isImage = !isPdf && (type.startsWith('image/') || /\.(jpe?g|png|heic|heif|webp)$/i.test(src.name ?? src.uri));
    if (isImage) {
      const { file } = await storePhoto(dir, src.uri);
      photoNo += 1;
      added.push({ id: uuid.v4(), name: `Page ${photoNo}.jpg`, type: 'image/jpeg', size: file.size, kind: 'photo', path: file.uri });
    } else {
      const source = new File(src.uri);
      const size = src.size ?? source.size;
      if (size > MAX_FILE_BYTES) throw new DraftLimitError(`“${src.name ?? 'That file'}” is larger than 25 MB.`);
      const name = safeName(src.name ?? '', isPdf ? 'Document.pdf' : 'Document');
      const target = new File(dir, `${uuid.v4()}${isPdf ? '.pdf' : ''}`);
      source.copySync(target);
      added.push({ id: uuid.v4(), name, type: isPdf ? 'application/pdf' : type || 'application/octet-stream', size: target.size, kind: isPdf ? 'pdf' : 'image', path: target.uri });
    }
  }
  return saveDraft({ ...resetSending(draft), files: [...draft.files, ...added] });
}

/** Turn a photo a quarter turn clockwise. The new image replaces the old one; any part already uploaded is sent again. */
export async function rotatePhoto(id: string, fileId: string): Promise<Draft> {
  const draft = getDraft(id);
  const target = draft?.files.find((f) => f.id === fileId);
  if (!draft || !target || target.kind !== 'photo') throw new Error('That photo is no longer in the draft.');
  const { file } = await storePhoto(folder(id), target.path, 90);
  new File(target.path).delete();
  const files = draft.files.map((f) => (f.id === fileId ? { ...f, path: file.uri, size: file.size, upload: undefined } : f));
  return saveDraft({ ...resetSending(draft), files });
}

export function removeFromDraft(id: string, fileId: string): Draft {
  const draft = getDraft(id);
  if (!draft) throw new Error('This draft no longer exists.');
  const target = draft.files.find((f) => f.id === fileId);
  if (target) {
    const f = new File(target.path);
    if (f.exists) f.delete();
  }
  // Photos are renumbered so the pages read in order.
  let n = 0;
  const files = draft.files.filter((f) => f.id !== fileId).map((f) => (f.kind === 'photo' ? { ...f, name: `Page ${++n}.jpg` } : f));
  return saveDraft({ ...resetSending(draft), files });
}

export function moveInDraft(id: string, fileId: string, by: -1 | 1): Draft {
  const draft = getDraft(id);
  if (!draft) throw new Error('This draft no longer exists.');
  const i = draft.files.findIndex((f) => f.id === fileId);
  const j = i + by;
  if (i < 0 || j < 0 || j >= draft.files.length) return draft;
  const files = [...draft.files];
  [files[i], files[j]] = [files[j]!, files[i]!];
  let n = 0;
  return saveDraft({ ...draft, files: files.map((f) => (f.kind === 'photo' ? { ...f, name: `Page ${++n}.jpg` } : f)) });
}

export function updateDraft(id: string, patch: Partial<Pick<Draft, 'title' | 'contract'>>): Draft {
  const draft = getDraft(id);
  if (!draft) throw new Error('This draft no longer exists.');
  return saveDraft({ ...draft, ...patch });
}

/** A failed draft goes back to being editable when it changes. */
function resetSending(d: Draft): Draft {
  return d.status === 'failed' ? { ...d, status: 'draft', error: null, progress: 0 } : d;
}

/** Delete a draft and its files from the phone. Never called on a draft the server has not confirmed, unless the person asks. */
export function deleteDraft(id: string): void {
  const dir = folder(id);
  if (dir.exists) dir.delete();
  drafts = load().filter((d) => d.id !== id);
  emit();
}

/** Once the server has the application, the copies on the phone are no longer needed; the receipt stays. */
export function releaseFiles(id: string): void {
  const draft = getDraft(id);
  if (!draft || draft.status !== 'submitted' || !draft.applicationId) return;
  for (const f of draft.files) {
    const file = new File(f.path);
    if (file.exists) file.delete();
  }
}

/** Receipts of sent drafts older than this are tidied away. */
const RECEIPT_DAYS = 14;

export function tidyReceipts(now = Date.now()): void {
  for (const d of load()) {
    if (d.status === 'submitted' && d.submittedAt && now - new Date(d.submittedAt).getTime() > RECEIPT_DAYS * 86_400_000) deleteDraft(d.id);
  }
}

export function draftBytes(d: Draft): number {
  return d.files.reduce((n, f) => n + f.size, 0);
}

export function isSendable(d: Draft): boolean {
  return d.files.length > 0 && (d.status === 'draft' || d.status === 'failed' || d.status === 'queued');
}
