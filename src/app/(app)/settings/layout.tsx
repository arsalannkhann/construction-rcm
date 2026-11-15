import { Page } from '@/components/ui/data';
import { SettingsNav } from './settings-nav';

export default function SettingsLayout({ children }: { children: React.ReactNode }) {
  return (
    <Page>
      <div className="grid grid-cols-[168px_minmax(0,1fr)] gap-10">
        <aside>
          <div className="sticky top-7">
            <div className="mb-2 px-2 text-[11px] font-medium uppercase tracking-wide text-ink-3">Settings</div>
            <SettingsNav />
          </div>
        </aside>
        <div className="min-w-0">{children}</div>
      </div>
    </Page>
  );
}
