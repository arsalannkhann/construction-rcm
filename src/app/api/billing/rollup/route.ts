/**
 * GET /api/billing/rollup?project=<id>&period=YYYY-MM — the approved
 * subcontractor billing on one project for one billing period, as CSV. The
 * organisation is the session's; nothing in the request can choose another.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { getDb } from '@/db';
import { apiCtx, apiError, contentDisposition } from '@/server/http';
import { billingRollup } from '@/server/services/billing';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const ctx = await apiCtx();
  if (ctx instanceof NextResponse) return ctx;
  try {
    const params = request.nextUrl.searchParams;
    const file = await billingRollup(await getDb(), ctx, params.get('project') ?? '', params.get('period') ?? '');
    return new NextResponse(`﻿${file.csv}`, {
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': contentDisposition('attachment', file.filename),
        'Cache-Control': 'private, no-store',
      },
    });
  } catch (err) {
    return apiError(err);
  }
}
