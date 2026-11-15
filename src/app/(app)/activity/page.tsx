import { Download, History, SearchX, ShieldAlert, ShieldCheck } from 'lucide-react';
import Link from '@/components/ui/link';
import { redirect } from 'next/navigation';
import { getDb } from '@/db';
import { Notice } from '@/components/settings/notice';
import { buttonClass } from '@/components/ui/button';
import { Avatar, Badge, EmptyState, Page, PageHeader, Panel, Table, Td, Th } from '@/components/ui/data';
import { formatDateTime, pluralize } from '@/lib/utils';
import { verifyAuditChain } from '@/server/audit';
import { requireCtx } from '@/server/auth/session';
import { AUDIT_AREAS, listAuditActors, listAuditEvents } from '@/server/services/audit-queries';
import { ActivityFilters } from './filter-bar';
import { PAGE_SIZE, readActivityParams, toAuditFilter } from './filters';
import { activityQuery } from './params';

export const metadata = { title: 'Activity' };

/** The zone the server formats times in ("CT", "GMT"), so the column says what the times mean. */
function serverTimeZone(): string | null {
  try {
    const parts = new Intl.DateTimeFormat('en-US', { timeZoneName: 'shortGeneric' }).formatToParts(new Date());
    return parts.find((p) => p.type === 'timeZoneName')?.value ?? null;
  } catch {
    return null;
  }
}

