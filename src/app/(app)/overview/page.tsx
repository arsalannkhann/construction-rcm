import { ArrowRight, Check, CircleDashed } from 'lucide-react';
import Link from 'next/link';
import { getDb } from '@/db';
import { BillingByPeriod, FindingsByCategory, PipelineBar, TurnaroundTrend } from '@/components/charts';
import { DemoWorkspaceCard } from '@/components/demo/demo-workspace-card';
import { buttonClass } from '@/components/ui/button';
import { Avatar, Badge, EmptyState, Money, Page, PageHeader, Panel, PanelHeader, StatusBadge, Table, Td, Th } from '@/components/ui/data';
import { formatMoney, formatMoneyCompact } from '@/lib/money';
import { cn, formatMonth, pluralize } from '@/lib/utils';
import { can } from '@/server/auth/permissions';
import { requireCtx } from '@/server/auth/session';
import { getDashboard } from '@/server/services/dashboard';
import { findDemoOrganization } from '@/server/services/demo';
import { FINDING_CATEGORY_LABEL } from '@/server/types';

export const metadata = { title: 'Overview' };

export default async function OverviewPage() {
  const ctx = await requireCtx();
  const db = await getDb();
  const d = await getDashboard(db, ctx);
  const hasDemo = ctx.isDemo || (await findDemoOrganization(db, ctx.userId)) !== null;
  const canUpload = can(ctx.role, 'application:upload');

  if (d.setup.applications === 0) {
    return (
      <Page width="narrow">
        <PageHeader title={`Welcome to ${ctx.orgName}`} description="Four steps take you from an empty workspace to a verified, approval-ready pay application. You do not need to connect any other software first." />
        <GettingStarted setup={d.setup} canWrite={can(ctx.role, 'records:write')} canUpload={canUpload} canInvite={can(ctx.role, 'team:manage')} />
        {!ctx.isDemo ? (
          <div className="mt-5">
            <DemoWorkspaceCard hasDemo={hasDemo} inDemo={false} />
          </div>
        ) : null}
      </Page>
    );
  }

  const k = d.kpis;
  const approvedDelta = k.approvedLastMonth.amount ? ((k.approvedThisMonth.amount - k.approvedLastMonth.amount) / k.approvedLastMonth.amount) * 100 : null;
  const billed = d.monthly.some((m) => m.requested > 0 || m.approved > 0);
  const trend = d.turnaroundTrend;
  const month = formatMonth(new Date().toISOString().slice(0, 7));

  return (
    <Page width="wide">
      <PageHeader
        title="Overview"
        description={`Billing operations for ${ctx.orgName}. Every figure here is computed from application records.`}
        actions={
          canUpload ? (
            <Link href="/applications/new" className={buttonClass({ variant: 'primary' })}>
              Upload package
            </Link>
          ) : null
        }
      />

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

      <div className="mt-4 grid grid-cols-1 gap-4 xl:grid-cols-3">
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

      <div className="mt-4 grid grid-cols-1 gap-4 xl:grid-cols-3">
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

      <Panel className="mt-4">
        <PanelHeader title="Projects" description="Committed subcontract value against approved billing." />
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

      <div className="mt-4 grid grid-cols-1 gap-4 xl:grid-cols-3">
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

      {!ctx.isDemo && !hasDemo ? (
        <div className="mt-4">
          <DemoWorkspaceCard hasDemo={false} inDemo={false} />
        </div>
      ) : null}
    </Page>
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

function GettingStarted({ setup, canWrite, canUpload, canInvite }: { setup: { projects: number; contracts: number; applications: number; members: number }; canWrite: boolean; canUpload: boolean; canInvite: boolean }) {
  const steps = [
    {
      done: setup.projects > 0,
      title: 'Add a project',
      body: 'Name, location and owner. The state decides which statutory lien-waiver form is expected.',
      href: '/projects/new',
      cta: 'New project',
      allowed: canWrite,
    },
    {
      done: setup.contracts > 0,
      title: 'Add a subcontractor and its subcontract',
      body: 'Contract amount, retainage terms and the schedule of values. Paste the schedule from a spreadsheet, or adopt it later from the first pay application.',
      href: setup.projects > 0 ? '/contracts/new' : '/projects/new',
      cta: 'New subcontract',
      allowed: canWrite,
    },
    {
      done: setup.applications > 0,
      title: 'Upload a billing package',
      body: 'The pay application, schedule of values and lien waiver. They are read, matched to the subcontract and checked against the contract.',
      href: '/applications/new',
      cta: 'Upload package',
      allowed: canUpload,
    },
    {
      done: setup.members > 1,
      title: 'Invite your team',
      body: 'Project accountants review; controllers approve. Roles decide who can override a finding.',
      href: '/settings/team',
      cta: 'Invite teammates',
      allowed: canInvite,
    },
  ];
  const next = steps.findIndex((s) => !s.done);
  return (
    <Panel>
      <ol>
        {steps.map((s, i) => (
          <li key={s.title} className={cn('flex items-start gap-3.5 px-5 py-4', i > 0 && 'border-t border-line')}>
            <span className={cn('mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full text-xs font-semibold', s.done ? 'bg-pass-soft text-pass' : i === next ? 'bg-ink text-white' : 'bg-sunken text-ink-3')}>
              {s.done ? <Check className="size-3.5" /> : i === next ? i + 1 : <CircleDashed className="size-3.5" />}
            </span>
            <div className="min-w-0 flex-1">
              <h2 className={cn('text-sm font-medium', s.done && 'text-ink-2')}>{s.title}</h2>
              <p className="mt-0.5 text-[13px] text-ink-3">{s.body}</p>
            </div>
            {s.done ? (
              <span className="mt-1 text-xs text-pass">Done</span>
            ) : s.allowed ? (
              <Link href={s.href} className={buttonClass({ variant: i === next ? 'primary' : 'secondary' })}>
                {s.cta}
              </Link>
            ) : (
              <span className="mt-1 max-w-[140px] text-right text-xs text-ink-3">Needs an admin or accountant</span>
            )}
          </li>
        ))}
      </ol>
    </Panel>
  );
}
