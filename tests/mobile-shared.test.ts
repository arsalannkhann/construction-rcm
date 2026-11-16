import { describe, expect, it } from 'vitest';
import { MAX_DRAFT_FILES } from '../mobile/src/lib/limits';
import { noneSkipped, roomFor, sharedExtension, sharedKind, sharedMimeType, skippedMessage, waitingTitle } from '../mobile/src/lib/shared-rules';

/**
 * Files shared to the phone app from another app. Only PDFs and images are
 * taken, never more than one capture holds, and the person is told about
 * anything left out.
 */
describe('files shared to the mobile app', () => {
  it('takes PDFs and images by their declared type', () => {
    expect(sharedKind('pay-app.pdf', 'application/pdf')).toBe('pdf');
    expect(sharedKind('IMG_0001.JPG', 'image/jpeg')).toBe('image');
    expect(sharedKind(null, 'image/heic')).toBe('image');
    expect(sharedKind('scan', 'APPLICATION/PDF')).toBe('pdf');
  });

  it('refuses any other declared type, whatever the name says', () => {
    expect(sharedKind('schedule.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')).toBeNull();
    expect(sharedKind('walkthrough.mp4', 'video/mp4')).toBeNull();
    expect(sharedKind('looks-like.pdf', 'text/plain')).toBeNull();
  });

  it('falls back to the name only when the other app gave no useful type', () => {
    expect(sharedKind('waiver.pdf', null)).toBe('pdf');
    expect(sharedKind('page.png', 'application/octet-stream')).toBe('image');
    expect(sharedKind('notes.txt', null)).toBeNull();
    expect(sharedKind(null, null)).toBeNull();
  });

  it('records a type and an extension a decoder recognises', () => {
    expect(sharedMimeType('pdf', 'x', null)).toBe('application/pdf');
    expect(sharedMimeType('image', 'photo.HEIC', null)).toBe('image/heic');
    expect(sharedMimeType('image', 'photo', 'image/png')).toBe('image/png');
    expect(sharedExtension('pdf', 'application/pdf')).toBe('.pdf');
    expect(sharedExtension('image', 'image/jpeg')).toBe('.jpg');
    expect(sharedExtension('image', 'image/webp')).toBe('.webp');
    expect(sharedExtension('image', 'image/x-unknown')).toBe('.jpg');
  });

  it('never holds more files than one capture takes', () => {
    expect(roomFor(0)).toBe(MAX_DRAFT_FILES);
    expect(roomFor(MAX_DRAFT_FILES - 1)).toBe(1);
    expect(roomFor(MAX_DRAFT_FILES)).toBe(0);
    expect(roomFor(MAX_DRAFT_FILES + 5)).toBe(0);
  });

  it('says nothing when every file was added, and names what was left out otherwise', () => {
    expect(skippedMessage(noneSkipped())).toBeNull();
    expect(skippedMessage({ ...noneSkipped(), tooLarge: ['Drawings.pdf'] })).toBe('“Drawings.pdf” is larger than 25 MB.');
    expect(skippedMessage({ ...noneSkipped(), tooLarge: [null] })).toBe('One file is larger than 25 MB.');
    const all = skippedMessage({ tooLarge: ['a.pdf', 'b.pdf'], unreadable: 1, unsupported: 2, overLimit: 3 });
    expect(all).toContain('2 files are larger than 25 MB.');
    expect(all).toContain('2 files are not a PDF or an image.');
    expect(all).toContain('One file could not be read');
    expect(all).toContain(`up to ${MAX_DRAFT_FILES} files, so 3 files were left out.`);
    expect(skippedMessage({ ...noneSkipped(), overLimit: 1 })).toContain('1 file was left out.');
  });

  it('tells a signed-out person how many shared files are waiting', () => {
    expect(waitingTitle(1)).toBe('A shared file is waiting');
    expect(waitingTitle(4)).toBe('4 shared files are waiting');
  });
});
