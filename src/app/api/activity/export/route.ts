/**
 * GET /api/activity/export — the organisation's audit log as CSV, with the
 * same filters as the Activity page (q, actor, area, from, to). Rows are in
 * the order they were written and streamed in batches.
 */
import type { NextRequest } from 'next/server';
import { getDb } from '@/db';
import { readActivityParams, toAuditFilter } from '@/app/(app)/activity/filters';
import { getSession } from '@/server/auth/session';
import { AUDIT_CSV_HEADER, auditCsvRow, auditEventBatches } from '@/server/services/audit-queries';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest): Promise<Response> {
  const session = await getSession();
  if (!session?.ctx) {
    return new Response('Sign in to export the activity log.', { status: 401, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' } });
  }
  // The organisation is the one the session is in; nothing in the request can choose another.
  const ctx = session.ctx;
  const db = await getDb();
  const { values } = readActivityParams(Object.fromEntries(request.nextUrl.searchParams));
  const batches = auditEventBatches(db, ctx, toAuditFilter(values));

  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      // The byte-order mark makes spreadsheet programs read the file as UTF-8.
      controller.enqueue(encoder.encode(`﻿${AUDIT_CSV_HEADER}`));
    },
    async pull(controller) {
      try {
        const { value, done } = await batches.next();
        if (done) controller.close();
        else controller.enqueue(encoder.encode(value.map(auditCsvRow).join('')));
      } catch (err) {
        console.error('[activity export] failed part-way through:', err);
        controller.error(err);
      }
    },
    async cancel() {
      await batches.return(undefined);
    },
  });

  const day = new Date().toISOString().slice(0, 10);
  return new Response(body, {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="activity-${day}.csv"`,
      'Cache-Control': 'no-store',
    },
  });
}
