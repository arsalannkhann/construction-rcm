'use client';

import { Link2, Mail } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { CopyField } from '@/components/settings/copy-field';
import { Button } from '@/components/ui/button';
import { Badge, Panel, PanelHeader } from '@/components/ui/data';
import { Checkbox, Field, Input } from '@/components/ui/form';
import { Dialog } from '@/components/ui/overlay';
import { useAction } from '@/lib/use-action';
import { formatDateTime, formatMonth } from '@/lib/utils';
import { createPortalLinkAction, emailPortalLinkAction, revokePortalLinkAction, updatePortalLinkAction } from '../actions';

export type PortalPanelData = {
  link: { id: string; url: string | null; email: string | null; reminders: boolean; createdAt: string; createdByName: string | null; lastUsedAt: string | null } | null;
  emails: Array<{ id: string; kind: 'link' | 'due_soon' | 'overdue'; period: string | null; toEmail: string; status: string; error: string | null; createdAt: string; createdByName: string | null }>;
  dueDay: number;
  emailConfigured: boolean;
  canManage: boolean;
  contactEmail: string | null;
  contractOpen: boolean;
};

const KIND: Record<PortalPanelData['emails'][number]['kind'], string> = { link: 'The link', due_soon: 'Due-date reminder', overdue: 'Overdue reminder' };
const STATUS: Record<string, { label: string; tone: 'pass' | 'warn' | 'block' | 'neutral' }> = {
  sent: { label: 'Sent', tone: 'pass' },
  sending: { label: 'Not confirmed', tone: 'warn' },
  unconfirmed: { label: 'Not confirmed', tone: 'warn' },
  failed: { label: 'Failed', tone: 'block' },
  not_sent: { label: 'Not sent', tone: 'neutral' },
};

const ordinal = (n: number) => `${n}${n % 10 === 1 && n !== 11 ? 'st' : n % 10 === 2 && n !== 12 ? 'nd' : n % 10 === 3 && n !== 13 ? 'rd' : 'th'}`;

/**
 * The subcontractor's portal link for this subcontract: make it, copy it, email
 * it, say where reminders go, replace or turn it off. Only members who review
 * applications see the link itself.
 */
