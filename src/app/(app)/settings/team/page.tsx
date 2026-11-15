import { Mail } from 'lucide-react';
import { getDb } from '@/db';
import { PermissionNote } from '@/components/settings/permission-note';
import { Avatar, Badge, EmptyState, PageHeader, Panel, PanelHeader, Table, Td, Th } from '@/components/ui/data';
import { cn, formatDateTime, formatRelative, pluralize } from '@/lib/utils';
import { can, ROLE_DESCRIPTION, ROLE_LABEL } from '@/server/auth/permissions';
import { requireCtx } from '@/server/auth/session';
import { emailDeliveryConfigured } from '@/server/email';
import { listInvitations, listMembers } from '@/server/services/team';
import { ROLES, type Role } from '@/server/types';
import { InviteDialogButton } from './invite-dialog';
import { MemberMenu, RevokeInviteButton, RoleSelect } from './team-controls';

export const metadata = { title: 'Team' };

const isRole = (value: string): value is Role => (ROLES as readonly string[]).includes(value);
const roleLabel = (value: string) => (isRole(value) ? ROLE_LABEL[value] : value);

export default async function TeamSettingsPage() {
  const ctx = await requireCtx();
  const db = await getDb();
  const members = await listMembers(db, ctx);
  const invitations = await listInvitations(db, ctx);
  const now = new Date();

  // The controls offered below mirror what the team service will accept, so nobody is handed a
  // control that is then refused. The service remains the check.
  const canManage = can(ctx.role, 'team:manage');
  const isOwner = ctx.role === 'owner';
  const grantable = ROLES.filter((r) => r !== 'owner' || isOwner);
  const canActOn = (m: { userId: string; role: string }) => canManage && m.userId !== ctx.userId && (m.role !== 'owner' || isOwner);

  const active = members.filter((m) => m.status === 'active').length;
  const deactivated = members.length - active;
  const nameOf = new Map(members.map((m) => [m.userId, m.name]));

  return (
    <>
      <PageHeader
        title="Team"
        description={`Who can work in ${ctx.orgName}, and what each person is allowed to do.`}
        actions={canManage ? <InviteDialogButton roles={grantable} emailConfigured={emailDeliveryConfigured()} /> : null}
      />
      <div className="space-y-6">
        {canManage ? null : <PermissionNote role={ctx.role} permission="team:manage" action="invite people, change roles or deactivate members" />}

        <Panel>
          <PanelHeader title="Members" description={`${active} active${deactivated ? `, ${deactivated} deactivated` : ''}`} />
          <Table>
            <thead>
              <tr>
                <Th className="pl-4">Name</Th>
                <Th>Email</Th>
                <Th>Role</Th>
                <Th>Status</Th>
                <Th>Last sign-in</Th>
                <Th className="w-10" />
              </tr>
            </thead>
            <tbody>
              {members.map((m) => {
                const self = m.userId === ctx.userId;
                const isActive = m.status === 'active';
                const actionable = canActOn(m);
                return (
                  <tr key={m.userId} className="hover:bg-canvas/60">
                    <Td className="pl-4">
                      <span className="flex items-center gap-2">
                        <Avatar name={m.name} />
                        <span className={cn('font-medium', !isActive && 'text-ink-3')}>{m.name}</span>
                        {self ? <span className="text-xs text-ink-3">You</span> : null}
                      </span>
                    </Td>
                    <Td className="text-ink-2">{m.email}</Td>
                    <Td>
                      {actionable && isRole(m.role) ? (
                        <RoleSelect userId={m.userId} name={m.name} role={m.role} options={grantable} />
                      ) : (
                        <span className={cn(!isActive && 'text-ink-3')}>{roleLabel(m.role)}</span>
                      )}
                    </Td>
                    <Td>
                      <Badge tone={isActive ? 'pass' : 'neutral'}>{isActive ? 'Active' : 'Deactivated'}</Badge>
                    </Td>
                    <Td className="whitespace-nowrap text-ink-2">
                      {m.lastLoginAt ? <span title={formatDateTime(m.lastLoginAt)}>{formatRelative(m.lastLoginAt, now)}</span> : <span className="text-ink-4">Never</span>}
                    </Td>
                    <Td className="pr-3 text-right">{actionable ? <MemberMenu userId={m.userId} name={m.name} active={isActive} orgName={ctx.orgName} /> : null}</Td>
                  </tr>
                );
              })}
            </tbody>
          </Table>
          {canManage ? (
            <p className="px-4 py-2.5 text-xs text-ink-3">
              You cannot change your own role or deactivate yourself; another owner or admin has to.{isOwner ? '' : ' Only an owner can change or deactivate an owner.'}
            </p>
          ) : null}
        </Panel>

        <Panel>
          <PanelHeader title="Pending invitations" description="People who have been invited and have not joined yet. Each link works once, until the date shown." />
          {invitations.length === 0 ? (
            <EmptyState
              icon={<Mail />}
              title="No pending invitations"
              description={canManage ? 'Use Invite teammate to add someone. Their invitation is listed here until they join, it is revoked, or it expires.' : 'When someone is invited, their invitation is listed here until they join, it is revoked, or it expires.'}
              className="py-9"
            />
          ) : (
            <Table>
              <thead>
                <tr>
                  <Th className="pl-4">Email</Th>
                  <Th>Role</Th>
                  <Th>Invited by</Th>
                  <Th>Expires</Th>
                  <Th className="w-24" />
                </tr>
              </thead>
              <tbody>
                {invitations.map((inv) => {
                  const expired = inv.expiresAt < now;
                  return (
                    <tr key={inv.id} className="hover:bg-canvas/60">
                      <Td className="pl-4 font-medium">{inv.email}</Td>
                      <Td>{roleLabel(inv.role)}</Td>
                      <Td className="text-ink-2">{nameOf.get(inv.invitedBy) ?? '—'}</Td>
                      <Td className="whitespace-nowrap">
                        {expired ? (
                          <span className="flex items-center gap-2">
                            <Badge tone="warn">Expired</Badge>
                            <span className="text-ink-3">{formatDateTime(inv.expiresAt)}</span>
                          </span>
                        ) : (
                          <span className="text-ink-2">{formatDateTime(inv.expiresAt)}</span>
                        )}
                      </Td>
                      <Td className="pr-3 text-right">{canManage ? <RevokeInviteButton id={inv.id} email={inv.email} /> : null}</Td>
                    </tr>
                  );
                })}
              </tbody>
            </Table>
          )}
        </Panel>

        <Panel>
          <PanelHeader title="Roles" description="What each role can do. A person has one role in this organisation." />
          <dl>
            {ROLES.map((r) => (
              <div key={r} className="flex items-baseline gap-4 border-b border-line px-4 py-2.5 last:border-b-0">
                <dt className="w-44 shrink-0 text-[13px] font-medium text-ink">{ROLE_LABEL[r]}</dt>
                <dd className="min-w-0 flex-1 text-[13px] text-ink-2">{ROLE_DESCRIPTION[r]}</dd>
                <dd className="num shrink-0 text-xs text-ink-3">{pluralize(members.filter((m) => m.role === r && m.status === 'active').length, 'member')}</dd>
              </div>
            ))}
          </dl>
        </Panel>
      </div>
    </>
  );
}
