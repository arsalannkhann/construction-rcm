import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getDb } from '@/db';
import { json, mobileError, mobileSession, readBody } from '@/server/mobile-http';
import { switchOrganization } from '@/server/services/team';

const schema = z.object({ orgId: z.string().min(1).max(64) });

/** Move this session to another organisation the person belongs to. The app clears everything it holds from the old one. */
export async function POST(request: Request) {
  const s = await mobileSession();
  if (s instanceof NextResponse) return s;
  try {
    const { orgId } = await readBody(request, schema);
    await switchOrganization(await getDb(), s.token, s.session.user.id, orgId);
    return json({ ok: true });
  } catch (err) {
    return mobileError(err);
  }
}
