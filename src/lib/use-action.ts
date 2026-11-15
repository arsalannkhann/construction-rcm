'use client';

import { useRouter } from 'next/navigation';
import { useCallback, useTransition } from 'react';
import { toast } from 'sonner';
import type { ActionResult } from './action';

type Options<T> = {
  /** Toast shown on success. */
  success?: string | ((data: T) => string);
  onSuccess?: (data: T) => void;
  /** Re-fetch the current page's server data afterwards (default true). */
  refresh?: boolean;
};

/** Run a server action with a pending flag, error toast and page refresh. */
export function useAction() {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const run = useCallback(
    <T,>(call: () => Promise<ActionResult<T>>, options: Options<T> = {}) => {
      startTransition(async () => {
        let result: ActionResult<T>;
        try {
          result = await call();
        } catch {
          toast.error('The request could not be completed. Check your connection and try again.');
          return;
        }
        if (!result.ok) {
          toast.error(result.error);
          return;
        }
        if (options.success) toast.success(typeof options.success === 'function' ? options.success(result.data) : options.success);
        options.onSuccess?.(result.data);
        if (options.refresh !== false) router.refresh();
      });
    },
    [router],
  );
  return { pending, run };
}
