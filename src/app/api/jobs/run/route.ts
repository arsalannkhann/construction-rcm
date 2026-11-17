/**
 * Runs the document-processing queue now, taking jobs for up to REQUEST_BUDGET_MS.
 *
 * On serverless hosting nothing runs between requests (src/server/jobs.ts), so
 * a scheduler calls this to pick up work nobody else has: a retry whose delay
 * has passed, or a job an instance abandoned when it was stopped. vercel.json
 * schedules it; any scheduler that can send the header will do.
 *
 * It also sends the day's billing reminders through subcontractor portal links
 * (src/server/services/portal.ts), first and for at most REMINDER_BUDGET_MS, so
 * a long queue cannot crowd them out.
 *
 * Requires `Authorization: Bearer <CRON_SECRET>`. Vercel's scheduler sends it
 * when the CRON_SECRET variable is set. Without CRON_SECRET it refuses to run.
 * The response holds counts only, no organisation's data.
 */
import { getDb } from '@/db';
import { bearerMatches } from '@/server/http';
import { drain, queueHealth, recordScheduledRun, requestLimits } from '@/server/jobs';
import '@/server/services/intake'; // registers the job handler
import { sendDueReminders } from '@/server/services/portal';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;
const REMINDER_BUDGET_MS = 60_000;

export async function GET(request: Request) {
  const ok = bearerMatches(request.headers.get('authorization'), process.env.CRON_SECRET);
  const headers = { 'cache-control': 'no-store' };
  if (ok === null) return Response.json({ error: 'Not configured: set CRON_SECRET to allow scheduled runs.' }, { status: 503, headers });
  if (!ok) return Response.json({ error: 'Not authorised.' }, { status: 401, headers });
  const db = await getDb();
  const startedAt = new Date();
  // A failure here must not stop the queue from being drained.
  const reminders = await sendDueReminders(db, { now: startedAt, deadline: startedAt.getTime() + REMINDER_BUDGET_MS }).catch((err) => {
    console.error('[jobs] billing reminders failed:', err instanceof Error ? err.message : err);
    return null;
  });
  const ran = await drain(db, requestLimits(startedAt.getTime()));
  const { queued, running, failed } = await queueHealth(db);
  // Proof the scheduler called, which /api/health reports (Vercel Hobby keeps logs for an hour).
  await recordScheduledRun(db, { startedAt, finishedAt: new Date(), ran, queued, failed });
  return Response.json({ ran, queued, running, failed, reminders: reminders ? { sent: reminders.sent, failed: reminders.failed, skipped: reminders.skipped } : { error: true } }, { headers });
}
