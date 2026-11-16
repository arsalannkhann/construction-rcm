/**
 * Sends submitted drafts to Zephric, one at a time, in 4 MB parts that can be
 * resumed. A draft is "submitted" only when the server answers with the
 * application it created; until then it stays on the phone, queued or failed,
 * with its files.
 *
 * Retrying is always safe: parts replace themselves on the server, and the
 * final request carries the draft's id as its client reference, so the
 * server returns the application an earlier attempt already made rather than
 * creating a second one.
 */
import { File } from 'expo-file-system';
import { uuid } from 'expo-modules-core';
import { api, ApiError, NetworkError, putPart } from './api';
import { draftsFor, getDraft, releaseFiles, saveDraft, type Draft, type Owner } from './drafts';

/** UPLOAD_PART_BYTES on the server. */
const PART_BYTES = 4 * 1024 * 1024;

let running = false;
let wake: (() => void) | null = null;

function newUploadId(): string {
  return `m${uuid.v4().replace(/-/g, '')}`;
}

function readChunk(path: string, offset: number, length: number): Uint8Array {
  const handle = new File(path).open();
  try {
    handle.offset = offset;
    return handle.readBytesSync(length);
  } finally {
    handle.close();
  }
}

/** Put a draft in the queue. The sender picks it up straight away when online. */
export function submitDraft(id: string): void {
  const d = getDraft(id);
  if (!d || d.files.length === 0 || d.status === 'submitted' || d.status === 'sending') return;
  saveDraft({ ...d, status: 'queued', error: null, progress: 0 });
  wake?.();
}

async function sendOne(start: Draft): Promise<void> {
  let d = saveDraft({ ...start, status: 'sending', error: null });
  const total = d.files.reduce((n, f) => n + f.size, 0) || 1;
  let sent = d.files.reduce((n, f) => n + Math.min(f.size, (f.upload?.partsDone ?? 0) * PART_BYTES), 0);

  for (const file of d.files) {
    const parts = Math.max(1, Math.ceil(file.size / PART_BYTES));
    let upload = file.upload ?? { uploadId: newUploadId(), partsDone: 0 };
    for (let part = upload.partsDone; part < parts; part++) {
      const length = Math.min(PART_BYTES, file.size - part * PART_BYTES);
      await putPart(upload.uploadId, part, readChunk(file.path, part * PART_BYTES, length));
      upload = { ...upload, partsDone: part + 1 };
      sent += length;
      const current = getDraft(d.id) ?? d;
      d = saveDraft({ ...current, files: current.files.map((f) => (f.id === file.id ? { ...f, upload } : f)), progress: Math.min(0.95, sent / total) });
    }
  }

  const result = await api<{ id: string; duplicate: boolean }>('/api/mobile/applications', {
    method: 'POST',
    timeoutMs: 120_000,
    body: {
      clientRef: d.id,
      contractId: d.contract?.id ?? null,
      staged: d.files.map((f) => ({ uploadId: f.upload!.uploadId, name: f.name, type: f.type, size: f.size })),
      combinePhotos: true,
      photosName: d.title.trim() || (d.contract ? `${d.contract.label.split(' · ')[0]} pay application` : 'Phone capture'),
    },
  });
  // Confirmed by the server: only now is it submitted.
  saveDraft({ ...(getDraft(d.id) ?? d), status: 'submitted', progress: 1, applicationId: result.id, submittedAt: new Date().toISOString(), error: null });
  releaseFiles(d.id);
}

function fail(id: string, message: string, status: Draft['status'] = 'failed') {
  const d = getDraft(id);
  if (d) saveDraft({ ...d, status, error: message, progress: 0 });
}

/** Parts left on the server more than six hours are cleared there; start those files again. */
function restartUploads(id: string) {
  const d = getDraft(id);
  if (d) saveDraft({ ...d, files: d.files.map((f) => ({ ...f, upload: undefined })) });
}

/**
 * Work through the queue for this person and organisation. Stops when the
 * queue is empty or the connection is gone; call again when it is back.
 */
export async function runQueue(owner: Owner | null, online: boolean): Promise<void> {
  if (!owner || !online || running) return;
  running = true;
  try {
    for (;;) {
      const next = draftsFor(owner).find((d) => d.status === 'queued');
      if (!next) break;
      try {
        await sendOne(next);
      } catch (err) {
        if (err instanceof NetworkError) {
          fail(next.id, 'Waiting for a connection. It will send when you are back online.', 'queued');
          break;
        }
        if (err instanceof ApiError && /did not arrive completely/.test(err.message) && !next.error?.startsWith('Sending again')) {
          restartUploads(next.id);
          fail(next.id, 'Sending again: the earlier upload expired.', 'queued');
          continue;
        }
        if (err instanceof ApiError && err.status === 401) {
          fail(next.id, 'Sign in again to send this.', 'queued');
          break;
        }
        fail(next.id, err instanceof ApiError ? err.message : 'This could not be sent. Try again.');
      }
    }
  } finally {
    running = false;
  }
}

/** Keep the queue moving while the app is open: on demand, and on a gentle timer for drafts waiting on a connection. */
export function startSender(getOwner: () => Owner | null, isOnline: () => boolean): () => void {
  let stopped = false;
  const tick = () => {
    if (!stopped) void runQueue(getOwner(), isOnline());
  };
  wake = tick;
  const timer = setInterval(tick, 30_000);
  tick();
  return () => {
    stopped = true;
    wake = null;
    clearInterval(timer);
  };
}
