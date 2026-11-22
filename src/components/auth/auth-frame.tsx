import { Check, KeyRound, Lock, OctagonAlert, Users } from 'lucide-react';
import Link from 'next/link';
import { Brand } from '@/components/brand';
import type { SampleSnapshot } from '@/content/sample-types';
import snapshot from '@/content/sample-workflow.json';
import { formatMoney } from '@/lib/money';

/**
 * The frame every sign-in screen shares: the form on the left, a quiet brand
 * panel on the right (wide screens only). The logo always leads to the public
 * homepage. The panel shows what Zephric does in three check rows, never
 * marketing copy or anything that moves for long.
 */
export function AuthFrame({ children, wide }: { children: React.ReactNode; wide?: boolean }) {
  // The panel's three rows are the sample package's own results (src/content/sample-types.ts), not invented ones.
  const sample = snapshot as SampleSnapshot;
  const finding = sample.findings[0];
  const rows = [
    { ok: true, title: 'Contract sum', detail: `Matches the subcontract and its approved change orders · ${formatMoney(sample.contract.contractSumToDate)}` },
    { ok: true, title: 'Schedule of values', detail: `${sample.lines.length} lines read, each one agrees with the schedule` },
    { ok: false, title: finding?.category ?? 'Prior billing', detail: `${finding?.difference ?? ''} against what was approved · blocks approval` },
  ];
  return (
    <div className="flex min-h-dvh bg-surface">
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center px-6 py-5 sm:px-10 sm:py-7">
          <Link href="/" className="focus-ring -m-1.5 rounded-lg p-1.5 transition-opacity hover:opacity-80" aria-label="Zephric home">
            <Brand className="h-[26px]" priority />
          </Link>
        </header>
        <main className="flex flex-1 items-start justify-center px-6 pb-16 pt-[6vh] sm:px-10 lg:items-center lg:pt-0">
          <div className={`w-full animate-rise ${wide ? 'max-w-[520px]' : 'max-w-[392px]'}`}>{children}</div>
        </main>
        <footer className="flex flex-wrap items-center gap-x-5 gap-y-1 px-6 py-5 text-[12px] text-ink-4 sm:px-10">
          <span>© 2026 Zephric</span>
          <Link href="/" className="hover:text-ink-2">
            Zephric website
          </Link>
          <Link href="/sample" className="hover:text-ink-2">
            Sample workflow
          </Link>
          <span className="hidden sm:inline">Billing intake, verification and approval for general contractors.</span>
        </footer>
      </div>

      <aside aria-hidden className="relative hidden w-[44%] max-w-[640px] shrink-0 overflow-hidden bg-navy lg:block">
        <div className="ledger-grid-dark absolute inset-0 [mask-image:radial-gradient(ellipse_90%_70%_at_70%_40%,#000_30%,transparent_85%)]" />
        {/* The Z's diagonal, as a single hairline across the panel. */}
        <div className="brand-gradient absolute -right-10 top-[93%] h-px w-[130%] origin-right -rotate-[16deg] opacity-40" />
        <div className="relative flex h-full flex-col justify-between p-12 xl:p-16">
          <p className="text-[12px] font-medium uppercase tracking-[0.16em] text-aqua">Zephric</p>

          <div>
            <p className="max-w-[420px] text-[30px] font-semibold leading-[1.15] tracking-[-0.025em] text-white xl:text-[34px]">
              Every figure recomputed. Every decision on the record.
            </p>
            <p className="mt-4 max-w-[400px] text-[14px] leading-[1.6] text-white/55">What Zephric found on its sample billing package, before anyone looked at it:</p>
            <ul className="mt-5 max-w-[420px] space-y-2.5">
              {rows.map((row, i) => (
                <li
                  key={row.title}
                  className="flex animate-rise items-start gap-3 rounded-xl border border-navy-line bg-navy-2/80 px-4 py-3 backdrop-blur"
                  style={{ animationDelay: `${200 + i * 120}ms` }}
                >
                  <span className={`mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full ${row.ok ? 'bg-aqua/15 text-aqua' : 'bg-[#f87060]/15 text-[#ff8a7a]'}`}>
                    {row.ok ? <Check className="size-3" strokeWidth={3} /> : <OctagonAlert className="size-3" strokeWidth={2.5} />}
                  </span>
                  <span>
                    <span className="block text-[13.5px] font-medium text-white">{row.title}</span>
                    <span className="block text-[12.5px] text-white/50">{row.detail}</span>
                  </span>
                </li>
              ))}
            </ul>
          </div>

          <ul className="flex flex-wrap gap-x-6 gap-y-2 text-[12.5px] text-white/45">
            <li className="flex items-center gap-2">
              <KeyRound className="size-3.5" /> Two-step verification
            </li>
            <li className="flex items-center gap-2">
              <Lock className="size-3.5" /> Records kept per organization
            </li>
            <li className="flex items-center gap-2">
              <Users className="size-3.5" /> Role-based approvals
            </li>
          </ul>
        </div>
      </aside>
    </div>
  );
}

/** The heading block at the top of each sign-in screen. */
export function AuthHeading({ title, children }: { title: React.ReactNode; children?: React.ReactNode }) {
  return (
    <div>
      <h1 className="text-[26px] font-semibold leading-tight tracking-[-0.025em] text-ink">{title}</h1>
      {children ? <p className="mt-2 text-[14px] leading-relaxed text-ink-2">{children}</p> : null}
    </div>
  );
}
