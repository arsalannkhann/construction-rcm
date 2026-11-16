import { NextResponse } from 'next/server';
import { getDb } from '@/db';
import { json, mobileCtx, mobileError } from '@/server/mobile-http';
import { mobileProject } from '@/server/services/mobile';

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const s = await mobileCtx();
  if (s instanceof NextResponse) return s;
  try {
    const project = await mobileProject(await getDb(), s.ctx, (await params).id);
    if (!project) return json({ error: 'This project is not in your organisation, or it no longer exists.', code: 'not_found' }, { status: 404 });
    return json(project);
  } catch (err) {
    return mobileError(err);
  }
}
