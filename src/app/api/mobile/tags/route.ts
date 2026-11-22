import { NextResponse } from 'next/server';
import { getDb } from '@/db';
import { json, mobileCtx, mobileError } from '@/server/mobile-http';
import { mobileTags } from '@/server/services/mobile';

/** The organisation's tags, most used first, offered as one-tap choices when sending. */
export async function GET() {
  const s = await mobileCtx();
  if (s instanceof NextResponse) return s;
  try {
    return json({ items: await mobileTags(await getDb(), s.ctx) });
  } catch (err) {
    return mobileError(err);
  }
}
