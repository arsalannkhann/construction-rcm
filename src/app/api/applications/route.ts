import { NextResponse } from 'next/server';
import { getDb } from '@/db';
import { apiCtx, apiError, sameOrigin } from '@/server/http';
import { createApplication, type IncomingFile } from '@/server/services/intake';

/** Upload a billing package: multipart form with one or more `files` and an optional `contractId`. */
export async function POST(request: Request) {
  const ctx = await apiCtx();
  if (ctx instanceof NextResponse) return ctx;
  if (!sameOrigin(request)) return NextResponse.json({ error: 'Cross-site request refused.' }, { status: 403 });
  try {
    const form = await request.formData();
    const files: IncomingFile[] = [];
    for (const entry of form.getAll('files')) {
      if (typeof entry === 'string') continue;
      files.push({ filename: entry.name, mimeType: entry.type, bytes: new Uint8Array(await entry.arrayBuffer()) });
    }
    const contractId = form.get('contractId');
    const { id } = await createApplication(await getDb(), ctx, { files, contractId: typeof contractId === 'string' && contractId ? contractId : null });
    return NextResponse.json({ id });
  } catch (err) {
    return apiError(err);
  }
}
