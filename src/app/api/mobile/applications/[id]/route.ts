import { NextResponse } from 'next/server';
import { getDb } from '@/db';
import { json, mobileCtx, mobileError } from '@/server/mobile-http';
import { mobileApplicationDetail } from '@/server/services/mobile';

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const s = await mobileCtx();
  if (s instanceof NextResponse) return s;
  try {
    const detail = await mobileApplicationDetail(await getDb(), s.ctx, (await params).id);
    if (!detail) return json({ error: 'This application is not in your organisation, or it no longer exists.', code: 'not_found' }, { status: 404 });
    return json(detail);
  } catch (err) {
    return mobileError(err);
  }
}
