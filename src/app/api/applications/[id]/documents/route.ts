import { NextResponse } from 'next/server';
import { getDb } from '@/db';
import { apiCtx, apiError, sameOrigin } from '@/server/http';
import { addDocuments, type IncomingFile } from '@/server/services/intake';

/** Add documents to an existing application (for example a corrected resubmission). The package is read again. */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await apiCtx();
  if (ctx instanceof NextResponse) return ctx;
  if (!sameOrigin(request)) return NextResponse.json({ error: 'Cross-site request refused.' }, { status: 403 });
  try {
    const { id } = await params;
    const form = await request.formData();
    const files: IncomingFile[] = [];
    for (const entry of form.getAll('files')) {
      if (typeof entry === 'string') continue;
      files.push({ filename: entry.name, mimeType: entry.type, bytes: new Uint8Array(await entry.arrayBuffer()) });
    }
    await addDocuments(await getDb(), ctx, id, files);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return apiError(err);
  }
}
