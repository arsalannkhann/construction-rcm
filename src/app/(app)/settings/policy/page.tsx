import { getDb } from '@/db';
import { PermissionNote } from '@/components/settings/permission-note';
import { PageHeader, Panel, PanelHeader } from '@/components/ui/data';
import { can } from '@/server/auth/permissions';
import { requireCtx } from '@/server/auth/session';
import { getOrganization } from '@/server/services/team';
import { DEFAULT_ORG_SETTINGS, type OrgSettings } from '@/server/types';
import { PolicyForm } from './policy-form';

export const metadata = { title: 'Review policy' };

export default async function PolicySettingsPage() {
  const ctx = await requireCtx();
  const org = await getOrganization(await getDb(), ctx);
  // Defaults fill in anything an older record does not carry.
  const settings: OrgSettings = { ...DEFAULT_ORG_SETTINGS, ...org.settings };
  const canEdit = can(ctx.role, 'policy:manage');

  return (
    <>
      <PageHeader
        title="Review policy"
        description={`The rules every billing package sent to ${ctx.orgName} is checked against. They decide what is raised as a finding, and whether it blocks approval or only warns.`}
      />
      <div className="space-y-6">
        {canEdit ? null : <PermissionNote role={ctx.role} permission="policy:manage" action="change the review policy" />}
        <Panel>
          <PanelHeader title="Checks" description="Blocking findings must be resolved or overridden before an application can be approved. Warnings must be acknowledged." />
          {/* Remounts with the stored values after a save, or when someone else has changed the policy. */}
          <PolicyForm key={JSON.stringify(settings)} initial={settings} canEdit={canEdit} />
        </Panel>
      </div>
    </>
  );
}
