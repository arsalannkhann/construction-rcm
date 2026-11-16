import { NextResponse } from 'next/server';
import { getDb } from '@/db';
import { json, mobileCtx, mobileError, readBody } from '@/server/mobile-http';
import { approveFromPhone, approveSchema } from '@/server/services/mobile';

/**
 * Approve from the phone. Only an application submitted for approval with
 * nothing open; anything else answers 409 `desktop_required`. The version and
 * amount the person was shown must still be current.
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const s = await mobileCtx();
  if (s instanceof NextResponse) return s;
  try {
    const input = await readBody(request, approveSchema);
    return json(await approveFromPhone(await getDb(), s.ctx, (await params).id, input));
  } catch (err) {
    return mobileError(err);
  }
}
