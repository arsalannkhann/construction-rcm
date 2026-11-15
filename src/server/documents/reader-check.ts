/**
 * Whether this deployment can read a PDF at all: a tiny one with a known line
 * of text is opened with the same reader uploads go through.
 *
 * The first live deployment answered its health check with "ok" while no PDF
 * could be opened, because a file the reader loads at run time had not been
 * deployed. Nothing about the database or the queue shows that; only reading
 * a document does.
 */
import { readPdfText, type PdfText } from './pdf-text';

/** The only text on the test PDF. */
export const READER_CHECK_TEXT = 'Construction RCM reader check';

/** One page (200 × 60 pt, standard Helvetica, made with pdf-lib) whose only text is READER_CHECK_TEXT. */
const READER_CHECK_PDF = [
  'JVBERi0xLjcKJYGBgYEKCjEgMCBvYmoKPDwKL1R5cGUgL1BhZ2VzCi9LaWRzIFsgNCAwIFIgXQovQ291bnQgMQo+PgplbmRvYmoKCjIgMCBvYmoKPDwKL1R5',
  'cGUgL0NhdGFsb2cKL1BhZ2VzIDEgMCBSCj4+CmVuZG9iagoKMyAwIG9iago8PAovUHJvZHVjZXIgPEZFRkYwMDYzMDA2RjAwNkUwMDczMDA3NDAwNzIwMDc1',
  'MDA2MzAwNzQwMDY5MDA2RjAwNkUwMDJEMDA3MjAwNjMwMDZEPgovTW9kRGF0ZSAoRDoyMDI2MDEwMTAwMDAwMFopCi9DcmVhdG9yIDxGRUZGMDA2MzAwNkYw',
  'MDZFMDA3MzAwNzQwMDcyMDA3NTAwNjMwMDc0MDA2OTAwNkYwMDZFMDAyRDAwNzIwMDYzMDA2RD4KL0NyZWF0aW9uRGF0ZSAoRDoyMDI2MDEwMTAwMDAwMFop',
  'Ci9UaXRsZSA8RkVGRjAwNTIwMDY1MDA2MTAwNjQwMDY1MDA3MjAwMjAwMDYzMDA2ODAwNjUwMDYzMDA2Qj4KPj4KZW5kb2JqCgo0IDAgb2JqCjw8Ci9UeXBl',
  'IC9QYWdlCi9QYXJlbnQgMSAwIFIKL1Jlc291cmNlcyA8PAovRm9udCA8PAovSGVsdmV0aWNhLTcwOTg0ODA3ODkgNSAwIFIKPj4KL1hPYmplY3QgPDwKPj4K',
  'L0V4dEdTdGF0ZSA8PAo+Pgo+PgovTWVkaWFCb3ggWyAwIDAgMjAwIDYwIF0KL0Fubm90cyBbIF0KL0NvbnRlbnRzIFsgNiAwIFIgXQo+PgplbmRvYmoKCjUg',
  'MCBvYmoKPDwKL1R5cGUgL0ZvbnQKL1N1YnR5cGUgL1R5cGUxCi9CYXNlRm9udCAvSGVsdmV0aWNhCi9FbmNvZGluZyAvV2luQW5zaUVuY29kaW5nCj4+CmVu',
  'ZG9iagoKNiAwIG9iago8PAovRmlsdGVyIC9GbGF0ZURlY29kZQovTGVuZ3RoIDEyMwo+PgpzdHJlYW0KeJwdijEKAkEMRfucIrUgZjKZnxkQi8UVCxshFxBZ',
  'RdFCEc/vjvzi8R7/RUOQcN/7Sqv99PhOn9v5tHRp1ap4bZyE40JqHAdK/2vqTQvHk9aWscPo2c3VC2ai9aJS1LJtVVxRkGAorirIqLNnDBuOO8WCxqAj/QBU',
  '1x3YCmVuZHN0cmVhbQplbmRvYmoKCnhyZWYKMCA3CjAwMDAwMDAwMDAgNjU1MzUgZiAKMDAwMDAwMDAxNiAwMDAwMCBuIAowMDAwMDAwMDc2IDAwMDAwIG4g',
  'CjAwMDAwMDAxMjYgMDAwMDAgbiAKMDAwMDAwMDQzNCAwMDAwMCBuIAowMDAwMDAwNjI4IDAwMDAwIG4gCjAwMDAwMDA3MjYgMDAwMDAgbiAKCnRyYWlsZXIK',
  'PDwKL1NpemUgNwovUm9vdCAyIDAgUgovSW5mbyAzIDAgUgo+PgoKc3RhcnR4cmVmCjkyMgolJUVPRg==',
].join('');

export type ReaderCheck = { ok: boolean };

let passed = false;

/**
 * Open the test PDF and find its text. The cause of a failure goes to the
 * server log only: the result is served without sign-in.
 */
export async function checkPdfReader(read: (bytes: Uint8Array) => Promise<PdfText> = readPdfText): Promise<ReaderCheck> {
  // What a deployment ships cannot change while it runs, so one success per process is enough.
  const real = read === readPdfText;
  if (real && passed) return { ok: true };
  try {
    const text = await read(new Uint8Array(Buffer.from(READER_CHECK_PDF, 'base64')));
    if (!text.pages.some((p) => p.text.includes(READER_CHECK_TEXT))) throw new Error(`the test PDF opened (${text.pageCount} page(s)) but its text was not found`);
    if (real) passed = true;
    return { ok: true };
  } catch (err) {
    console.error(`[health] this deployment could not read a test PDF: ${err instanceof Error ? err.message : String(err)}`);
    return { ok: false };
  }
}
