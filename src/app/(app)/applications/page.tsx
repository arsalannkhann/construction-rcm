import { ArrowUpFromLine, Inbox, Mail } from 'lucide-react';
import Link from '@/components/ui/link';
import { getDb } from '@/db';
import { buttonClass } from '@/components/ui/button';
import { Avatar, Badge, EmptyState, Money, Page, PageHeader, Panel, StatusBadge, Table, Td, Th } from '@/components/ui/data';
import { formatDelta } from '@/lib/money';
import { cn, daysBetween, formatDate, formatRelative } from '@/lib/utils';
import { can } from '@/server/auth/permissions';
import { requireCtx } from '@/server/auth/session';
import { listApplications, queueCounts } from '@/server/services/queries';
import type { AppStatus } from '@/server/types';

export const metadata = { title: 'Pay applications' };

type View = { key: string; label: string; statuses: AppStatus[]; empty: string };

export default async function ApplicationsPage({ searchParams }: { searchParams: Promise<{ view?: string; project?: string; subcontractor?: string; contract?: string; mine?: string }> }) {
  const ctx = await requireCtx();
  const sp = await searchParams;
  const db = await getDb();
  const counts = await queueCounts(db, ctx);
  const approver = can(ctx.role, 'application:approve');

  const views: View[] = [
    { key: 'attention', label: 'Needs attention', statuses: approver ? ['needs_matching', 'needs_review', 'pending_approval', 'processing'] : ['needs_matching', 'needs_review', 'processing'], empty: 'Nothing is waiting on your team. New billing packages appear here as soon as they are read.' },
    ...(approver ? [] : [{ key: 'pending', label: 'Pending approval', statuses: ['pending_approval'] as AppStatus[], empty: 'Nothing is waiting for an approver.' }]),
    { key: 'hold', label: 'Awaiting subcontractor', statuses: ['on_hold'], empty: 'No applications are on hold waiting for a subcontractor.' },
    { key: 'approved', label: 'Approved', statuses: ['approved'], empty: 'No applications have been approved yet.' },
    { key: 'closed', label: 'Rejected or void', statuses: ['rejected', 'void'], empty: 'No applications have been rejected or voided.' },
    { key: 'all', label: 'All', statuses: [], empty: 'No billing packages have been received yet.' },
  ];
  const view = views.find((v) => v.key === sp.view) ?? views[0]!;
  const rows = await listApplications(db, ctx, {
    statuses: view.statuses,
    projectId: sp.project,
    subcontractorId: sp.subcontractor,
    contractId: sp.contract,
    assigneeId: sp.mine ? ctx.userId : undefined,
  });
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  const filtered = !!(sp.project || sp.subcontractor || sp.contract || sp.mine);
  const query = (extra: Record<string, string | undefined>) => {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries({ view: view.key, project: sp.project, subcontractor: sp.subcontractor, contract: sp.contract, mine: sp.mine, ...extra })) if (v) q.set(k, v);
    return `/applications?${q.toString()}`;
  };
  const scope = rows[0];

  return (
    <Page width="wide">
      <PageHeader
        title="Pay applications"
        description="Every billing package received, from intake to approval."
        actions={
          can(ctx.role, 'application:upload') ? (
            <Link href="/applications/new" className={buttonClass({ variant: 'primary' })}>
              <ArrowUpFromLine className="size-3.5" />
              Upload package
            </Link>
          ) : null
        }
      />

      <div className="mb-3 flex flex-wrap items-center gap-x-1 gap-y-2 border-b border-line">
        {views.map((v) => {
          const n = v.statuses.length ? v.statuses.reduce((a, s) => a + counts[s], 0) : total;
          const on = v.key === view.key;
          return (
            <Link key={v.key} href={query({ view: v.key })} className={cn('relative flex h-9 items-center gap-1.5 px-2.5 text-[13px]', on ? 'font-medium text-ink' : 'text-ink-3 hover:text-ink')} aria-current={on ? 'page' : undefined}>
              {v.label}
              <span className={cn('num rounded-full px-1.5 text-[10px] font-semibold leading-4', on && v.key === 'attention' && n > 0 ? 'bg-accent text-white' : 'bg-sunken text-ink-2')}>{n}</span>
              {on ? <span className="absolute inset-x-2 -bottom-px h-0.5 rounded-full bg-ink" /> : null}
            </Link>
          );
        })}
        <span className="flex-1" />
        <Link href={query({ mine: sp.mine ? undefined : '1' })} className={cn('mb-1.5 rounded-full border px-2.5 py-0.5 text-xs', sp.mine ? 'border-accent-line bg-accent-soft font-medium text-accent-ink' : 'border-line text-ink-2 hover:border-line-strong')}>
          Assigned to me
        </Link>
      </div>

      {filtered && (sp.project || sp.subcontractor || sp.contract) ? (
        <div className="mb-3 flex items-center gap-2 text-xs text-ink-2">
          <span>
            Filtered to {sp.contract ? `contract ${scope?.contractNumber ?? ''}` : sp.project ? `project ${scope?.projectName ?? ''}` : `subcontractor ${scope?.subcontractorName ?? ''}`}
          </span>
          <Link href={`/applications?view=${view.key}${sp.mine ? '&mine=1' : ''}`} className="font-medium text-accent hover:underline">
            Clear
          </Link>
        </div>
      ) : null}

      <Panel>
        {rows.length === 0 ? (
          <EmptyState
            icon={<Inbox />}
            title={filtered ? 'No applications match this filter' : total === 0 ? 'No billing packages yet' : 'Nothing here'}
            description={total === 0 ? 'Upload a subcontractor’s pay application, schedule of values and lien waiver. The system reads them, matches the subcontract and checks every figure.' : view.empty}
            action={
              total === 0 && can(ctx.role, 'application:upload') ? (
                <Link href="/applications/new" className={buttonClass({ variant: 'primary' })}>
                  Upload the first package
                </Link>
              ) : null
            }
          />
        ) : (
          <Table>
            <thead>
              <tr>
                <Th className="pl-4">Subcontractor</Th>
                <Th>Project</Th>
                <Th align="right">App.</Th>
                <Th>Period to</Th>
                <Th align="right">Requested</Th>
                <Th align="right">{view.key === 'approved' ? 'Approved' : 'Verified'}</Th>
                <Th>Findings</Th>
                <Th>Received</Th>
                <Th>Reviewer</Th>
                <Th className="pr-4">Status</Th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const amount = r.status === 'approved' ? r.approvedAmount : r.verifiedAmount;
                const diff = r.claimedAmount !== null && amount !== null ? r.claimedAmount - amount : null;
                const age = daysBetween(r.receivedAt);
                const open = ['needs_matching', 'needs_review', 'pending_approval', 'on_hold'].includes(r.status);
                return (
                  <tr key={r.id} className="group relative hover:bg-canvas/70">
                    <Td className="pl-4">
                      <Link href={`/applications/${r.id}`} className="font-medium text-ink after:absolute after:inset-0">
                        {r.subcontractorName ?? r.stated?.contractorName ?? 'Unidentified'}
                      </Link>
                      {r.contractNumber ? <div className="text-xs text-ink-3">{r.contractNumber}</div> : null}
                    </Td>
                    <Td className="max-w-[220px] truncate text-ink-2">{r.projectName ?? <span className="text-ink-4">Not matched</span>}</Td>
                    <Td align="right">{r.applicationNumber !== null ? `#${r.applicationNumber}` : '—'}</Td>
                    <Td className="whitespace-nowrap text-ink-2">{formatDate(r.periodTo)}</Td>
                    <Td align="right">
                      <Money cents={r.claimedAmount} />
                    </Td>
                    <Td align="right">
                      <Money cents={amount} className="font-medium" />
                      {diff ? <div className="num text-[11px] font-normal text-block">{formatDelta(-diff)}</div> : null}
                    </Td>
                    <Td>
                      {r.status === 'processing' ? (
                        <span className="text-xs text-ink-3">{r.processingError ? 'Processing failed' : 'Reading…'}</span>
                      ) : r.status === 'needs_matching' ? (
                        <span className="text-xs text-ink-3">Not verified yet</span>
                      ) : open ? (
                        <span className="flex items-center gap-1">
                          {r.openBlocking ? <Badge tone="block">{r.openBlocking} blocking</Badge> : null}
                          {r.openWarnings ? <Badge tone="warn">{r.openWarnings}</Badge> : null}
                          {!r.openBlocking && !r.openWarnings ? <Badge tone="pass">Clear</Badge> : null}
                        </span>
                      ) : (
                        <span className="text-ink-4">—</span>
                      )}
                    </Td>
                    <Td className="whitespace-nowrap">
                      <span className="flex items-center gap-1.5 text-ink-2">
                        {r.receivedVia === 'email' ? <Mail className="size-3 text-ink-3" aria-label="Received by email" /> : null}
                        {formatRelative(r.receivedAt)}
                      </span>
                      {open && age >= 5 ? <div className="text-[11px] text-warn">{age} days open</div> : null}
                    </Td>
                    <Td>
                      {r.assigneeName ? (
                        <span className="flex items-center gap-1.5 text-ink-2">
                          <Avatar name={r.assigneeName} size="sm" />
                          <span className="truncate">{r.assigneeName.split(' ')[0]}</span>
                        </span>
                      ) : (
                        <span className="text-ink-4">{open ? 'Unassigned' : '—'}</span>
                      )}
                    </Td>
                    <Td className="pr-4">
                      <StatusBadge status={r.status} />
                    </Td>
                  </tr>
                );
              })}
            </tbody>
          </Table>
        )}
      </Panel>
    </Page>
  );
}
