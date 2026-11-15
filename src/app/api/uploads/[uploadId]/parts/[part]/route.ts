import { NextResponse } from 'next/server';
import { getDb } from '@/db';
import { apiCtx, apiError, sameOrigin } from '@/server/http';
import { stagePart, UPLOAD_PART_BYTES } from '@/server/services/uploads';

/**
 * One part of a large file, as the raw request body (src/server/services/uploads.ts).
 * The parts are joined by the request that creates the application or adds documents.
 */
export async function POST(request: Request, { params }: { params: Promise<{ uploadId: string; part: string }> }) {
  const ctx = await apiCtx();
  if (ctx instanceof NextResponse) return ctx;
  if (!sameOrigin(request)) return NextResponse.json({ error: 'Cross-site request refused.' }, { status: 403 });
  try {
    const { uploadId, part } = await params;
    const declared = Number(request.headers.get('content-length'));
    if (declared > UPLOAD_PART_BYTES) return NextResponse.json({ error: 'That part is too large.' }, { status: 413 });
    const bytes = new Uint8Array(await request.arrayBuffer());
    await stagePart(await getDb(), ctx, uploadId, /^\d{1,3}$/.test(part) ? Number(part) : -1, bytes);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return apiError(err);
  }
}
