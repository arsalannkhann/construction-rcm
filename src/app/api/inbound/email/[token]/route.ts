import { NextResponse } from 'next/server';
import { getDb } from '@/db';
import { InboundRejected, parseInboundJson, parseInboundMime, presentedSecret, receiveInboundEmail } from '@/server/services/inbound';

const MAX_BYTES = 40 * 1024 * 1024;

/**
 * Webhook for an inbound-email provider. Authenticated by the intake token in
 * the path plus a shared secret. A message that is delivered correctly but is
 * not usable (a duplicate, no attachments, an unknown sender under the strict
 * policy) is answered with 200 and what happened to it, so the provider does
 * not retry; only a delivery problem gets an error status.
 */
export async function POST(request: Request, { params }: { params: Promise<{ token: string }> }) {
  try {
    const { token } = await params;
    const declared = Number(request.headers.get('content-length') ?? '0');
    if (declared > MAX_BYTES) return NextResponse.json({ error: 'Message too large.' }, { status: 413 });
    const raw = new Uint8Array(await request.arrayBuffer());
    if (raw.byteLength > MAX_BYTES) return NextResponse.json({ error: 'Message too large.' }, { status: 413 });
    const type = request.headers.get('content-type') ?? '';
    let message;
    if (type.includes('application/json')) {
      let body: unknown;
      try {
        body = JSON.parse(new TextDecoder().decode(raw));
      } catch {
        return NextResponse.json({ error: 'The body is not valid JSON.' }, { status: 422 });
      }
      message = parseInboundJson(body);
    } else {
      message = await parseInboundMime(raw);
    }
    const result = await receiveInboundEmail(await getDb(), token, presentedSecret(request), message);
    return NextResponse.json(result);
  } catch (err) {
    if (err instanceof InboundRejected) return NextResponse.json({ error: err.message }, { status: err.status });
    console.error('[inbound] unexpected error:', err);
    return NextResponse.json({ error: 'The message could not be processed.' }, { status: 500 });
  }
}
