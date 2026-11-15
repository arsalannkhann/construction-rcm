/**
 * Builds the form for an upload request in the browser.
 *
 * Serverless hosting caps one request at 4.5 MB (Vercel). A package that fits
 * in WHOLE_LIMIT is sent whole, as before. Anything bigger is first sent to the
 * server in parts of PART_BYTES (/api/uploads/<id>/parts/<n>), and the form
 * only names the staged files. See src/server/services/uploads.ts.
 */

/** Must equal UPLOAD_PART_BYTES on the server. */
export const PART_BYTES = 4 * 1024 * 1024;
/** Packages up to this size go in one request. */
export const WHOLE_LIMIT = 4 * 1024 * 1024;

export class UploadError extends Error {}

async function sendPart(uploadId: string, part: number, body: Blob): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    let res: Response;
    try {
      res = await fetch(`/api/uploads/${uploadId}/parts/${part}`, { method: 'POST', body, headers: { 'content-type': 'application/octet-stream' } });
    } catch {
      if (attempt < 3) continue;
      throw new UploadError('The upload did not complete. Check your connection and try again.');
    }
    if (res.ok) return;
    if (res.status >= 500 && attempt < 3) continue;
    const json = (await res.json().catch(() => ({}))) as { error?: string };
    throw new UploadError(json.error ?? 'The upload could not be completed. Nothing was saved.');
  }
}

/**
 * The FormData for `files` plus `fields`. Large packages are staged first;
 * `onProgress` hears the share sent so far, from 0 to 1.
 */
export async function buildUploadForm(files: File[], fields: Record<string, string> = {}, onProgress?: (share: number) => void): Promise<FormData> {
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) form.append(k, v);
  const total = files.reduce((n, f) => n + f.size, 0);
  if (total <= WHOLE_LIMIT) {
    for (const f of files) form.append('files', f);
    return form;
  }
  let sent = 0;
  for (const f of files) {
    const uploadId = crypto.randomUUID();
    for (let part = 0, offset = 0; offset < f.size; part++, offset += PART_BYTES) {
      const chunk = f.slice(offset, Math.min(offset + PART_BYTES, f.size));
      await sendPart(uploadId, part, chunk);
      sent += chunk.size;
      onProgress?.(sent / total);
    }
    form.append('staged', JSON.stringify({ uploadId, name: f.name, type: f.type, size: f.size }));
  }
  return form;
}
