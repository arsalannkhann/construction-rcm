import { CalendarRange, FileText, Inbox, Landmark, ListTree, Plus } from 'lucide-react';
import Link from '@/components/ui/link';
import { notFound } from 'next/navigation';
import { getDb } from '@/db';
import { BillingGrid, BudgetStandingBadge, CostBar, CostLegend } from '@/components/records/billing';
import { Figure, Figures, ProgressBar, RecordStatusBadge } from '@/components/records/figures';
import { OwnerStatusBadge } from '@/components/records/owner-billing';
import { BackLink } from '@/components/records/page-parts';
import { buttonClass } from '@/components/ui/button';
import { Badge, EmptyState, Money, Page, PageHeader, Panel, PanelHeader, StatusBadge, Table, Td, Th } from '@/components/ui/data';
import { formatMoney, percentOf, sum } from '@/lib/money';
import { cn, formatDate, pluralize } from '@/lib/utils';
import { can } from '@/server/auth/permissions';
import { requireCtx } from '@/server/auth/session';
import { getBillingBoard, monthOf, monthsEnding } from '@/server/services/billing';
import { getOwnerBilling } from '@/server/services/owner-billing';
import { getProjectDetail } from '@/server/services/records-queries';
import { ProjectDialogButton } from './project-dialog';

export const metadata = { title: 'Project' };

