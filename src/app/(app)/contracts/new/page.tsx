import { Building2, Users } from 'lucide-react';
import Link from '@/components/ui/link';
import { getDb } from '@/db';
import { BackLink, CannotEditRecords } from '@/components/records/page-parts';
import { buttonClass } from '@/components/ui/button';
import { EmptyState, Page, PageHeader, Panel } from '@/components/ui/data';
import { can } from '@/server/auth/permissions';
import { requireCtx } from '@/server/auth/session';
import { listProjectOptions, listSubcontractorOptions } from '@/server/services/records-queries';
import { ContractForm } from './contract-form';

export const metadata = { title: 'New subcontract' };

export default async function NewContractPage({ searchParams }: { searchParams: Promise<{ project?: string | string[] }> }) {
  const ctx = await requireCtx();
  const { project } = await searchParams;
  const requested = Array.isArray(project) ? project[0] : project;

  const db = await getDb();
  const projects = await listProjectOptions(db, ctx);
  const subcontractors = await listSubcontractorOptions(db, ctx);
  // Only a project in this organisation can be preselected; anything else is ignored.
  const selected = projects.find((p) => p.id === requested) ?? null;
  const backHref = selected ? `/projects/${selected.id}` : '/projects';

  const header = (
    <PageHeader
      back={<BackLink href={backHref}>{selected ? selected.name : 'Projects'}</BackLink>}
      title="New subcontract"
      description="Record the subcontract and its schedule of values. Billing packages from this subcontractor on this project are matched to it and verified against it."
    />
  );

  if (!can(ctx.role, 'records:write')) {
    return (
      <Page>
        {header}
        <CannotEditRecords role={ctx.role} what="set up subcontracts" />
      </Page>
    );
  }

  if (projects.length === 0 || subcontractors.length === 0) {
    return (
      <Page>
        {header}
        <Panel>
          {projects.length === 0 ? (
            <EmptyState
              icon={<Building2 />}
              title="Create a project first"
              description="A subcontract belongs to a project. Create the project, then add its subcontracts from the project page."
              action={
                <Link href="/projects/new" className={buttonClass({ variant: 'primary' })}>
                  New project
                </Link>
              }
            />
          ) : (
            <EmptyState
              icon={<Users />}
              title="Add the subcontractor first"
              description="A subcontract is held with a subcontractor on your list. Add the company, then come back to set up its subcontract."
              action={
                <Link href="/subcontractors" className={buttonClass({ variant: 'primary' })}>
                  Go to subcontractors
                </Link>
              }
            />
          )}
        </Panel>
      </Page>
    );
  }

  return (
    <Page>
      {header}
      <ContractForm
        projects={projects.map((p) => ({ id: p.id, label: `${p.name}${p.number ? ` · ${p.number}` : ''}${p.status === 'closed' ? ' (closed)' : ''}` }))}
        subcontractors={subcontractors.map((s) => ({ id: s.id, label: s.trade ? `${s.name} · ${s.trade}` : s.name }))}
        defaultProjectId={selected?.id ?? (projects.length === 1 ? projects[0]!.id : '')}
        cancelHref={backHref}
      />
    </Page>
  );
}
