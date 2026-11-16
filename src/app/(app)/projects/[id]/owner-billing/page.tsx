import { FileText, Landmark } from 'lucide-react';
import { notFound } from 'next/navigation';
import { ChangeOrdersPanel } from '@/app/(app)/contracts/[id]/change-orders';
import { Figure, Figures, Note } from '@/components/records/figures';
import { OwnerStatusBadge } from '@/components/records/owner-billing';
import { BackLink } from '@/components/records/page-parts';
import { buttonClass } from '@/components/ui/button';
import { EmptyState, Money, Page, PageHeader, Panel, PanelHeader, Table, Td, Th } from '@/components/ui/data';
import Link from '@/components/ui/link';
import { formatBps, formatMoney } from '@/lib/money';
import { formatDate, formatMonth } from '@/lib/utils';
import { getDb } from '@/db';
import { can } from '@/server/auth/permissions';
import { requireCtx } from '@/server/auth/session';
import { getOwnerBilling, suggestedPeriod } from '@/server/services/owner-billing';
import { PrimeContractDialogButton } from './prime-contract-dialog';
import { PrimeSchedulePanel } from './prime-schedule';
import { StartApplicationButton } from './start-application';

export const metadata = { title: 'Owner billing' };

/** How the contract sum to date is made up, and what is still pending. */
function contractNote(original: number, approved: number, pending: number): string {
  const made = approved === 0 ? 'No change orders approved' : `Original ${formatMoney(original)}, ${approved > 0 ? 'plus' : 'less'} ${formatMoney(Math.abs(approved))} in approved change orders`;
  return pending ? `${made}; ${formatMoney(pending)} pending` : made;
}