export default async function ActivityPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const ctx = await requireCtx();
  const db = await getDb();
  const { values: asked, page } = readActivityParams(await searchParams);

  const actors = await listAuditActors(db, ctx);
  // A "who" that is not in this organisation's log is not a filter the bar could show; drop it.
  const values = !asked.actor || actors.some((a) => a.id === asked.actor) ? asked : { ...asked, actor: '' };
  const filtered = activityQuery(values) !== '';

  const { events, total } = await listAuditEvents(db, ctx, toAuditFilter(values), { limit: PAGE_SIZE, offset: (page - 1) * PAGE_SIZE });
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  if (page > pages) redirect(`/activity${activityQuery(values, pages)}`);

  // Verified against the whole log on every view, not just the rows on screen.
  const chain = await verifyAuditChain(db, ctx.orgId);
  const brokenAt = chain.ok ? null : chain.brokenAtSeq;
  const zone = serverTimeZone();
  const first = (page - 1) * PAGE_SIZE + 1;
  const last = first + events.length - 1;

  return (
    <Page>
      <PageHeader
        title="Activity"
        description={`Everything that has changed in ${ctx.orgName}: who did it, when, and what changed. Entries are written once and are not edited afterwards.`}
        actions={
          total > 0 ? (
            <a href={`/api/activity/export${activityQuery(values)}`} className={buttonClass()} title={filtered ? 'Downloads the events that match the current filters' : 'Downloads the whole log'}>
              <Download className="size-3.5" strokeWidth={1.9} />
              Export CSV
            </a>
          ) : null
        }
      />

      {chain.ok ? (
        <Notice tone="pass" icon={<ShieldCheck strokeWidth={1.9} />} className="mb-4">
          <span className="font-medium">Audit trail intact</span>
          {chain.events > 0 ? ` · ${pluralize(chain.events, 'event')}, each cryptographically chained to the one before it` : ' · no events recorded yet'}
        </Notice>
      ) : (
        <Notice tone="block" icon={<ShieldAlert strokeWidth={1.9} />} className="mb-4">
          <span className="font-medium">Audit trail verification failed at event #{chain.brokenAtSeq}.</span> Events before #{chain.brokenAtSeq} verify correctly. Event #{chain.brokenAtSeq} does not match its
          cryptographic record, or the event that should come before it is missing, so it and everything after it cannot be relied on as written. Export the log and contact whoever administers this deployment.
        </Notice>
      )}

      <Panel>
        <ActivityFilters current={values} actors={actors} areas={AUDIT_AREAS.map(([value, label]) => ({ value, label }))} />
        {events.length === 0 ? (
          filtered ? (
            <EmptyState
              icon={<SearchX />}
              title="No events match these filters"
              description="Try a wider date range, a different person or area, or fewer words."
              action={
                <Link href="/activity" className={buttonClass()}>
                  Clear filters
                </Link>
              }
            />
          ) : (
            <EmptyState
              icon={<History />}
              title="No activity yet"
              description="Every change to a billing package, contract, team member or policy is recorded here with who made it and when. Upload a billing package or set up a project to see the first entries."
            />
          )
        ) : (
          <>
            <Table>
              <thead>
                <tr>
                  <Th className="w-14 pl-4" align="right">
                    #
                  </Th>
                  <Th className="w-48">Time{zone ? ` (${zone})` : ''}</Th>
                  <Th className="w-52">Who</Th>
                  <Th>What</Th>
                  <Th className="w-36" />
                </tr>
              </thead>
              <tbody>
                {events.map((e) => (
                  <tr key={e.id} className={e.seq === brokenAt ? 'bg-block-soft/60' : 'hover:bg-canvas/60'}>
                    <Td className="pl-4 align-top text-ink-3" align="right">
                      {e.seq}
                    </Td>
                    <Td className="num whitespace-nowrap align-top text-ink-2">
                      <time dateTime={e.createdAt.toISOString()} title={e.createdAt.toISOString()}>
                        {formatDateTime(e.createdAt)}
                      </time>
                    </Td>
                    <Td className="align-top">
                      {e.actorType === 'system' ? (
                        <span className="flex items-center gap-2 text-ink-3">
                          <Badge tone="muted">System</Badge>
                          <span className="truncate">{e.actorName}</span>
                        </span>
                      ) : (
                        <span className="flex items-center gap-2">
                          <Avatar name={e.actorName} size="sm" />
                          <span className="truncate">{e.actorName}</span>
                        </span>
                      )}
                    </Td>
                    <Td className="align-top">
                      {e.summary}
                      {e.seq === brokenAt ? (
                        <Badge tone="block" className="ml-2">
                          Fails verification
                        </Badge>
                      ) : null}
                    </Td>
                    <Td className="whitespace-nowrap pr-4 text-right align-top">
                      {e.payApplicationId ? (
                        <Link href={`/applications/${e.payApplicationId}`} className="font-medium text-accent hover:underline">
                          Open application
                        </Link>
                      ) : null}
                    </Td>
                  </tr>
                ))}
              </tbody>
            </Table>
            <div className="flex items-center justify-between gap-4 px-4 py-2.5 text-xs text-ink-3">
              <span className="num">
                Showing {first.toLocaleString('en-US')}–{last.toLocaleString('en-US')} of {total.toLocaleString('en-US')} {filtered ? 'matching ' : ''}
                {total === 1 ? 'event' : 'events'}, newest first
              </span>
              {pages > 1 ? (
                <nav className="flex items-center gap-2" aria-label="Pages">
                  {page > 1 ? (
                    <Link href={`/activity${activityQuery(values, page - 1)}`} className={buttonClass({ size: 'sm' })} rel="prev">
                      Previous
                    </Link>
                  ) : (
                    <span className={buttonClass({ size: 'sm', className: 'pointer-events-none opacity-50' })} aria-disabled="true">
                      Previous
                    </span>
                  )}
                  <span className="num px-1">
                    Page {page} of {pages.toLocaleString('en-US')}
                  </span>
                  {page < pages ? (
                    <Link href={`/activity${activityQuery(values, page + 1)}`} className={buttonClass({ size: 'sm' })} rel="next">
                      Next
                    </Link>
                  ) : (
                    <span className={buttonClass({ size: 'sm', className: 'pointer-events-none opacity-50' })} aria-disabled="true">
                      Next
                    </span>
                  )}
                </nav>
              ) : null}
            </div>
          </>
        )}
      </Panel>
    </Page>
  );
}
