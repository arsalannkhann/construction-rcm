import { NextResponse } from 'next/server';
import { getDb } from '@/db';
import { apiCtx, apiError } from '@/server/http';
import { kick } from '@/server/jobs';
import { applicationStatus } from '@/server/services/queries';

/** Serverless hosting: the package is read after the response is sent, within this limit (src/server/jobs.ts). */
export const maxDuration = 300;

/** Polled by the processing screen. */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await apiCtx();
  if (ctx instanceof NextResponse) return ctx;
  try {
    const { id } = await params;
    const status = await applicationStatus(await getDb(), ctx, id);
    if (!status) return NextResponse.json({ error: 'Application not found.' }, { status: 404 });
    // If something is still queued (for example after a restart), make sure the runner is going.
    if (status.status === 'processing' && !status.processingError) kick();
    return NextResponse.json({ status: status.status, error: status.processingError });
  } catch (err) {
    return apiError(err);
  }
}
