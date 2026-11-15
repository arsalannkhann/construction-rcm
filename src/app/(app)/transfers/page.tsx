import { Download, Send } from 'lucide-react';
import Link from '@/components/ui/link';
import { getDb } from '@/db';
import { buttonClass } from '@/components/ui/button';
import { Badge, EmptyState, Money, Page, PageHeader, Panel, PanelHeader, Table, Td, Th } from '@/components/ui/data';
import { Tooltip } from '@/components/ui/overlay';
import { formatDateTime } from '@/lib/utils';
import { can } from '@/server/auth/permissions';
import { requireCtx } from '@/server/auth/session';
import { procoreStatus } from '@/server/integrations/procore';
import { listAwaitingTransfer, listTransfers } from '@/server/services/exports';
import { ReadyTable } from './ready-table';

export const metadata = { title: 'Transfers' };

const KIND: Record<string, string> = { pdf: 'Approval record (PDF)', csv: 'CSV', json: 'JSON', procore: 'Procore invoice' };

export default async function TransfersPage() {
  const ctx = await requireCtx();
  const db = await getDb();
  const ready = await listAwaitingTransfer(db, ctx);
  const history = await listTransfers(db, ctx);
  const procore = await procoreStatus(db, ctx);
  const canExport = can(ctx.role, 'export:run');

  return (
    <Page>
      <PageHeader title="Transfers" description="Approved applications leave Zephric here, as files for your accounting system or as draft invoices in a connected system. Every transfer is produced from the approved record and logged." />

      <Panel className="mb-4 flex items-center gap-3 px-4 py-3">
        <div className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-sunken text-ink-3">
          <Send className="size-4" />
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-[13px] font-medium">
            Procore{' '}
            {procore.connected ? (
              <Badge tone="pass" className="ml-1">
                Connected{procore.companyName ? ` · ${procore.companyName}` : ''}
              </Badge>
            ) : (
              <Badge tone="neutral" className="ml-1">
                {procore.configured ? 'Not connected' : 'Not configured'}
              </Badge>
            )}
          </p>
          <p className="text-xs text-ink-3">
            {procore.connected
              ? 'Approved applications on subcontracts imported from Procore can be sent as draft subcontractor invoices from the application page.'
              : 'File export below is always available. Connecting Procore additionally lets you send approved applications as draft subcontractor invoices.'}
          </p>
        </div>
        <Link href="/settings/integrations" className={buttonClass({ size: 'sm' })}>
          {procore.connected ? 'Manage' : 'Set up'}
        </Link>
      </Panel>

      <Panel className="mb-4">
        <PanelHeader title="Approved, not yet transferred" description="Export one from its page, or select several for a single accounts-payable summary file." />
        {ready.length === 0 ? (
          <EmptyState className="py-10" title="Nothing is waiting" description="Applications appear here once they are approved and until they are exported or sent." />
        ) : (
          <ReadyTable rows={ready.map((r) => ({ ...r, decidedAt: r.decidedAt?.toISOString() ?? null }))} canExport={canExport} />
        )}
      </Panel>

      <Panel>
        <PanelHeader title="Transfer history" description="What left the system, when, and who sent it. The checksum identifies the exact file." />
        {history.length === 0 ? (
          <EmptyState className="py-10" title="No transfers yet" description="Exports and integration pushes are listed here with their outcome." />
        ) : (
          <Table>
            <thead>
              <tr>
                <Th className="pl-4">When</Th>
                <Th>Application</Th>
                <Th align="right">Approved</Th>
                <Th>Type</Th>
                <Th>Outcome</Th>
                <Th>By</Th>
                <Th>Checksum</Th>
                <Th className="pr-4" />
              </tr>
            </thead>
            <tbody>
              {history.map((t) => (
                <tr key={t.id} className="hover:bg-canvas/60">
                  <Td className="whitespace-nowrap pl-4 text-ink-2">{formatDateTime(t.createdAt)}</Td>
                  <Td>
                    <Link href={`/applications/${t.applicationId}`} className="font-medium hover:underline">
                      {t.record?.subcontractor.name ?? 'Application'}
                    </Link>
                    <span className="ml-1.5 text-ink-3">#{t.applicationNumber}</span>
                    {t.record ? <div className="text-xs text-ink-3">{t.record.project.name}</div> : null}
                  </Td>
                  <Td align="right">
                    <Money cents={t.approvedAmount} />
                  </Td>
                  <Td className="text-ink-2">{KIND[t.kind] ?? t.kind}</Td>
                  <Td>
                    {t.status === 'completed' ? (
                      <Badge tone="pass">{t.kind === 'procore' ? `Invoice ${t.externalRef ?? ''}` : 'Exported'}</Badge>
                    ) : t.status === 'sending' ? (
                      <Badge tone="neutral">Sending</Badge>
                    ) : t.status === 'unknown' ? (
                      <Tooltip content="Procore may have created the invoice. Sending again checks Procore first and will not create a second one.">
                        <span>
                          <Badge tone="warn">No answer</Badge>
                        </span>
                      </Tooltip>
                    ) : (
                      <Tooltip content={t.error ?? 'The transfer failed.'}>
                        <span>
                          <Badge tone="block">Failed</Badge>
                        </span>
                      </Tooltip>
                    )}
                    {t.status !== 'completed' && t.error ? <div className="mt-0.5 max-w-[260px] text-xs text-ink-3">{t.error}</div> : null}
                  </Td>
                  <Td className="text-ink-2">{t.userName ?? '—'}</Td>
                  <Td>{t.sha256 ? <span className="font-mono text-[11px] text-ink-3" title={t.sha256}>{t.sha256.slice(0, 12)}</span> : <span className="text-ink-4">—</span>}</Td>
                  <Td className="pr-4 text-right">
                    {t.filename && t.status === 'completed' && t.kind !== 'procore' ? (
                      <a href={`/api/transfers/${t.id}/download`} className={buttonClass({ size: 'sm', variant: 'ghost' })} aria-label={`Download ${t.filename}`} title={t.filename}>
                        <Download className="size-3.5" />
                      </a>
                    ) : null}
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Panel>
    </Page>
  );
}
