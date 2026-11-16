import { Page } from '@/components/ui/data';

/**
 * Shown inside the app frame while a page's data loads: the sidebar stays put
 * and only the content area waits. Shapes, not a spinner, and nothing from any
 * organisation until the real page arrives.
 */
export default function AppLoading() {
  const bar = 'rounded-md bg-sunken animate-shimmer';
  return (
    <Page>
      <div role="status" aria-label="Loading" className="animate-in">
        <div className={`${bar} h-7 w-56`} />
        <div className={`${bar} mt-2.5 h-4 w-80 max-w-full`} />
        <div className="mt-8 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {Array.from({ length: 4 }, (_, i) => (
            <div key={i} className="rounded-xl border border-line bg-surface p-4">
              <div className={`${bar} h-3 w-20`} />
              <div className={`${bar} mt-3 h-6 w-28`} />
            </div>
          ))}
        </div>
        <div className="mt-6 rounded-xl border border-line bg-surface">
          {Array.from({ length: 6 }, (_, i) => (
            <div key={i} className="flex items-center gap-4 border-b border-line px-4 py-3.5 last:border-0">
              <div className={`${bar} h-4 w-40`} />
              <div className={`${bar} ml-auto h-4 w-24`} />
              <div className={`${bar} h-4 w-16`} />
            </div>
          ))}
        </div>
      </div>
    </Page>
  );
}
