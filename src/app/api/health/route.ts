/**
 * Health check for a load balancer or uptime monitor. No sign-in, and no
 * organisation's data: database reachability, queue depth and whether this
 * process is running the queue.
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
      runner: { polling: health.runner.polling, lastActivityAt: health.runner.lastActivityAt?.toISOString() ?? null },
      checkedAt: new Date().toISOString(),
    },
    { status: health.status === 'down' ? 503 : 200, headers: { 'cache-control': 'no-store' } },
  );
}
