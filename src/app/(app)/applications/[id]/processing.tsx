'use client';

import { FileText, Loader2, TriangleAlert } from 'lucide-react';
import Link from '@/components/ui/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { Button, buttonClass } from '@/components/ui/button';
import { useAction } from '@/lib/use-action';
import { retryProcessingAction } from '../actions';

/** Shown while the package is being read. Polls, then hands over to the review workspace. */
export function ProcessingScreen({ id, files, error, aiConfigured }: { id: string; files: string[]; error: string | null; aiConfigured: boolean }) {
  const router = useRouter();
  const [failure, setFailure] = useState(error);
  const { pending, run } = useAction();

  useEffect(() => {
    if (failure) return;
    let stopped = false;
    const tick = async () => {
      try {
        const res = await fetch(`/api/applications/${id}/status`, { cache: 'no-store' });
        if (!res.ok) return;
        const json = (await res.json()) as { status: string; error: string | null };
        if (stopped) return;
        if (json.error) setFailure(json.error);
        else if (json.status !== 'processing') router.refresh();
      } catch {
        /* transient; try again on the next tick */
      }
    };
    const timer = setInterval(tick, 1200);
    tick();
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [id, failure, router]);

  return (
    <div className="flex h-full items-center justify-center px-6">
      <div className="w-full max-w-md text-center">
        {failure ? (
          <>
            <div className="mx-auto flex size-10 items-center justify-center rounded-full bg-block-soft text-block">
              <TriangleAlert className="size-5" />
            </div>
            <h1 className="mt-4 text-base font-semibold">Processing did not finish</h1>
            <p className="mt-1 text-[13px] text-ink-2">The documents are stored safely. Reading them failed, and nothing was approved or changed.</p>
            <p className="mt-2 rounded-md bg-sunken px-3 py-2 text-left font-mono text-[11px] text-ink-2">{failure}</p>
            <div className="mt-4 flex justify-center gap-2">
              <Link href="/applications" className={buttonClass({})}>
                Back to applications
              </Link>
              <Button variant="primary" loading={pending} onClick={() => run(() => retryProcessingAction(id), { onSuccess: () => setFailure(null) })}>
                Try again
              </Button>
            </div>
          </>
        ) : (
          <>
            <Loader2 className="mx-auto size-6 animate-spin text-ink-3" />
            <h1 className="mt-4 text-base font-semibold">Reading the billing package</h1>
            <p className="mt-1 text-[13px] text-ink-2">
              Originals are stored. Now identifying each document, reading the figures, matching the subcontract and checking them against the contract and billing history.
              {aiConfigured ? ' This usually takes under a minute.' : ' This takes a few seconds.'}
            </p>
            <ul className="mx-auto mt-5 inline-block space-y-1 text-left">
              {files.map((f) => (
                <li key={f} className="flex items-center gap-2 text-xs text-ink-2">
                  <FileText className="size-3.5 text-ink-3" />
                  {f}
                </li>
              ))}
            </ul>
            <p className="mt-5 text-xs text-ink-3">You can leave this page. You will be notified when it is ready.</p>
          </>
        )}
      </div>
    </div>
  );
}
