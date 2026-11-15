/**
 * Health check for a load balancer or uptime monitor. No sign-in, and no
 * organisation's data: database reachability, queue depth, whether this
 * process is running the queue, and whether it can read a PDF.
 *
 *   200 {"status":"ok" | "degraded", ...}   serving; "degraded" lists problems
 *   503 {"status":"down", ...}              the database is not answering
 */
import { getDb } from '@/db';
import { deploymentHealth } from '@/server/services/system';

export const dynamic = 'force-dynamic';

export async function GET() {
  const health = await deploymentHealth(getDb);
  return Response.json(
    {
      status: health.status,
      problems: health.problems,
      database: health.database,
      dataApi: health.dataApi && { supabaseRoles: health.dataApi.rolesPresent, exposedTables: health.dataApi.exposedTables.length, tablesWithoutRls: health.dataApi.tablesWithoutRls.length },
      storage: health.storage,
      queue: health.queue && {
        queued: health.queue.queued,
        running: health.queue.running,
        failed: health.queue.failed,
        oldestQueuedSeconds: health.queue.oldestQueuedAt ? Math.round((Date.now() - health.queue.oldestQueuedAt.getTime()) / 1000) : null,
        stalled: health.queue.stalled,
      },
      runner: { mode: health.runner.mode, polling: health.runner.polling, lastActivityAt: health.runner.lastActivityAt?.toISOString() ?? null },
      scheduler: health.scheduler && { lastRunAt: health.scheduler.lastRunAt?.toISOString() ?? null, overdue: health.scheduler.overdue },
      pdfReader: health.pdfReader,
      checkedAt: new Date().toISOString(),
    },
    { status: health.status === 'down' ? 503 : 200, headers: { 'cache-control': 'no-store' } },
  );
}
