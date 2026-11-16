import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getDb } from '@/db';
import { json, mobileCtx, mobileError, readBody } from '@/server/mobile-http';
import { addComment } from '@/server/services/review';

const schema = z.object({ body: z.string().max(4000) });

/** An internal comment on the application, visible to the team. */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const s = await mobileCtx();
  if (s instanceof NextResponse) return s;
  try {
    const { body } = await readBody(request, schema);
    await addComment(await getDb(), s.ctx, (await params).id, body);
    return json({ ok: true }, { status: 201 });
  } catch (err) {
    return mobileError(err);
  }
}
