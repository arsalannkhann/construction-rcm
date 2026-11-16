/**
 * Files shared to Zephric from another app: Android's Share sheet
 * (modules/share-intake) and iOS's "Open in" / "Copy to" (app/+native-intent.tsx).
 *
 * Each file is copied into the app's own folder as soon as it arrives, because
 * the other app's permission to read it does not last, and waits there (also
 * across the app being closed) until someone signed in with upload access opens
 * the app. Then the files become a new capture in the organisation they are
 * signed in to (app/_layout.tsx, SharedIntake). Nothing is sent: the capture
 * screen still needs the person to press Send. Files nobody opens are removed
 * after a week.
 */
import { uuid } from 'expo-modules-core';
import { Directory, File, Paths } from 'expo-file-system';
import { useSyncExternalStore } from 'react';
import { takeShare } from '../../modules/share-intake';
import { addToDraft, createDraft, deleteDraft, type Owner } from './drafts';
import { MAX_FILE_BYTES } from './limits';
import { noneSkipped, roomFor, sharedExtension, sharedKind, sharedMimeType, skippedMessage, type Skipped } from './shared-rules';

export type PendingFile = { file: string; name: string; mimeType: string; size: number };
export type PendingShare = { receivedAt: string; files: PendingFile[] };

const KEEP_DAYS = 7;

function folder(): Directory {
  const dir = new Directory(Paths.document, 'shared-in');
  if (!dir.exists) dir.create({ intermediates: true });
  return dir;
}

function manifest(): File {
  return new File(folder(), 'pending.json');
}

let pending: PendingShare | null | undefined;
const listeners = new Set<() => void>();

function emit() {
  for (const l of listeners) l();
}

function load(): PendingShare | null {
  if (pending !== undefined) return pending;
  pending = null;
  try {
    const m = manifest();
    if (m.exists) {
      const p = JSON.parse(m.textSync()) as PendingShare;
      const files = p.files.filter((f) => new File(folder(), f.file).exists);
      const stale = Date.now() - new Date(p.receivedAt).getTime() > KEEP_DAYS * 86_400_000;
      if (stale) wipe();
      else pending = files.length > 0 ? { ...p, files } : null;
    }
  } catch {
    pending = null;
  }
  return pending;
}

function save(next: PendingShare | null) {
  pending = next;
  const m = manifest();
  if (next) {
    if (!m.exists) m.create();
    m.writeSync(JSON.stringify(next));
  } else if (m.exists) {
    m.delete();
  }
  emit();
}

function wipe() {
  const dir = new Directory(Paths.document, 'shared-in');
  if (dir.exists) dir.delete();
  pending = null;
}

/** Remove every shared file waiting on this phone. */
export function clearShared(): void {
  wipe();
  emit();
}

export function usePendingShare(): PendingShare | null {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    load,
    load,
  );
}

type Arrived = { uri: string; name: string | null; mimeType: string | null; size: number | null };

/** Move arrived files into the waiting folder. Returns what was not added. */
function keep(arrived: Arrived[], skipped: Skipped): Skipped {
  const current = load();
  const files = [...(current?.files ?? [])];
  for (const a of arrived) {
    const source = new File(a.uri);
    const kind = sharedKind(a.name, a.mimeType);
    const size = a.size ?? (source.exists ? source.size : 0);
    if (!kind) skipped.unsupported += 1;
    else if (size > MAX_FILE_BYTES) skipped.tooLarge.push(a.name);
    else if (roomFor(files.length) === 0) skipped.overLimit += 1;
    else if (!source.exists) skipped.unreadable += 1;
    else {
      const mimeType = sharedMimeType(kind, a.name, a.mimeType);
      const target = new File(folder(), `${uuid.v4()}${sharedExtension(kind, mimeType)}`);
      source.copySync(target);
      files.push({ file: target.name, name: a.name ?? (kind === 'pdf' ? 'Document.pdf' : 'Image'), mimeType, size: target.size });
    }
    if (source.exists) {
      try {
        source.delete();
      } catch {
        /* The copy is what matters; the other app's original stays where it was. */
      }
    }
  }
  if (files.length > 0) save({ receivedAt: current?.receivedAt ?? new Date().toISOString(), files });
  return skipped;
}

let queue: Promise<unknown> = Promise.resolve();

/** Take whatever Android shared to the app. Returns a message about files that were not added, if any. */
export function collectAndroidShare(): Promise<string | null> {
  const run = queue.then(async () => {
    const taken = await takeShare(roomFor(load()?.files.length ?? 0), MAX_FILE_BYTES);
    const skipped = noneSkipped();
    skipped.overLimit = taken.overLimit;
    const arrived: Arrived[] = [];
    for (const f of taken.files) {
      if (f.status === 'ok' && f.uri) arrived.push({ uri: f.uri, name: f.name, mimeType: f.mimeType, size: f.size });
      else if (f.status === 'too_large') skipped.tooLarge.push(f.name);
      else if (f.status === 'unsupported') skipped.unsupported += 1;
      else skipped.unreadable += 1;
    }
    return skippedMessage(keep(arrived, skipped));
  });
  queue = run.catch(() => null);
  return run;
}

/** A file iOS opened in the app ("Open in Zephric"), as a file:// address in the app's Inbox folder. */
export function receiveOpenedFile(url: string): Promise<string | null> {
  const run = queue.then(() => {
    const name = decodeURIComponent(url.split('/').pop() ?? '') || null;
    return skippedMessage(keep([{ uri: url, name, mimeType: null, size: null }], noneSkipped()));
  });
  queue = run.catch(() => null);
  return run;
}

/** Turn the waiting files into a new capture for this person and organisation. Returns its id. */
export async function openSharedAsCapture(owner: Owner): Promise<string | null> {
  const p = load();
  if (!p || p.files.length === 0) return null;
  const draft = createDraft(owner);
  try {
    await addToDraft(
      draft.id,
      p.files.map((f) => ({ uri: new File(folder(), f.file).uri, name: f.name, mimeType: f.mimeType, size: f.size })),
    );
  } catch (err) {
    deleteDraft(draft.id);
    throw err;
  }
  clearShared();
  return draft.id;
}
