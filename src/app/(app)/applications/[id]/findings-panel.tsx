'use client';

import { Check, ChevronRight, CircleCheck, Info, LocateFixed, OctagonAlert, RotateCcw, Scale, TriangleAlert } from 'lucide-react';
import Link from '@/components/ui/link';
import { useState } from 'react';
import { Button, buttonClass } from '@/components/ui/button';
import { Badge, Money } from '@/components/ui/data';
import { Textarea } from '@/components/ui/form';
import { Dialog } from '@/components/ui/overlay';
import { formatDelta } from '@/lib/money';
import { useAction } from '@/lib/use-action';
import { cn, formatDate, formatRelative } from '@/lib/utils';
import type { ReviewData } from '@/server/services/queries';
import type { FindingCategory } from '@/server/types';
import { FINDING_CATEGORIES, FINDING_CATEGORY_LABEL } from '@/server/types';
import { SubcontractorDialogButton } from '../../subcontractors/subcontractor-dialog';
import { acceptFindingAction, adoptScheduleAction, confirmSignatureAction, reopenFindingAction, setOpeningBalancesAction, supersedeAction } from '../actions';
import { useWorkspace } from './workspace';

type Finding = ReviewData['findings'][number];

export function FindingsPanel() {
  const { data } = useWorkspace();
  const open = data.findings.filter((f) => f.status === 'open' && f.severity !== 'info');
  const notes = data.findings.filter((f) => f.status === 'open' && f.severity === 'info');
  const accepted = data.findings.filter((f) => f.status === 'accepted');
  const passed = data.findings.filter((f) => f.status === 'passed');
  const decided = ['approved', 'rejected', 'void'].includes(data.app.status);
  const approved = data.app.status === 'approved';
  const blocking = open.filter((f) => f.severity === 'blocking');
  const warnings = open.filter((f) => f.severity === 'warning');

  return (
    <div className="space-y-6 px-5 py-4">
      {data.replacedBy ? (
        <div className="flex items-start gap-3 rounded-lg border border-line bg-canvas/60 px-4 py-3 text-xs text-ink-2">
          <Info className="mt-0.5 size-4 shrink-0 text-ink-3" />
          <p>
            This submission was replaced by a corrected one received {formatDate(new Date(data.replacedBy.receivedAt).toISOString().slice(0, 10))} and is void.{' '}
            <Link href={`/applications/${data.replacedBy.id}`} className="font-medium text-accent hover:underline">
              Open the replacement
            </Link>
          </p>
        </div>
      ) : null}
      {data.replaces.length > 0 ? (
        <div className="flex items-start gap-3 rounded-lg border border-line bg-canvas/60 px-4 py-3 text-xs text-ink-2">
          <Info className="mt-0.5 size-4 shrink-0 text-ink-3" />
          <p>
            This submission replaced{' '}
            {data.replaces.map((r, i) => (
              <span key={r.id}>
                {i > 0 ? ', ' : ''}
                <Link href={`/applications/${r.id}`} className="font-medium text-accent hover:underline">
                  the one received {formatDate(new Date(r.receivedAt).toISOString().slice(0, 10))}
                </Link>
              </span>
            ))}
            , which {data.replaces.length === 1 ? 'was' : 'were'} voided.
          </p>
        </div>
      ) : null}
      {approved && open.length > 0 ? (
        <section>
          <SectionTitle>
            Acknowledged at approval
            <span className="ml-2 font-normal normal-case tracking-normal text-ink-3">
              {data.app.decidedBy ? (data.people[data.app.decidedBy] ?? 'The approver') : 'The approver'} confirmed these did not prevent payment
            </span>
          </SectionTitle>
          <ul className="space-y-2">
            {open.map((f) => (
              <li key={f.id} className="flex gap-2.5 rounded-lg border border-line px-3.5 py-2.5">
                <TriangleAlert className="mt-0.5 size-4 shrink-0 text-warn" />
                <div>
                  <p className="text-[13px] font-medium text-ink">{f.title}</p>
                  <p className="text-xs text-ink-2">{f.detail}</p>
                </div>
              </li>
            ))}
          </ul>
        </section>
      ) : open.length === 0 ? (
        <div className="flex items-start gap-3 rounded-lg border border-pass-line bg-pass-soft px-4 py-3">
          <CircleCheck className="mt-0.5 size-4 shrink-0 text-pass" />
          <div>
            <p className="text-[13px] font-medium text-pass">{decided ? 'No open findings.' : 'Nothing needs attention.'}</p>
            <p className="text-xs text-pass/85">
              {passed.length} check{passed.length === 1 ? '' : 's'} passed
              {accepted.length ? `, ${accepted.length} finding${accepted.length === 1 ? '' : 's'} accepted by a person` : ''}. The documents, the contract and the billing history agree.
            </p>
          </div>
        </div>
      ) : (
        <section>
          <SectionTitle>
            Needs attention
            <span className="ml-2 font-normal normal-case tracking-normal text-ink-3">
              {blocking.length ? `${blocking.length} must be resolved before approval` : ''}
              {blocking.length && warnings.length ? ' · ' : ''}
              {warnings.length ? `${warnings.length} to acknowledge` : ''}
            </span>
          </SectionTitle>
          <ul className="space-y-2.5">
            {[...blocking, ...warnings].map((f) => (
              <li key={f.id}>
                <FindingCard finding={f} />
              </li>
            ))}
          </ul>
        </section>
      )}

      {accepted.length > 0 ? (
        <section>
          <SectionTitle>Accepted by a person</SectionTitle>
          <ul className="space-y-2">
            {accepted.map((f) => (
              <li key={f.id}>
                <AcceptedRow finding={f} />
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {notes.length > 0 ? (
        <section>
          <SectionTitle>Notes</SectionTitle>
          <ul className="space-y-2">
            {notes.map((f) => (
              <li key={f.id} className="flex gap-2.5 rounded-lg border border-line px-3.5 py-2.5">
                <Info className="mt-0.5 size-4 shrink-0 text-ink-3" />
                <div>
                  <p className="text-[13px] font-medium text-ink">{f.title}</p>
                  <p className="text-xs text-ink-2">{f.detail}</p>
                </div>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <PassedChecks passed={passed} />
    </div>
  );
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return <h2 className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-ink-2">{children}</h2>;
}

function FindingCard({ finding: f }: { finding: Finding }) {
  const ws = useWorkspace();
  const { data, perms, editable } = ws;
  const { pending, run } = useAction();
  const [accepting, setAccepting] = useState(false);
  const [confirmBaseline, setConfirmBaseline] = useState(false);
  const blocking = f.severity === 'blocking';

  const spot =
    (f.refs?.field ? ws.spotForField(f.refs.field) : null) ??
    (f.refs?.lineId ? ws.spotForLine(f.refs.lineId) : null) ??
    (f.refs?.waiverId ? ws.spotForWaiver(f.refs.waiverId) : null) ??
    (f.refs?.documentId ? { documentId: f.refs.documentId, page: f.refs.page ?? 1 } : null);

  const mayAccept = f.needsQualifiedReview ? perms.signoff : blocking ? perms.approve : perms.review;
  const acceptLabel = f.needsQualifiedReview ? 'Sign off' : blocking ? 'Override' : 'Accept';
  const contractCodes = ['co.net_change', 'sov.unknown_line', 'sov.contract_total', 'contract.original_sum', 'sov.scheduled_value', 'ret.amount'];
  const hasNumbers = f.data && typeof f.data.expected === 'number' && typeof f.data.actual === 'number';

  return (
    <article className={cn('rounded-lg border bg-surface', blocking ? 'border-block-line' : 'border-warn-line')}>
      <div className={cn('flex items-start gap-2.5 rounded-t-lg px-3.5 py-2.5', blocking ? 'bg-block-soft/60' : 'bg-warn-soft/60')}>
        {blocking ? <OctagonAlert className="mt-0.5 size-4 shrink-0 text-block" /> : <TriangleAlert className="mt-0.5 size-4 shrink-0 text-warn" />}
        <div className="min-w-0 flex-1">
          <h3 className="text-[13px] font-semibold leading-5 text-ink">{f.title}</h3>
          <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[11px] text-ink-3">
            <span className={cn('font-medium', blocking ? 'text-block' : 'text-warn')}>{blocking ? 'Blocking' : 'Warning'}</span>
            <span>·</span>
            <span>{FINDING_CATEGORY_LABEL[f.category as FindingCategory] ?? f.category}</span>
            {f.needsQualifiedReview ? (
              <Badge tone="accent" className="ml-1 h-[18px]">
                <Scale className="size-3" /> Needs qualified review
              </Badge>
            ) : null}
          </div>
        </div>
      </div>

      <div className="space-y-2.5 px-3.5 py-3">
        <p className="text-[13px] leading-5 text-ink-2">{f.detail}</p>

        {hasNumbers ? (
          <dl className="grid grid-cols-3 gap-px overflow-hidden rounded-md border border-line bg-line text-xs">
            <Cell label="Expected">
              <Money cents={f.data!.expected} />
            </Cell>
            <Cell label="On the document">
              <Money cents={f.data!.actual} />
            </Cell>
            <Cell label="Difference">
              <span className="num font-medium text-block">{formatDelta(f.data!.delta ?? null)}</span>
            </Cell>
          </dl>
        ) : null}

        {f.action ? (
          <p className="text-xs leading-[18px] text-ink">
            <span className="font-medium">What to do: </span>
            {f.action}
          </p>
        ) : null}

        {f.code === 'seq.duplicate_number' && data.sameNumber.length > 0 ? <SameNumber /> : null}

        <div className="flex flex-wrap items-center gap-1.5 pt-0.5">
          {spot ? (
            <Button size="sm" onClick={() => ws.show(spot)}>
              <LocateFixed className="size-3.5" />
              Show in document
            </Button>
          ) : null}
          {f.refs?.lineId ? (
            <Button size="sm" onClick={() => ws.focusLine(f.refs!.lineId!)}>
              Go to line
            </Button>
          ) : f.refs?.tab === 'lines' ? (
            <Button size="sm" onClick={() => ws.setTab('lines')}>
              Open schedule
            </Button>
          ) : null}
          {f.refs?.waiverId || f.category === 'compliance' ? (
            <Button size="sm" onClick={() => ws.setTab('compliance')}>
              Open waiver
            </Button>
          ) : null}
          {f.refs?.field && f.category !== 'compliance' && f.refs.tab === 'summary' ? (
            <Button size="sm" onClick={() => ws.setTab('summary')}>
              Open summary
            </Button>
          ) : null}
          {contractCodes.includes(f.code) && data.contract ? (
            <Link href={`/contracts/${data.contract.id}`} className={buttonClass({ size: 'sm' })}>
              Open contract
            </Link>
          ) : null}

          {editable && f.code === 'doc.signature' ? (
            <Button size="sm" variant="primary" loading={pending} onClick={() => run(() => confirmSignatureAction(data.app.id, true), { success: 'Signature confirmed' })}>
              <Check className="size-3.5" />
              I can see the signature
            </Button>
          ) : null}
          {editable && f.code === 'sov.none_on_contract' && perms.records ? (
            <Button size="sm" variant="primary" loading={pending} onClick={() => run(() => adoptScheduleAction(data.app.id), { success: 'Schedule adopted for this contract' })}>
              Adopt this schedule
            </Button>
          ) : null}
          {editable && f.code === 'intake.sender' && perms.records && data.subcontractor ? (
            <SubcontractorDialogButton
              mode="edit"
              label="Update subcontractor contact"
              subcontractor={{ id: data.subcontractor.id, name: data.subcontractor.name, trade: data.subcontractor.trade, contactName: data.subcontractor.contactName, contactEmail: data.subcontractor.contactEmail, phone: data.subcontractor.phone, address: data.subcontractor.address }}
            />
          ) : null}
          {editable && f.code === 'prior.no_history' && perms.approve ? (
            <Button size="sm" variant="primary" onClick={() => setConfirmBaseline(true)}>
              Set opening balances…
            </Button>
          ) : null}

          <span className="flex-1" />
          {editable && f.code !== 'doc.signature' && f.code !== 'prior.no_history' ? (
            mayAccept ? (
              <Button size="sm" variant="ghost" onClick={() => setAccepting(true)}>
                {acceptLabel}…
              </Button>
            ) : (
              <span className="text-[11px] text-ink-3">{f.needsQualifiedReview || blocking ? 'A controller or admin can sign this off' : ''}</span>
            )
          ) : null}
        </div>
      </div>

      <AcceptDialog finding={f} open={accepting} onOpenChange={setAccepting} label={acceptLabel} />
      <Dialog
        open={confirmBaseline}
        onOpenChange={setConfirmBaseline}
        title="Set opening balances from this application?"
        description="Use this only for a contract that was already being billed before you started using Construction RCM."
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirmBaseline(false)}>
              Cancel
            </Button>
            <Button variant="primary" loading={pending} onClick={() => run(() => setOpeningBalancesAction(data.app.id), { success: 'Opening balances set', onSuccess: () => setConfirmBaseline(false) })}>
              Set opening balances
            </Button>
          </>
        }
      >
        <div className="space-y-2 text-[13px] text-ink-2">
          <p>
            The “previous” column on this application&apos;s schedule and its line 7 (
            <Money cents={data.app.claimed.lessPreviousCertificates} className="font-medium text-ink" />) will become the contract&apos;s starting point. Every later application is verified against it.
          </p>
          <p>Check those figures against your own records first. This is recorded in the audit trail under your name and cannot be changed once an application has been approved.</p>
        </div>
      </Dialog>
    </article>
  );
}

function Cell({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="bg-surface px-2.5 py-1.5">
      <dt className="text-[10.5px] uppercase tracking-wide text-ink-3">{label}</dt>
      <dd className="mt-0.5 text-[13px]">{children}</dd>
    </div>
  );
}

function AcceptDialog({ finding: f, open, onOpenChange, label }: { finding: Finding; open: boolean; onOpenChange: (o: boolean) => void; label: string }) {
  const { data } = useWorkspace();
  const [note, setNote] = useState('');
  const { pending, run } = useAction();
  const required = f.severity === 'blocking' || f.needsQualifiedReview;
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={`${label}: ${f.title}`}
      description={
        f.needsQualifiedReview
          ? 'You are confirming that a qualified person has reviewed this and it is acceptable. The system has not made a legal determination.'
          : f.severity === 'blocking'
            ? 'This finding blocks approval. Overriding it lets the application be approved as it stands.'
            : 'This warning will be marked as reviewed.'
      }
      footer={
        <>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            variant="primary"
            loading={pending}
            disabled={required && note.trim().length < 5}
            onClick={() =>
              run(() => acceptFindingAction(f.id, note, data.app.version), {
                success: `${label === 'Override' ? 'Overridden' : label === 'Sign off' ? 'Signed off' : 'Accepted'}`,
                onSuccess: () => {
                  onOpenChange(false);
                  setNote('');
                },
              })
            }
          >
            {label}
          </Button>
        </>
      }
    >
      <label className="block">
        <span className="mb-1 block text-xs font-medium text-ink-2">{required ? 'Reason (required)' : 'Note (optional)'}</span>
        <Textarea autoFocus value={note} onChange={(e) => setNote(e.target.value)} placeholder={required ? 'Why is this acceptable? This is kept with the approval record and shown in exports.' : 'Anything the approver should know.'} />
      </label>
      <p className="mt-2 text-xs text-ink-3">Recorded under your name with the time. If the figures behind this finding change later, it reopens automatically.</p>
    </Dialog>
  );
}

function AcceptedRow({ finding: f }: { finding: Finding }) {
  const { data, editable } = useWorkspace();
  const { pending, run } = useAction();
  return (
    <div className="flex items-start gap-2.5 rounded-lg border border-line px-3.5 py-2.5">
      <Check className="mt-0.5 size-4 shrink-0 text-ink-3" />
      <div className="min-w-0 flex-1">
        <p className="text-[13px] text-ink">
          <span className="font-medium">{f.title}</span>
          <span className="ml-2 text-[11px] text-ink-3">{f.severity === 'blocking' ? 'Blocking, overridden' : f.needsQualifiedReview ? 'Signed off' : 'Warning, accepted'}</span>
        </p>
        <p className="mt-0.5 text-xs text-ink-2">
          {f.resolutionNote ? `“${f.resolutionNote}”` : 'No note.'}
          <span className="text-ink-3">
            {' '}
            — {f.resolvedBy ? (data.people[f.resolvedBy] ?? 'Unknown') : 'Unknown'}
            {f.resolvedAt ? `, ${formatRelative(f.resolvedAt)}` : ''}
          </span>
        </p>
      </div>
      {editable ? (
        <Button size="sm" variant="ghost" loading={pending} onClick={() => run(() => reopenFindingAction(f.id), { success: 'Finding reopened' })}>
          <RotateCcw className="size-3.5" />
          Reopen
        </Button>
      ) : null}
    </div>
  );
}

function PassedChecks({ passed }: { passed: Finding[] }) {
  const [open, setOpen] = useState(false);
  if (passed.length === 0) return null;
  const groups = FINDING_CATEGORIES.map((c) => ({ category: c, items: passed.filter((f) => f.category === c) })).filter((g) => g.items.length > 0);
  return (
    <section>
      <button className="focus-ring -ml-1 flex items-center gap-1 rounded px-1 text-[11px] font-semibold uppercase tracking-wide text-ink-2 hover:text-ink" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        <ChevronRight className={cn('size-3.5 transition-transform', open && 'rotate-90')} />
        {passed.length} checks passed
      </button>
      {open ? (
        <div className="mt-2 space-y-3 rounded-lg border border-line px-3.5 py-3">
          {groups.map((g) => (
            <div key={g.category}>
              <h3 className="text-[11px] font-medium text-ink-3">{FINDING_CATEGORY_LABEL[g.category]}</h3>
              <ul className="mt-1 space-y-1">
                {g.items.map((f) => (
                  <li key={f.id} className="flex items-start gap-2 text-xs leading-[18px]">
                    <CircleCheck className="mt-[3px] size-3.5 shrink-0 text-pass" />
                    <span>
                      <span className="text-ink">{f.title}.</span> <span className="text-ink-3">{f.detail}</span>
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      ) : (
        <p className="mt-1 text-xs text-ink-3">
          {groups
            .slice(0, 6)
            .map((g) => FINDING_CATEGORY_LABEL[g.category])
            .join(' · ')}
        </p>
      )}
    </section>
  );
}

/** The other submissions with this application number, and the way to retire an earlier one in favour of this corrected package. */
function SameNumber() {
  const { data, perms, editable } = useWorkspace();
  const { pending, run } = useAction();
  const [replacing, setReplacing] = useState<ReviewData['sameNumber'][number] | null>(null);
  const received = new Date(data.app.receivedAt).getTime();
  return (
    <>
      <ul className="divide-y divide-line overflow-hidden rounded-md border border-line text-xs">
        {data.sameNumber.map((s) => {
          const earlier = new Date(s.receivedAt).getTime() < received;
          const replaceable = editable && perms.review && earlier && s.status !== 'approved' && s.status !== 'processing';
          return (
            <li key={s.id} className="flex items-center gap-2 px-3 py-2">
              <div className="min-w-0 flex-1">
                <Link href={`/applications/${s.id}`} className="font-medium text-ink hover:underline">
                  Application #{s.applicationNumber}, received {formatDate(new Date(s.receivedAt).toISOString().slice(0, 10))}
                </Link>
                <div className="text-ink-3">
                  {s.status.replace('_', ' ')}
                  {s.claimedAmount !== null ? (
                    <>
                      {' · requested '}
                      <Money cents={s.claimedAmount} />
                    </>
                  ) : null}
                  {earlier ? '' : ' · arrived after this one'}
                </div>
              </div>
              {replaceable ? (
                <Button size="sm" onClick={() => setReplacing(s)}>
                  Replace with this submission…
                </Button>
              ) : null}
            </li>
          );
        })}
      </ul>
      <Dialog
        open={replacing !== null}
        onOpenChange={(o) => (o ? null : setReplacing(null))}
        title="Replace the earlier submission?"
        description={
          replacing
            ? `Application #${replacing.applicationNumber} received ${formatDate(new Date(replacing.receivedAt).toISOString().slice(0, 10))} will be voided and linked to this one, so the same billing cannot be approved twice. Its documents and history are kept, and it can be reopened later if this was a mistake.`
            : ''
        }
        footer={
          <>
            <Button variant="ghost" onClick={() => setReplacing(null)}>
              Cancel
            </Button>
            <Button
              variant="primary"
              loading={pending}
              onClick={() => replacing && run(() => supersedeAction(data.app.id, replacing.id), { success: 'Earlier submission replaced', onSuccess: () => setReplacing(null) })}
            >
              Void the earlier one and keep this
            </Button>
          </>
        }
      >
        <p className="text-xs text-ink-2">Use this when the subcontractor sent a corrected package for the same period. If this upload is the duplicate instead, void this one from the ⋯ menu.</p>
      </Dialog>
    </>
  );
}
