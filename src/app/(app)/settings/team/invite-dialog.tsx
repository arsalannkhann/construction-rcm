'use client';

import { MailCheck, MailX, UserPlus } from 'lucide-react';
import { useState } from 'react';
import { CopyField } from '@/components/settings/copy-field';
import { Notice } from '@/components/settings/notice';
import { Button } from '@/components/ui/button';
import { Field, Input } from '@/components/ui/form';
import { Dialog } from '@/components/ui/overlay';
import { useAction } from '@/lib/use-action';
import { cn } from '@/lib/utils';
import { ROLE_DESCRIPTION, ROLE_LABEL } from '@/server/auth/permissions';
import type { Role } from '@/server/types';
import { inviteAction } from './actions';

type Outcome = { to: string; link: string; email: 'sent' | 'not_sent' | 'failed' | 'unconfirmed'; detail: string | null };

/**
 * `roles` are the roles this person may grant, most senior first.
 * `emailConfigured` only sets expectations up front; what is reported afterwards is the actual delivery outcome.
 */
export function InviteDialogButton({ roles, emailConfigured }: { roles: Role[]; emailConfigured: boolean }) {
  const leastPrivileged = roles[roles.length - 1] ?? 'viewer';
  const [open, setOpen] = useState(false);
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<Role>(leastPrivileged);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const { pending, run } = useAction();

  const reset = () => {
    setEmail('');
    setRole(leastPrivileged);
    setOutcome(null);
  };
  const submit = () => {
    const to = email.trim();
    if (!to || pending) return;
    run(() => inviteAction({ email: to, role }), { onSuccess: (data) => setOutcome({ ...data, to }) });
  };

  return (
    <>
      <Button
        variant="primary"
        onClick={() => {
          reset();
          setOpen(true);
        }}
      >
        <UserPlus className="size-3.5" strokeWidth={1.9} />
        Invite teammate
      </Button>
      <Dialog
        open={open}
        onOpenChange={setOpen}
        title={outcome ? 'Invitation created' : 'Invite teammate'}
        description={outcome ? undefined : 'They join this organisation with the role you choose. You can change it later.'}
        footer={
          outcome ? (
            <>
              <Button variant="ghost" onClick={reset}>
                Invite another
              </Button>
              <Button variant="primary" onClick={() => setOpen(false)}>
                Done
              </Button>
            </>
          ) : (
            <>
              <Button variant="ghost" onClick={() => setOpen(false)}>
                Cancel
              </Button>
              <Button variant="primary" loading={pending} onClick={submit} disabled={!email.trim()}>
                {emailConfigured ? 'Send invitation' : 'Create invitation link'}
              </Button>
            </>
          )
        }
      >
        {outcome ? (
          <div className="space-y-4">
            {outcome.email === 'sent' ? (
              <Notice tone="pass" icon={<MailCheck strokeWidth={1.9} />}>
                Invitation emailed to {outcome.to}.
              </Notice>
            ) : outcome.email === 'unconfirmed' ? (
              <Notice tone="warn" icon={<MailX strokeWidth={1.9} />}>
                The email provider did not confirm the invitation to {outcome.to}; it may or may not have arrived. Send this link to {outcome.to} yourself to be sure.
              </Notice>
            ) : outcome.email === 'failed' ? (
              <Notice tone="block" icon={<MailX strokeWidth={1.9} />}>
                The invitation email to {outcome.to} was not sent{outcome.detail ? `: ${outcome.detail.replace(/\.$/, '')}` : ''}. Send this link to {outcome.to} yourself.
              </Notice>
            ) : (
              <Notice tone="warn" icon={<MailX strokeWidth={1.9} />}>
                Email delivery is not configured — send this link to {outcome.to} yourself.
              </Notice>
            )}
            <div>
              <div className="mb-1 text-xs font-medium text-ink-2">Invitation link</div>
              <CopyField value={outcome.link} label="Invitation link" />
              <p className="mt-1.5 text-xs text-ink-3">
                This link is shown only once, and it can be used once. If it is lost, revoke the invitation under Pending invitations and invite {outcome.to} again.
              </p>
            </div>
          </div>
        ) : (
          <form
            className="space-y-4"
            onSubmit={(e) => {
              e.preventDefault();
              submit();
            }}
          >
            <Field label="Work email" hint={emailConfigured ? 'The invitation is emailed to this address.' : 'Email delivery is not configured on this deployment, so nothing is emailed. You will get a link to pass on yourself.'}>
              <Input type="email" autoFocus required autoComplete="off" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="name@company.com" />
            </Field>
            <fieldset>
              <legend className="mb-1 text-xs font-medium text-ink-2">Role</legend>
              <div className="overflow-hidden rounded-md border border-line-strong">
                {roles.map((r) => (
                  <label key={r} className={cn('flex cursor-pointer items-start gap-2.5 border-b border-line px-3 py-2 last:border-b-0', role === r ? 'bg-accent-soft/60' : 'hover:bg-canvas/70')}>
                    <input type="radio" name="invite-role" value={r} checked={role === r} onChange={() => setRole(r)} className="mt-[3px] size-3.5 shrink-0 accent-ink" />
                    <span className="min-w-0">
                      <span className="block text-[13px] font-medium text-ink">{ROLE_LABEL[r]}</span>
                      <span className="block text-xs text-ink-3">{ROLE_DESCRIPTION[r]}</span>
                    </span>
                  </label>
                ))}
              </div>
            </fieldset>
            <button type="submit" hidden />
          </form>
        )}
      </Dialog>
    </>
  );
}
