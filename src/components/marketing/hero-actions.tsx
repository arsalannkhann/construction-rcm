'use client';

import { ArrowRight, History } from 'lucide-react';
import Link from 'next/link';
import { useLastPage, useSignedIn } from './session-hint';

/** The hero's calls to action. Someone already signed in is offered their dashboard, never redirected to it. */
export function HeroActions() {
  const signedIn = useSignedIn();
  const last = useLastPage();

  if (signedIn) {
    return (
      <div className="flex flex-col items-start gap-4 sm:flex-row sm:items-center">
        <Link
          href="/overview"
          className="focus-ring group inline-flex h-12 items-center gap-2 whitespace-nowrap rounded-full bg-ink px-6 text-[15px] font-medium text-white shadow-[0_8px_24px_-8px_rgb(11_18_32/0.5)] transition-colors hover:bg-ink/85"
        >
          Continue to dashboard
          <ArrowRight className="size-4 transition-transform group-hover:translate-x-0.5" />
        </Link>
        {last && (
          <Link href={last.path} className="focus-ring inline-flex h-12 items-center gap-2 rounded-full px-2 text-[14px] font-medium text-ink-2 transition-colors hover:text-ink">
            <History className="size-4 text-ink-3" />
            Resume {last.label}
          </Link>
        )}
      </div>
    );
  }

  return (
    <div className="flex flex-col items-stretch gap-3 sm:flex-row sm:items-center">
      <a
        href="#partner"
        className="focus-ring group inline-flex h-12 items-center justify-center gap-2 whitespace-nowrap rounded-full bg-ink px-6 text-[15px] font-medium text-white shadow-[0_8px_24px_-8px_rgb(11_18_32/0.5)] transition-colors hover:bg-ink/85"
      >
        Become a Design Partner
        <ArrowRight className="size-4 transition-transform group-hover:translate-x-0.5" />
      </a>
      <a
        href="#product"
        className="focus-ring inline-flex h-12 items-center justify-center whitespace-nowrap rounded-full border border-line-strong bg-surface/70 px-6 text-[15px] font-medium text-ink backdrop-blur transition-colors hover:border-ink-4 hover:bg-surface"
      >
        Explore Zephric
      </a>
    </div>
  );
}
