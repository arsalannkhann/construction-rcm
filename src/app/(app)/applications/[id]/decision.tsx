'use client';

import { Ban, Check, ChevronDown, Download, Ellipsis, FilePlus2, FileSpreadsheet, FileText, Braces, MailQuestion, OctagonAlert, RotateCcw, Send, TriangleAlert, Undo2, UserRound } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Badge, Money } from '@/components/ui/data';
import { Checkbox, Field, Input, Select, Textarea } from '@/components/ui/form';
import { Dialog, Menu, MenuItem, MenuLabel, MenuSeparator, Tooltip } from '@/components/ui/overlay';
import { formatMoney } from '@/lib/money';
import { useAction } from '@/lib/use-action';
import { can, ROLE_LABEL } from '@/server/auth/permissions';
import type { Role } from '@/server/types';
import {
  approveAction,
  assignReviewerAction,
  draftCorrectionAction,
  exportAction,
  rejectAction,
  reopenAction,
  resumeReviewAction,
  sendMessageAction,
  submitForApprovalAction,
  voidAction,
} from '../actions';
import { pushToProcoreAction } from '../procore-actions';
import { useWorkspace } from './workspace';

type DialogKey = 'approve' | 'reject' | 'correction' | 'void' | 'reopen' | 'assign' | 'submit' | null;

