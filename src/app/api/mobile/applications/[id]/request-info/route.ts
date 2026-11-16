import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getDb } from '@/db';
import { assertCan } from '@/server/auth/permissions';
import { json, mobileCtx, mobileError, readBody } from '@/server/mobile-http';
import { draftCorrectionRequest, sendSubcontractorMessage } from '@/server/services/review';

/** The drafted correction request, from the open findings, for the person to edit before sending. */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const s = await mobileCtx();
  if (s instanceof NextResponse) return s;
  try {
    assertCan(s.ctx, 'application:review');
    return json(await draftCorrectionRequest(await getDb(), s.ctx, (await params).id));
  } catch (err) {
    return mobileError(err);
  }
}

const schema = z.object({
  to: z.string().trim().max(254),
  subject: z.string().max(300),
  body: z.string().max(20000),
  hold: z.boolean().optional().default(false),
});

/**
 * Ask the subcontractor for corrections or information. The answer says
 * honestly what happened: sent, recorded but not sent (no email provider),
 * failed, or not confirmed.
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const s = await mobileCtx();
  if (s instanceof NextResponse) return s;
  try {
    const input = await readBody(request, schema);
    const result = await sendSubcontractorMessage(await getDb(), s.ctx, (await params).id, { ...input, kind: 'correction_request' });
    return json(result);
  } catch (err) {
    return mobileError(err);
  }
}
