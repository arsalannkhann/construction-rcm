/**
 * The public website's "design partner" form posts here (src/components/marketing/partner-form.tsx).
 * No sign-in. See src/server/services/inquiries.ts for what is accepted.
 */
import { getDb } from '@/db';
import { clientIp } from '@/server/auth/request-meta';
import { MAX_INQUIRY_BYTES, receiveInquiry, sameSite } from '@/server/services/inquiries';

export const dynamic = 'force-dynamic';

const headers = { 'cache-control': 'no-store' };
const fail = (status: number, error: string) => Response.json({ error }, { status, headers });

export async function POST(request: Request) {
  if (!sameSite(request.headers.get('origin'), request.headers.get('host'))) return fail(403, 'This submission origin is not allowed.');
  if (!(request.headers.get('content-type') ?? '').startsWith('application/json')) return fail(415, 'Use JSON for this request.');
  if (Number(request.headers.get('content-length') ?? 0) > MAX_INQUIRY_BYTES) return fail(413, 'Your inquiry is too large.');
  const text = await request.text();
  if (Buffer.byteLength(text) > MAX_INQUIRY_BYTES) return fail(413, 'Your inquiry is too large.');
  let input: unknown;
  try {
    input = JSON.parse(text);
  } catch {
    return fail(400, 'Invalid JSON request.');
  }
  try {
    const result = await receiveInquiry(await getDb(), input, { address: clientIp(request.headers) });
    if (!result.ok) return fail(result.status, result.error);
    return Response.json({ reference: result.reference }, { status: 201, headers });
  } catch (err) {
    // Never the submission itself.
    console.error('[inquiries] could not store an inquiry:', err instanceof Error ? err.message : 'unknown error');
    return fail(503, 'We could not save your inquiry right now. Please try again later.');
  }
}
