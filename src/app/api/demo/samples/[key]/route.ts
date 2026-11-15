import { NextResponse } from 'next/server';
import { getDb } from '@/db';
import { apiCtx, apiError, contentDisposition } from '@/server/http';
import { renderDemoSample } from '@/server/services/demo';

/** A generated sample billing package for the demo workspace. */
export async function GET(_request: Request, { params }: { params: Promise<{ key: string }> }) {
  const ctx = await apiCtx();
  if (ctx instanceof NextResponse) return ctx;
  try {
    const { key } = await params;
    const sample = await renderDemoSample(await getDb(), ctx, key);
    return new NextResponse(new Uint8Array(sample.bytes), {
      headers: { 'Content-Type': 'application/pdf', 'Content-Disposition': contentDisposition('attachment', sample.filename), 'Cache-Control': 'private, no-store' },
    });
  } catch (err) {
    return apiError(err);
  }
}
