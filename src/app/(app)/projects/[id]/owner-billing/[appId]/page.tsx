import { Download } from 'lucide-react';
import { notFound } from 'next/navigation';
import { Note } from '@/components/records/figures';
import { OwnerCheckList, OwnerStatusBadge } from '@/components/records/owner-billing';
import { BackLink } from '@/components/records/page-parts';
import { buttonClass } from '@/components/ui/button';
import { Money, Page, PageHeader, Panel, PanelHeader, Table, Td, Th } from '@/components/ui/data';
import Link from '@/components/ui/link';
import { formatMoney } from '@/lib/money';
import { cn, formatDate, formatDateTime, formatMonth } from '@/lib/utils';
import { getDb } from '@/db';
import { can } from '@/server/auth/permissions';
import { requireCtx } from '@/server/auth/session';
import { getOwnerApplication } from '@/server/services/owner-billing';
import { CLAIMED_FIELD_LABEL, CLAIMED_FIELD_LINE, type ClaimedField, type OwnerAppStatus } from '@/server/types';
import { ApplicationActions } from './application-actions';
import { ContinuationSheet } from './continuation-sheet';

export const metadata = { title: 'Owner application' };

const SUMMARY: Array<{ field: ClaimedField; indent?: boolean; strong?: boolean }> = [
  { field: 'originalContractSum' },
  { field: 'netChangeOrders' },
  { field: 'contractSumToDate' },
  { field: 'totalCompletedStored' },
  { field: 'retainageWork', indent: true },
  { field: 'retainageStored', indent: true },
  { field: 'retainageTotal' },
  { field: 'totalEarnedLessRetainage' },
  { field: 'lessPreviousCertificates' },
  { field: 'currentPaymentDue', strong: true },
  { field: 'balanceToFinish' },
];

