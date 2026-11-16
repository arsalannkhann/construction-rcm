import { NextResponse } from 'next/server';
import { getDb } from '@/db';
import { json, mobileCtx, mobileError } from '@/server/mobile-http';
import { mobileContracts } from '@/server/services/mobile';

/** Active subcontracts, grouped by project, to file a capture against. */
export async function GET() {
  const s = await mobileCtx();
  if (s instanceof NextResponse) return s;
  try {
    return json({ items: await mobileContracts(await getDb(), s.ctx) });
  } catch (err) {
    return mobileError(err);
  }
}
