'use client';

import { ArrowRight, Loader2 } from 'lucide-react';
import { useState, useTransition } from 'react';
import { toast } from 'sonner';
import { openExampleAction, startOwnSetupAction } from '@/app/onboarding-actions';
import { buttonClass } from '@/components/ui/button';

type Variant = Parameters<typeof buttonClass>[0];

/**
 * Opens the example workspace, building it first if this person has none
 * (which takes up to a minute, and says so). The session moves into the
 * example, so the page is loaded afresh rather than navigated.
 */
export function OpenExampleButton({ hasExample, children, ...style }: { hasExample: boolean; children?: React.ReactNode } & Variant) {
  const [busy, setBusy] = useState(false);
  const [, start] = useTransition();
  return (
    <span className="inline-flex flex-wrap items-center gap-x-3 gap-y-1.5">
      <button
        type="button"
        disabled={busy}
        className={buttonClass(style)}
        onClick={() => {
          setBusy(true);
          start(async () => {
            const result = await openExampleAction();
            if (!result.ok) {
              toast.error(result.error);
              setBusy(false);
            } else window.location.assign(result.data.next);
          });
        }}
      >
        {busy ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : null}
        {children ?? (hasExample ? 'Open the example' : 'Explore the example')}
        {busy ? null : <ArrowRight className="size-3.5" />}
      </button>
      {busy && !hasExample ? (
        <span role="status" className="text-xs text-ink-3">
          Preparing it: about forty billing packages are being generated, read and checked. Up to a minute.
        </span>
      ) : null}
    </span>
  );
}

/** From the example to the member's own organisation, at its setup guide. */
export function StartOwnSetupButton({ children, ...style }: { children: React.ReactNode } & Variant) {
  const [busy, setBusy] = useState(false);
  const [, start] = useTransition();
  return (
    <button
      type="button"
      disabled={busy}
      className={buttonClass(style)}
      onClick={() => {
        setBusy(true);
        start(async () => {
          const result = await startOwnSetupAction();
          if (!result.ok) {
            toast.error(result.error);
            setBusy(false);
          } else window.location.assign(result.data.next);
        });
      }}
    >
      {busy ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : null}
      {children}
    </button>
  );
}