export function DecisionBar() {
  const { data, perms, extras } = useWorkspace();
  const { app } = data;
  const router = useRouter();
  const { pending, run } = useAction();
  const [dialog, setDialog] = useState<DialogKey>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const close = () => setDialog(null);

  const status = app.status;
  const undecided = ['needs_review', 'pending_approval', 'on_hold', 'needs_matching'].includes(status);
  const canDecide = perms.approve && (status === 'needs_review' || status === 'pending_approval');
  const assignee = data.members.find((m) => m.userId === app.assigneeId);

  const upload = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    setUploading(true);
    try {
      const form = new FormData();
      for (const f of Array.from(files)) form.append('files', f);
      const res = await fetch(`/api/applications/${app.id}/documents`, { method: 'POST', body: form });
      const json = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) toast.error(json.error ?? 'The documents could not be added.');
      else {
        toast.success('Documents added. Reading the package again.');
        router.refresh();
      }
    } catch {
      toast.error('The upload did not complete. Check your connection and try again.');
    } finally {
      setUploading(false);
      if (fileInput.current) fileInput.current.value = '';
    }
  };

  const download = (kind: 'csv' | 'json' | 'pdf') =>
    run(() => exportAction(app.id, kind), {
      success: (d) => `Exported ${d.filename}`,
      onSuccess: (d) => {
        window.location.assign(`/api/transfers/${d.transferId}/download`);
      },
    });

  return (
    <div className="flex shrink-0 items-center gap-1.5">
      <input ref={fileInput} type="file" multiple hidden accept="application/pdf,image/png,image/jpeg,image/webp" onChange={(e) => upload(e.target.files)} />

      {perms.review && undecided ? (
        <Tooltip content={assignee ? `Assigned to ${assignee.name}` : 'Nobody is assigned'} side="bottom">
          <Button variant="ghost" onClick={() => setDialog('assign')} className="max-w-[160px]">
            <UserRound className="size-3.5 shrink-0" />
            <span className="truncate">{assignee ? assignee.name.split(' ')[0] : 'Assign'}</span>
          </Button>
        </Tooltip>
      ) : null}

      {status === 'needs_review' || status === 'pending_approval' || status === 'on_hold' ? (
        perms.review ? (
          <Button onClick={() => setDialog('correction')}>
            <MailQuestion className="size-3.5" />
            Request correction
          </Button>
        ) : null
      ) : null}

      {status === 'on_hold' && perms.review ? (
        <Button variant="primary" loading={pending} onClick={() => run(() => resumeReviewAction(app.id), { success: 'Review resumed' })}>
          Resume review
        </Button>
      ) : null}

      {status === 'needs_review' && perms.review && !perms.approve ? (
        <Button variant="primary" onClick={() => setDialog('submit')}>
          <Send className="size-3.5" />
          Submit for approval
        </Button>
      ) : null}
      {status === 'pending_approval' && !perms.approve ? <span className="px-1 text-xs text-ink-3">Waiting for an approver</span> : null}

      {canDecide ? (
        <>
          <Button variant="danger-outline" onClick={() => setDialog('reject')}>
            Reject
          </Button>
          <Button variant="primary" onClick={() => setDialog('approve')}>
            <Check className="size-3.5" />
            Approve {app.verifiedAmount !== null ? formatMoney(app.verifiedAmount) : ''}
          </Button>
        </>
      ) : null}

      {status === 'approved' ? (
        <>
          {app.transferStatus === 'synced' ? <Badge tone="pass">Sent to Procore</Badge> : app.transferStatus === 'exported' ? <Badge tone="pass">Exported</Badge> : app.transferStatus === 'failed' ? <Badge tone="block">Transfer failed</Badge> : <Badge tone="warn">Not yet transferred</Badge>}
          {perms.exportRun ? (
            <Menu
              trigger={
                <Button variant="primary" loading={pending}>
                  <Download className="size-3.5" />
                  Transfer
                  <ChevronDown className="size-3.5" />
                </Button>
              }
            >
              <MenuLabel>Export a file</MenuLabel>
              <MenuItem icon={<FileText />} onSelect={() => download('pdf')}>
                Approval record (PDF)
              </MenuItem>
              <MenuItem icon={<FileSpreadsheet />} onSelect={() => download('csv')}>
                Approved line items (CSV)
              </MenuItem>
              <MenuItem icon={<Braces />} onSelect={() => download('json')}>
                Full record (JSON)
              </MenuItem>
              <MenuSeparator />
              <MenuLabel>Send to a connected system</MenuLabel>
              <MenuItem
                icon={<Send />}
                disabled={!extras.procore.available}
                onSelect={() =>
                  run(() => pushToProcoreAction(app.id), {
                    onSuccess: (r) => {
                      if (r.status === 'completed') toast.success(`Created draft invoice ${r.externalRef ?? ''} in Procore`);
                      else toast.error(r.error ?? 'Procore did not accept the invoice.');
                    },
                  })
                }
              >
                <span>
                  Procore, as a draft subcontractor invoice
                  {!extras.procore.available && extras.procore.reason ? <span className="block max-w-[260px] whitespace-normal text-[11px] leading-4 text-ink-3">{extras.procore.reason}</span> : null}
                </span>
              </MenuItem>
            </Menu>
          ) : null}
        </>
      ) : null}

      <Menu
        trigger={
          <Button variant="ghost" aria-label="More actions" loading={uploading} className="px-2">
            {uploading ? null : <Ellipsis className="size-4" />}
          </Button>
        }
      >
        {perms.upload && undecided ? (
          <MenuItem icon={<FilePlus2 />} onSelect={() => fileInput.current?.click()}>
            Add documents and re-read…
          </MenuItem>
        ) : null}
        {status === 'pending_approval' && perms.review ? (
          <MenuItem icon={<Undo2 />} onSelect={() => run(() => resumeReviewAction(app.id), { success: 'Returned to review' })}>
            Return to review
          </MenuItem>
        ) : null}
        {perms.approve && (status === 'needs_matching' || status === 'on_hold') ? (
          <MenuItem icon={<OctagonAlert />} danger onSelect={() => setDialog('reject')}>
            Reject…
          </MenuItem>
        ) : null}
        {perms.approve && undecided ? (
          <MenuItem icon={<Ban />} danger onSelect={() => setDialog('void')}>
            Void (duplicate or withdrawn)…
          </MenuItem>
        ) : null}
        {perms.approve && ['approved', 'rejected', 'void'].includes(status) ? (
          <MenuItem icon={<RotateCcw />} onSelect={() => setDialog('reopen')}>
            Reopen…
          </MenuItem>
        ) : null}
        {!((perms.upload && undecided) || (status === 'pending_approval' && perms.review) || (perms.approve && (undecided || ['approved', 'rejected', 'void'].includes(status)))) ? (
          <div className="px-2 py-1.5 text-xs text-ink-3">No further actions are available to you here.</div>
        ) : null}
      </Menu>

      <ApproveDialog open={dialog === 'approve'} onClose={close} />
      <ReasonDialog
        open={dialog === 'reject'}
        onClose={close}
        title="Reject this application?"
        description="The application is closed without payment. The subcontractor can resubmit under the same application number."
        label="Reason"
        placeholder="What is wrong with it? Kept with the record."
        confirm="Reject application"
        danger
        action={(reason) => rejectAction(app.id, reason)}
        success="Application rejected"
      />
      <ReasonDialog
        open={dialog === 'void'}
        onClose={close}
        title="Void this application?"
        description="Use this for a duplicate upload or a submission the subcontractor withdrew. It is removed from totals and sequence checks but kept in the record."
        label="Reason"
        placeholder="For example: duplicate of application #5 uploaded on 3 November."
        confirm="Void application"
        danger
        action={(reason) => voidAction(app.id, reason)}
        success="Application voided"
      />
      <ReasonDialog
        open={dialog === 'reopen'}
        onClose={close}
        title="Reopen this application?"
        description={
          status === 'approved'
            ? `The approval of ${formatMoney(app.approvedAmount)} is withdrawn and the application returns to review.${app.transferStatus === 'exported' ? ' Files already exported from it will be out of date.' : ''}`
            : 'The application returns to review.'
        }
        label="Reason"
        placeholder="Why is the decision being undone?"
        confirm="Reopen"
        action={(reason) => reopenAction(app.id, reason)}
        success="Application reopened"
      />
      <SubmitDialog open={dialog === 'submit'} onClose={close} />
      <AssignDialog open={dialog === 'assign'} onClose={close} />
      <CorrectionDialog open={dialog === 'correction'} onClose={close} />
    </div>
  );
}

function ApproveDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { data } = useWorkspace();
  const { app } = data;
  const { pending, run } = useAction();
  const [note, setNote] = useState('');
  const [ack, setAck] = useState(false);
  useEffect(() => {
    if (open) {
      setNote('');
      setAck(false);
    }
  }, [open]);

  const openFindings = data.findings.filter((f) => f.status === 'open');
  const blocking = openFindings.filter((f) => f.severity === 'blocking');
  const warnings = openFindings.filter((f) => f.severity === 'warning');
  const accepted = data.findings.filter((f) => f.status === 'accepted');
  const diff = app.claimedAmount !== null && app.verifiedAmount !== null ? app.verifiedAmount - app.claimedAmount : null;
  const missing = app.applicationNumber === null || !app.periodTo;

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => (o ? null : onClose())}
      title="Approve this application"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            loading={pending}
            disabled={blocking.length > 0 || missing || (warnings.length > 0 && !ack)}
            onClick={() => run(() => approveAction(app.id, { note: note.trim() || null, acknowledgeWarnings: ack }), { success: `Approved for ${formatMoney(app.verifiedAmount)}`, onSuccess: onClose })}
          >
            <Check className="size-3.5" />
            Approve {formatMoney(app.verifiedAmount)}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="rounded-lg border border-line bg-canvas/60 px-4 py-3">
          <div className="text-[10.5px] font-medium uppercase tracking-wide text-ink-3">Amount approved for payment</div>
          <div className="mt-0.5 text-2xl font-semibold tracking-tight">
            <Money cents={app.verifiedAmount} />
          </div>
          <p className="mt-1 text-xs text-ink-2">
            {diff === null
              ? 'The requested amount could not be read from the application.'
              : diff === 0
                ? 'Equal to the amount the subcontractor requested.'
                : `The subcontractor requested ${formatMoney(app.claimedAmount)}. You are approving ${formatMoney(Math.abs(diff))} ${diff < 0 ? 'less' : 'more'}.`}
            {app.verified ? ` Retainage held after this payment: ${formatMoney(app.verified.retainageTotal)}.` : ''}
          </p>
        </div>

        {missing ? <Notice tone="block" title="The application number and period are required" items={['Enter them on the Summary tab.']} /> : null}
        {blocking.length > 0 ? <Notice tone="block" title={`${blocking.length} blocking finding${blocking.length === 1 ? '' : 's'} must be resolved or overridden first`} items={blocking.map((f) => f.title)} /> : null}
        {warnings.length > 0 ? (
          <div>
            <Notice tone="warn" title={`${warnings.length} open warning${warnings.length === 1 ? '' : 's'}`} items={warnings.map((f) => f.title)} />
            <Checkbox className="mt-2.5" checked={ack} onChange={(e) => setAck(e.target.checked)} label="I have reviewed these warnings and they do not prevent payment" description="Recorded on the approval record under your name." />
          </div>
        ) : null}
        {accepted.length > 0 ? (
          <p className="text-xs text-ink-2">
            {accepted.length} finding{accepted.length === 1 ? ' was' : 's were'} accepted or overridden during review and will be listed on the approval record with the reasons given.
          </p>
        ) : null}

        <Field label="Note" optional>
          <Textarea value={note} onChange={(e) => setNote(e.target.value)} placeholder="Anything accounts payable should know." className="min-h-16" />
        </Field>
        <p className="text-xs text-ink-3">Approval writes an immutable record of these figures. Exports and transfers are produced from that record. No money moves from this system.</p>
      </div>
    </Dialog>
  );
}

