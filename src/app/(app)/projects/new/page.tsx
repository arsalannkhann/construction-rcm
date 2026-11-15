import { BackLink, CannotEditRecords } from '@/components/records/page-parts';
import { Page, PageHeader } from '@/components/ui/data';
import { can } from '@/server/auth/permissions';
import { requireCtx } from '@/server/auth/session';
import { ProjectForm } from './project-form';

export const metadata = { title: 'New project' };

export default async function NewProjectPage() {
  const ctx = await requireCtx();
  return (
    <Page width="narrow">
      <PageHeader
        back={<BackLink href="/projects">Projects</BackLink>}
        title="New project"
        description="A project is a job you hold subcontracts on. Once it exists, add its subcontracts; incoming billing packages are then matched to them."
      />
      {can(ctx.role, 'records:write') ? <ProjectForm /> : <CannotEditRecords role={ctx.role} what="create projects" />}
    </Page>
  );
}
