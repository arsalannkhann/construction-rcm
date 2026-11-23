import { AlertTriangle, ArrowRight, CircleCheck, CircleDot, Clock, Compass, OctagonAlert } from 'lucide-react';
import Link from '@/components/ui/link';
import { getDb } from '@/db';
import { BillingByPeriod, FindingsByCategory, PipelineBar, TurnaroundTrend } from '@/components/charts';
import { OpenExampleButton } from '@/components/onboarding/example-button';
import { SetupMeter } from '@/components/onboarding/setup-guide';
import { BudgetStandingBadge } from '@/components/records/billing';
import { buttonClass } from '@/components/ui/button';
import { Avatar, Badge, EmptyState, Money, Page, PageHeader, Panel, PanelHeader, StatusBadge, Table, Td, Th } from '@/components/ui/data';
import { formatMoney, formatMoneyCompact } from '@/lib/money';
import { NEXT_ACTIONS_SHOWN, nextActions, type NextAction } from '@/lib/next-actions';
import { defaultFocus, FOCUS_LABEL } from '@/lib/onboarding';
import { setupSteps, summarizeSetup, type SetupSummary } from '@/lib/setup-guide';
import { cn, formatMonth, pluralize } from '@/lib/utils';
import { can } from '@/server/auth/permissions';
import { requireCtx } from '@/server/auth/session';
import { getDashboard } from '@/server/services/dashboard';
import { findDemoOrganization } from '@/server/services/demo';
import { getOnboardingState, getSetupProgress, noteSetupDone } from '@/server/services/onboarding';
import { FINDING_CATEGORY_LABEL, type MemberFocus } from '@/server/types';

export const metadata = { title: 'Overview' };

const RISKS_SHOWN = 8;

/** The order of the overview's sections for each focus. What a person mostly does comes first; nothing is hidden from anyone. */
const SECTIONS: Record<MemberFocus, Array<'tiles' | 'open' | 'periods' | 'risks' | 'projects' | 'team'>> = {
  review: ['tiles', 'open', 'periods', 'risks', 'projects', 'team'],
  approve: ['tiles', 'open', 'risks', 'periods', 'projects', 'team'],
  oversee: ['tiles', 'risks', 'periods', 'projects', 'team', 'open'],
  projects: ['projects', 'risks', 'tiles', 'periods', 'open', 'team'],
};