function Notice({ tone, title, items }: { tone: 'block' | 'warn'; title: string; items: string[] }) {
  const Icon = tone === 'block' ? OctagonAlert : TriangleAlert;
  return (
    <div className={tone === 'block' ? 'rounded-lg border border-block-line bg-block-soft/60 px-3.5 py-2.5' : 'rounded-lg border border-warn-line bg-warn-soft/60 px-3.5 py-2.5'}>
      <p className={`flex items-center gap-1.5 text-[13px] font-medium ${tone === 'block' ? 'text-block' : 'text-warn'}`}>
        <Icon className="size-3.5" />
        {title}
      </p>
      <ul className="mt-1 list-disc space-y-0.5 pl-5 text-xs text-ink-2 marker:text-ink-4">
        {items.slice(0, 6).map((t, i) => (
          <li key={i}>{t}</li>
        ))}
        {items.length > 6 ? <li>and {items.length - 6} more</li> : null}
      </ul>
    </div>
  );
}

function ReasonDialog({
  open,
  onClose,
  title,
  description,
  label,
  placeholder,
  confirm,
  danger,
  action,
  success,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  description: string;
  label: string;
  placeholder: string;
  confirm: string;
  danger?: boolean;
  action: (reason: string) => Promise<{ ok: true; data: undefined } | { ok: false; error: string }>;
  success: string;
}) {
  const [reason, setReason] = useState('');
  const { pending, run } = useAction();
  useEffect(() => {
    if (open) setReason('');
  }, [open]);
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => (o ? null : onClose())}
      title={title}
      description={description}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant={danger ? 'danger' : 'primary'} loading={pending} disabled={reason.trim().length < 5} onClick={() => run(() => action(reason), { success, onSuccess: onClose })}>
            {confirm}
          </Button>
        </>
      }
    >
      <Field label={label}>
        <Textarea autoFocus value={reason} onChange={(e) => setReason(e.target.value)} placeholder={placeholder} />
      </Field>
    </Dialog>
  );
}

function SubmitDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { data } = useWorkspace();
  const { app } = data;
  const [note, setNote] = useState('');
  const { pending, run } = useAction();
  const blocking = data.findings.filter((f) => f.status === 'open' && f.severity === 'blocking');
  useEffect(() => {
    if (open) setNote('');
  }, [open]);
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => (o ? null : onClose())}
      title="Submit for approval"
      description={`A controller or admin will be notified and can approve it for ${formatMoney(app.verifiedAmount)}.`}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" loading={pending} onClick={() => run(() => submitForApprovalAction(app.id, note.trim() || null), { success: 'Submitted for approval', onSuccess: onClose })}>
            Submit for approval
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        {blocking.length > 0 ? <Notice tone="block" title={`${blocking.length} blocking finding${blocking.length === 1 ? ' is' : 's are'} still open`} items={[...blocking.map((f) => f.title), 'The approver will have to resolve or override these before approving.']} /> : null}
        <Field label="Note for the approver" optional>
          <Textarea value={note} onChange={(e) => setNote(e.target.value)} placeholder="What you checked, and anything they should look at." className="min-h-16" />
        </Field>
      </div>
    </Dialog>
  );
}

function AssignDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { data } = useWorkspace();
  const [userId, setUserId] = useState(data.app.assigneeId ?? '');
  const { pending, run } = useAction();
  useEffect(() => {
    if (open) setUserId(data.app.assigneeId ?? '');
  }, [open, data.app.assigneeId]);
  const reviewers = data.members.filter((m) => can(m.role as Role, 'application:review'));
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => (o ? null : onClose())}
      size="sm"
      title="Assign reviewer"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" loading={pending} disabled={(userId || null) === data.app.assigneeId} onClick={() => run(() => assignReviewerAction(data.app.id, userId || null), { success: 'Assignment updated', onSuccess: onClose })}>
            Save
          </Button>
        </>
      }
    >
      <Field label="Reviewer" hint="They are notified. Anyone with review access can still open the application.">
        <Select value={userId} onChange={(e) => setUserId(e.target.value)}>
          <option value="">Unassigned</option>
          {reviewers.map((m) => (
            <option key={m.userId} value={m.userId}>
              {m.name} · {ROLE_LABEL[m.role as Role]}
            </option>
          ))}
        </Select>
      </Field>
    </Dialog>
  );
}

function CorrectionDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { data, extras } = useWorkspace();
  const { app } = data;
  const [form, setForm] = useState({ to: '', subject: '', body: '' });
  const [hold, setHold] = useState(true);
  const [loading, setLoading] = useState(false);
  const { pending, run } = useAction();

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    setHold(app.status !== 'on_hold');
    draftCorrectionAction(app.id).then((r) => {
      if (cancelled) return;
      setLoading(false);
      if (r.ok) setForm(r.data);
      else toast.error(r.error);
    });
    return () => {
      cancelled = true;
    };
  }, [open, app.id, app.status]);

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => (o ? null : onClose())}
      size="lg"
      title="Request a correction from the subcontractor"
      description="Drafted from the open findings. Edit it before it goes out."
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            loading={pending}
            disabled={loading || !form.to.trim() || !form.body.trim()}
            onClick={() =>
              run(() => sendMessageAction(app.id, { ...form, hold }), {
                onSuccess: (r) => {
                  if (r.status === 'sent') toast.success(`Sent to ${form.to}`);
                  else if (r.status === 'failed') toast.error(`The email failed to send: ${r.detail ?? 'unknown error'}. The message is saved under Activity.`);
                  else toast.message('Saved as a draft, not sent', { description: 'Email delivery is not configured. Copy the message from the Activity tab into your own email.' });
                  onClose();
                },
              })
            }
          >
            {extras.emailConfigured ? (
              <>
                <Send className="size-3.5" /> Send email
              </>
            ) : (
              'Save to record'
            )}
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        {!extras.emailConfigured ? (
          <div className="rounded-lg border border-warn-line bg-warn-soft/60 px-3.5 py-2.5 text-xs text-ink-2">
            <span className="font-medium text-warn">Email delivery is not configured on this deployment.</span> The message will be saved to the application’s record as a draft and will not be sent. Copy it into your own email to send it.
          </div>
        ) : null}
        <div className="grid grid-cols-2 gap-3">
          <Field label="To">
            <Input type="email" value={form.to} onChange={(e) => setForm((f) => ({ ...f, to: e.target.value }))} placeholder="billing@subcontractor.com" disabled={loading} />
          </Field>
          <Field label="Subject">
            <Input value={form.subject} onChange={(e) => setForm((f) => ({ ...f, subject: e.target.value }))} disabled={loading} />
          </Field>
        </div>
        <Field label="Message">
          <Textarea value={form.body} onChange={(e) => setForm((f) => ({ ...f, body: e.target.value }))} className="min-h-[260px] font-mono text-xs leading-[18px]" disabled={loading} />
        </Field>
        <Checkbox checked={hold} onChange={(e) => setHold(e.target.checked)} label="Put the application on hold until they reply" description="It moves to “Awaiting subcontractor”. Add their revised documents to pick it up again." />
      </div>
    </Dialog>
  );
}
