import { Brand } from '@/components/brand';

export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen flex-col">
      <header className="px-8 py-6">
        <Brand />
      </header>
      <main className="flex flex-1 items-start justify-center px-6 pb-24 pt-[8vh]">
        <div className="w-full max-w-[380px]">{children}</div>
      </main>
      <footer className="px-8 py-5 text-xs text-ink-4">Billing intake, verification and approval for general contractors.</footer>
    </div>
  );
}
