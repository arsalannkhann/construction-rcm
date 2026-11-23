'use client';

import { ArrowRight, History } from 'lucide-react';
import Link from 'next/link';
import { useLastPage, useSignedIn } from './session-hint';

const PRIMARY =
  'focus-ring group inline-flex h-12 items-center justify-center gap-2 whitespace-nowrap rounded-full bg-ink px-6 text-[15px] font-medium text-white shadow-[0_8px_24px_-8px_rgb(11_18_32/0.5)] transition-colors hover:bg-ink/85';
const SECONDARY =
  'focus-ring inline-flex h-12 items-center justify-center whitespace-nowrap rounded-full border border-line-strong bg-surface/70 px-6 text-[15px] font-medium text-ink backdrop-blur transition-colors hover:border-ink-4 hover:bg-surface';

/**
 * The hero's calls to action. A visitor is offered the sample first (nothing
 * to sign up for), then the conversation. Someone already signed in is
 * offered their dashboard, never redirected to it.
 */
export function HeroActions() {
  const signedIn = useSignedIn();
  const last = useLastPage();

  if (signedIn) {
    return (
      <div>
        <div className="flex flex-col items-stretch gap-3 sm:flex-row sm:flex-wrap sm:items-center">
          <Link href="/overview" className={PRIMARY}>
            Continue to dashboard
            <ArrowRight className="size-4 transition-transform group-hover:translate-x-0.5" />
          </Link>
          <Link href="/sample" className={SECONDARY}>
            Explore a sample workflow
          </Link>
        </div>
        {last ? (
          <Link href={last.path} className="focus-ring mt-4 inline-flex items-center gap-2 rounded text-[14px] font-medium text-ink-2 transition-colors hover:text-ink">
            <History className="size-4 shrink-0 text-ink-3" />
            Resume {last.label}
          </Link>
        ) : null}
      </div>
    );
  }

  return (
    <div className="flex flex-col items-stretch gap-3 sm:flex-row sm:flex-wrap sm:items-center">
      <Link href="/sample" className={PRIMARY}>
        Explore a sample workflow
        <ArrowRight className="size-4 transition-transform group-hover:translate-x-0.5" />
      </Link>
      <a href="#partner" className={SECONDARY}>
        Become a design partner
      </a>
    </div>
  );
}
