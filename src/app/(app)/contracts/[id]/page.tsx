import { Inbox } from 'lucide-react';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getDb } from '@/db';
import { Figure, Figures, Note, RecordStatusBadge } from '@/components/records/figures';
import { BackLink } from '@/components/records/page-parts';
import { buttonClass } from '@/components/ui/button';
import { EmptyState, Money, Page, PageHeader, Panel, PanelHeader, Stat, StatusBadge, Table, Td, Th } from '@/components/ui/data';
import { formatBps, formatMoney, percentOf } from '@/lib/money';
import { describeRetainageTerms } from '@/lib/retainage';
import { formatDate, pluralize } from '@/lib/utils';
import { can } from '@/server/auth/permissions';
import { requireCtx } from '@/server/auth/session';
import { getContractDetail } from '@/server/services/records-queries';
import { ChangeOrdersPanel } from './change-orders';
import { RetainagePanel } from './retainage-panel';
import { SchedulePanel } from './schedule-panel';
import { TermsDialogButton } from './terms-dialog';

export const metadata = { title: 'Subcontract' };

export default async function ContractPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await requireCtx();
  const detail = await getContractDetail(await getDb(), ctx, id);
  if (!detail) notFound();

  const { contract, project, subcontractor, position, baseline, applications } = detail;
  const canWrite = can(ctx.role, 'records:write');
  const canUpload = can(ctx.role, 'application:upload');
  const canApprove = can(ctx.role, 'application:approve');
  const retainageTerms = describeRetainageTerms(contract.retainageWorkBps, contract.retainageTerms);
  const approvedCos = detail.changeOrders.filter((c) => c.status === 'approved').length;
  const pendingCos = detail.changeOrders.filter((c) => c.status === 'pending').length;
  const percentComplete = percentOf(position.completedStored, position.contractSum);
  const through = position.latestApproved?.applicationNumber != null ? `application #${position.latestApproved.applicationNumber}` : 'the latest approved application';

  return (
    <Page>
      <PageHeader
        back={<BackLink href={`/projects/${project.id}`}>{project.name}</BackLink>}
        title={
          <span className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
            {subcontractor.name}
            <RecordStatusBadge status={contract.status} />
          </span>
        }
        description={
          <>
            {contract.number} – {contract.title} ·{' '}
            <Link href={`/projects/${project.id}`} className="text-ink underline decoration-line-strong underline-offset-2 hover:decoration-ink">
              {project.name}
              {project.number ? ` (${project.number})` : ''}
            </Link>
          </>
        }
      />

      <div className="space-y-5">
        <div className="space-y-2">
          <Figures className="grid-cols-2 sm:grid-cols-3">
            <Figure label="Original amount" cents={position.originalAmount} note={contract.executedOn ? `Contract dated ${formatDate(contract.executedOn)}` : undefined} />
            <Figure
              label="Approved change orders"
              cents={position.approvedChangeOrders}
              note={approvedCos === 0 && pendingCos === 0 ? 'None on this contract' : `${approvedCos} approved${pendingCos > 0 ? ` · ${pendingCos} pending, not included` : ''}`}
            />
            <Figure label="Contract sum to date" cents={position.contractSum} note="Original amount plus approved change orders" />
            <Figure
              label="Completed and stored to date"
              cents={position.completedStored}
              note={position.latestApproved ? `${percentComplete === null ? '' : `${percentComplete}% of the contract sum, `}through ${through}` : 'No application approved yet'}
            />
            <Figure label="Retainage held" cents={position.retainageHeld} note={`${retainageTerms} on completed work · ${formatBps(contract.retainageStoredBps)} on stored materials`} />
            <Figure label="Balance to finish" cents={position.balanceToFinish} note="Contract sum less total earned, so it includes retainage" />
          </Figures>
          {baseline && !position.latestApproved ? (
            <Note>
              No application has been approved on this contract here yet, so the billing figures above do not include the {formatMoney(baseline.previousCertificates)} certified before application #{baseline.asOfApplicationNumber + 1}. They will once that
              application is approved.
            </Note>
          ) : null}
        </div>

        <Panel>
          <PanelHeader
            title="Terms"
            description="What every application on this contract is verified against."
            actions={
              canWrite ? (
                <TermsDialogButton
                  contract={{
                    id: contract.id,
                    number: contract.number,
                    title: contract.title,
                    originalAmount: contract.originalAmount,
                    retainageWorkBps: contract.retainageWorkBps,
                    retainageStoredBps: contract.retainageStoredBps,
                    retainageTerms: contract.retainageTerms,
                    executedOn: contract.executedOn,
                    status: contract.status,
                  }}
                />
              ) : null
            }
          />
          <dl className="grid grid-cols-2 gap-x-6 gap-y-4 p-4 sm:grid-cols-3">
            <Stat label="Contract number">{contract.number}</Stat>
            <Stat label="Scope / title">{contract.title}</Stat>
            <Stat label="Contract date">{formatDate(contract.executedOn)}</Stat>
            <Stat label="Original amount">
              <Money cents={contract.originalAmount} />
            </Stat>
            <Stat label="Retainage on completed work">
              <span className="num">{retainageTerms}</span>
            </Stat>
            <Stat label="Retainage on stored materials">
              <span className="num">{formatBps(contract.retainageStoredBps)}</span>
            </Stat>
          </dl>
        </Panel>

        <SchedulePanel
          contractId={contract.id}
          lines={detail.schedule.map((l) => ({ id: l.id, itemNo: l.itemNo, description: l.description, scheduledValue: l.scheduledValue, changeOrderId: l.changeOrderId }))}
          contractSum={position.contractSum}
          canWrite={canWrite}
        />

        <ChangeOrdersPanel contractId={contract.id} changeOrders={detail.changeOrders} canWrite={canWrite} />

        <RetainagePanel
          contractId={contract.id}
          terms={`${retainageTerms} on completed work and ${formatBps(contract.retainageStoredBps)} on stored materials`}
          held={position.retainageHeld}
          hasApproval={!!position.latestApproved}
          pending={detail.releasePending}
          releases={detail.releases}
          canApprove={canApprove}
        />

        {baseline ? (
          <Panel>
            <PanelHeader title="Opening balances" description="This contract was already being billed before it was set up here." />
            <div className="space-y-1 p-4">
              <p>
                Billing before application #{baseline.asOfApplicationNumber + 1} was recorded as opening balances: <Money cents={baseline.previousCertificates} className="font-medium" /> previously certified
                {baseline.retainageHeld !== null ? (
                  <>
                    , with <Money cents={baseline.retainageHeld} className="font-medium" /> of retainage held
                  </>
                ) : null}
                .
              </p>
              <p className="text-xs text-ink-3">
                Recorded{baseline.setByName ? ` by ${baseline.setByName}` : ''} on {formatDate(baseline.setAt)}
                {baseline.sourceApplication ? (
                  <>
                    , from the previous-billing figures on{' '}
                    <Link href={`/applications/${baseline.sourceApplication.id}`} className="text-ink-2 underline decoration-line-strong underline-offset-2 hover:text-ink">
                      {baseline.sourceApplication.applicationNumber !== null ? `application #${baseline.sourceApplication.applicationNumber}` : 'the first application received'}
                    </Link>
                  </>
                ) : null}
                .
              </p>
            </div>
          </Panel>
        ) : null}

        <Panel className="overflow-hidden">
          <PanelHeader
            title="Billing history"
            description={applications.length > 0 ? `${pluralize(applications.length, 'application')} received on this contract, newest first.` : undefined}
            actions={
              canUpload && applications.length > 0 ? (
                <Link href="/applications/new" className={buttonClass({ size: 'sm' })}>
                  Upload a package
                </Link>
              ) : null
            }
          />
          {applications.length === 0 ? (
            <EmptyState
              icon={<Inbox />}
              title="No applications on this contract yet"
              description={`Upload a billing package from ${subcontractor.name}. It is read, matched to this contract and checked against the terms and schedule above.`}
              action={
                canUpload ? (
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
                  <Th>Period to</Th>
                  <Th>Status</Th>
                  <Th align="right">Requested</Th>
                  <Th align="right">Approved</Th>
                  <Th align="right" className="pr-4">
                    Retainage held
                  </Th>
                </tr>
              </thead>
              <tbody className="[&_tr:last-child>td]:border-b-0">
                {applications.map((a) => (
                  <tr key={a.id} className="hover:bg-canvas/60">
                    <Td className="pl-4">
                      <Link href={`/applications/${a.id}`} className="font-medium hover:underline">
                        {a.applicationNumber !== null ? `Application #${a.applicationNumber}` : 'Application, number not read'}
                      </Link>
                    </Td>
                    <Td className="whitespace-nowrap text-ink-2">{formatDate(a.periodTo)}</Td>
                    <Td>
                      <StatusBadge status={a.status} />
                    </Td>
                    <Td align="right">
                      <Money cents={a.claimedAmount} />
                    </Td>
                    <Td align="right">
                      <Money cents={a.approvedAmount} />
                    </Td>
                    <Td align="right" className="pr-4">
                      <Money cents={a.approvedRetainage} />
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
