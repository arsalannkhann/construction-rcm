import Link from 'next/link';
import { getDb } from '@/db';
import { Badge, EmptyState, PageHeader, Panel, PanelHeader, Table, Td, Th } from '@/components/ui/data';
import { formatDateTime, formatRelative } from '@/lib/utils';
import { can } from '@/server/auth/permissions';
import { requireCtx } from '@/server/auth/session';
import { queueHealth } from '@/server/jobs';
import { listInboundMessages } from '@/server/services/inbound';
import { deploymentHealth, listFailedJobs } from '@/server/services/system';
import { RetryJobButton } from './retry-button';

export const metadata = { title: 'System status' };
export const dynamic = 'force-dynamic';

const STORAGE_TEXT = {
  database: 'Original documents and exports are stored in the PostgreSQL database, so one database backup captures the records and the files they refer to.',
  disk: 'Original documents and exports are stored on this server’s disk, under the data directory. Back that directory up together with the database.',
  memory: 'Documents are held in memory and are lost when the process stops. This mode is for automated tests only.',
} as const;

const TLS_TEXT = {
  verified: 'The connection is encrypted and the server’s certificate is checked.',
  unverified: 'The connection is encrypted, but the server’s certificate is not checked. Set DATABASE_CA_CERT to check it.',
  off: 'The connection is not encrypted, which is acceptable only on a private network such as Docker Compose’s.',
} as const;

