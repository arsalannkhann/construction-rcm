'use client';

import { KeyRound, MoreHorizontal, ShieldOff, UserCheck, UserX } from 'lucide-react';
import { useState } from 'react';
import { CopyField } from '@/components/settings/copy-field';
import { Notice } from '@/components/settings/notice';
import { Button } from '@/components/ui/button';
import { Select } from '@/components/ui/form';
import { Dialog, Menu, MenuItem, MenuSeparator } from '@/components/ui/overlay';
import { useAction } from '@/lib/use-action';
import { formatDateTime } from '@/lib/utils';
import { ROLE_LABEL } from '@/server/auth/permissions';
import type { Role } from '@/server/types';
import { changeRoleAction, issuePasswordResetAction, resetMemberMfaAction, revokeInvitationAction, setMemberActiveAction } from './actions';

/** Changes a member's role as soon as a different one is picked. `options` are the roles this person may grant. */
export function RoleSelect({ userId, name, role, options }: { userId: string; name: string; role: Role; options: Role[] }) {
  const { pending, run } = useAction();
  const [requested, setRequested] = useState<Role | null>(null);
  // Show the requested role while the change is in flight; afterwards show what the server says,
  // so a refused change visibly snaps back.
  const shown = pending && requested ? requested : role;
  const choices = options.includes(role) ? options : [role, ...options];

  return (
    <Select
      aria-label={`Role for ${name}`}
      className="h-7 w-44 text-xs"
      value={shown}
      disabled={pending}
      onChange={(e) => {
        const next = e.target.value as Role;
        if (next === role) return;
        setRequested(next);
        run(() => changeRoleAction(userId, next), { success: `${name} is now ${ROLE_LABEL[next]}` });
      }}
    >
      {choices.map((r) => (
        <option key={r} value={r}>
          {ROLE_LABEL[r]}
        </option>
      ))}
    </Select>
  );
}

export function MemberMenu({ userId, name, active, mfaEnabled, orgName }: { userId: string; name: string; active: boolean; mfaEnabled: boolean; orgName: string }) {
  const [dialog, setDialog] = useState<'deactivate' | 'reset-link' | 'reset-mfa' | null>(null);
  const [issued, setIssued] = useState<{ link: string; expiresAt: string } | null>(null);
  const { pending, run } = useAction();
  // Opened on the next tick, once the menu has closed, so the two overlays never fight over focus.
  const open = (next: NonNullable<typeof dialog>) =>
    window.setTimeout(() => {
      setIssued(null);
      setDialog(next);
    }, 0);
  const close = () => {
    setDialog(null);
    // The link is shown once: it is dropped from memory as soon as the dialog closes.
    setIssued(null);
  };

  return (
    <>
      <Menu
        trigger={
          <Button variant="ghost" size="sm" className="px-1.5" aria-label={`Actions for ${name}`} disabled={pending}>
            <MoreHorizontal className="size-4" strokeWidth={1.9} />
          </Button>
        }
      >
        {active ? (
          <>
            <MenuItem icon={<KeyRound />} onSelect={() => open('reset-link')}>
              Create password reset link…
            </MenuItem>
            {mfaEnabled ? (
              <MenuItem icon={<ShieldOff />} onSelect={() => open('reset-mfa')}>
                Reset two-step verification…
              </MenuItem>
            ) : null}
            <MenuSeparator />
            <MenuItem danger icon={<UserX />} onSelect={() => open('deactivate')}>
              Deactivate…
            </MenuItem>
          </>
        ) : (
          <MenuItem icon={<UserCheck />} onSelect={() => run(() => setMemberActiveAction(userId, true), { success: `${name} reactivated` })}>
            Reactivate
          </MenuItem>
        )}
      </Menu>

      <Dialog
        open={dialog === 'deactivate'}
        onOpenChange={(next) => (next ? null : close())}
        size="sm"
        title={`Deactivate ${name}?`}
        description={`They are signed out of ${orgName} straight away and can no longer open it. Open applications assigned to them become unassigned. Nothing they did is removed from the record, and you can reactivate them later.`}
        footer={
          <>
            <Button variant="ghost" onClick={close}>
              Cancel
            </Button>
            <Button variant="danger" loading={pending} onClick={() => run(() => setMemberActiveAction(userId, false), { success: `${name} deactivated`, onSuccess: close })}>
              Deactivate
            </Button>
          </>
        }
      />

      <Dialog
        open={dialog === 'reset-link'}
        onOpenChange={(next) => (next ? null : close())}
        title={issued ? `Password reset link for ${name}` : `Create a password reset link for ${name}?`}
        description={
          issued
            ? undefined
            : `You get a one-time link that lets ${name} choose a new password. Give it to them yourself, in person or by a channel you trust. Any earlier link for them stops working. Their current password keeps working until they use it. This is recorded in the audit log and ${name} is notified.`
        }
        footer={
          issued ? (
            <Button variant="primary" onClick={close}>
              Done
            </Button>
          ) : (
            <>
              <Button variant="ghost" onClick={close}>
                Cancel
              </Button>
              <Button variant="primary" loading={pending} onClick={() => run(() => issuePasswordResetAction(userId), { refresh: false, onSuccess: setIssued })}>
                Create link
              </Button>
            </>
          )
        }
      >
        {issued ? (
          <div className="space-y-3 text-[13px] text-ink-2">
            <Notice tone="warn">This link is shown only now. Anyone who has it can set {name}&apos;s password, so send it only to them.</Notice>
            <CopyField value={issued.link} label="Password reset link" />
            <p>
              It works once, until {formatDateTime(new Date(issued.expiresAt))}. Setting a new password signs {name} out on every device. It does not turn off their two-step verification.
            </p>
          </div>
        ) : null}
      </Dialog>

      <Dialog
        open={dialog === 'reset-mfa'}
        onOpenChange={(next) => (next ? null : close())}
        size="sm"
        title={`Reset two-step verification for ${name}?`}
        description={`Use this when ${name} has lost their phone and their recovery codes. Their authenticator app and recovery codes stop working, and they are signed out on every device. They can then sign in with their password alone and set it up again. This is recorded in the audit log and ${name} is notified.`}
        footer={
          <>
            <Button variant="ghost" onClick={close}>
              Cancel
            </Button>
            <Button variant="danger" loading={pending} onClick={() => run(() => resetMemberMfaAction(userId), { success: `Two-step verification reset for ${name}`, onSuccess: close })}>
              Reset
            </Button>
          </>
        }
      >
        <p className="text-[13px] text-ink-2">Confirm with {name} that the request really comes from them, for example by calling them on a number you already have. Someone who has their password could otherwise get in.</p>
      </Dialog>
    </>
  );
}

export function RevokeInviteButton({ id, email }: { id: string; email: string }) {
  const { pending, run } = useAction();
  return (
    <Button variant="ghost" size="sm" loading={pending} aria-label={`Revoke the invitation for ${email}`} onClick={() => run(() => revokeInvitationAction(id), { success: `Invitation for ${email} revoked` })}>
      Revoke
    </Button>
  );
}
