'use client';

import Link from 'next/link';
import { useSignedIn } from '@/components/marketing/session-hint';

/** Sign in, or back to the dashboard for someone who already is. */
export function SampleAccountLink() {
  const signedIn = useSignedIn();
  return (
    <Link href={signedIn ? '/overview' : '/login'} className="focus-ring hidden h-9 items-center whitespace-nowrap rounded-full px-3 text-[13.5px] font-medium text-ink-2 transition-colors hover:text-ink min-[420px]:inline-flex">
      {signedIn ? 'Continue to dashboard' : 'Sign in'}
    </Link>
  );
}
