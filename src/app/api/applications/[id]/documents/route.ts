import { NextResponse } from 'next/server';
import { getDb } from '@/db';
import { apiCtx, apiError, sameOrigin } from '@/server/http';
import { addDocuments } from '@/server/services/intake';
import { filesFromForm } from '@/server/services/uploads';

/** Serverless hosting: the package is read after the response is sent, within this limit (src/server/jobs.ts). */
export const maxDuration = 300;

/** Add documents to an existing application (for example a corrected resubmission). The package is read again. */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await apiCtx();
  if (ctx instanceof NextResponse) return ctx;
  if (!sameOrigin(request)) return NextResponse.json({ error: 'Cross-site request refused.' }, { status: 403 });
  try {
    const { id } = await params;
    const form = await request.formData();
    const db = await getDb();
    const { files, done } = await filesFromForm(db, ctx, form);
    await addDocuments(db, ctx, id, files);
    await done();
    return NextResponse.json({ ok: true });
  } catch (err) {
    return apiError(err);
  }
}
