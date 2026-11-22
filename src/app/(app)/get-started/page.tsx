import { Compass, PartyPopper } from 'lucide-react';
import { getDb } from '@/db';
import { OpenExampleButton, StartOwnSetupButton } from '@/components/onboarding/example-button';
import { GuideVisibilityButton } from '@/components/onboarding/guide-visibility';
import { SetupFollowUps, SetupMeter, SetupSteps } from '@/components/onboarding/setup-guide';
import { StartTourButton } from '@/components/tour/start-tour-button';
import { buttonClass } from '@/components/ui/button';
import { Page, PageHeader, Panel, PanelHeader } from '@/components/ui/data';
import Link from '@/components/ui/link';
import { kindNote, regionNote } from '@/lib/onboarding';
import { setupFollowUps, setupSteps, summarizeSetup } from '@/lib/setup-guide';
import { requireCtx } from '@/server/auth/session';
import { findDemoOrganization } from '@/server/services/demo';
import { getOnboardingState, getSetupProgress } from '@/server/services/onboarding';

export const metadata = { title: 'Get started' };

/**
 * The setup guide. Every step's state is read from the organisation's records,
 * so the guide can be left and come back to at any point, by anyone on the
 * team, and it shows where things really stand.
 */
export default async function GetStartedPage() {
  const ctx = await requireCtx();
  const db = await getDb();
  const state = await getOnboardingState(db, ctx);
  const [progress, demoOrgId] = await Promise.all([getSetupProgress(db, ctx, state), ctx.isDemo ? Promise.resolve(ctx.orgId) : findDemoOrganization(db, ctx.userId)]);
  const steps = setupSteps(progress, ctx.role);
  const summary = summarizeSetup(steps);
  const followUps = setupFollowUps(progress, ctx.role);
  const notes = state.profile ? [kindNote(state.profile.kind), state.profile.kind === 'general_contractor' && state.profile.region === 'us' ? null : regionNote(state.profile.region)].filter((n): n is string => !!n) : [];

  if (ctx.isDemo) {
    return (
      <Page width="narrow">
        <PageHeader title="Get started" description="You are in the example workspace, which is already set up so there is something to look at." />
        <Panel className="p-5">
          <h2 className="text-sm font-medium">Take the tour, or set up your own</h2>
          <p className="mt-1 max-w-[60ch] text-[13px] leading-[1.55] text-ink-2">The tour follows one billing package from the queue to a decision. When you are ready for your own documents, the setup guide is in your organisation.</p>
          <div className="mt-4 flex flex-wrap gap-2">
            <StartTourButton tour="review" variant="primary" size="lg">
              Take the tour
            </StartTourButton>
            <StartOwnSetupButton size="lg">Set up my own project</StartOwnSetupButton>
          </div>
        </Panel>
      </Page>
    );
  }

  return (
    <Page width="narrow">
      <PageHeader
        title={summary.complete ? 'You are set up' : 'Get started'}
        description={
          summary.complete
            ? `${ctx.orgName} has been through the whole path: a project, a subcontract, a billing package and a decision.`
            : 'From an empty workspace to your first reviewed billing package. Leave whenever you like: this page picks up from what is already there.'
        }
      />

      {notes.length ? (
        <div className="mb-4 rounded-xl border border-warn-line bg-warn-soft px-4 py-3 text-[13px] leading-[1.55] text-warn">
          {notes.map((n) => (
            <p key={n} className="[&+p]:mt-1.5">
              {n}
            </p>
          ))}
        </div>
      ) : null}

      <Panel>
        <div className="flex flex-wrap items-center gap-x-6 gap-y-2 border-b border-line px-5 py-3.5">
          <h2 className="text-[13px] font-semibold">{summary.complete ? 'Every step is done' : summary.next ? `Next: ${summary.next.title}` : 'Setup'}</h2>
          <SetupMeter summary={summary} className="min-w-[200px] flex-1" />
        </div>
        {summary.complete ? (
          <div className="flex items-start gap-3.5 px-5 py-5">
            <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-pass-soft text-pass">
              <PartyPopper className="size-[18px]" />
            </span>
            <div>
              <p className="text-sm font-medium">The first one is the hard one.</p>
              <p className="mt-1 max-w-[60ch] text-[13px] leading-[1.55] text-ink-2">From here each billing package follows the same path: it arrives, it is read and checked, and your team decides with the evidence in front of them.</p>
              <div className="mt-3 flex flex-wrap gap-2">
                <Link href="/overview" className={buttonClass({ variant: 'primary' })}>
                  Go to the overview
                </Link>
                <Link href="/applications/new" className={buttonClass()}>
                  Upload another package
                </Link>
              </div>
            </div>
          </div>
        ) : null}
        <SetupSteps steps={steps} />
      </Panel>

      <Panel className="mt-4">
        <PanelHeader title="When the first one is through" description="Worth doing early, but never in the way of the steps above." />
        <SetupFollowUps items={followUps} />
      </Panel>

      <Panel className="mt-4 flex flex-wrap items-start gap-4 p-5">
        <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-accent-soft text-accent-ink">
          <Compass className="size-[18px]" />
        </span>
        <div className="min-w-[240px] flex-1">
          <h2 className="text-sm font-medium">Not ready to enter your own records?</h2>
          <p className="mt-1 max-w-[60ch] text-[13px] leading-[1.55] text-ink-2">The example workspace has fictitious projects and five months of billing already in it, with a short tour. It is separate from {ctx.orgName} and can be deleted in one step.</p>
          <div className="mt-3">
            <OpenExampleButton hasExample={demoOrgId !== null} />
          </div>
        </div>
      </Panel>

      {!summary.complete ? (
        <p className="mt-5 text-center">
          <GuideVisibilityButton hidden={!!state.member?.guideHiddenAt} />
        </p>
      ) : null}
    </Page>
  );
}
