import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getDb } from '@/db';
import { Brand } from '@/components/brand';
import { defaultFocus, focusesFor } from '@/lib/onboarding';
import { can } from '@/server/auth/permissions';
import { requireCtx } from '@/server/auth/session';
import { findDemoOrganization } from '@/server/services/demo';
import { getOnboardingState } from '@/server/services/onboarding';
import { StartFlow } from './start-flow';

export const metadata = { title: 'Welcome' };

/** Building the example workspace (about forty packages read and checked) runs in this page's action. */
export const maxDuration = 300;

/**
 * The welcome step: two short questions and a choice of where to begin. A new
 * member is brought here once (src/app/(app)/layout.tsx); after that it stays
 * reachable from Help, to change what they see first. It asks nothing whose
 * answer does not change something on screen.
 */
export default async function StartPage() {
  const ctx = await requireCtx();
  if (ctx.isDemo) redirect('/overview');
  const db = await getDb();
  const [state, demoOrgId] = await Promise.all([getOnboardingState(db, ctx), findDemoOrganization(db, ctx.userId)]);
  const firstName = ctx.userName.trim().split(/\s+/)[0] || ctx.userName;
  const returning = !!state.member?.welcomedAt;

  return (
    <div className="relative min-h-dvh bg-canvas">
      <div aria-hidden className="ledger-grid pointer-events-none absolute inset-x-0 top-0 h-[420px] [mask-image:linear-gradient(to_bottom,#000,transparent)]" />
      <header className="relative mx-auto flex w-full max-w-[1040px] items-center justify-between px-5 py-5 sm:px-8 sm:py-7">
        <Link href="/" className="focus-ring -m-1.5 rounded-lg p-1.5 transition-opacity hover:opacity-80" aria-label="Zephric home">
          <Brand className="h-[26px]" priority />
        </Link>
        <span className="truncate pl-4 text-[13px] text-ink-3">{ctx.orgName}</span>
      </header>
      <main className="relative mx-auto w-full max-w-[1040px] px-5 pb-20 pt-4 sm:px-8 sm:pt-8">
        <StartFlow
          firstName={firstName}
          orgName={ctx.orgName}
          returning={returning}
          focuses={focusesFor(ctx.role)}
          initialFocus={state.member?.focus ?? defaultFocus(ctx.role)}
          askProfile={can(ctx.role, 'org:manage')}
          initialProfile={state.profile}
          canSetUp={can(ctx.role, 'records:write')}
          hasExample={demoOrgId !== null}
        />
      </main>
    </div>
  );
}
