import { PageHeader, Panel, PanelHeader, Stat } from '@/components/ui/data';
import { ROLE_LABEL } from '@/server/auth/permissions';
import { requireCtx, requireUser } from '@/server/auth/session';
import { NameForm, PasswordForm } from './profile-forms';

export const metadata = { title: 'Profile' };

export default async function ProfileSettingsPage() {
  const user = await requireUser();
  const ctx = await requireCtx();

  return (
    <>
      <PageHeader title="Profile" description="Your own account. These settings follow you across every organisation you belong to." />
      <div className="space-y-6">
        <Panel>
          <PanelHeader title="Your details" />
          <div className="px-4 py-4">
            <NameForm key={user.name} name={user.name} />
          </div>
          <dl className="flex gap-12 border-t border-line px-4 py-3">
            <Stat label="Sign-in email">{user.email}</Stat>
            <Stat label={`Role in ${ctx.orgName}`}>{ROLE_LABEL[ctx.role]}</Stat>
          </dl>
        </Panel>

        <Panel>
          <PanelHeader title="Password" description="Changing your password signs out every other session on your account, on this and any other device." />
          <div className="px-4 py-4">
            <PasswordForm email={user.email} />
          </div>
        </Panel>
      </div>
    </>
  );
}
