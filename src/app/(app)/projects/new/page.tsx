import { BackLink, CannotEditRecords } from '@/components/records/page-parts';
import { Page, PageHeader } from '@/components/ui/data';
import { can } from '@/server/auth/permissions';
import { getDb } from '@/db';
import { requireCtx } from '@/server/auth/session';
import { getMatchingDraft } from '@/server/services/records-queries';
import { ProjectForm } from './project-form';

export const metadata = { title: 'New project' };

export default async function NewProjectPage({ searchParams }: { searchParams: Promise<{ from?: string | string[] }> }) {
  const ctx = await requireCtx();
  const { from } = await searchParams;
  // Set up from an application that could not be matched: its project name and number are filled in.
  const draft = await getMatchingDraft(await getDb(), ctx, Array.isArray(from) ? from[0] : from);
  return (
    <Page width="narrow">
      <PageHeader
        back={draft ? <BackLink href={`/applications/${draft.appId}`}>{draft.title}</BackLink> : <BackLink href="/projects">Projects</BackLink>}
        title="New project"
        description="A project is a job you hold subcontracts on. Once it exists, add its subcontracts; incoming billing packages are then matched to them."
      />
      {can(ctx.role, 'records:write') ? (
        <ProjectForm fromApplication={draft ? { id: draft.appId, title: draft.title, name: draft.projectName ?? '', number: draft.projectNumber ?? '' } : null} />
      ) : (
        <CannotEditRecords role={ctx.role} what="create projects" />
      )}
    </Page>
  );
}
