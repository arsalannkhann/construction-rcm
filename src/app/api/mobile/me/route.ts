import { NextResponse } from 'next/server';
import { getDb } from '@/db';
import { json, mobileError, mobileSession } from '@/server/mobile-http';
import { mobileMe } from '@/server/services/mobile';

/** Who is signed in, in which organisation, and what they may do there. */
export async function GET() {
  const s = await mobileSession();
  if (s instanceof NextResponse) return s;
  try {
    const me = await mobileMe(await getDb(), s.session);
    return json({ ...me, mfaRequired: s.session.mfaRequired });
  } catch (err) {
    return mobileError(err);
  }
}
