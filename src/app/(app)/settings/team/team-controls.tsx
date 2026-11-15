'use client';

import { MoreHorizontal, UserCheck, UserX } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Select } from '@/components/ui/form';
import { Dialog, Menu, MenuItem } from '@/components/ui/overlay';
import { useAction } from '@/lib/use-action';
import { ROLE_LABEL } from '@/server/auth/permissions';
import type { Role } from '@/server/types';
import { changeRoleAction, revokeInvitationAction, setMemberActiveAction } from './actions';

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

export function MemberMenu({ userId, name, active, orgName }: { userId: string; name: string; active: boolean; orgName: string }) {
  const [confirming, setConfirming] = useState(false);
  const { pending, run } = useAction();

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
          // Opened on the next tick, once the menu has closed, so the two overlays never fight over focus.
          <MenuItem danger icon={<UserX />} onSelect={() => window.setTimeout(() => setConfirming(true), 0)}>
            Deactivate…
          </MenuItem>
        ) : (
          <MenuItem icon={<UserCheck />} onSelect={() => run(() => setMemberActiveAction(userId, true), { success: `${name} reactivated` })}>
            Reactivate
          </MenuItem>
        )}
      </Menu>
      <Dialog
        open={confirming}
        onOpenChange={setConfirming}
        size="sm"
        title={`Deactivate ${name}?`}
        description={`They are signed out of ${orgName} straight away and can no longer open it. Open applications assigned to them become unassigned. Nothing they did is removed from the record, and you can reactivate them later.`}
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirming(false)}>
              Cancel
            </Button>
            <Button variant="danger" loading={pending} onClick={() => run(() => setMemberActiveAction(userId, false), { success: `${name} deactivated`, onSuccess: () => setConfirming(false) })}>
              Deactivate
            </Button>
          </>
        }
      />
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
