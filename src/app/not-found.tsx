import { Brand } from '@/components/brand';
import Link from '@/components/ui/link';

export const metadata = { title: 'Page not found' };

/** Any address that is not a page: says so, and offers a way back. */
export default function NotFound() {
  return (
    <div className="flex min-h-screen flex-col">
      <header className="px-8 py-6">
        <Brand />
      </header>
      <main className="flex flex-1 items-start justify-center px-6 pb-24 pt-[8vh]">
        <div className="w-full max-w-[380px]">
          <p className="text-xs font-medium uppercase tracking-wide text-ink-3">404</p>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight">This page does not exist</h1>
          <p className="mt-2 text-[13px] text-ink-2">The link may be mistyped, or the page may have moved. Nothing has been changed.</p>
          <p className="mt-6 flex gap-5 text-[13px]">
            <Link href="/overview" className="font-medium text-accent hover:underline">
              Go to the overview
            </Link>
            <Link href="/" className="font-medium text-ink-2 hover:underline">
              Zephric home
            </Link>
          </p>
        </div>
      </main>
    </div>
  );
}
