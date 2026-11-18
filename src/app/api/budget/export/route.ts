/**
 * GET /api/budget/export?project=<id> — one project's budget by cost code, as
 * CSV. The organisation is the session's; nothing in the request can choose
 * another.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { getDb } from '@/db';
import { apiCtx, apiError, contentDisposition } from '@/server/http';
import { budgetCsv } from '@/server/services/budget';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const ctx = await apiCtx();
  if (ctx instanceof NextResponse) return ctx;
  try {
    const file = await budgetCsv(await getDb(), ctx, request.nextUrl.searchParams.get('project') ?? '');
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
