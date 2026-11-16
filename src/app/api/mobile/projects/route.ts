import { NextResponse } from 'next/server';
import { getDb } from '@/db';
import { json, mobileCtx, mobileError } from '@/server/mobile-http';
import { mobileProjects } from '@/server/services/mobile';

export async function GET() {
  const s = await mobileCtx();
  if (s instanceof NextResponse) return s;
  try {
    return json({ items: await mobileProjects(await getDb(), s.ctx) });
  } catch (err) {
    return mobileError(err);
  }
}
