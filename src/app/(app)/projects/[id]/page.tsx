import { FileText, Inbox, Plus } from 'lucide-react';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getDb } from '@/db';
import { Figure, Figures, ProgressBar, RecordStatusBadge } from '@/components/records/figures';
import { BackLink } from '@/components/records/page-parts';
import { buttonClass } from '@/components/ui/button';
import { Badge, EmptyState, Money, Page, PageHeader, Panel, PanelHeader, StatusBadge, Table, Td, Th } from '@/components/ui/data';
import { percentOf } from '@/lib/money';
import { formatDate, pluralize } from '@/lib/utils';
import { can } from '@/server/auth/permissions';
import { requireCtx } from '@/server/auth/session';
import { getProjectDetail } from '@/server/services/records-queries';
import { ProjectDialogButton } from './project-dialog';

export const metadata = { title: 'Project' };

export default async function ProjectPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await requireCtx();
  const detail = await getProjectDetail(await getDb(), ctx, id);
  if (!detail) notFound();

  const { project, totals, contracts, applications } = detail;
  const canWrite = can(ctx.role, 'records:write');
  const canUpload = can(ctx.role, 'application:upload');
  const location = [project.address, project.city, project.state].filter(Boolean).join(', ');
  const facts = [project.number ? `Project ${project.number}` : null, location || null, project.ownerName ? `Owner: ${project.ownerName}` : null].filter(Boolean);

  const addSubcontract = (variant: 'primary' | 'secondary') => (
    <Link href={`/contracts/new?project=${project.id}`} className={buttonClass({ variant, size: variant === 'primary' ? 'md' : 'sm' })}>
      <Plus className="size-3.5" />
      Add subcontract
    </Link>
  );

  return (
    <Page>
      <PageHeader
        back={<BackLink href="/projects">Projects</BackLink>}
        title={
          <span className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
            {project.name}
            <RecordStatusBadge status={project.status} />
          </span>
        }
        description={facts.length > 0 ? facts.join(' · ') : undefined}
        actions={
          canWrite ? (
            <ProjectDialogButton
              project={{ id: project.id, name: project.name, number: project.number, address: project.address, city: project.city, state: project.state, ownerName: project.ownerName, status: project.status }}
            />
          ) : null
        }
      />

      <div className="space-y-5">
        <Figures className="grid-cols-2 lg:grid-cols-4">
          <Figure label="Committed" cents={totals.committed} note={`${pluralize(contracts.length, 'subcontract')}, with approved change orders`} />
          <Figure label="Approved to date" cents={totals.approvedToDate} note="Payments approved on applications" />
          <Figure label="Retainage held" cents={totals.retainageHeld} note="As of each subcontract’s latest approval" />
          <Figure label="Balance to finish" cents={totals.balanceToFinish} note="Committed less total earned, incl. retainage" />
        </Figures>

        <Panel className="overflow-hidden">
          <PanelHeader
            title="Subcontracts"
            description="Completed to date and retainage are as of each subcontract’s latest approved application."
            actions={canWrite && contracts.length > 0 ? addSubcontract('secondary') : null}
          />
          {contracts.length === 0 ? (
            <EmptyState
              icon={<FileText />}
              title="No subcontracts on this project"
              description="A subcontract records who is doing the work, for how much and at what retainage. Applications from that subcontractor are verified against it."
              action={canWrite ? addSubcontract('primary') : null}
            />
          ) : (
            <Table>
              <thead>
                <tr>
                  <Th className="pl-4">Subcontractor</Th>
                  <Th>Contract</Th>
                  <Th align="right">Contract sum to date</Th>
                  <Th className="w-52">Completed to date</Th>
                  <Th align="right">Retainage held</Th>
                  <Th className="pr-4">Latest application</Th>
                </tr>
              </thead>
              <tbody className="[&_tr:last-child>td]:border-b-0">
                {contracts.map((c) => {
                  const percent = percentOf(c.completedStored, c.contractSum);
                  return (
                    <tr key={c.id} className="hover:bg-canvas/60">
                      <Td className="pl-4">
                        <Link href={`/contracts/${c.id}`} className="font-medium hover:underline">
                          {c.subcontractorName}
                        </Link>
                        {c.status === 'closed' ? (
                          <Badge tone="muted" className="ml-2">
                            Closed
                          </Badge>
                        ) : null}
                      </Td>
                      <Td>
                        <Link href={`/contracts/${c.id}`} className="hover:underline">
                          {c.number}
                        </Link>
                        <div className="text-xs text-ink-3">{c.title}</div>
                      </Td>
                      <Td align="right">
                        <Money cents={c.contractSum} />
                        {c.approvedChangeOrders !== 0 ? <div className="text-xs text-ink-3">incl. change orders</div> : null}
                      </Td>
                      <Td>
                        <div className="flex items-baseline justify-between gap-3">
                          <Money cents={c.completedStored} />
                          <span className="num text-xs text-ink-3">{percent === null ? '—' : `${percent}%`}</span>
                        </div>
                        <ProgressBar percent={percent} className="mt-1.5" />
                      </Td>
                      <Td align="right">
                        <Money cents={c.retainageHeld} />
                      </Td>
                      <Td className="pr-4">
                        {c.latestApplication ? (
                          <Link href={`/applications/${c.latestApplication.id}`} className="inline-flex items-center gap-2">
                            <StatusBadge status={c.latestApplication.status} />
                            {c.latestApplication.applicationNumber !== null ? <span className="num text-xs text-ink-3">#{c.latestApplication.applicationNumber}</span> : null}
                          </Link>
                        ) : (
                          <span className="text-ink-4">None received</span>
                        )}
                      </Td>
                    </tr>
                  );
                })}
              </tbody>
            </Table>
          )}
        </Panel>

        <Panel className="overflow-hidden">
          <PanelHeader
            title="Recent applications"
            description={applications.length > 0 ? 'Billing packages on this project, most recently received first. Up to ten are shown.' : undefined}
            actions={
              applications.length > 0 ? (
                <Link href={`/applications?project=${project.id}`} className={buttonClass({ variant: 'ghost', size: 'sm' })}>
                  View all
                </Link>
              ) : null
            }
          />
          {applications.length === 0 ? (
            <EmptyState
              icon={<Inbox />}
              title="No applications on this project yet"
              description={
                contracts.length === 0
                  ? 'Add a subcontract first. Billing packages are matched to a subcontract and then appear here.'
                  : 'Billing packages matched to this project’s subcontracts appear here as they are received.'
              }
              action={
                canUpload && contracts.length > 0 ? (
                  <Link href="/applications/new" className={buttonClass({ variant: 'primary' })}>
                    Upload a package
                  </Link>
                ) : null
              }
            />
          ) : (
            <Table>
              <thead>
                <tr>
                  <Th className="pl-4">Application</Th>
                  <Th>Subcontractor</Th>
                  <Th>Period to</Th>
                  <Th align="right">Requested</Th>
                  <Th align="right">Approved</Th>
                  <Th className="pr-4">Status</Th>
                </tr>
              </thead>
              <tbody className="[&_tr:last-child>td]:border-b-0">
                {applications.map((a) => (
                  <tr key={a.id} className="hover:bg-canvas/60">
                    <Td className="pl-4">
                      <Link href={`/applications/${a.id}`} className="font-medium hover:underline">
                        {a.applicationNumber !== null ? `Application #${a.applicationNumber}` : 'Application, number not read'}
                      </Link>
                      {a.contractNumber ? <div className="text-xs text-ink-3">{a.contractNumber}</div> : null}
                    </Td>
                    <Td className="text-ink-2">{a.subcontractorName ?? <span className="text-ink-4">—</span>}</Td>
                    <Td className="whitespace-nowrap text-ink-2">{formatDate(a.periodTo)}</Td>
                    <Td align="right">
                      <Money cents={a.claimedAmount} />
                    </Td>
                    <Td align="right">
                      <Money cents={a.approvedAmount} />
                    </Td>
                    <Td className="pr-4">
                      <StatusBadge status={a.status} />
                    </Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </Panel>
      </div>
    </Page>
  );
}