export default async function SystemStatusPage() {
  const ctx = await requireCtx();
  const db = await getDb();
  const health = await deploymentHealth(getDb);
  const ours = await queueHealth(db, ctx.orgId);
  const failed = await listFailedJobs(db, ctx);
  const inbound = await listInboundMessages(db, ctx, 25);
  const canRetry = can(ctx.role, 'application:upload');

  const rows: Array<{ name: string; tone: 'pass' | 'warn' | 'block' | 'neutral'; status: string; detail: string }> = [
    health.database.ok
      ? {
          name: 'Database',
          tone: health.database.driver !== 'postgres' ? 'neutral' : health.database.tls === 'off' && health.dataApi?.rolesPresent ? 'warn' : 'pass',
          status: health.database.driver === 'postgres' ? (health.dataApi?.rolesPresent ? 'Supabase' : 'PostgreSQL') : 'Embedded',
          detail:
            (health.database.driver === 'postgres'
              ? `Connected to ${health.dataApi?.rolesPresent ? 'a Supabase PostgreSQL database' : 'PostgreSQL'} through DATABASE_URL. ${TLS_TEXT[health.database.tls ?? 'off']}`
              : 'The embedded database runs inside this process: one server only, suitable for evaluation. Set DATABASE_URL for a pilot.') + ` Answered in ${health.database.latencyMs} ms.`,
        }
      : { name: 'Database', tone: 'block', status: 'Not answering', detail: health.problems[0] ?? 'The database did not respond. Nothing can be saved until it does.' },
    ...(health.dataApi?.rolesPresent
      ? [
          health.dataApi.exposedTables.length === 0 && health.dataApi.tablesWithoutRls.length === 0
            ? { name: 'Supabase Data API', tone: 'pass' as const, status: 'Locked', detail: 'This is a Supabase database. No table can be read or changed through its Data API: every table has row level security and the API roles hold no privileges. This app does not use the Data API.' }
            : {
                name: 'Supabase Data API',
                tone: 'block' as const,
                status: 'Exposed',
                detail: `Reachable through the Data API: ${health.dataApi.exposedTables.join(', ') || 'none'}. Without row level security: ${health.dataApi.tablesWithoutRls.join(', ') || 'none'}. Re-run migration 0002 or revoke the grants; see docs/operations.md.`,
              },
        ]
      : []),
    { name: 'Document storage', tone: health.storage === 'memory' ? 'warn' : 'pass', status: health.storage === 'database' ? 'In the database' : health.storage === 'disk' ? 'On disk' : 'In memory', detail: STORAGE_TEXT[health.storage] },
    health.runner.polling
      ? {
          name: 'Document processing',
          tone: health.queue?.stalled ? 'warn' : 'pass',
          status: health.queue?.stalled ? 'Falling behind' : 'Running',
          detail: `This server checks the queue every few seconds${health.runner.lastActivityAt ? `; it last did ${formatRelative(health.runner.lastActivityAt)}` : ''}. ${ours.queued} queued and ${ours.running} in progress for ${ctx.orgName}.${
            health.queue?.stalled ? ' Work has been waiting more than ten minutes.' : ''
          }`,
        }
      : { name: 'Document processing', tone: 'block', status: 'Not running', detail: 'This process is not running the queue, so uploaded packages will not be read. Restart the server.' },
  ];

  return (
    <>
      <PageHeader title="System status" description="Whether this deployment is healthy, what background work failed, and what arrived at the email-intake address." />
      <div className="space-y-6">
        <Panel>
          <PanelHeader title="Health" description={<>Also available to a monitoring service, without sign-in and without any organisation’s data, at <code className="text-ink">/api/health</code>.</>} />
          <ul>
            {rows.map((r) => (
              <li key={r.name} className="flex items-start gap-4 border-b border-line px-4 py-3 last:border-b-0">
                <div className="w-44 shrink-0 text-[13px] font-medium text-ink">{r.name}</div>
                <p className="min-w-0 flex-1 text-[13px] text-ink-2">{r.detail}</p>
                <Badge tone={r.tone}>{r.status}</Badge>
              </li>
            ))}
          </ul>
        </Panel>

        <Panel className="overflow-hidden">
          <PanelHeader title="Failed background work" description="Each job is tried three times, with a pause between attempts, before it is listed here. Nothing that was uploaded is lost; the package can be read again." />
          {failed.length === 0 ? (
            <EmptyState title="Nothing has failed" description={`No background work for ${ctx.orgName} has failed in the last 30 days.`} />
          ) : (
            <Table>
              <thead>
                <tr>
                  <Th className="pl-4">Job</Th>
                  <Th>Error</Th>
                  <Th>Failed</Th>
                  <Th className="pr-4" />
                </tr>
              </thead>
              <tbody className="[&_tr:last-child>td]:border-b-0">
                {failed.map((j) => (
                  <tr key={j.id}>
                    <Td className="pl-4">
                      <div className="font-medium">{j.label}</div>
                      {j.application ? (
                        <Link href={`/applications/${j.application.id}`} className="text-xs text-ink-2 hover:underline">
                          {j.application.applicationNumber !== null ? `Application #${j.application.applicationNumber}` : 'Open the application'}
                          {j.application.status !== 'processing' ? ` · since ${j.application.status.replace('_', ' ')}` : ''}
                        </Link>
                      ) : null}
                    </Td>
                    <Td>
                      <p className="max-w-md text-xs text-ink-2">{j.error ?? 'No error was recorded.'}</p>
                      <p className="text-[11px] text-ink-3">After {j.attempts} attempt{j.attempts === 1 ? '' : 's'}</p>
                    </Td>
                    <Td className="whitespace-nowrap text-xs text-ink-2">{formatDateTime(j.finishedAt)}</Td>
                    <Td align="right" className="pr-4">
                      {canRetry && j.retryable ? <RetryJobButton jobId={j.id} /> : null}
                    </Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </Panel>

        <Panel className="overflow-hidden" id="intake">
          <PanelHeader title="Email intake" description="Every message that reached this organisation’s intake address, including the ones that were turned away or recognised as repeats." />
          {inbound.length === 0 ? (
            <EmptyState title="No email received" description="Nothing has arrived at the intake address. See Settings → Organisation for the address and how to connect an email provider." />
          ) : (
            <Table>
              <thead>
                <tr>
                  <Th className="pl-4">Received</Th>
                  <Th>From</Th>
                  <Th>Outcome</Th>
                  <Th className="pr-4">Detail</Th>
                </tr>
              </thead>
              <tbody className="[&_tr:last-child>td]:border-b-0">
                {inbound.map((m) => (
                  <tr key={m.id}>
                    <Td className="whitespace-nowrap pl-4 text-xs text-ink-2">{formatDateTime(m.createdAt)}</Td>
                    <Td>
                      <div className="text-[13px]">{m.fromEmail ?? 'No sender address'}</div>
                      {m.subject ? <div className="max-w-xs truncate text-xs text-ink-3">{m.subject}</div> : null}
                    </Td>
                    <Td>
                      <Badge tone={m.outcome === 'accepted' ? 'pass' : m.outcome === 'duplicate' ? 'neutral' : 'block'}>{m.outcome === 'accepted' ? 'Accepted' : m.outcome === 'duplicate' ? 'Repeat, ignored' : 'Turned away'}</Badge>
                    </Td>
                    <Td className="pr-4 text-xs text-ink-2">
                      {m.payApplicationId ? (
                        <Link href={`/applications/${m.payApplicationId}`} className="font-medium text-accent hover:underline">
                          Open the package
                        </Link>
                      ) : null}
                      {m.reason ? <p className="max-w-md">{m.reason}</p> : null}
                    </Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </Panel>
      </div>
    </>
  );
}
