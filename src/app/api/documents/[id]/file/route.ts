import { NextResponse } from 'next/server';
import { getDb } from '@/db';
import { apiCtx, apiError, contentDisposition } from '@/server/http';
import { getDocumentForDownload } from '@/server/services/queries';
import { getObject } from '@/server/storage';

/** Serve an original document, exactly as received, to a member of the organisation that owns it. */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await apiCtx();
  if (ctx instanceof NextResponse) return ctx;
  try {
    const { id } = await params;
    const doc = await getDocumentForDownload(await getDb(), ctx, id);
    const bytes = await getObject(doc.storageKey);
    // Only types we know are safe to render inline; anything else downloads.
    const inline = ['application/pdf', 'image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(doc.mimeType);
    return new NextResponse(new Uint8Array(bytes), {
      headers: {
        'Content-Type': inline ? doc.mimeType : 'application/octet-stream',
        'Content-Length': String(bytes.byteLength),
        'Content-Disposition': contentDisposition(inline ? 'inline' : 'attachment', doc.filename),
        'Cache-Control': 'private, max-age=3600, immutable',
        'X-Content-Type-Options': 'nosniff',
      },
    });
  } catch (err) {
    return apiError(err);
  }
}
