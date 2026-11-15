import { dbDriver, getDb } from '@/db';
import { DemoWorkspaceCard } from '@/components/demo/demo-workspace-card';
import { CopyField } from '@/components/settings/copy-field';
import { PermissionNote } from '@/components/settings/permission-note';
import { Badge, PageHeader, Panel, PanelHeader, Stat } from '@/components/ui/data';
import { formatDate } from '@/lib/utils';
import { can, ROLE_LABEL } from '@/server/auth/permissions';
import { requireCtx } from '@/server/auth/session';
import { aiConfig, appUrl, emailConfig, inboundEmailSecret, procoreConfig } from '@/server/config';
import { getOrganization, listMyOrganizations } from '@/server/services/team';
import { RenameForm } from './rename-form';

export const metadata = { title: 'Organisation' };

type Check = { name: string; configured: boolean; status: string; detail: string };

export default async function OrganizationSettingsPage() {
  const ctx = await requireCtx();
  const db = await getDb();
  const org = await getOrganization(db, ctx);
  const hasDemo = (await listMyOrganizations(db, ctx.userId)).some((o) => o.isDemo);
  const canManage = can(ctx.role, 'org:manage');

  const endpoint = `${appUrl()}/api/inbound/email/${org.intakeToken}`;
  const secretSet = inboundEmailSecret() !== null;

  const driver = await dbDriver();
  const ai = aiConfig();
  const email = emailConfig();
  const procore = procoreConfig();
  // Only names, models and addresses are read here; keys and secrets never reach the page.
  const checks: Check[] = [
    driver === 'postgres'
      ? { name: 'Database', configured: true, status: 'Configured', detail: 'PostgreSQL.' }
      : { name: 'Database', configured: false, status: 'Embedded', detail: 'Embedded database, single node — suitable for evaluation.' },
    ai.configured
      ? { name: 'AI document reading', configured: true, status: 'Configured', detail: `Documents, including scans, are read with ${ai.model}.` }
      : { name: 'AI document reading', configured: false, status: 'Not configured', detail: 'Documents with a text layer are read by the rule-based parser; scans must be keyed by hand.' },
    email.configured
      ? { name: 'Outbound email', configured: true, status: 'Configured', detail: `Messages to subcontractors and invitations are emailed from ${email.from}.` }
      : { name: 'Outbound email', configured: false, status: 'Not configured', detail: 'Messages to subcontractors and invitations are drafted but not sent.' },
    procore.configured
      ? { name: 'Procore', configured: true, status: 'Configured', detail: `OAuth app credentials are set for Procore’s ${procore.env} environment. Whether an account is connected is shown under Integrations.` }
      : { name: 'Procore', configured: false, status: 'Not configured', detail: 'OAuth app credentials are not set; file export is available.' },
  ];

  return (
    <>
      <PageHeader title="Organisation" description="Your company’s workspace: its name, how billing packages can reach it by email, and what this deployment is set up to do." />
      <div className="space-y-6">
        <Panel>
          <PanelHeader title="Name" description="Shown to your team and used to sign messages to subcontractors." />
          <div className="px-4 py-4">
            {canManage ? (
              <RenameForm key={org.name} name={org.name} />
            ) : (
              <div className="space-y-3">
                <div className="text-sm font-medium text-ink">{org.name}</div>
                <PermissionNote role={ctx.role} permission="org:manage" action="rename the organisation" />
              </div>
            )}
          </div>
          <dl className="flex gap-12 border-t border-line px-4 py-3">
            <Stat label="Your role">{ROLE_LABEL[ctx.role]}</Stat>
            <Stat label="Created">{formatDate(org.createdAt.toISOString().slice(0, 10))}</Stat>
          </dl>
        </Panel>

        <Panel>
          <PanelHeader title="Email intake" description="Receive billing packages by email instead of uploading them." />
          <div className="space-y-4 px-4 py-4">
            <p className="max-w-2xl text-[13px] text-ink-2">
              An email provider that supports inbound webhooks (for example Postmark) can POST incoming mail to the address below, and the attachments of each message become a new billing package. This needs an account with such a provider. It is
              not active until that provider is pointed at this address.
            </p>
            <div>
              <div className="mb-1 text-xs font-medium text-ink-2">Inbound endpoint for {org.name}</div>
              <CopyField value={endpoint} label="Inbound endpoint" />
            </div>
            <div className="flex items-start justify-between gap-4 border-t border-line pt-3">
              <div className="min-w-0">
                <div className="text-[13px] font-medium text-ink">Shared secret</div>
                <p className="mt-0.5 text-xs text-ink-3">
                  {secretSet
                    ? 'Set on the server as INBOUND_EMAIL_SECRET. Your provider must send it with every request: as the password of HTTP basic authentication, an x-inbound-secret header, or ?secret= on the address above. It is never shown here.'
                    : 'Not set on the server (INBOUND_EMAIL_SECRET). The endpoint rejects all requests until it is set.'}
                </p>
              </div>
              <Badge tone={secretSet ? 'pass' : 'neutral'}>{secretSet ? 'Configured' : 'Not configured'}</Badge>
            </div>
            <p className="border-t border-line pt-3 text-xs text-ink-3">
              Each message is processed once, even if the provider delivers it again. Messages from an address that is not on file are handled as set in{' '}
              <a href="/settings/policy" className="text-ink-2 underline underline-offset-2">
                Review policy
              </a>
              . Every message received, and what happened to it, is listed under{' '}
              <a href="/settings/system#intake" className="text-ink-2 underline underline-offset-2">
                System status
              </a>
              .
            </p>
          </div>
        </Panel>

        <Panel>
          <PanelHeader title="Deployment status" description="What this installation is set up to do. These are set on the server by whoever runs it, not from this page." />
          <ul>
            {checks.map((c) => (
              <li key={c.name} className="flex items-start gap-4 border-b border-line px-4 py-3 last:border-b-0">
                <div className="w-44 shrink-0 text-[13px] font-medium text-ink">{c.name}</div>
                <p className="min-w-0 flex-1 text-[13px] text-ink-2">{c.detail}</p>
                <Badge tone={c.configured ? 'pass' : 'neutral'}>{c.status}</Badge>
              </li>
            ))}
          </ul>
        </Panel>

        <section id="demo" className="scroll-mt-7">
          <DemoWorkspaceCard hasDemo={hasDemo} inDemo={ctx.isDemo} />
        </section>
      </div>
    </>
  );
}
