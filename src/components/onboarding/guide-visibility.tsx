'use client';

import { useRouter } from 'next/navigation';
import { useTransition } from 'react';
import { toast } from 'sonner';
import { setGuideHiddenAction } from '@/app/onboarding-actions';
import { cn } from '@/lib/utils';

/** Puts the setup guide away for this member, or brings it back. It stays under Help either way. */
export function GuideVisibilityButton({ hidden, className }: { hidden: boolean; className?: string }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  return (
    <button
      type="button"
      disabled={pending}
      className={cn('focus-ring rounded text-xs font-medium text-ink-3 underline-offset-4 hover:text-ink hover:underline disabled:opacity-50', className)}
      onClick={() =>
        start(async () => {
          const result = await setGuideHiddenAction(!hidden);
          if (!result.ok) toast.error(result.error);
          else {
            if (!hidden) toast('Setup guide hidden', { description: 'It is still under Help whenever you want it.' });
            router.refresh();
          }
        })
      }
    >
      {hidden ? 'Show it on my overview again' : 'Hide from my overview'}
    </button>
  );
}
