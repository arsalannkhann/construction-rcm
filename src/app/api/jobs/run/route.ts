/**
 * Runs the document-processing queue now, taking jobs for up to REQUEST_BUDGET_MS.
 *
 * On serverless hosting nothing runs between requests (src/server/jobs.ts), so
 * a scheduler calls this to pick up work nobody else has: a retry whose delay
 * has passed, or a job an instance abandoned when it was stopped. vercel.json
 * schedules it; any scheduler that can send the header will do.
 *
 * Requires `Authorization: Bearer <CRON_SECRET>`. Vercel's scheduler sends it
 * when the CRON_SECRET variable is set. Without CRON_SECRET it refuses to run.
 * The response holds counts only, no organisation's data.
 */
import { getDb } from '@/db';
import { bearerMatches } from '@/server/http';
import { drain, queueHealth, recordScheduledRun, requestLimits } from '@/server/jobs';
import '@/server/services/intake'; // registers the job handler

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

export async function GET(request: Request) {
  const ok = bearerMatches(request.headers.get('authorization'), process.env.CRON_SECRET);
  const headers = { 'cache-control': 'no-store' };
  if (ok === null) return Response.json({ error: 'Not configured: set CRON_SECRET to allow scheduled runs.' }, { status: 503, headers });
  if (!ok) return Response.json({ error: 'Not authorised.' }, { status: 401, headers });
  const db = await getDb();
  const startedAt = new Date();
  const ran = await drain(db, requestLimits(startedAt.getTime()));
  const { queued, running, failed } = await queueHealth(db);
  // Proof the scheduler called, which /api/health reports (Vercel Hobby keeps logs for an hour).
  await recordScheduledRun(db, { startedAt, finishedAt: new Date(), ran, queued, failed });
  return Response.json({ ran, queued, running, failed }, { headers });
}
