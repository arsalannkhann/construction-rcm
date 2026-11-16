import { NextResponse } from 'next/server';
import { getDb } from '@/db';
import { json, mobileCtx, mobileError } from '@/server/mobile-http';
import { mobileHome } from '@/server/services/mobile';

export async function GET() {
  const s = await mobileCtx();
  if (s instanceof NextResponse) return s;
  try {
    return json(await mobileHome(await getDb(), s.ctx));
  } catch (err) {
    return mobileError(err);
  }
}
