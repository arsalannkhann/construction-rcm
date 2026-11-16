/**
 * Rules for files shared to Zephric from another app, kept free of React
 * Native so they can be tested on their own (tests/mobile-shared.test.ts).
 */
import { plural } from './format';
import { MAX_DRAFT_FILES, MAX_FILE_BYTES } from './limits';

export type SharedKind = 'pdf' | 'image';

const IMAGE_TYPES: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  heic: 'image/heic',
  heif: 'image/heif',
  webp: 'image/webp',
};

function extensionOf(name: string | null | undefined): string {
  const m = /\.([a-z0-9]{1,5})$/i.exec(name ?? '');
  return m ? m[1]!.toLowerCase() : '';
}

/** What a shared file is, from its declared type or, when the other app gave none, its name. Anything else is refused. */
export function sharedKind(name: string | null | undefined, mimeType: string | null | undefined): SharedKind | null {
  const type = (mimeType ?? '').toLowerCase().trim();
  if (type === 'application/pdf') return 'pdf';
  if (type.startsWith('image/')) return 'image';
  // A real declared type that is neither: a spreadsheet, a video, a text file.
  if (type && type !== 'application/octet-stream') return null;
  const ext = extensionOf(name);
  if (ext === 'pdf') return 'pdf';
  if (ext in IMAGE_TYPES) return 'image';
  return null;
}

/** The type to record for an accepted file. */
export function sharedMimeType(kind: SharedKind, name: string | null | undefined, mimeType: string | null | undefined): string {
  const type = (mimeType ?? '').toLowerCase().trim();
  if (kind === 'pdf') return 'application/pdf';
  if (type.startsWith('image/')) return type;
  return IMAGE_TYPES[extensionOf(name)] ?? 'image/jpeg';
}

/** The extension to store the copy under, so image decoders and previews recognise it. */
export function sharedExtension(kind: SharedKind, mimeType: string): string {
  if (kind === 'pdf') return '.pdf';
  const sub = mimeType.split('/')[1] ?? '';
  return sub === 'jpeg' ? '.jpg' : sub in IMAGE_TYPES ? `.${sub}` : '.jpg';
}

/** Room left for shared files waiting to become a capture. */
export function roomFor(waiting: number): number {
  return Math.max(MAX_DRAFT_FILES - waiting, 0);
}

export type Skipped = { tooLarge: (string | null)[]; unreadable: number; unsupported: number; overLimit: number };

export function noneSkipped(): Skipped {
  return { tooLarge: [], unreadable: 0, unsupported: 0, overLimit: 0 };
}

/** What to tell the person about files that were not added, or null when every file was. */
export function skippedMessage(s: Skipped): string | null {
  const mb = Math.round(MAX_FILE_BYTES / (1024 * 1024));
  const parts: string[] = [];
  if (s.tooLarge.length === 1) parts.push(s.tooLarge[0] ? `“${s.tooLarge[0]}” is larger than ${mb} MB.` : `One file is larger than ${mb} MB.`);
  else if (s.tooLarge.length > 1) parts.push(`${s.tooLarge.length} files are larger than ${mb} MB.`);
  if (s.unsupported > 0) parts.push(`${s.unsupported === 1 ? 'One file is' : `${s.unsupported} files are`} not a PDF or an image.`);
  if (s.unreadable > 0) parts.push(`${s.unreadable === 1 ? 'One file' : `${s.unreadable} files`} could not be read; try sharing again.`);
  if (s.overLimit > 0) parts.push(`A capture takes up to ${MAX_DRAFT_FILES} files, so ${plural(s.overLimit, 'file was', 'files were')} left out.`);
  return parts.length > 0 ? parts.join(' ') : null;
}

/** The sign-in screen's heading for shared files waiting. */
export function waitingTitle(n: number): string {
  return n === 1 ? 'A shared file is waiting' : `${n} shared files are waiting`;
}
