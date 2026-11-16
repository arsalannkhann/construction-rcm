'use client';

import { FlaskConical } from 'lucide-react';
import { useState, useTransition } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/overlay';
import { cn } from '@/lib/utils';
import { deleteDemoWorkspaceAction, openDemoWorkspaceAction } from './actions';

/**
 * Create, open or delete the demo workspace.
 * `hasDemo`: the user already has one. `inDemo`: they are looking at it now.
 */
export function DemoWorkspaceCard({ hasDemo, inDemo, variant = 'panel' }: { hasDemo: boolean; inDemo: boolean; variant?: 'panel' | 'inline' }) {
  const [pending, start] = useTransition();
  const [confirming, setConfirming] = useState(false);

  const open = () =>
    start(async () => {
      const result = await openDemoWorkspaceAction();
      if (!result.ok) toast.error(result.error);
      else window.location.assign('/overview');
    });
  const remove = () =>
    start(async () => {
      const result = await deleteDemoWorkspaceAction();
      if (!result.ok) toast.error(result.error);
      else window.location.replace('/overview');
    });

  return (
    <div className={cn(variant === 'panel' && 'rounded-xl border border-line bg-surface p-4 shadow-card')}>
      <div className="flex items-start gap-3">
        <div className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-accent-soft text-accent-ink">
          <FlaskConical className="size-4" />
        </div>
        <div className="min-w-0 flex-1">
          <h2 className="text-[13px] font-semibold">Demo workspace</h2>
          <p className="mt-0.5 text-xs leading-[18px] text-ink-2">
            {inDemo
              ? 'You are in the demo workspace: three fictitious projects, eight subcontracts and five months of billing. It is a separate organisation, so nothing here touches your own records. Deleting it removes all of it.'
              : 'A separate organisation with three fictitious projects, eight subcontracts and five months of billing, including applications with real discrepancies to review. Every record in it was produced by generating a PDF and running it through the product, not typed in. It never mixes with your own data.'}
          </p>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            {inDemo ? (
              <Button variant="danger-outline" onClick={() => setConfirming(true)}>
                Delete the demo workspace
              </Button>
            ) : (
              <Button variant={hasDemo ? 'secondary' : 'primary'} loading={pending} onClick={open}>
                {hasDemo ? 'Open the demo workspace' : 'Create the demo workspace'}
              </Button>
            )}
            {!hasDemo && !inDemo ? <span className="text-xs text-ink-3">{pending ? 'Generating and processing about forty billing packages. This takes up to a minute.' : 'Takes up to a minute to build.'}</span> : null}
          </div>
        </div>
      </div>
      <Dialog
        open={confirming}
        onOpenChange={setConfirming}
        size="sm"
        title="Delete the demo workspace?"
        description="All demo projects, applications, documents and history are removed. Your own organisation is not affected. You can create a fresh demo workspace again later."
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirming(false)}>
              Cancel
            </Button>
            <Button variant="danger" loading={pending} onClick={remove}>
              Delete demo workspace
            </Button>
          </>
        }
      />
    </div>
  );
}
