'use client';

import { buttonClass } from '@/components/ui/button';
import type { TourId } from '@/server/types';
import { useTour } from './tour';

/** Starts a tour from its first step, wherever the member is. */
export function StartTourButton({ tour, children, ...style }: { tour: TourId; children: React.ReactNode } & Parameters<typeof buttonClass>[0]) {
  const { start } = useTour();
  return (
    <button type="button" className={buttonClass(style)} onClick={() => start(tour)}>
      {children}
    </button>
  );
}
