import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getDb } from '@/db';
import { json, mobileCtx, mobileError, readBody } from '@/server/mobile-http';
import { mobileNotifications } from '@/server/services/mobile';
import { markRead } from '@/server/services/notify';

export async function GET() {
  const s = await mobileCtx();
  if (s instanceof NextResponse) return s;
  try {
    return json(await mobileNotifications(await getDb(), s.ctx));
  } catch (err) {
    return mobileError(err);
  }
}

const schema = z.object({ ids: z.array(z.string().max(64)).max(200).optional() });

/** Mark notifications read: the ones named, or all of them. */
export async function POST(request: Request) {
  const s = await mobileCtx();
  if (s instanceof NextResponse) return s;
  try {
    const { ids } = await readBody(request, schema);
    await markRead(await getDb(), s.ctx, ids);
    return json({ ok: true });
  } catch (err) {
    return mobileError(err);
  }
}
