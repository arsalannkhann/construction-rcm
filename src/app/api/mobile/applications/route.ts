import { NextResponse } from 'next/server';
import { getDb } from '@/db';
import { json, mobileCtx, mobileError, readBody } from '@/server/mobile-http';
import { MOBILE_VIEWS, mobileApplications, submitFromPhone, submitSchema, type MobileView } from '@/server/services/mobile';

/** Serverless hosting: the package is read after the response is sent, within this limit (src/server/jobs.ts). */
export const maxDuration = 300;

export async function GET(request: Request) {
  const s = await mobileCtx();
  if (s instanceof NextResponse) return s;
  try {
    const asked = new URL(request.url).searchParams.get('view') ?? 'open';
    const view: MobileView = (MOBILE_VIEWS as readonly string[]).includes(asked) ? (asked as MobileView) : 'open';
    return json({ view, items: await mobileApplications(await getDb(), s.ctx, view) });
  } catch (err) {
    return mobileError(err);
  }
}

/**
 * Submit a capture: files staged beforehand in parts at /api/uploads/:uploadId/parts/:part,
 * named here with the draft's client reference. Sending it again returns the same application.
 */
export async function POST(request: Request) {
  const s = await mobileCtx();
  if (s instanceof NextResponse) return s;
  try {
    const input = await readBody(request, submitSchema);
    const result = await submitFromPhone(await getDb(), s.ctx, input);
    return json(result, { status: result.duplicate ? 200 : 201 });
  } catch (err) {
    return mobileError(err);
  }
}
