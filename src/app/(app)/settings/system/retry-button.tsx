'use client';

import { RotateCcw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useAction } from '@/lib/use-action';
import { retryJobAction } from './actions';

export function RetryJobButton({ jobId }: { jobId: string }) {
  const { pending, run } = useAction();
  return (
    <Button size="sm" loading={pending} onClick={() => run(() => retryJobAction(jobId), { success: 'Queued again' })}>
      <RotateCcw className="size-3.5" />
      Retry
    </Button>
  );
}
