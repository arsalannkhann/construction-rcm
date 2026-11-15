import { NextResponse } from 'next/server';
import { getDb } from '@/db';
import { InboundRejected, parseInboundJson, parseInboundMime, receiveInboundEmail } from '@/server/services/inbound';

const MAX_BYTES = 40 * 1024 * 1024;

/** Webhook for an inbound-email provider. Authenticated by the intake token in the path plus a shared secret. */
export async function POST(request: Request, { params }: { params: Promise<{ token: string }> }) {
  try {
    const { token } = await params;
    const secret = new URL(request.url).searchParams.get('secret') ?? request.headers.get('x-inbound-secret');
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
    const result = await receiveInboundEmail(await getDb(), token, secret, message);
    return NextResponse.json(result);
  } catch (err) {
    if (err instanceof InboundRejected) return NextResponse.json({ error: err.message }, { status: err.status });
    console.error('[inbound] unexpected error:', err);
    return NextResponse.json({ error: 'The message could not be processed.' }, { status: 500 });
  }
}
