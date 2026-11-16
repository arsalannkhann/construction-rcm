import { Page } from '@/components/ui/data';
import { SettingsNav } from './settings-nav';

export default function SettingsLayout({ children }: { children: React.ReactNode }) {
  return (
    <Page>
      {/* Side by side on wide screens; on narrower ones the sections sit in a row above the page. */}
      <div className="grid gap-5 lg:grid-cols-[168px_minmax(0,1fr)] lg:gap-10">
        <aside className="min-w-0">
          <div className="lg:sticky lg:top-7">
            <div className="mb-2 hidden px-2 text-[11px] font-medium uppercase tracking-wide text-ink-3 lg:block">Settings</div>
            <SettingsNav />
          </div>
        </aside>
        <div className="min-w-0">{children}</div>
      </div>
    </Page>
  );
}
