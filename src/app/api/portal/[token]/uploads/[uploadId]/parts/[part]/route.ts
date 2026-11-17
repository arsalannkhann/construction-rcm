import { getDb } from '@/db';
import { apiError, sameOrigin } from '@/server/http';
import { lookUpPortal, portalRefusal } from '@/server/portal-http';
import { stagePortalPart } from '@/server/services/portal';
import { UPLOAD_PART_BYTES } from '@/server/services/uploads';

export const dynamic = 'force-dynamic';

/** One part of a large file sent through a portal link (see src/server/services/uploads.ts for why files come in parts). */
export async function POST(request: Request, { params }: { params: Promise<{ token: string; uploadId: string; part: string }> }) {
  if (!sameOrigin(request)) return Response.json({ error: 'Cross-site request refused.' }, { status: 403 });
  const { token, uploadId, part } = await params;
  const found = await lookUpPortal(token, request.headers);
  if (!found.ok) return portalRefusal(found.reason);
  try {
    const declared = Number(request.headers.get('content-length'));
    if (declared > UPLOAD_PART_BYTES) return Response.json({ error: 'That part is too large.' }, { status: 413 });
    const bytes = new Uint8Array(await request.arrayBuffer());
    await stagePortalPart(await getDb(), found.access, uploadId, /^\d{1,3}$/.test(part) ? Number(part) : -1, bytes);
    return Response.json({ ok: true });
  } catch (err) {
    return apiError(err);
  }
}
