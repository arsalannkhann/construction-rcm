/**
 * GET /api/owner-applications/<id>/pdf — the main contractor's application
 * for payment to the owner, as a PDF: the submitted record, or a draft marked
 * as one. The organisation is the session's; nothing in the request can
 * choose another.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { getDb } from '@/db';
import { apiCtx, apiError, contentDisposition } from '@/server/http';
import { ownerApplicationForPdf } from '@/server/services/owner-billing';
import { renderOwnerApplicationPdf } from '@/server/services/owner-billing-pdf';

export const dynamic = 'force-dynamic';

export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await apiCtx();
  if (ctx instanceof NextResponse) return ctx;
  try {
    const { id } = await params;
    const { record, draft, filename } = await ownerApplicationForPdf(await getDb(), ctx, id);
    const bytes = await renderOwnerApplicationPdf(record, { draft });
    return new NextResponse(Buffer.from(bytes), {
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': contentDisposition('inline', filename),
        'Cache-Control': 'private, no-store',
      },
    });
  } catch (err) {
    return apiError(err);
  }
}
