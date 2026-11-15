'use client';

import { HandCoins, Plus } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Badge, EmptyState, Money, Panel, PanelHeader, Table, Td, Th } from '@/components/ui/data';
import { Field, Input, MoneyInput, Textarea } from '@/components/ui/form';
import { Dialog } from '@/components/ui/overlay';
import { formatMoney } from '@/lib/money';
import { useAction } from '@/lib/use-action';
import { formatDate } from '@/lib/utils';
import { createRetainageReleaseAction, voidRetainageReleaseAction } from '../actions';

type Release = {
  id: string;
  amount: number;
  effectiveOn: string;
  note: string | null;
  status: string;
  createdAt: string;
  createdByName: string | null;
  voidedByName: string | null;
  voidedAt: string | null;
  countedIn: { id: string; applicationNumber: number | null } | null;
};

/**
 * Retainage terms and releases on one contract. A release is a decision to pay
 * out withheld money, so only approvers record or cancel one; it changes what
 * the next application is verified against, and nothing is paid from here.
 */
export function RetainagePanel({
  contractId,
  terms,
  held,
  hasApproval,
  pending,
  releases,
  canApprove,
}: {
  contractId: string;
  terms: string;
  held: number;
  hasApproval: boolean;
  pending: number;
  releases: Release[];
  canApprove: boolean;
}) {
  const [recording, setRecording] = useState(false);
  const [cancelling, setCancelling] = useState<Release | null>(null);
  const available = Math.max(held - pending, 0);

  return (
    <Panel className="overflow-hidden">
      <PanelHeader
        title="Retainage"
        description={`Withheld at ${terms}.`}
        actions={
          canApprove && releases.length > 0 ? (
            <Button size="sm" onClick={() => setRecording(true)}>
              <Plus className="size-3.5" />
              Record a release
            </Button>
          ) : null
        }
      />
      <dl className="grid grid-cols-3 gap-px border-b border-line bg-line text-xs">
        <Cell label={hasApproval ? 'Held after the last approved application' : 'Held'}>
          <Money cents={held} />
        </Cell>
        <Cell label="Recorded for release, not yet billed">
          <Money cents={pending} />
        </Cell>
        <Cell label="Still available to release">
          <Money cents={available} />
        </Cell>
      </dl>

      {releases.length === 0 ? (
        <EmptyState
          icon={<HandCoins />}
          title="No retainage released"
          description="When retainage is to be paid out (at substantial completion, or a partial release the owner agreed), record it here first. The application that bills it is then checked against the release instead of being flagged for withholding too little."
          action={
            canApprove ? (
              <Button variant="primary" onClick={() => setRecording(true)} disabled={held <= 0}>
                <Plus className="size-3.5" />
                Record a release
              </Button>
            ) : (
              <span className="text-xs text-ink-3">Owners, admins and controllers can record a release.</span>
            )
          }
        />
      ) : (
        <Table>
          <thead>
            <tr>
              <Th className="pl-4">Effective</Th>
              <Th align="right">Amount</Th>
              <Th>Authorised by</Th>
              <Th>Status</Th>
              <Th className="pr-4" />
            </tr>
          </thead>
          <tbody className="[&_tr:last-child>td]:border-b-0">
            {releases.map((r) => (
              <tr key={r.id} className={r.status === 'void' ? 'text-ink-3' : undefined}>
                <Td className="whitespace-nowrap pl-4">{formatDate(r.effectiveOn)}</Td>
                <Td align="right">
                  <Money cents={r.amount} className={r.status === 'void' ? 'line-through' : undefined} />
                </Td>
                <Td>
                  <div className="max-w-[340px] text-ink-2">{r.note}</div>
                  <div className="text-[11px] text-ink-3">
                    Recorded{r.createdByName ? ` by ${r.createdByName}` : ''} on {formatDate(r.createdAt.slice(0, 10))}
                    {r.status === 'void' ? ` · cancelled${r.voidedByName ? ` by ${r.voidedByName}` : ''}${r.voidedAt ? ` on ${formatDate(r.voidedAt.slice(0, 10))}` : ''}` : ''}
                  </div>
                </Td>
                <Td>
                  {r.status === 'void' ? (
                    <Badge>Cancelled</Badge>
                  ) : r.countedIn ? (
                    <Link href={`/applications/${r.countedIn.id}`} className="hover:underline">
                      <Badge tone="pass">Billed in #{r.countedIn.applicationNumber ?? '?'}</Badge>
                    </Link>
                  ) : (
                    <Badge tone="warn">Not yet billed</Badge>
                  )}
                </Td>
                <Td align="right" className="pr-4">
                  {canApprove && r.status !== 'void' && !r.countedIn ? (
                    <Button size="sm" variant="ghost" onClick={() => setCancelling(r)}>
                      Cancel…
                    </Button>
                  ) : null}
                </Td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}

      <RecordDialog open={recording} onClose={() => setRecording(false)} contractId={contractId} available={available} />
      <CancelDialog release={cancelling} onClose={() => setCancelling(null)} />
    </Panel>
  );
}

function Cell({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="bg-surface px-4 py-2.5">
      <dt className="text-[10.5px] uppercase tracking-wide text-ink-3">{label}</dt>
      <dd className="mt-0.5 text-[13px] font-medium">{children}</dd>
    </div>
  );
}

function RecordDialog({ open, onClose, contractId, available }: { open: boolean; onClose: () => void; contractId: string; available: number }) {
  const [amount, setAmount] = useState<number | null>(null);
  const [effectiveOn, setEffectiveOn] = useState('');
  const [note, setNote] = useState('');
  const { pending, run } = useAction();
  const tooMuch = amount !== null && amount > available;
  const complete = amount !== null && amount > 0 && !tooMuch && !!effectiveOn && note.trim().length >= 5;

  const reset = () => {
    setAmount(null);
    setEffectiveOn('');
    setNote('');
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) onClose();
        else reset();
      }}
      title="Record a retainage release"
      description="From the effective date, applications on this contract are verified with this much less retainage held. Nothing is paid from this system."
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            loading={pending}
            disabled={!complete}
            onClick={() =>
              amount !== null &&
              run(() => createRetainageReleaseAction(contractId, { amount, effectiveOn, note }), {
                success: `Release of ${formatMoney(amount)} recorded`,
                onSuccess: () => {
                  reset();
                  onClose();
                },
              })
            }
          >
            Record release
          </Button>
        </>
      }
    >
      <div className="grid grid-cols-2 gap-4">
        <Field label="Amount to release" error={tooMuch ? `Only ${formatMoney(available)} is available to release.` : undefined} hint={tooMuch ? undefined : `${formatMoney(available)} available.`}>
          <MoneyInput value={amount} onChange={setAmount} allowBlank />
        </Field>
        <Field label="Effective from" hint="The first billing period it can be billed in.">
          <Input type="date" value={effectiveOn} onChange={(e) => setEffectiveOn(e.target.value)} />
        </Field>
        <Field label="Who authorised it, and why" className="col-span-2">
          <Textarea value={note} onChange={(e) => setNote(e.target.value)} placeholder="For example: 50% release at substantial completion, approved by the owner on 3 November (letter on file)." className="min-h-16" />
        </Field>
      </div>
    </Dialog>
  );
}

function CancelDialog({ release, onClose }: { release: Release | null; onClose: () => void }) {
  const [reason, setReason] = useState('');
  const { pending, run } = useAction();
  return (
    <Dialog
      open={release !== null}
      onOpenChange={(o) => {
        if (!o) onClose();
        else setReason('');
      }}
      title="Cancel this release?"
      description={release ? `The release of ${formatMoney(release.amount)} effective ${formatDate(release.effectiveOn)} stays on the record, marked cancelled. Undecided applications on this contract are checked again without it.` : ''}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Keep it
          </Button>
          <Button
            variant="danger"
            loading={pending}
            disabled={reason.trim().length < 5}
            onClick={() =>
              release &&
              run(() => voidRetainageReleaseAction(release.id, reason), {
                success: 'Release cancelled',
                onSuccess: () => {
                  setReason('');
                  onClose();
                },
              })
            }
          >
            Cancel release
          </Button>
        </>
      }
    >
      <Field label="Reason">
        <Textarea autoFocus value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Why is the release no longer going ahead?" />
      </Field>
    </Dialog>
  );
}
