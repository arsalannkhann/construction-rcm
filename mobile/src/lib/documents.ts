/**
 * Opening an original document: downloaded with the session, into a cache
 * folder that is emptied at sign-out, then shown in the system viewer.
 */
import { Directory, File, Paths } from 'expo-file-system';
import * as Sharing from 'expo-sharing';
import { authHeaders, currentServer, NetworkError } from './api';

function cacheDir(): Directory {
  const dir = new Directory(Paths.cache, 'documents');
  if (!dir.exists) dir.create({ intermediates: true });
  return dir;
}

export async function openDocument(doc: { id: string; filename: string; mimeType: string }): Promise<void> {
  const safe = doc.filename.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').slice(0, 120) || 'document';
  const target = new File(cacheDir(), `${doc.id}-${safe}`);
  if (!target.exists) {
    try {
      await File.downloadFileAsync(`${currentServer()}/api/documents/${doc.id}/file`, target, { headers: authHeaders(), idempotent: true });
    } catch {
      throw new NetworkError('The document could not be downloaded. Check your connection and try again.');
    }
  }
  if (await target.canPreview({ mimeType: doc.mimeType }).catch(() => false)) {
    await target.preview({ title: doc.filename, mimeType: doc.mimeType });
    return;
  }
  if (await Sharing.isAvailableAsync()) await Sharing.shareAsync(target.uri, { mimeType: doc.mimeType, dialogTitle: doc.filename });
}

/** Called at sign-out and organisation switch: no document stays on the phone afterwards. */
export function clearDocumentCache(): void {
  try {
    const dir = new Directory(Paths.cache, 'documents');
    if (dir.exists) dir.delete();
  } catch {
    /* The system clears its cache folder in time anyway. */
  }
}
