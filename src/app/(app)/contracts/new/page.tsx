import { Building2 } from 'lucide-react';
import Link from '@/components/ui/link';
import { getDb } from '@/db';
import { BackLink, CannotEditRecords } from '@/components/records/page-parts';
import { buttonClass } from '@/components/ui/button';
import { EmptyState, Page, PageHeader, Panel } from '@/components/ui/data';
import { can } from '@/server/auth/permissions';
import { requireCtx } from '@/server/auth/session';
import { getMatchingDraft, listProjectOptions, listSubcontractorOptions } from '@/server/services/records-queries';
import { ContractForm } from './contract-form';

export const metadata = { title: 'New subcontract' };

export default async function NewContractPage({ searchParams }: { searchParams: Promise<{ project?: string | string[]; from?: string | string[] }> }) {
  const ctx = await requireCtx();
  const { project, from } = await searchParams;
  const requested = Array.isArray(project) ? project[0] : project;

  const db = await getDb();
  const projects = await listProjectOptions(db, ctx);
  const subcontractors = await listSubcontractorOptions(db, ctx);
  // Set up from an application that could not be matched: only one in this organisation, still waiting.
  const draft = await getMatchingDraft(db, ctx, Array.isArray(from) ? from[0] : from);
  // Only a project in this organisation can be preselected; anything else is ignored.
  const selected = projects.find((p) => p.id === requested) ?? projects.find((p) => p.id === draft?.projectId) ?? null;
  const backHref = draft ? `/applications/${draft.appId}` : selected ? `/projects/${selected.id}` : '/projects';

  const header = (
    <PageHeader
      back={<BackLink href={backHref}>{draft ? draft.title : selected ? selected.name : 'Projects'}</BackLink>}
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

  // With no subcontractor yet the form still opens: one can be added from it.
  if (projects.length === 0) {
    return (
      <Page>
        {header}
        <Panel>
          <EmptyState
            icon={<Building2 />}
            title="Create a project first"
            description="A subcontract belongs to a project. Create the project, then add its subcontracts from the project page."
            action={
              <Link href={draft ? `/projects/new?from=${draft.appId}` : '/projects/new'} className={buttonClass({ variant: 'primary' })}>
                New project
              </Link>
            }
          />
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
        // From a package that names a project not on file, nothing is preselected: the person chooses or creates it.
        defaultProjectId={selected?.id ?? (projects.length === 1 && !draft ? projects[0]!.id : '')}
        cancelHref={backHref}
        fromApplication={
          draft
            ? { id: draft.appId, title: draft.title, contractNumber: draft.contractNumber, subcontractorId: draft.subcontractorId, contractorName: draft.contractorName, projectName: draft.projectName, projectMatched: selected !== null && selected.id === draft.projectId }
            : null
        }
      />
    </Page>
  );
}
