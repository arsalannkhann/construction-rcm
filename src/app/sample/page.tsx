import type { Metadata } from 'next';
import Link from 'next/link';
import { Brand } from '@/components/brand';
import { SampleAccountLink } from '@/components/sample/sample-account-link';
import { SampleWorkflow } from '@/components/sample/sample-workflow';
import type { SampleSnapshot } from '@/content/sample-types';
import snapshot from '@/content/sample-workflow.json';

export const metadata: Metadata = {
  title: 'Sample workflow',
  description: 'Follow one fictitious subcontractor billing package through Zephric: read, checked against the project records, and decided by a person. No account needed.',
};

/**
 * The public sample workflow. No account, no database: the page is the saved
 * output of the product for one fictitious package (src/content/sample-types.ts),
 * so it is the same for every visitor and can be served as a static page.
 */
export default function SamplePage() {
  return (
    <div className="flex min-h-dvh flex-col bg-canvas text-ink lg:h-dvh">
      <header className="shrink-0 border-b border-line bg-surface">
        <div className="mx-auto flex h-14 w-full max-w-[1400px] items-center gap-2.5 px-3 sm:gap-3 sm:px-6">
          <Link href="/" className="focus-ring -m-1.5 shrink-0 rounded-lg p-1.5 transition-opacity hover:opacity-80" aria-label="Zephric home">
            <Brand className="h-6" priority />
          </Link>
          <span aria-hidden className="hidden h-5 w-px bg-line-strong sm:block" />
          <p className="hidden min-w-0 truncate text-[13.5px] font-medium text-ink-2 sm:block">Sample workflow</p>
          <span className="whitespace-nowrap rounded-full border border-warn-line bg-warn-soft px-2 py-0.5 text-[10.5px] font-medium uppercase tracking-[0.08em] text-warn">
            <span className="sm:hidden">Sample</span>
            <span className="hidden sm:inline">Fictitious data</span>
          </span>
          <div className="ml-auto flex items-center gap-1.5">
            <SampleAccountLink />
            <Link href="/#partner" className="focus-ring inline-flex h-9 items-center whitespace-nowrap rounded-full bg-ink px-3.5 text-[13.5px] font-medium text-white transition-colors hover:bg-ink/85">
              <span className="sm:hidden">Design partner</span>
              <span className="hidden sm:inline">Become a design partner</span>
            </Link>
          </div>
        </div>
      </header>
      <main className="flex min-h-0 flex-1 flex-col">
        <SampleWorkflow snapshot={snapshot as SampleSnapshot} />
      </main>
    </div>
  );
}
