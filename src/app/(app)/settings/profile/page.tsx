import { ShieldCheck, ShieldOff } from 'lucide-react';
import { getDb } from '@/db';
import { Notice } from '@/components/settings/notice';
import { Badge, PageHeader, Panel, PanelHeader, Stat, Table, Td, Th } from '@/components/ui/data';
import { formatDateTime, formatRelative, pluralize } from '@/lib/utils';
import { getMfaStatus } from '@/server/auth/mfa';
import { ROLE_LABEL } from '@/server/auth/permissions';
import { requireCtx, requireUser, sessionToken } from '@/server/auth/session';
import { listMyOrganizations, listSessions, SESSION_DAYS, SESSION_IDLE_DAYS } from '@/server/services/team';
import { NameForm, PasswordForm } from './profile-forms';
import { ManageMfa, RevokeOtherSessionsButton, RevokeSessionButton, SetUpMfaButton } from './security-controls';

export const metadata = { title: 'Profile' };

export default async function ProfileSettingsPage() {
  const user = await requireUser();
  const ctx = await requireCtx();
  const db = await getDb();
  const mfa = await getMfaStatus(db, user.id);
  const devices = await listSessions(db, user.id, await sessionToken());
  const requiredBy = (await listMyOrganizations(db, user.id)).filter((o) => o.requiresMfa).map((o) => o.name);
  const others = devices.filter((d) => !d.current).length;
  const now = new Date();

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
            <PasswordForm email={user.email} name={user.name} />
          </div>
        </Panel>

        <Panel id="two-step">
          <PanelHeader
            title="Two-step verification"
            description="After your password, signing in also asks for a code from an app on your phone, so a stolen password alone does not get into your account."
            actions={mfa.enabled ? <Badge tone="pass">On</Badge> : <Badge tone="neutral">Off</Badge>}
          />
          <div className="space-y-4 px-4 py-4">
            {mfa.enabled ? (
              <>
                <div className="flex items-start gap-2.5 text-[13px] text-ink-2">
                  <ShieldCheck className="mt-0.5 size-4 shrink-0 text-pass" strokeWidth={1.9} />
                  <p>
                    On since {formatDateTime(mfa.enabledAt)}. You have {pluralize(mfa.recoveryCodesLeft, 'unused recovery code')}.
                  </p>
                </div>
                {mfa.recoveryCodesLeft <= 3 ? (
                  <Notice tone="warn">
                    {mfa.recoveryCodesLeft === 0 ? 'You have no recovery codes left.' : `Only ${pluralize(mfa.recoveryCodesLeft, 'recovery code')} left.`} Replace them, so you can still sign in if you lose your phone.
                  </Notice>
                ) : null}
                <ManageMfa email={user.email} requiredBy={requiredBy} />
              </>
            ) : (
              <>
                {requiredBy.length > 0 ? <Notice tone="warn">{requiredBy.join(', ')} {requiredBy.length === 1 ? 'requires' : 'require'} two-step verification for every member.</Notice> : null}
                <div className="flex items-start gap-2.5 text-[13px] text-ink-2">
                  <ShieldOff className="mt-0.5 size-4 shrink-0 text-ink-3" strokeWidth={1.9} />
                  <p>Off. Anyone who has your password can sign in as you.</p>
                </div>
                <SetUpMfaButton />
              </>
            )}
          </div>
        </Panel>

        <Panel>
          <PanelHeader
            title="Signed-in devices"
            description={`Every browser where your account is signed in right now. A session ends when you sign out${SESSION_IDLE_DAYS < SESSION_DAYS ? `, after ${pluralize(SESSION_IDLE_DAYS, 'day')} without use,` : ''} or ${pluralize(SESSION_DAYS, 'day')} after signing in, whichever comes first.`}
            actions={others > 0 ? <RevokeOtherSessionsButton count={others} /> : null}
          />
          <Table>
            <thead>
              <tr>
                <Th className="pl-4">Device</Th>
                <Th>Address</Th>
                <Th>Organisation</Th>
                <Th>Signed in</Th>
                <Th>Last active</Th>
                <Th className="w-24" />
              </tr>
            </thead>
            <tbody>
              {devices.map((d) => (
                <tr key={d.id} className="hover:bg-canvas/60">
                  <Td className="pl-4">
                    <span className="flex items-center gap-2">
                      <span className="font-medium">{d.device}</span>
                      {d.current ? <Badge tone="accent">This device</Badge> : null}
                    </span>
                  </Td>
                  <Td className="num text-ink-2">{d.ipAddress ?? <span className="text-ink-4">Unknown</span>}</Td>
                  <Td className="text-ink-2">{d.organization ?? <span className="text-ink-4">—</span>}</Td>
                  <Td className="whitespace-nowrap text-ink-2">{formatDateTime(d.createdAt)}</Td>
                  <Td className="whitespace-nowrap text-ink-2">
                    <span title={formatDateTime(d.lastSeenAt)}>{d.current ? 'Now' : formatRelative(d.lastSeenAt, now)}</span>
                  </Td>
                  <Td className="pr-3 text-right">{d.current ? null : <RevokeSessionButton id={d.id} device={d.device} />}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
          <p className="px-4 py-2.5 text-xs text-ink-3">
            Device names and addresses come from what each browser reports, so treat them as a guide. If you see one you do not recognise, sign it out and change your password.
          </p>
        </Panel>
      </div>
    </>
  );
}
