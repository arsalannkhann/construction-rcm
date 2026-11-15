'use client';

import { Unplug } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/overlay';
import { useAction } from '@/lib/use-action';
import { disconnectAction } from './actions';

export function DisconnectButton({ orgName }: { orgName: string }) {
  const [open, setOpen] = useState(false);
  const { pending, run } = useAction();

  return (
    <>
      <Button variant="danger-outline" onClick={() => setOpen(true)}>
        <Unplug className="size-3.5" strokeWidth={1.9} />
        Disconnect
      </Button>
      <Dialog
        open={open}
        // Stay open while the request is in flight so its outcome is not missed.
        onOpenChange={(next) => {
          if (!pending) setOpen(next);
        }}
        title="Disconnect Procore?"
        description={`${orgName} will no longer be able to import from Procore or send applications to it until someone connects again.`}
        footer={
          <>
            <Button variant="ghost" disabled={pending} onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button variant="danger" loading={pending} onClick={() => run(() => disconnectAction(), { success: 'Procore disconnected', onSuccess: () => setOpen(false) })}>
              Disconnect
            </Button>
          </>
        }
      >
        <ul className="list-disc space-y-1.5 pl-5 text-[13px] text-ink-2">
          <li>Projects, subcontractors, subcontracts and change orders that were imported stay here, still linked to their Procore records.</li>
          <li>Invoices already sent stay in Procore. Nothing is deleted there.</li>
          <li>The stored authorization is revoked at Procore if Procore can be reached, and deleted here either way.</li>
          <li>CSV, JSON and PDF exports keep working.</li>
        </ul>
      </Dialog>
    </>
  );
}
