'use client';

import { FilePlus2 } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Field, Input } from '@/components/ui/form';
import { Dialog } from '@/components/ui/overlay';
import { useAction } from '@/lib/use-action';
import { startOwnerApplicationAction } from './actions';

/** Start the next application to the owner, for a period that runs to `suggested` unless changed. */
export function StartApplicationButton({ projectId, number, suggested, variant = 'primary' }: { projectId: string; number: number; suggested: string; variant?: 'primary' | 'secondary' }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [periodTo, setPeriodTo] = useState(suggested);
  const { pending, run } = useAction();
  const submit = () => {
    if (!periodTo) return;
    run(() => startOwnerApplicationAction(projectId, periodTo), {
      refresh: false,
      onSuccess: ({ id }) => router.push(`/projects/${projectId}/owner-billing/${id}`),
    });
  };
  return (
    <>
      <Button
        variant={variant}
        size={variant === 'primary' ? 'md' : 'sm'}
        onClick={() => {
          setPeriodTo(suggested);
          setOpen(true);
        }}
      >
        <FilePlus2 className="size-3.5" />
        Start application #{number}
      </Button>
      <Dialog
        open={open}
        onOpenChange={setOpen}
        size="sm"
        title={`Start application #${number}`}
        description="It is worked out from the subcontractor billing approved up to the end of this period. Nothing goes to the owner until it is submitted."
        footer={
          <>
            <Button variant="ghost" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button variant="primary" loading={pending} disabled={!periodTo} onClick={submit}>
              Start draft
            </Button>
          </>
        }
      >
        <form
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          <Field label="Period to">
            <Input type="date" required value={periodTo} onChange={(e) => setPeriodTo(e.target.value)} />
          </Field>
        </form>
      </Dialog>
    </>
  );
}