export default async function OwnerApplicationPage({ params }: { params: Promise<{ id: string; appId: string }> }) {
  const { id, appId } = await params;
  const ctx = await requireCtx();
  const found = await getOwnerApplication(await getDb(), ctx, appId);
  if (!found || found.project.id !== id) notFound();
  const { app, prime, project, computed, isLatest } = found;
  const status = app.status as OwnerAppStatus;
  const draft = status === 'draft';
  const { header, checks, lines, sources } = computed;
  const blocking = checks.filter((c) => c.severity === 'blocking').length;
  const warnings = checks.filter((c) => c.severity === 'warning').length;
  const canWrite = can(ctx.role, 'records:write');
  const canApprove = can(ctx.role, 'application:approve');
  const canExport = can(ctx.role, 'export:run');
  const amountDue = draft ? header.currentPaymentDue : (app.amountDue ?? header.currentPaymentDue);

  return (
    <Page width="wide">
      <PageHeader
        back={<BackLink href={`/projects/${project.id}/owner-billing`}>Owner billing · {project.name}</BackLink>}
        title={
          <span className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
            Application #{app.applicationNumber}
            <OwnerStatusBadge status={status} />
          </span>
        }
        description={`Period to ${formatDate(app.periodTo)} · to ${project.ownerName ?? 'the owner'}${prime.number ? ` · contract ${prime.number}` : ''}`}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            {canExport ? (
              <a href={`/api/owner-applications/${app.id}/pdf`} target="_blank" rel="noopener" className={buttonClass({ variant: 'secondary' })}>
                <Download className="size-3.5" />
                {draft ? 'Draft PDF' : 'PDF'}
              </a>
            ) : null}
            <ApplicationActions
              projectId={project.id}
              appId={app.id}
              number={app.applicationNumber}
              status={status}
              fingerprint={computed.fingerprint}
              amountDue={amountDue}
              blocking={blocking}
              warnings={warnings}
              certified={{ amount: app.certifiedAmount, on: app.certifiedOn, note: app.certificationNote }}
              can={{ write: canWrite, approve: canApprove }}
              isLatest={isLatest}
            />
          </div>
        }
      />

      <div className="space-y-5">
        {draft ? (
          <Note>
            A draft follows the subcontractor billing approved up to {formatMonth(app.periodTo)} every time it is opened, so it is always current. Lines someone typed over keep their figures. Submitting freezes everything.
          </Note>
        ) : (
          <Note>
            Submitted {app.submittedAt ? formatDateTime(app.submittedAt) : ''} by {app.record?.submittedBy.name ?? 'someone'}. These are the figures as submitted; later approvals go on the next application.
            {status === 'certified' ? ` The owner certified ${formatMoney(app.certifiedAmount)} on ${formatDate(app.certifiedOn)}${app.certificationNote ? `: ${app.certificationNote}` : '.'}` : ''}
          </Note>
        )}

        <div className="grid gap-5 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)]">
          <Panel className="overflow-hidden">
            <PanelHeader title="Application summary" description="G702 lines 1 to 9." />
            <dl className="divide-y divide-line">
              {SUMMARY.map((r) => (
                <div key={r.field} className={cn('flex items-baseline justify-between gap-4 px-4 py-2', r.strong && 'bg-canvas/70 py-3')}>
                  <dt className={cn('flex gap-2 text-[13px]', r.indent ? 'pl-6 text-ink-2' : 'text-ink', r.strong && 'font-semibold')}>
                    <span className="num w-6 shrink-0 text-ink-3">{CLAIMED_FIELD_LINE[r.field]}</span>
                    {CLAIMED_FIELD_LABEL[r.field]}
                  </dt>
                  <dd className={cn(r.strong ? 'text-[17px] font-semibold' : 'text-[13px]', r.indent && 'text-ink-2')}>
                    <Money cents={header[r.field]} />
                  </dd>
                </div>
              ))}
            </dl>
          </Panel>

          <Panel className="overflow-hidden">
            <PanelHeader
              title={draft ? 'Checks' : 'Checks when submitted'}
              description={blocking ? `${blocking} must be resolved before it can be submitted.` : checks.length ? 'None of these stop it being submitted. Read them first.' : undefined}
            />
            {checks.length === 0 ? <p className="px-4 py-6 text-[13px] text-ink-3">Nothing to flag: the schedule adds up, no line is billed beyond its value or ahead of the approved progress, and every subcontract is accounted for.</p> : <OwnerCheckList checks={checks} />}
          </Panel>
        </div>

        <Panel className="overflow-hidden">
          <ContinuationSheet key={`${app.id}-${app.version}-${computed.fingerprint}`} appId={app.id} version={app.version} lines={lines} editable={draft && canWrite} />
        </Panel>

        <Panel className="overflow-hidden">
          <PanelHeader title="Subcontractor billing it draws on" description={`The latest approved application on each subcontract up to ${formatMonth(app.periodTo)}${draft ? '' : ', as it was when submitted'}. Only approved billing counts.`} />
          {sources.length === 0 ? (
            <p className="px-4 py-6 text-[13px] text-ink-3">No subcontracts on this project.</p>
          ) : (
            <Table>
              <thead>
                <tr>
                  <Th className="pl-4">Subcontract</Th>
                  <Th>Counted as of</Th>
                  <Th align="right">Contract sum</Th>
                  <Th align="right">Work to date</Th>
                  <Th align="right">Stored</Th>
                  <Th className="pr-4">Owner lines</Th>
                </tr>
              </thead>
              <tbody className="[&_tr:last-child>td]:border-b-0">
                {sources.map((s) => (
                  <tr key={s.contractId}>
                    <Td className="pl-4">
                      <Link href={`/contracts/${s.contractId}`} className="font-medium hover:underline">
                        {s.subcontractorName}
                      </Link>
                      <div className="text-xs text-ink-3">{s.contractNumber}</div>
                    </Td>
                    <Td>
                      {s.asOf ? (
                        <Link href={`/applications/${s.asOf.applicationId}`} className="hover:underline">
                          Application #{s.asOf.applicationNumber}, {formatDate(s.asOf.periodTo)}
                        </Link>
                      ) : (
                        <span className="text-ink-3">Nothing approved yet</span>
                      )}
                      {s.openThisPeriod ? <div className="text-xs text-warn">{s.openThisPeriod} for this period still in review</div> : null}
                    </Td>
                    <Td align="right">
                      <Money cents={s.contractSum} />
                    </Td>
                    <Td align="right">
                      <Money cents={s.workToDate} />
                    </Td>
                    <Td align="right">
                      <Money cents={s.stored} />
                    </Td>
                    <Td className={cn('pr-4', s.primeLineIds.length ? 'text-ink-2' : 'text-warn')}>
                      {s.primeLineIds.length ? s.primeLineIds.map((pid) => lines.find((l) => l.primeLineId === pid)?.itemNo ?? '?').join(', ') : 'Not on the owner schedule'}
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