export default async function ProjectPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await requireCtx();
  const db = await getDb();
  const detail = await getProjectDetail(db, ctx, id);
  if (!detail) notFound();

  const { project, totals, cost, contracts, applications, unassigned } = detail;
  const budgetLines = cost.forecast && cost.budget !== null ? { count: cost.forecast.lines, total: cost.budget } : null;
  const projectFields = { id: project.id, name: project.name, number: project.number, address: project.address, city: project.city, state: project.state, ownerName: project.ownerName, budget: project.budget, status: project.status };
  const current = monthOf(new Date());
  const board = await getBillingBoard(db, ctx, { months: monthsEnding(current, 6), current, projectId: project.id });
  const billing = board.sections[0];
  const owner = await getOwnerBilling(db, ctx, project.id);
  const ownerLatest = owner?.applications[0] ?? null;
  const completed = sum(contracts.map((c) => c.completedStored));
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
            <ProjectDialogButton project={projectFields} budgetLines={budgetLines} />
          ) : null
        }
      />

      <div className="space-y-5">
        <Panel>
          <PanelHeader
            title="Budget and commitments"
            description="What is set aside for subcontracted work, what is committed, and what pending change orders could add."
            actions={
              <div className="flex flex-wrap items-center gap-2">
                <BudgetStandingBadge cost={cost} />
                <Link href={`/projects/${project.id}/budget`} className={buttonClass({ variant: 'ghost', size: 'sm' })}>
                  <ListTree className="size-3.5" />
                  {cost.forecast ? 'Budget by cost code' : canWrite ? 'Split by cost code' : 'Budget by cost code'}
                </Link>
              </div>
            }
          />
          <dl className="grid grid-cols-2 gap-x-6 gap-y-3 px-4 pt-4 sm:grid-cols-3 lg:grid-cols-5">
            <CostFigure label="Budget" value={cost.budget === null ? null : formatMoney(cost.budget)} note={cost.budget === null ? 'Not set' : cost.forecast ? `${pluralize(cost.forecast.lines, 'budget line')}` : 'for subcontracted work'} />
            <CostFigure label="Committed" value={formatMoney(cost.committed)} note={`${pluralize(contracts.length, 'subcontract')}, with approved change orders`} />
            <CostFigure label="Pending changes" value={formatMoney(cost.pendingChanges)} note="change orders not yet approved" />
            <CostFigure label="Projected" value={formatMoney(cost.projected)} note="committed plus pending changes" />
            <CostFigure
              label={cost.remaining !== null && cost.remaining < 0 ? 'Over budget' : 'Left in budget'}
              value={cost.remaining === null ? null : formatMoney(Math.abs(cost.remaining))}
              note={cost.remaining === null ? 'Set a budget to see this' : cost.percentOfBudget !== null ? `projected is ${cost.percentOfBudget}% of budget` : undefined}
              tone={cost.remaining !== null && cost.remaining < 0 ? 'block' : undefined}
            />
          </dl>
          {cost.forecast ? (
            <div className="mx-4 mt-4 rounded-lg bg-canvas px-3 py-2.5">
              <p className="mb-1.5 text-[11px] font-medium uppercase tracking-wide text-ink-3">Forecast, from each budget line’s method</p>
              <dl className="grid grid-cols-2 gap-x-6 gap-y-2 sm:grid-cols-4">
                <CostFigure label="Still to commit" value={formatMoney(cost.forecast.stillToCommit)} />
                <CostFigure label="At completion" value={formatMoney(cost.forecast.atCompletion)} />
                <CostFigure label="To complete" value={formatMoney(cost.forecast.toComplete)} note="at completion less completed and stored" />
                <CostFigure label={cost.forecast.variance < 0 ? 'Forecast over' : 'Forecast under'} value={formatMoney(Math.abs(cost.forecast.variance))} tone={cost.forecast.variance < 0 ? 'block' : undefined} />
              </dl>
              {unassigned > 0 ? (
                <p className="mt-2 text-xs text-warn">
                  {pluralize(unassigned, 'subcontract')} on no budget line.{' '}
                  <Link href={`/projects/${project.id}/budget`} className="font-medium underline">
                    Assign {unassigned === 1 ? 'it' : 'them'}
                  </Link>
                </p>
              ) : null}
            </div>
          ) : null}
          <div className="space-y-2 px-4 pb-4 pt-4">
            <CostBar cost={cost} />
            <div className="flex flex-wrap items-center justify-between gap-2">
              <CostLegend cost={cost} />
              {cost.budget === null && canWrite ? (
                <ProjectDialogButton label="Set a budget" variant="ghost" project={projectFields} />
              ) : null}
            </div>
          </div>
        </Panel>

        <Figures className="grid-cols-1 sm:grid-cols-2 lg:grid-cols-4">
          <Figure label="Completed and stored" cents={completed} note={totals.committed ? `${percentOf(completed, totals.committed) ?? 0}% of committed, as approved` : 'As approved'} />
          <Figure label="Approved to date" cents={totals.approvedToDate} note="Payments approved on applications" />
          <Figure label="Retainage held" cents={totals.retainageHeld} note="As of each subcontract’s latest approval" />
          <Figure label="Balance to finish" cents={totals.balanceToFinish} note="Committed less total earned, incl. retainage" />
        </Figures>

        <Panel>
          <PanelHeader
            title="Owner billing"
            description={owner?.prime ? `Your applications for payment to ${project.ownerName ?? 'the owner'}, built from the subcontractor billing you approved.` : 'Bill the owner from the subcontractor billing you approved: set up your contract with the owner and its schedule of values.'}
            actions={
              <Link href={`/projects/${project.id}/owner-billing`} className={buttonClass({ variant: owner?.prime ? 'ghost' : 'secondary', size: 'sm' })}>
                <Landmark className="size-3.5" />
                {owner?.prime ? 'Owner billing' : canWrite ? 'Set up owner billing' : 'Owner billing'}
              </Link>
            }
          />
          {owner?.prime ? (
            <dl className="grid grid-cols-2 gap-x-6 gap-y-3 p-4 sm:grid-cols-4">
              <CostFigure label="Contract sum to date" value={formatMoney(owner.prime.contractSumToDate)} note={owner.prime.pendingChanges ? `${formatMoney(owner.prime.pendingChanges)} pending` : 'with approved change orders'} />
              <CostFigure label="Completed and stored" value={owner.billed ? formatMoney(owner.billed.totalCompletedStored) : null} note={owner.billed ? `as of application #${owner.billed.applicationNumber}` : 'nothing submitted yet'} />
              <CostFigure label="Certified for payment" value={owner.billed ? formatMoney(owner.billed.certified) : null} note={owner.billed?.awaitingCertification ? `${formatMoney(owner.billed.awaitingCertification)} awaiting certification` : undefined} />
              <div className="min-w-0">
                <dt className="text-[11px] font-medium uppercase tracking-wide text-ink-3">Latest application</dt>
                {ownerLatest ? (
                  <dd className="mt-1 flex flex-wrap items-center gap-2">
                    <Link href={`/projects/${project.id}/owner-billing/${ownerLatest.id}`} className="font-medium hover:underline">
                      #{ownerLatest.applicationNumber}, {formatDate(ownerLatest.periodTo)}
                    </Link>
                    <OwnerStatusBadge status={ownerLatest.status} />
                  </dd>
                ) : (
                  <dd className="mt-0.5 text-[13px] text-ink-4">None yet</dd>
                )}
              </div>
            </dl>
          ) : null}
        </Panel>

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
                        {c.pendingChangeOrders !== 0 ? <div className="text-xs text-warn">{formatMoney(c.pendingChangeOrders)} pending</div> : null}
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

        {billing && billing.rows.length > 0 ? (
          <Panel className="overflow-hidden">
            <PanelHeader
              title="Billing by period"
              description="Each subcontract’s application for the last six billing periods. Missing means it had been billing, still has work left, and sent nothing for a period that has ended."
              actions={
                <Link href="/billing" className={buttonClass({ variant: 'ghost', size: 'sm' })}>
                  <CalendarRange className="size-3.5" />
                  Billing periods
                </Link>
              }
            />
            <BillingGrid section={billing} months={board.months} />
          </Panel>
        ) : null}

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

function CostFigure({ label, value, note, tone }: { label: string; value: string | null; note?: string; tone?: 'block' }) {
  return (
    <div className="min-w-0">
      <dt className="text-[11px] font-medium uppercase tracking-wide text-ink-3">{label}</dt>
      <dd className={cn('num mt-0.5 text-[17px] font-semibold leading-6', value === null && 'text-ink-4', tone === 'block' && 'text-block')}>{value ?? '—'}</dd>
      {note ? <dd className="text-xs text-ink-3">{note}</dd> : null}
    </div>
  );
}
