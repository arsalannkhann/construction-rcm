import { NextResponse } from 'next/server';
import { getDb } from '@/db';
import { apiCtx, apiError, sameOrigin } from '@/server/http';
import { createApplication } from '@/server/services/intake';
import { filesFromForm } from '@/server/services/uploads';

/** Serverless hosting: the package is read after the response is sent, within this limit (src/server/jobs.ts). */
export const maxDuration = 300;

/**
 * Upload a billing package: multipart form with one or more `files` and an optional `contractId`.
 * Files too large for one request arrive beforehand in parts and are named in `staged` entries (src/server/services/uploads.ts).
 */
export async function POST(request: Request) {
  const ctx = await apiCtx();
  if (ctx instanceof NextResponse) return ctx;
  if (!sameOrigin(request)) return NextResponse.json({ error: 'Cross-site request refused.' }, { status: 403 });
  try {
    const form = await request.formData();
    const db = await getDb();
    const { files, done } = await filesFromForm(db, ctx, form);
    const contractId = form.get('contractId');
    const { id } = await createApplication(db, ctx, { files, contractId: typeof contractId === 'string' && contractId ? contractId : null });
    await done();
    return NextResponse.json({ id });
  } catch (err) {
    return apiError(err);
  }
}