export function PortalPanel({ contractId, data, subcontractorName }: { contractId: string; data: PortalPanelData; subcontractorName: string }) {
  const { link, emails, canManage, emailConfigured, dueDay } = data;
  const { pending, run } = useAction();
  const [email, setEmail] = useState(data.contactEmail ?? '');
  const [editing, setEditing] = useState(false);
  const [editEmail, setEditEmail] = useState(link?.email ?? '');
  const [editReminders, setEditReminders] = useState(link?.reminders ?? true);
  const [confirm, setConfirm] = useState<'replace' | 'revoke' | null>(null);
  const who = subcontractorName.replace(/\.$/, '');

  return (
    <Panel className="overflow-hidden">
      <PanelHeader title="Subcontractor portal" description={`A link ${who} uses to send billing for this subcontract and see where it stands, without an account.`} />
      {/* Called, not rendered as components: an inner component would remount on every keystroke and lose the field's focus. */}
      <div className="space-y-4 p-4">{link ? linkBody() : noLink()}</div>

      {emails.length > 0 ? (
        <div className="border-t border-line">
          <p className="px-4 pb-1 pt-3 text-xs font-medium text-ink-2">Emails about the portal</p>
          <ul className="divide-y divide-line">
            {emails.map((e) => {
              const st = STATUS[e.status] ?? { label: e.status, tone: 'neutral' as const };
              return (
                <li key={e.id} className="flex flex-wrap items-start justify-between gap-x-4 gap-y-1 px-4 py-2.5">
                  <div className="min-w-0 text-[13px]">
                    <p className="text-ink">
                      {KIND[e.kind]}
                      {e.period ? ` for ${formatMonth(e.period)}` : ''} <span className="text-ink-3">to {e.toEmail}</span>
                    </p>
                    <p className="text-xs text-ink-3">
                      {formatDateTime(e.createdAt)} · {e.createdByName ? `by ${e.createdByName}` : 'sent automatically'}
                    </p>
                    {e.error ? <p className="mt-0.5 text-xs text-block">{e.error}</p> : null}
                  </div>
                  <Badge tone={st.tone}>{st.label}</Badge>
                </li>
              );
            })}
          </ul>
        </div>
      ) : null}

      <Dialog
        open={editing}
        onOpenChange={setEditing}
        title="Reminders"
        description={`Reminders go out when this subcontract has nothing in for the month: once in the five days before the ${ordinal(dueDay)} and once after it.`}
        footer={
          <>
            <Button variant="ghost" onClick={() => setEditing(false)} disabled={pending}>
              Cancel
            </Button>
            <Button
              variant="primary"
              loading={pending}
              onClick={() => link && run(() => updatePortalLinkAction(link.id, { email: editEmail, reminders: editReminders }), { success: 'Saved', onSuccess: () => setEditing(false) })}
            >
              Save
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          <Field label="Send reminders and the link to" hint="Usually the person who prepares their billing.">
            <Input type="email" value={editEmail} onChange={(e) => setEditEmail(e.target.value)} placeholder="billing@subcontractor.com" />
          </Field>
          <Checkbox checked={editReminders} onChange={(e) => setEditReminders(e.target.checked)} label="Email reminders when a month’s billing is due" />
        </div>
      </Dialog>

      <Dialog
        open={confirm !== null}
        onOpenChange={(o) => !o && setConfirm(null)}
        title={confirm === 'replace' ? 'Replace the link?' : 'Turn the link off?'}
        description={
          confirm === 'replace'
            ? `The current link stops working at once and a new one is made. Send the new one to ${who}. Use this if the link reached someone it should not have.`
            : `The link stops working at once. Everything already sent through it stays on record. You can make a new link later.`
        }
        size="sm"
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirm(null)} disabled={pending}>
              Cancel
            </Button>
            <Button
              variant="danger"
              loading={pending}
              onClick={() =>
                link &&
                run(() => (confirm === 'replace' ? createPortalLinkAction(contractId, link.email ?? '') : revokePortalLinkAction(link.id)), {
                  success: confirm === 'replace' ? 'New link made; the old one no longer works' : 'Link turned off',
                  onSuccess: () => setConfirm(null),
                })
              }
            >
              {confirm === 'replace' ? 'Replace link' : 'Turn off'}
            </Button>
          </>
        }
      />
    </Panel>
  );

  function noLink() {
    if (!data.contractOpen) return <p className="text-[13px] text-ink-3">This subcontract is closed, so it has no portal link.</p>;
    if (!canManage) return <p className="text-[13px] text-ink-3">No link yet. Someone who reviews applications can make one.</p>;
    return (
      <div className="space-y-3">
        <p className="max-w-2xl text-[13px] text-ink-2">
          {who} uploads each month’s application and lien waivers through the link, already matched to this subcontract, and sees whether each one was received, is in review, is waiting on them (with your message) or was approved. They see nothing
          else of yours.
        </p>
        <div className="flex flex-wrap items-end gap-2">
          <Field label="Reminders and the link go to" optional className="w-full max-w-xs">
            <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="billing@subcontractor.com" />
          </Field>
          <Button variant="primary" loading={pending} onClick={() => run(() => createPortalLinkAction(contractId, email), { success: 'Portal link made' })}>
            <Link2 className="size-3.5" />
            Make a portal link
          </Button>
        </div>
      </div>
    );
  }

  function linkBody() {
    if (!link) return null;
    return (
      <>
        {canManage ? (
          link.url ? (
            <CopyField value={link.url} label="Portal link" />
          ) : (
            <p className="text-[13px] text-warn">This link can no longer be shown (the server’s encryption key changed). Replace it to make a new one.</p>
          )
        ) : (
          <p className="text-[13px] text-ink-2">A portal link is live. Someone who reviews applications can copy it.</p>
        )}

        <dl className="grid gap-x-6 gap-y-3 text-[13px] sm:grid-cols-3">
          <div>
            <dt className="text-xs text-ink-3">Reminders</dt>
            <dd className="mt-0.5 text-ink">{!link.reminders ? 'Off' : link.email ? `On, to ${link.email}` : 'On, but no address to send to'}</dd>
          </div>
          <div>
            <dt className="text-xs text-ink-3">Billing due</dt>
            <dd className="mt-0.5 text-ink">The {ordinal(dueDay)} of each month</dd>
          </div>
          <div>
            <dt className="text-xs text-ink-3">Last used</dt>
            <dd className="mt-0.5 text-ink">{link.lastUsedAt ? formatDateTime(link.lastUsedAt) : 'Not used yet'}</dd>
          </div>
        </dl>

        {!emailConfigured ? (
          <p className="rounded-md border border-warn-line bg-warn-soft px-3 py-2 text-[13px] text-warn">Email delivery is not set up on this deployment, so no reminders or emails go out. Copy the link and send it yourself.</p>
        ) : null}
        {!data.contractOpen ? <p className="text-[13px] text-ink-3">This subcontract is closed: the link shows its history but takes no new billing, and no reminders go out.</p> : null}

        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-xs text-ink-3">
            Made {formatDateTime(link.createdAt)}
            {link.createdByName ? ` by ${link.createdByName}` : ''}
          </p>
          {canManage ? (
            <div className="flex flex-wrap items-center gap-2">
              <Button
                size="sm"
                disabled={pending || !emailConfigured || !link.email}
                onClick={() =>
                  run(() => emailPortalLinkAction(link.id), {
                    onSuccess: (r) => {
                      if (r.status === 'sent') toast.success(`Link emailed to ${link.email}`);
                      else toast.error(r.detail ?? 'The email did not go out.');
                    },
                  })
                }
              >
                <Mail className="size-3.5" />
                Email the link
              </Button>
              <Button
                size="sm"
                disabled={pending}
                onClick={() => {
                  setEditEmail(link.email ?? '');
                  setEditReminders(link.reminders);
                  setEditing(true);
                }}
              >
                Reminders…
              </Button>
              {data.contractOpen ? (
                <Button size="sm" disabled={pending} onClick={() => setConfirm('replace')}>
                  Replace
                </Button>
              ) : null}
              <Button size="sm" variant="danger-outline" disabled={pending} onClick={() => setConfirm('revoke')}>
                Turn off
              </Button>
            </div>
          ) : null}
        </div>
      </>
    );
  }
}