export default async function OwnerBillingPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await requireCtx();
  const data = await getOwnerBilling(await getDb(), ctx, id);
  if (!data) notFound();
  const { project, prime, lines, changeOrders, subcontracts, applications, billed } = data;
  const canWrite = can(ctx.role, 'records:write');
  const canExport = can(ctx.role, 'export:run');
  const draft = applications.find((a) => a.status === 'draft');
  const latest = applications[0];
  const nextNumber = (latest?.applicationNumber ?? 0) + 1;
  const terms = prime ? { number: prime.number, architectName: prime.architectName, originalAmount: prime.originalAmount, retainageWorkBps: prime.retainageWorkBps, retainageStoredBps: prime.retainageStoredBps, executedOn: prime.executedOn } : null;
  const start = (variant: 'primary' | 'secondary') =>
    prime && lines.length > 0 && !draft && canWrite ? <StartApplicationButton projectId={project.id} number={nextNumber} suggested={suggestedPeriod(latest?.periodTo ?? null)} variant={variant} /> : null;

  return (
    <Page>
      <PageHeader
        back={<BackLink href={`/projects/${project.id}`}>{project.name}</BackLink>}
        title="Owner billing"
        description={
          prime
            ? `Your applications for payment to ${project.ownerName ?? 'the owner'}${prime.number ? ` under contract ${prime.number}` : ''}, built from the subcontractor billing you approved.`
            : 'Bill the owner from the subcontractor billing you approved.'
        }
        actions={
          prime ? (
            <div className="flex flex-wrap gap-2">
              {canWrite ? <PrimeContractDialogButton projectId={project.id} ownerName={project.ownerName} terms={terms} /> : null}
              {draft ? (
                <Link href={`/projects/${project.id}/owner-billing/${draft.id}`} className={buttonClass({ variant: 'primary' })}>
                  Continue draft #{draft.applicationNumber}
                </Link>
              ) : (
                start('primary')
              )}
            </div>
          ) : null
        }
      />

      {!prime ? (
        <Panel>
          <EmptyState
            icon={<Landmark />}
            title="Set up your contract with the owner"
            description="Enter the contract sum and retainage, then the schedule of values you bill against. Each period, Zephric works out your application from the subcontractor billing you approved and lays it out as a G702 and G703, ready to check, submit and download."
            action={canWrite ? <PrimeContractDialogButton projectId={project.id} ownerName={project.ownerName} terms={null} variant="primary" /> : <p className="text-[13px] text-ink-3">Someone who keeps the records can set it up.</p>}
          />
        </Panel>
      ) : (
        <div className="space-y-5">
          <Figures className="grid-cols-1 sm:grid-cols-2 lg:grid-cols-4">
            <Figure label="Contract sum to date" cents={prime.contractSumToDate} note={contractNote(prime.originalAmount, prime.contractSumToDate - prime.originalAmount, prime.pendingChanges)} />
            <Figure label="Completed and stored" cents={billed?.totalCompletedStored ?? 0} note={billed ? `As of application #${billed.applicationNumber}, ${formatMonth(billed.periodTo)}` : 'Nothing submitted yet'} />
            <Figure label="Certified for payment" cents={billed?.certified ?? 0} note={billed?.awaitingCertification ? `${formatMoney(billed.awaitingCertification)} awaiting certification` : 'Recorded from the owner’s certificates'} />
            <Figure label="Retainage held by the owner" cents={billed?.retainage ?? 0} note={`${formatBps(prime.retainageWorkBps)} on work, ${formatBps(prime.retainageStoredBps)} on stored materials`} />
          </Figures>

          <Panel className="overflow-hidden">
            <PanelHeader title="Applications to the owner" description="One per period. A draft follows the latest approvals until it is submitted; then its figures are frozen." actions={applications.length > 0 && !draft ? start('secondary') : null} />
            {applications.length === 0 ? (
              <EmptyState
                icon={<FileText />}
                title="No applications yet"
                description={lines.length === 0 ? 'Add the schedule of values below first.' : 'Start the first application. It is worked out from the subcontractor billing approved up to the end of its period.'}
                action={start('primary')}
              />
            ) : (
              <Table>
                <thead>
                  <tr>
                    <Th className="pl-4">Application</Th>
                    <Th>Period to</Th>
                    <Th>Status</Th>
                    <Th align="right">Completed and stored</Th>
                    <Th align="right">Payment due</Th>
                    <Th align="right">Certified</Th>
                    <Th className="pr-4" />
                  </tr>
                </thead>
                <tbody className="[&_tr:last-child>td]:border-b-0">
                  {applications.map((a) => (
                    <tr key={a.id} className="hover:bg-canvas/60">
                      <Td className="pl-4">
                        <Link href={`/projects/${project.id}/owner-billing/${a.id}`} className="font-medium hover:underline">
                          Application #{a.applicationNumber}
                        </Link>
                      </Td>
                      <Td className="whitespace-nowrap text-ink-2">{formatDate(a.periodTo)}</Td>
                      <Td>
                        <OwnerStatusBadge status={a.status} />
                      </Td>
                      <Td align="right">
                        <Money cents={a.totalCompletedStored} />
                      </Td>
                      <Td align="right">
                        <Money cents={a.amountDue} />
                        {a.status === 'draft' ? <div className="text-xs text-ink-3">so far</div> : null}
                      </Td>
                      <Td align="right">
                        {a.status === 'certified' ? (
                          <>
                            <Money cents={a.certifiedAmount} />
                            <div className="text-xs text-ink-3">{formatDate(a.certifiedOn)}</div>
                          </>
                        ) : (
                          <span className="text-ink-4">—</span>
                        )}
                      </Td>
                      <Td className="pr-4 text-right">
                        {canExport ? (
                          <a href={`/api/owner-applications/${a.id}/pdf`} target="_blank" rel="noopener" className={buttonClass({ variant: 'ghost', size: 'sm' })}>
                            PDF
                          </a>
                        ) : null}
                      </Td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            )}
          </Panel>

          <PrimeSchedulePanel
            projectId={project.id}
            lines={lines}
            subcontracts={subcontracts.map((s) => ({ id: s.id, number: s.number, title: s.title, subcontractorName: s.subcontractorName, contractSum: s.contractSum, status: s.status }))}
            contractSumToDate={prime.contractSumToDate}
            canWrite={canWrite}
          />

          <ChangeOrdersPanel contractId={project.id} changeOrders={changeOrders} canWrite={canWrite} owner />

          {project.ownerName ? null : <Note>The project has no owner name on file, so the application is addressed to “the owner”. Add it on the project page.</Note>}
        </div>
      )}
    </Page>
  );
}
