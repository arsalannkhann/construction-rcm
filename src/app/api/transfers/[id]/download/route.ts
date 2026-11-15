import { NextResponse } from 'next/server';
import { getDb } from '@/db';
import { apiCtx, apiError, contentDisposition } from '@/server/http';
import { getTransferFile } from '@/server/services/exports';

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await apiCtx();
  if (ctx instanceof NextResponse) return ctx;
  try {
    const { id } = await params;
    const file = await getTransferFile(await getDb(), ctx, id);
    return new NextResponse(new Uint8Array(file.bytes), {
      headers: {
        'Content-Type': file.contentType,
        'Content-Length': String(file.bytes.byteLength),
        'Content-Disposition': contentDisposition('attachment', file.filename),
        'Cache-Control': 'private, no-store',
      },
    });
  } catch (err) {
    return apiError(err);
  }
}
