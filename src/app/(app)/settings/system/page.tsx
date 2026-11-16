import Link from '@/components/ui/link';
import { getDb } from '@/db';
import { Badge, EmptyState, PageHeader, Panel, PanelHeader, Table, Td, Th } from '@/components/ui/data';
import { formatDateTime, formatRelative } from '@/lib/utils';
import { can } from '@/server/auth/permissions';
import { requireCtx } from '@/server/auth/session';
import { queueHealth } from '@/server/jobs';
import { listInboundMessages } from '@/server/services/inbound';
import { READING_WINDOW_DAYS, readerLabel, readingQuality, type ReadingTally } from '@/server/services/reading-quality';
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
  const reading = await readingQuality(db, ctx);
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
    health.pdfReader.ok
      ? { name: 'Document reading', tone: 'pass', status: 'Working', detail: 'A test PDF was opened and its text read on this server, with the same reader uploaded packages go through.' }
      : { name: 'Document reading', tone: 'block', status: 'Not working', detail: 'This server could not open a test PDF, so uploaded packages are stored but not read. The cause is in the server log, in a line starting “[health]”.' },
    { name: 'Document storage', tone: health.storage === 'memory' ? 'warn' : 'pass', status: health.storage === 'database' ? 'In the database' : health.storage === 'disk' ? 'On disk' : 'In memory', detail: STORAGE_TEXT[health.storage] },
    health.runner.mode === 'request'
      ? {
          name: 'Document processing',
          tone: health.queue?.stalled || health.scheduler?.overdue ? 'warn' : 'pass',
          status: health.queue?.stalled ? 'Falling behind' : 'On request',
          detail: `Serverless hosting: packages are read right after they are uploaded, and anything left over is picked up when someone uses the app or the scheduled check runs${health.runner.lastActivityAt ? `. This instance last looked at the queue ${formatRelative(health.runner.lastActivityAt)}` : ''}. ${ours.queued} queued and ${ours.running} in progress for ${ctx.orgName}. ${
            health.scheduler?.lastRunAt ? `The scheduled check last ran ${formatRelative(health.scheduler.lastRunAt)}.` : 'The scheduled check has not run yet.'
          }${health.queue?.stalled ? ' Work has been waiting more than ten minutes: check that the scheduled call to /api/jobs/run is set up (docs/operations.md, Vercel).' : ''}${
            health.scheduler?.overdue ? ' The scheduled check should run daily and has missed at least a day: check the cron job and CRON_SECRET (docs/operations.md, Monitoring).' : ''
          }`,
        }
      : health.runner.polling
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
              <li key={r.name} className="flex flex-wrap items-start gap-x-4 gap-y-1 border-b border-line px-4 py-3 last:border-b-0 sm:flex-nowrap">
                <div className="min-w-0 flex-1 text-[13px] font-medium text-ink sm:w-44 sm:flex-none">{r.name}</div>
                {/* On a phone the explanation goes below the name and status. */}
                <p className="order-last w-full text-[13px] text-ink-2 sm:order-none sm:w-auto sm:min-w-0 sm:flex-1">{r.detail}</p>
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

        <Panel className="overflow-hidden" id="reading">
          <PanelHeader
            title="What reviewers changed after the reader"
            description={`Applications approved or rejected in the last ${READING_WINDOW_DAYS} days, and how many of the values read from their documents a reviewer had to fix or key by hand. This is not an accuracy rate: a misread value nobody noticed counts as correct here. Accuracy on your documents is measured with the double-keyed check described in docs/extraction-evaluation.md.`}
          />
          {reading.length === 0 ? (
            <EmptyState title="Nothing decided yet" description={`No application for ${ctx.orgName} has been approved or rejected in the last ${READING_WINDOW_DAYS} days.`} />
          ) : (
            <Table>
              <thead>
                <tr>
                  <Th className="pl-4">Read by</Th>
                  <Th align="right">Applications</Th>
                  <Th align="right">Summary figures</Th>
                  <Th align="right">Schedule lines</Th>
                  <Th align="right">Lien waivers</Th>
                  <Th align="right" className="pr-4">Documents</Th>
                </tr>
              </thead>
              <tbody className="[&_tr:last-child>td]:border-b-0">
                {reading.map((t) => (
                  <tr key={t.reader}>
                    <Td className="pl-4 font-medium">{readerLabel(t.reader)}</Td>
                    <Td align="right">
                      <Count main={t.applications} />
                      <Sub>{t.withChanges === 0 ? 'none changed' : `${t.withChanges} changed`}</Sub>
                    </Td>
                    <Td align="right">
                      <Count main={t.summary.read} unit="read" />
                      <Sub>{changes(t.summary.misread, 'corrected', t.summary.missed, 'keyed where blank')}</Sub>
                    </Td>
                    <Td align="right">
                      <Count main={t.lines.read} unit="read" />
                      <Sub>{changes(t.lines.corrected, 'corrected', t.lines.keyedByHand, 'added by hand')}</Sub>
                    </Td>
                    <Td align="right">
                      <Count main={t.waivers.read} unit="read" />
                      <Sub>{changes(t.waivers.corrected, 'corrected', t.waivers.keyedByHand, 'added by hand')}</Sub>
                    </Td>
                    <Td align="right" className="pr-4">
                      <Count main={t.documents.total} />
                      <Sub>{documentsNote(t)}</Sub>
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

function Count({ main, unit }: { main: number; unit?: string }) {
  return (
    <div className="num text-[13px] text-ink">
      {main}
      {unit ? <span className="text-ink-3"> {unit}</span> : null}
    </div>
  );
}

function Sub({ children }: { children: React.ReactNode }) {
  return <div className="text-[11px] text-ink-3">{children}</div>;
}

function changes(fixed: number, fixedWord: string, added: number, addedWord: string): string {
  const parts = [fixed ? `${fixed} ${fixedWord}` : null, added ? `${added} ${addedWord}` : null].filter(Boolean);
  return parts.length ? parts.join(', ') : 'none changed';
}

function documentsNote(t: ReadingTally): string {
  const parts = [t.documents.notRead ? `${t.documents.notRead} not read` : null, t.documents.backupReader ? `${t.documents.backupReader} by the backup reader` : null].filter(Boolean);
  return parts.length ? parts.join(', ') : 'all read';
}
