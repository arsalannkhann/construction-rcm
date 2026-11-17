import { getDb } from '@/db';
import { apiError, sameOrigin } from '@/server/http';
import { lookUpPortal, portalRefusal } from '@/server/portal-http';
import { portalFilesFromForm, submitThroughPortal } from '@/server/services/portal';

export const dynamic = 'force-dynamic';

/**
 * A billing package sent through a subcontractor's portal link. The link is the
 * only credential; it reaches one subcontract (src/server/services/portal.ts).
 */
export async function POST(request: Request, { params }: { params: Promise<{ token: string }> }) {
  if (!sameOrigin(request)) return Response.json({ error: 'Cross-site request refused.' }, { status: 403 });
  const { token } = await params;
  const found = await lookUpPortal(token, request.headers);
  if (!found.ok) return portalRefusal(found.reason);
  try {
    const db = await getDb();
    const form = await request.formData();
    const { files, staged } = await portalFilesFromForm(db, found.access, form);
    const result = await submitThroughPortal(db, found.access, files, { staged });
    return Response.json({ received: true, files: result.files }, { headers: { 'cache-control': 'no-store' } });
  } catch (err) {
    return apiError(err);
  }
}
