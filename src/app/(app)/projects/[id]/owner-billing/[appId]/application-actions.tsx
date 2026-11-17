'use client';

import { BadgeCheck, Send, Trash2, Undo2 } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Field, Input, MoneyInput, Textarea } from '@/components/ui/form';
import { Dialog } from '@/components/ui/overlay';
import { formatMoney } from '@/lib/money';
import { useAction } from '@/lib/use-action';
import { pluralize } from '@/lib/utils';
import { certifyOwnerApplicationAction, deleteOwnerDraftAction, reopenOwnerApplicationAction, submitOwnerApplicationAction } from '../actions';

type Props = {
  projectId: string;
  appId: string;
  number: number;
  status: 'draft' | 'submitted' | 'certified';
  fingerprint: string;
  amountDue: number;
  blocking: number;
  warnings: number;
  certified: { amount: number | null; on: string | null; note: string | null };
  can: { write: boolean; approve: boolean };
  isLatest: boolean;
};

type Open = 'submit' | 'delete' | 'reopen' | 'certify' | null;

/** Today's date where the person is, as YYYY-MM-DD (toISOString would give the date in UTC). */
function localToday(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function ApplicationActions(p: Props) {
  const router = useRouter();
  const [open, setOpen] = useState<Open>(null);
  const [reason, setReason] = useState('');
  const [amount, setAmount] = useState<number | null>(p.certified.amount ?? p.amountDue);
  const [on, setOn] = useState(p.certified.on ?? '');
  const [note, setNote] = useState(p.certified.note ?? '');
  const { pending, run } = useAction();
  const close = () => setOpen(null);
  const short = amount !== null && amount < p.amountDue;

  const buttons: React.ReactNode[] = [];
  if (p.status === 'draft' && p.can.approve) {
    buttons.push(
      <Button key="submit" variant="primary" disabled={p.blocking > 0} title={p.blocking > 0 ? 'Resolve the blocking checks first' : undefined} onClick={() => setOpen('submit')}>
        <Send className="size-3.5" />
        Submit to owner
      </Button>,
    );
  }
  if (p.status === 'draft' && p.can.write) {
    buttons.push(
      <Button key="delete" variant="ghost" onClick={() => setOpen('delete')}>
        <Trash2 className="size-3.5" />
        Delete draft
      </Button>,
    );
  }
  if (p.status !== 'draft' && p.can.approve) {
    buttons.push(
      <Button
        key="certify"
        variant={p.status === 'submitted' ? 'primary' : 'secondary'}
        onClick={() => {
          setAmount(p.certified.amount ?? p.amountDue);
          setOn(p.certified.on ?? localToday());
          setOpen('certify');
        }}
      >
        <BadgeCheck className="size-3.5" />
        {p.status === 'certified' ? 'Change certification' : 'Record certification'}
      </Button>,
    );
  }
  if (p.status === 'submitted' && p.can.approve && p.isLatest) {
    buttons.push(
      <Button key="reopen" variant="ghost" onClick={() => setOpen('reopen')}>
        <Undo2 className="size-3.5" />
        Reopen
      </Button>,
    );
  }
  if (buttons.length === 0) return null;

  return (
    <>
      <div className="flex flex-wrap gap-2">{buttons}</div>

      <Dialog
        open={open === 'submit'}
        onOpenChange={(o) => !o && close()}
        title={`Submit application #${p.number}`}
        description="Its figures are frozen as they are now, and the PDF is made from them. Send the PDF to the owner yourself; nothing is emailed from here."
        footer={
          <>
            <Button variant="ghost" onClick={close}>
              Cancel
            </Button>
            <Button variant="primary" loading={pending} onClick={() => run(() => submitOwnerApplicationAction(p.appId, p.fingerprint), { success: `Application #${p.number} submitted`, onSuccess: close, onError: (conflict) => conflict && close() })}>
              Submit {formatMoney(p.amountDue)}
            </Button>
          </>
        }
      >
        <p className="text-[13px] text-ink-2">
          Current payment due: <span className="num font-medium text-ink">{formatMoney(p.amountDue)}</span>.
          {p.warnings > 0 ? ` ${pluralize(p.warnings, 'warning')} on the page will be kept with the record. Read them before submitting.` : ' There are no warnings.'}
        </p>
      </Dialog>

      <Dialog
        open={open === 'delete'}
        onOpenChange={(o) => !o && close()}
        size="sm"
        title={`Delete draft #${p.number}?`}
        description="The figures typed over are discarded. The application number becomes free for the next draft."
        footer={
          <>
            <Button variant="ghost" onClick={close}>
              Keep it
            </Button>
            <Button variant="danger" loading={pending} onClick={() => run(() => deleteOwnerDraftAction(p.appId), { success: 'Draft deleted', refresh: false, onSuccess: () => router.push(`/projects/${p.projectId}/owner-billing`) })}>
              Delete draft
            </Button>
          </>
        }
      />

      <Dialog
        open={open === 'reopen'}
        onOpenChange={(o) => !o && close()}
        title={`Reopen application #${p.number}`}
        description="It goes back to a draft, keeping its number and the figures typed over, and follows the latest approvals again. The submitted version is kept in the activity log."
        footer={
          <>
            <Button variant="ghost" onClick={close}>
              Cancel
            </Button>
            <Button variant="primary" loading={pending} disabled={reason.trim().length < 5} onClick={() => run(() => reopenOwnerApplicationAction(p.appId, reason), { success: `Application #${p.number} is a draft again`, onSuccess: close })}>
              Reopen
            </Button>
          </>
        }
      >
        <Field label="Why" hint="For example, what the owner or architect asked to change.">
          <Textarea autoFocus rows={3} value={reason} onChange={(e) => setReason(e.target.value)} />
        </Field>
      </Dialog>

      <Dialog
        open={open === 'certify'}
        onOpenChange={(o) => !o && close()}
        title={`Certification of application #${p.number}`}
        description={`What the owner or architect certified for payment. It counts as a previous certificate on the next application. Applied for: ${formatMoney(p.amountDue)}.`}
        footer={
          <>
            <Button variant="ghost" onClick={close}>
              Cancel
            </Button>
            <Button
              variant="primary"
              loading={pending}
              disabled={amount === null || !on || (short && note.trim().length < 5)}
              onClick={() => amount !== null && run(() => certifyOwnerApplicationAction(p.appId, { amount, certifiedOn: on, note }), { success: 'Certification recorded', onSuccess: close })}
            >
              Save certification
            </Button>
          </>
        }
      >
        <form
          className="grid grid-cols-2 gap-4"
          onSubmit={(e) => {
            e.preventDefault();
          }}
        >
          <Field label="Amount certified">
            <MoneyInput autoFocus value={amount} onChange={setAmount} />
          </Field>
          <Field label="Certified on">
            <Input type="date" value={on} onChange={(e) => setOn(e.target.value)} />
          </Field>
          <Field label="Note" optional={!short} className="col-span-2" hint={short ? `${formatMoney(p.amountDue - (amount ?? 0))} less than applied for: say what was held back and why.` : undefined}>
            <Textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} />
          </Field>
        </form>
      </Dialog>
    </>
  );
}
