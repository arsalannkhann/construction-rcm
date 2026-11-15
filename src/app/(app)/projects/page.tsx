import { Building2, Plus } from 'lucide-react';
import Link from '@/components/ui/link';
import { getDb } from '@/db';
import { RecordStatusBadge } from '@/components/records/figures';
import { buttonClass } from '@/components/ui/button';
import { Badge, EmptyState, Money, Page, PageHeader, Panel, Table, Td, Th } from '@/components/ui/data';
import { can } from '@/server/auth/permissions';
import { requireCtx } from '@/server/auth/session';
import { listProjects } from '@/server/services/records-queries';

export const metadata = { title: 'Projects' };

export default async function ProjectsPage() {
  const ctx = await requireCtx();
  const projects = await listProjects(await getDb(), ctx);
  const canWrite = can(ctx.role, 'records:write');

  const newProject = (variant: 'primary' | 'secondary') => (
    <Link href="/projects/new" className={buttonClass({ variant })}>
      <Plus className="size-3.5" />
      New project
    </Link>
  );

  return (
    <Page>
      <PageHeader
        title="Projects"
        description="The jobs you hold subcontracts on. Committed value is the original contract amounts plus approved change orders; approved to date is what has been approved for payment."
        actions={canWrite ? newProject('secondary') : null}
      />
      <Panel className="overflow-hidden">
        {projects.length === 0 ? (
          <EmptyState
            icon={<Building2 />}
            title="No projects yet"
            description="A project is a job you hold subcontracts on. Create one, add its subcontracts, and incoming billing packages are matched to them and verified against their terms."
            action={canWrite ? newProject('primary') : null}
          />
        ) : (
          <Table>
            <thead>
              <tr>
                <Th className="pl-4">Project</Th>
                <Th>Location</Th>
                <Th>Owner</Th>
                <Th align="right">Subcontracts</Th>
                <Th align="right">Committed</Th>
                <Th align="right">Approved to date</Th>
                <Th>In review</Th>
                <Th className="pr-4">Status</Th>
              </tr>
            </thead>
            <tbody className="[&_tr:last-child>td]:border-b-0">
              {projects.map((p) => {
                const location = [p.city, p.state].filter(Boolean).join(', ');
                return (
                  <tr key={p.id} className="hover:bg-canvas/60">
                    <Td className="pl-4">
                      <Link href={`/projects/${p.id}`} className="font-medium hover:underline">
                        {p.name}
                      </Link>
                      {p.number ? <div className="text-xs text-ink-3">{p.number}</div> : null}
                    </Td>
                    <Td className="text-ink-2">{location || <span className="text-ink-4">—</span>}</Td>
                    <Td className="text-ink-2">{p.ownerName ?? <span className="text-ink-4">—</span>}</Td>
                    <Td align="right">{p.contracts}</Td>
                    <Td align="right">
                      <Money cents={p.contracts ? p.committed : null} />
                    </Td>
                    <Td align="right">
                      <Money cents={p.contracts ? p.approvedToDate : null} />
                    </Td>
                    <Td>
                      {p.inReview > 0 ? (
                        <Link href={`/applications?project=${p.id}`}>
                          <Badge tone="warn">{p.inReview} in review</Badge>
                        </Link>
                      ) : (
                        <span className="text-ink-4">—</span>
                      )}
                    </Td>
                    <Td className="pr-4">
                      <RecordStatusBadge status={p.status} />
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
