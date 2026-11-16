import { NextResponse } from 'next/server';
import { getDb } from '@/db';
import { authorizeInbound, deliverInbound, InboundRejected, parseInboundJson, parseInboundMime, presentedSecret } from '@/server/services/inbound';

/**
 * Larger than any message an inbound provider forwards (Postmark: 35 MB of
 * attachments, which base64 makes about 47 MB of JSON). On Vercel the platform
 * refuses any request body over 4.5 MB before it reaches this code.
 */
const MAX_BYTES = 50 * 1024 * 1024;

/**
 * Webhook for an inbound-email provider. Authenticated by the intake token in
 * the path plus a shared secret, both checked before the body is read. A
 * message that is delivered correctly but is not usable (a duplicate, no
 * attachments, spam, an unknown sender under the strict policy) is answered
 * with 200 and what happened to it, so the provider does not retry. 403 means
 * "do not retry" (Postmark stops on it); 401, 503 and 500 are retried.
 */
export async function POST(request: Request, { params }: { params: Promise<{ token: string }> }) {
  try {
    const { token } = await params;
    const db = await getDb();
    const org = await authorizeInbound(db, token, presentedSecret(request));

    const declared = Number(request.headers.get('content-length') ?? '0');
    if (declared > MAX_BYTES) throw new InboundRejected(403, 'Message too large.');
    const raw = new Uint8Array(await request.arrayBuffer());
    if (raw.byteLength > MAX_BYTES) throw new InboundRejected(403, 'Message too large.');

    const type = request.headers.get('content-type') ?? '';
    let message;
    if (type.includes('application/json')) {
      let body: unknown;
      try {
        body = JSON.parse(new TextDecoder().decode(raw));
      } catch {
        throw new InboundRejected(403, 'The body is not valid JSON.');
      }
      message = parseInboundJson(body);
    } else {
      try {
        message = await parseInboundMime(raw);
      } catch {
        throw new InboundRejected(403, 'The body is not a readable email message.');
      }
    }
    return NextResponse.json(await deliverInbound(db, org, message));
  } catch (err) {
    if (err instanceof InboundRejected) {
      console.warn(`[inbound] refused with ${err.status}: ${err.message}`);
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    console.error('[inbound] unexpected error:', err);
    return NextResponse.json({ error: 'The message could not be processed.' }, { status: 500 });
  }
}