export default async function OverviewPage() {
  const ctx = await requireCtx();
  const db = await getDb();
  const [d, state] = await Promise.all([getDashboard(db, ctx), getOnboardingState(db, ctx)]);
  const canUpload = can(ctx.role, 'application:upload');
  const focus = state.member?.focus ?? defaultFocus(ctx.role);

  // Setup is only counted while it is still being offered: not in the example, and not once it is finished or put away.
  const guideOpen = !ctx.isDemo && !state.member?.setupDoneAt;
  const setup = guideOpen ? summarizeSetup(setupSteps(await getSetupProgress(db, ctx, state), ctx.role)) : null;
  if (setup?.complete) await noteSetupDone(db, ctx, state);

  if (d.setup.applications === 0) {
    const hasDemo = ctx.isDemo || (await findDemoOrganization(db, ctx.userId)) !== null;
    return (
      <Page width="narrow">
        <PageHeader title={`Welcome to ${ctx.orgName}`} description="Nothing has been billed here yet. This is the shortest path to your first reviewed billing package, and you do not need to connect any other software first." />
        {setup ? <SetupNext setup={setup} first /> : null}
        {!ctx.isDemo ? (
          <Panel className="mt-4 flex flex-wrap items-start gap-4 p-5">
            <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-accent-soft text-accent-ink">
              <Compass className="size-[18px]" />
            </span>
            <div className="min-w-[240px] flex-1">
              <h2 className="text-sm font-medium">See it working first</h2>
              <p className="mt-1 max-w-[60ch] text-[13px] leading-[1.55] text-ink-2">
                The example workspace has fictitious projects and five months of billing already in it, including pay applications with real problems to find, and a two-minute tour. It is separate from {ctx.orgName} and can be deleted in one step.
              </p>
              <div className="mt-3">
                <OpenExampleButton hasExample={hasDemo} />
              </div>
            </div>
          </Panel>
        ) : null}
      </Page>
    );
  }

  const k = d.kpis;
  const approvedDelta = k.approvedLastMonth.amount ? ((k.approvedThisMonth.amount - k.approvedLastMonth.amount) / k.approvedLastMonth.amount) * 100 : null;
  const billed = d.monthly.some((m) => m.requested > 0 || m.approved > 0);
  const trend = d.turnaroundTrend;
  const month = formatMonth(new Date().toISOString().slice(0, 7));
  const actions = nextActions(d, { role: ctx.role, focus, userId: ctx.userId });

  const sections = {
    tiles: (
      <div className="grid grid-cols-2 gap-4 xl:grid-cols-4">
        <Tile label="Awaiting review" href="/applications?view=attention" value={String(k.awaitingReview.count)} unit={pluralize(k.awaitingReview.count, 'application').replace(/^\S+ /, '')} sub={k.awaitingReview.count ? `${formatMoney(k.awaitingReview.amount)} to verify` : 'Nothing waiting'} />
        <Tile
          label="Pending approval"
          href={can(ctx.role, 'application:approve') ? '/applications?view=attention' : '/applications?view=pending'}
          value={String(k.pendingApproval.count)}
          unit={pluralize(k.pendingApproval.count, 'application').replace(/^\S+ /, '')}
          sub={k.pendingApproval.count ? `${formatMoney(k.pendingApproval.amount)} ready to approve` : k.onHold.count ? `${k.onHold.count} awaiting a subcontractor` : 'Nothing waiting'}
        />
        <Tile
          label={`Approved in ${month}`}
          href="/applications?view=approved"
          value={formatMoneyCompact(k.approvedThisMonth.amount)}
          sub={
            `${pluralize(k.approvedThisMonth.count, 'application')}` +
            (approvedDelta !== null ? ` · ${approvedDelta >= 0 ? '+' : '−'}${Math.abs(approvedDelta).toFixed(0)}% vs last month` : k.approvedLastMonth.count === 0 ? '' : '')
          }
        />
        <Tile
          label="Requested above verified"
          href="/applications?view=attention"
          tone={k.overAsk.amount > 0 ? 'block' : 'pass'}
          value={formatMoneyCompact(k.overAsk.amount)}
          sub={k.overAsk.count ? `on ${pluralize(k.overAsk.count, 'open application')}` : 'No open application is over its verified amount'}
        />
      </div>
    ),
    periods: (
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-3">
        <Panel className="xl:col-span-2">
          <PanelHeader title="Billing by period" description="What subcontractors requested for each billing month, and what has been approved for it." />
          <div className="px-4 pb-4 pt-4">{billed ? <BillingByPeriod data={d.monthly} /> : <EmptyState className="py-10" title="No billing periods yet" description="This fills in as applications are read and approved." />}</div>
        </Panel>

        <Panel>
          <PanelHeader title="Open work" description="Applications that have not been decided." />
          <div className="px-4 py-4">
            <PipelineBar
              segments={[
                { key: 'needs_matching', label: 'Needs matching', tone: 'neutral', href: '/applications?view=attention', ...pick(d.pipeline, 'needs_matching') },
                { key: 'needs_review', label: 'Needs review', tone: 'warn', href: '/applications?view=attention', ...pick(d.pipeline, 'needs_review') },
                { key: 'pending_approval', label: 'Pending approval', tone: 'accent', href: can(ctx.role, 'application:approve') ? '/applications?view=attention' : '/applications?view=pending', ...pick(d.pipeline, 'pending_approval') },
                { key: 'on_hold', label: 'Awaiting subcontractor', tone: 'quiet', href: '/applications?view=hold', ...pick(d.pipeline, 'on_hold') },
              ]}
            />
          </div>
          <dl className="grid grid-cols-2 border-t border-line">
            <div className="border-r border-line px-4 py-3">
              <dt className="text-[10.5px] font-medium uppercase tracking-wide text-ink-3">Retainage held</dt>
              <dd className="mt-0.5 text-[17px] font-semibold tracking-tight">
                <Money cents={k.retainageHeld} />
              </dd>
              <dd className="text-[11px] text-ink-3">across approved billing</dd>
            </div>
            <div className="px-4 py-3">
              <dt className="text-[10.5px] font-medium uppercase tracking-wide text-ink-3">Awaiting transfer</dt>
              <dd className="mt-0.5 text-[17px] font-semibold tracking-tight">
                <Link href="/transfers" className="hover:underline">
                  <Money cents={k.awaitingTransfer.amount} />
                </Link>
              </dd>
              <dd className={cn('text-[11px]', k.failedTransfers ? 'font-medium text-block' : 'text-ink-3')}>
                {k.failedTransfers ? `${pluralize(k.failedTransfers, 'transfer')} failed` : `${pluralize(k.awaitingTransfer.count, 'approved application')} not yet exported`}
              </dd>
            </div>
          </dl>
        </Panel>
      </div>
    ),
    open: (
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-3">
        <Panel className="xl:col-span-2">
          <PanelHeader
            title="Oldest open applications"
            description="Longest-waiting first."
            actions={
              <Link href="/applications" className="flex items-center gap-1 text-xs font-medium text-accent hover:underline">
                All applications <ArrowRight className="size-3" />
              </Link>
            }
          />
          {d.attention.length === 0 ? (
            <EmptyState className="py-10" title="Nothing is open" description="Every application received has been decided." />
          ) : (
            <Table>
              <thead>
                <tr>
                  <Th className="pl-4">Subcontractor</Th>
                  <Th>Project</Th>
                  <Th align="right">Requested</Th>
                  <Th>Findings</Th>
                  <Th align="right">Open</Th>
                  <Th className="pr-4">Status</Th>
                </tr>
              </thead>
              <tbody>
                {d.attention.map((a) => (
                  <tr key={a.id} className="relative hover:bg-canvas/70">
                    <Td className="pl-4">
                      <Link href={`/applications/${a.id}`} className="font-medium after:absolute after:inset-0">
                        {a.subcontractor}
                      </Link>
                      <span className="ml-1.5 text-ink-3">{a.applicationNumber !== null ? `#${a.applicationNumber}` : ''}</span>
                    </Td>
                    <Td className="max-w-[200px] truncate text-ink-2">{a.project ?? <span className="text-ink-4">Not matched</span>}</Td>
                    <Td align="right">
                      <Money cents={a.amount} />
                    </Td>
                    <Td>
                      {a.status === 'needs_matching' ? (
                        <span className="text-xs text-ink-3">Not verified yet</span>
                      ) : (
                        <span className="flex items-center gap-1">
                          {a.blocking ? <Badge tone="block">{a.blocking} blocking</Badge> : null}
                          {a.warnings ? <Badge tone="warn">{a.warnings}</Badge> : null}
                          {!a.blocking && !a.warnings ? <Badge tone="pass">Clear</Badge> : null}
                        </span>
                      )}
                    </Td>
                    <Td align="right" className={cn(a.ageDays >= 5 && 'font-medium text-warn')}>
                      {a.ageDays === 0 ? 'Today' : `${a.ageDays} d`}
                    </Td>
                    <Td className="pr-4">
                      <StatusBadge status={a.status} />
                    </Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </Panel>

        <Panel>
          <PanelHeader title="Open findings by kind" description="What is holding applications up right now." />
          <div className="px-4 py-4">
            {d.findingsByCategory.length === 0 ? (
              <p className="py-6 text-center text-[13px] text-ink-3">No open findings.</p>
            ) : (
              <FindingsByCategory data={d.findingsByCategory.map((c) => ({ label: FINDING_CATEGORY_LABEL[c.category], blocking: c.blocking, warnings: c.warnings }))} />
            )}
          </div>
          {k.shortPaid.count > 0 ? (
            <p className="border-t border-line px-4 py-3 text-xs text-ink-2">
              In the last 90 days, <span className="font-medium text-ink">{pluralize(k.shortPaid.count, 'application')}</span> {k.shortPaid.count === 1 ? 'was' : 'were'} approved for less than requested, a total of{' '}
              <span className="num font-medium text-ink">{formatMoney(k.shortPaid.amount)}</span> not paid.
            </p>
          ) : null}
        </Panel>
      </div>
    ),
    risks: (
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-3">
        <Panel className="xl:col-span-2">
          <PanelHeader title="Cost and billing risks" description="Rules run over your records: budgets, pending change orders and missed billing periods. Each links to what it is about." />
          {d.risks.length === 0 ? (
            <p className="px-4 py-8 text-center text-[13px] text-ink-3">No project is over or close to its budget, no subcontract has large pending changes, and nobody missed last period’s billing.</p>
          ) : (
            <ul className="divide-y divide-line">
              {d.risks.slice(0, RISKS_SHOWN).map((r) => (
                <li key={r.key} className="relative flex items-start gap-3 px-4 py-2.5 hover:bg-canvas/70">
                  {r.tone === 'block' ? <OctagonAlert className="mt-0.5 size-4 shrink-0 text-block" aria-label="Needs action" /> : <AlertTriangle className="mt-0.5 size-4 shrink-0 text-warn" aria-label="Watch" />}
                  <div className="min-w-0">
                    <Link href={r.href} className="text-[13px] font-medium after:absolute after:inset-0">
                      {r.title}
                    </Link>
                    <p className="text-xs text-ink-3">{r.detail}</p>
                  </div>
                </li>
              ))}
              {d.risks.length > RISKS_SHOWN ? <li className="px-4 py-2.5 text-xs text-ink-3">and {pluralize(d.risks.length - RISKS_SHOWN, 'more')}.</li> : null}
            </ul>
          )}
        </Panel>

        <Panel>
          <PanelHeader
            title="Billing periods"
            description="Applications expected from subcontracts that are billing."
            actions={
              <Link href="/billing" className="flex items-center gap-1 text-xs font-medium text-accent hover:underline">
                Open <ArrowRight className="size-3" />
              </Link>
            }
          />
          <dl className="divide-y divide-line">
            {[
              { p: d.billing.last, label: formatMonth(d.billing.last.month), closed: true },
              { p: d.billing.current, label: `${formatMonth(d.billing.current.month)} (current)`, closed: false },
            ].map(({ p, label, closed }) => (
              <div key={p.month} className="px-4 py-3">
                <dt className="flex items-center justify-between gap-2 text-[12.5px] font-medium">
                  <Link href={`/billing?period=${p.month}`} className="hover:underline">
                    {label}
                  </Link>
                  {closed && p.missing ? <Badge tone="block">{p.missing} missing</Badge> : !closed && p.due ? <Badge tone="warn">{p.due} not received yet</Badge> : p.expected ? <Badge tone="pass">All in</Badge> : null}
                </dt>
                <dd className="mt-1 text-xs text-ink-3">
                  {p.expected ? (
                    <>
                      {p.received} of {pluralize(p.expected, 'expected application')} received, {p.approved} approved, <span className="num">{formatMoney(p.approvedAmount)}</span> approved for payment
                    </>
                  ) : (
                    'No applications expected.'
                  )}
                </dd>
              </div>
            ))}
          </dl>
        </Panel>
      </div>
    ),
    projects: (
      <Panel>
        <PanelHeader title="Projects" description="Committed subcontract value against approved billing, and against each project’s budget where one is set." />
        {d.projects.length === 0 ? (
          <EmptyState className="py-10" title="No projects" description="Add a project to see its billing position here." />
        ) : (
          <Table>
            <thead>
              <tr>
                <Th className="pl-4">Project</Th>
                <Th align="right">Subcontracts</Th>
                <Th align="right">Committed</Th>
                <Th className="w-[190px]">Completed &amp; stored</Th>
                <Th align="right">Approved for payment</Th>
                <Th align="right">Retainage held</Th>
                <Th align="right">Balance to finish</Th>
                <Th className="pr-4" align="right">
                  In review
                </Th>
              </tr>
            </thead>
            <tbody>
              {d.projects.map((p) => (
                <tr key={p.id} className="relative hover:bg-canvas/70">
                  <Td className="pl-4">
                    <Link href={`/projects/${p.id}`} className="font-medium after:absolute after:inset-0">
                      {p.name}
                    </Link>
                    <div className="text-xs text-ink-3">{[p.number, p.state].filter(Boolean).join(' · ')}</div>
                    {p.cost.budget !== null ? (
                      <div className="mt-0.5">
                        <BudgetStandingBadge cost={p.cost} />
                      </div>
                    ) : null}
                  </Td>
                  <Td align="right">{p.contracts}</Td>
                  <Td align="right">
                    <Money cents={p.committed} />
                  </Td>
                  <Td>
                    <div className="flex items-center gap-2">
                      <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-sunken">
                        <div className="h-full rounded-full bg-ink" style={{ width: `${Math.min(100, p.percent ?? 0)}%` }} />
                      </div>
                      <span className="num w-10 text-right text-xs text-ink-2">{p.percent === null ? '—' : `${p.percent.toFixed(0)}%`}</span>
                    </div>
                  </Td>
                  <Td align="right">
                    <Money cents={p.approvedToDate} />
                  </Td>
                  <Td align="right">
                    <Money cents={p.retainageHeld} />
                  </Td>
                  <Td align="right">
                    <Money cents={p.balanceToFinish} />
                  </Td>
                  <Td align="right" className="pr-4">
                    {p.openApplications || <span className="text-ink-4">—</span>}
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Panel>
    ),
    team: (
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-3">
        <Panel className="xl:col-span-2">
          <PanelHeader title="Team workload" description="Open applications by assigned reviewer." />
          {d.workload.length === 0 ? (
            <EmptyState className="py-10" title="No open applications" />
          ) : (
            <Table>
              <thead>
                <tr>
                  <Th className="pl-4">Reviewer</Th>
                  <Th align="right">Open</Th>
                  <Th align="right">Amount</Th>
                  <Th align="right">Blocking findings</Th>
                  <Th className="pr-4" align="right">
                    Oldest
                  </Th>
                </tr>
              </thead>
              <tbody>
                {d.workload.map((w) => (
                  <tr key={w.userId ?? 'none'}>
                    <Td className="pl-4">
                      <span className="flex items-center gap-2">
                        {w.userId ? <Avatar name={w.name} /> : <span className="flex size-6 items-center justify-center rounded-full border border-dashed border-line-strong text-ink-4">?</span>}
                        <span className={cn(!w.userId && 'text-ink-2')}>{w.name}</span>
                      </span>
                    </Td>
                    <Td align="right" className="font-medium">
                      {w.count}
                    </Td>
                    <Td align="right">
                      <Money cents={w.amount} />
                    </Td>
                    <Td align="right">{w.blocking || <span className="text-ink-4">—</span>}</Td>
                    <Td align="right" className={cn('pr-4', w.oldestDays >= 5 && 'font-medium text-warn')}>
                      {w.oldestDays === 0 ? 'Today' : `${w.oldestDays} d`}
                    </Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </Panel>

        <Panel>
          <PanelHeader title="Turnaround" description="Average days from receipt to decision, by month decided." />
          <div className="px-4 py-4">
            <div className="mb-3 flex items-baseline gap-2">
              <span className="text-2xl font-semibold tracking-tight">{k.turnaroundDays === null ? '—' : k.turnaroundDays.toFixed(1)}</span>
              <span className="text-xs text-ink-3">{k.turnaroundDays === null ? 'No decisions in the last 90 days' : `days, over ${pluralize(k.turnaroundSample, 'decision')} in the last 90 days`}</span>
            </div>
            {trend.some((t) => t.value !== null) ? <TurnaroundTrend data={trend} /> : null}
          </div>
        </Panel>
      </div>
    ),
  };

  return (
    <Page width="wide">
      <PageHeader
        title="Overview"
        description={`What needs attention at ${ctx.orgName}, then where billing stands. Every figure is computed from the records.`}
        actions={
          canUpload ? (
            <Link href="/applications/new" className={buttonClass({ variant: 'primary' })}>
              Upload package
            </Link>
          ) : null
        }
      />

      <NeedsYou actions={actions} focus={focus} canChange={!ctx.isDemo} />

      {setup && !setup.complete && !state.member?.guideHiddenAt ? (
        <div className="mt-4">
          <SetupNext setup={setup} />
        </div>
      ) : null}

      <div className="mt-4 space-y-4">
        {SECTIONS[focus].map((key) => (
          <div key={key}>{sections[key]}</div>
        ))}
      </div>
    </Page>
  );
}

const ACTION_ICON = { block: OctagonAlert, warn: AlertTriangle, accent: CircleDot, neutral: Clock } as const;
const ACTION_TONE = { block: 'bg-block-soft text-block', warn: 'bg-warn-soft text-warn', accent: 'bg-accent-soft text-accent-ink', neutral: 'bg-sunken text-ink-3' } as const;

/** The first thing on the overview: what this person can act on now, most pressing first. */
function NeedsYou({ actions, focus, canChange }: { actions: NextAction[]; focus: MemberFocus; canChange: boolean }) {
  const shown = actions.slice(0, NEXT_ACTIONS_SHOWN);
  return (
    <Panel data-tour="needs-you">
      <PanelHeader
        title="Needs you"
        description={shown.length ? 'Most pressing first. Each line opens exactly the records it counts.' : undefined}
        actions={
          <span className="text-xs text-ink-3">
            Ordered for: {FOCUS_LABEL[focus].toLowerCase()}
            {canChange ? (
              <>
                {' · '}
                <Link href="/start" className="font-medium text-ink-2 hover:text-ink hover:underline">
                  Change
                </Link>
              </>
            ) : null}
          </span>
        }
      />
      {shown.length === 0 ? (
        <div className="flex items-center gap-3 px-4 py-5">
          <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-pass-soft text-pass">
            <CircleCheck className="size-[18px]" />
          </span>
          <div>
            <p className="text-sm font-medium">Nothing is waiting on you</p>
            <p className="text-[13px] text-ink-3">No application needs review or a decision, nothing failed, and nobody missed last period’s billing.</p>
          </div>
        </div>
      ) : (
        <ul className="divide-y divide-line">
          {shown.map((a, i) => {
            const Icon = ACTION_ICON[a.tone];
            return (
              <li key={a.key} className="relative flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3 hover:bg-canvas/70">
                <span className={cn('flex size-8 shrink-0 items-center justify-center rounded-full', ACTION_TONE[a.tone])}>
                  <Icon className="size-4" aria-hidden />
                </span>
                <div className="min-w-[200px] flex-1">
                  <Link href={a.href} className="text-sm font-medium after:absolute after:inset-0">
                    {a.title}
                  </Link>
                  <p className="text-[13px] text-ink-3">{a.detail}</p>
                </div>
                <span className={cn(buttonClass({ variant: i === 0 ? 'primary' : 'secondary' }), 'pointer-events-none')} aria-hidden>
                  {a.cta}
                  <ArrowRight className="size-3.5" />
                </span>
              </li>
            );
          })}
          {actions.length > shown.length ? <li className="px-4 py-2.5 text-xs text-ink-3">and {actions.length - shown.length} more further down this page.</li> : null}
        </ul>
      )}
    </Panel>
  );
}

/** Where setup stands, and the one step to do next. The whole list is on the guide page. */
function SetupNext({ setup, first = false }: { setup: SetupSummary; first?: boolean }) {
  const next = setup.next;
  if (!next) return null;
  return (
    <Panel>
      <div className="flex flex-wrap items-center gap-x-6 gap-y-2 border-b border-line px-5 py-3.5">
        <h2 className="text-[13px] font-semibold">{first ? 'Get started' : 'Finish setting up'}</h2>
        <SetupMeter summary={setup} className="min-w-[200px] flex-1" />
        <Link href="/get-started" className="flex items-center gap-1 text-xs font-medium text-accent hover:underline">
          All {setup.total} steps <ArrowRight className="size-3" />
        </Link>
      </div>
      <div className="flex flex-wrap items-start gap-x-6 gap-y-3 px-5 py-4">
        <div className="min-w-[240px] flex-1">
          <p className="text-[11px] font-medium uppercase tracking-wide text-accent-ink">Next step</p>
          <h3 className={cn('mt-1 font-medium', first ? 'text-[17px] tracking-[-0.01em]' : 'text-sm')}>{next.title}</h3>
          <p className="mt-1 max-w-[62ch] text-[13px] leading-[1.55] text-ink-2">{next.body}</p>
          {first && next.hint ? <p className="mt-2 max-w-[62ch] text-[12.5px] leading-[1.55] text-ink-3">{next.hint}</p> : null}
        </div>
        {next.allowed ? (
          <Link href={next.href} className={buttonClass({ variant: 'primary', size: first ? 'lg' : 'md' })}>
            {next.cta}
            <ArrowRight className="size-4" />
          </Link>
        ) : (
          <p className="max-w-[220px] text-xs leading-[1.5] text-ink-3">{next.who} Your role cannot do this step.</p>
        )}
      </div>
    </Panel>
  );
}

function pick(pipeline: Array<{ status: string; count: number; amount: number }>, status: string) {
  const row = pipeline.find((p) => p.status === status);
  return { count: row?.count ?? 0, amount: row?.amount ?? 0 };
}

function Tile({ label, value, unit, sub, href, tone }: { label: string; value: string; unit?: string; sub?: string; href: string; tone?: 'block' | 'pass' }) {
  return (
    <Link href={href} className="focus-ring group rounded-xl border border-line bg-surface px-4 py-3.5 shadow-card transition-colors hover:border-line-strong">
      <div className="text-[11px] font-medium uppercase tracking-wide text-ink-3">{label}</div>
      <div className="mt-1.5 flex items-baseline gap-1.5">
        <span className={cn('num text-[26px] font-semibold leading-8 tracking-tight', tone === 'block' ? 'text-block' : 'text-ink')}>{value}</span>
        {unit ? <span className="text-xs text-ink-3">{unit}</span> : null}
      </div>
      {sub ? <div className="mt-0.5 text-xs text-ink-2">{sub}</div> : null}
    </Link>
  );
}
