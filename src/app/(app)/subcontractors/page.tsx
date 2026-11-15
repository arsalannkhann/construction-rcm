import { Users } from 'lucide-react';
import Link from '@/components/ui/link';
import { getDb } from '@/db';
import { Badge, EmptyState, Money, Page, PageHeader, Panel, Table, Td, Th } from '@/components/ui/data';
import { can } from '@/server/auth/permissions';
import { requireCtx } from '@/server/auth/session';
import { listSubcontractors } from '@/server/services/records-queries';
import { SubcontractorDialogButton } from './subcontractor-dialog';

export const metadata = { title: 'Subcontractors' };

export default async function SubcontractorsPage() {
  const ctx = await requireCtx();
  const subs = await listSubcontractors(await getDb(), ctx);
  const canWrite = can(ctx.role, 'records:write');

  return (
    <Page>
      <PageHeader
        title="Subcontractors"
        description="The companies you hold subcontracts with. Incoming billing packages are matched to these by name."
        actions={canWrite ? <SubcontractorDialogButton mode="create" /> : null}
      />
      <Panel>
        {subs.length === 0 ? (
          <EmptyState
            icon={<Users />}
            title="No subcontractors yet"
            description="Add the subcontractors you work with, then set up a subcontract for each on a project."
            action={canWrite ? <SubcontractorDialogButton mode="create" variant="primary" /> : null}
          />
        ) : (
          <Table>
            <thead>
              <tr>
                <Th className="pl-4">Subcontractor</Th>
                <Th>Trade</Th>
                <Th>Billing contact</Th>
                <Th align="right">Contracts</Th>
                <Th align="right">Contract value</Th>
                <Th>In review</Th>
                <Th className="w-10" />
              </tr>
            </thead>
            <tbody>
              {subs.map((s) => (
                <tr key={s.id} className="group hover:bg-canvas/60">
                  <Td className="pl-4 font-medium">{s.name}</Td>
                  <Td className="text-ink-2">{s.trade ?? '—'}</Td>
                  <Td>
                    {s.contactName || s.contactEmail ? (
                      <>
                        <div>{s.contactName ?? '—'}</div>
                        {s.contactEmail ? <div className="text-xs text-ink-3">{s.contactEmail}</div> : null}
                      </>
                    ) : (
                      <span className="text-ink-4">—</span>
                    )}
                  </Td>
                  <Td align="right">{s.contracts}</Td>
                  <Td align="right">
                    <Money cents={s.contracts ? s.contractValue : null} />
                  </Td>
                  <Td>
                    {s.openApplications > 0 ? (
                      <Link href={`/applications?subcontractor=${s.id}`}>
                        <Badge tone="warn">{s.openApplications} open</Badge>
                      </Link>
                    ) : (
                      <span className="text-ink-4">—</span>
                    )}
                  </Td>
                  <Td className="pr-3 text-right">
                    {canWrite ? (
                      <SubcontractorDialogButton
                        mode="edit"
                        subcontractor={{ id: s.id, name: s.name, trade: s.trade, contactName: s.contactName, contactEmail: s.contactEmail, phone: s.phone, address: s.address }}
                      />
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
