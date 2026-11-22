/**
 * "Needs you": the few things on the overview that this person can act on
 * now, in the order their work suggests.
 *
 * Every line is a count or an amount taken from the organisation's records
 * (the dashboard figures), with a link to exactly those records. Nothing is
 * shown to a role that cannot act on it as if it were theirs to do, and what a
 * person said they mostly do (their focus) only changes the order.
 */
import { formatMoney } from '@/lib/money';
import { formatMonth, pluralize } from '@/lib/utils';
import { can } from '@/server/auth/permissions';
import type { MemberFocus, Role } from '@/server/types';

type Group = { count: number; amount: number };

/** The part of the dashboard this reads (src/server/services/dashboard.ts). */
export type ActionFacts = {
  kpis: { pendingApproval: Group; onHold: Group; awaitingTransfer: Group; failedTransfers: number };
  pipeline: Array<{ status: string; count: number; amount: number }>;
  workload: Array<{ userId: string | null; count: number; blocking: number; oldestDays: number }>;
  billing: { last: { month: string; missing: number }; current: { month: string; due: number } };
  risks: Array<{ key: string; tone: 'block' | 'warn'; title: string; detail: string; href: string }>;
};

export type NextAction = {
  key: string;
  tone: 'block' | 'warn' | 'accent' | 'neutral';
  title: string;
  detail: string;
  href: string;
  cta: string;
};

const ORDER: Record<MemberFocus, string[]> = {
  review: ['mine', 'review', 'matching', 'approve', 'failed', 'hold', 'export', 'missing', 'risk'],
  approve: ['approve', 'failed', 'risk', 'mine', 'review', 'matching', 'export', 'missing', 'hold'],
  oversee: ['failed', 'risk', 'approve', 'missing', 'review', 'matching', 'mine', 'export', 'hold'],
  projects: ['missing', 'risk', 'review', 'matching', 'hold', 'approve', 'mine', 'export', 'failed'],
};

export const NEXT_ACTIONS_SHOWN = 5;

export function nextActions(d: ActionFacts, who: { role: Role; focus: MemberFocus; userId: string }): NextAction[] {
  const reviews = can(who.role, 'application:review');
  const approves = can(who.role, 'application:approve');
  const exports = can(who.role, 'export:run');
  const stage = (status: string) => d.pipeline.find((p) => p.status === status) ?? { count: 0, amount: 0 };
  const needsReview = stage('needs_review');
  const needsMatching = stage('needs_matching');
  const mine = d.workload.find((w) => w.userId === who.userId);
  const out: NextAction[] = [];

  if (approves && d.kpis.pendingApproval.count > 0) {
    out.push({
      key: 'approve',
      tone: 'accent',
      title: `${pluralize(d.kpis.pendingApproval.count, 'application')} ${d.kpis.pendingApproval.count === 1 ? 'is' : 'are'} ready for your decision`,
      detail: `${formatMoney(d.kpis.pendingApproval.amount)} reviewed and waiting for approval.`,
      href: '/applications?view=attention',
      cta: 'Review and decide',
    });
  }
  if (reviews && mine && mine.count > 0) {
    out.push({
      key: 'mine',
      tone: mine.blocking > 0 ? 'warn' : 'accent',
      title: `${pluralize(mine.count, 'application')} assigned to you`,
      detail: [mine.blocking > 0 ? `${pluralize(mine.blocking, 'blocking finding')} to resolve` : 'No blocking findings', mine.oldestDays > 0 ? `the oldest has waited ${pluralize(mine.oldestDays, 'day')}` : 'all received today'].join(', ') + '.',
      href: '/applications?view=attention&mine=1',
      cta: 'Open my queue',
    });
  }
  if (needsReview.count > 0) {
    out.push({
      key: 'review',
      tone: reviews ? 'warn' : 'neutral',
      title: `${pluralize(needsReview.count, 'application')} ${needsReview.count === 1 ? 'needs' : 'need'} review`,
      detail: reviews ? `${formatMoney(needsReview.amount)} requested. Each has been read and checked, and shows what was found.` : `${formatMoney(needsReview.amount)} requested, with your reviewers now.`,
      href: '/applications?view=attention',
      cta: reviews ? 'Start reviewing' : 'See the queue',
    });
  }
  if (needsMatching.count > 0 && can(who.role, 'application:upload')) {
    out.push({
      key: 'matching',
      tone: 'warn',
      title: `${pluralize(needsMatching.count, 'package')} could not be matched to a subcontract`,
      detail: 'Nothing can be checked until each one is linked to its subcontract.',
      href: '/applications?view=attention',
      cta: 'Match them',
    });
  }
  if (exports && d.kpis.failedTransfers > 0) {
    out.push({
      key: 'failed',
      tone: 'block',
      title: `${pluralize(d.kpis.failedTransfers, 'transfer')} failed`,
      detail: 'An approved application did not reach the connected system. Nothing was lost; it can be sent again.',
      href: '/transfers',
      cta: 'See what failed',
    });
  }
  if (exports && d.kpis.awaitingTransfer.count > 0) {
    out.push({
      key: 'export',
      tone: 'neutral',
      title: `${pluralize(d.kpis.awaitingTransfer.count, 'approved application')} not exported yet`,
      detail: `${formatMoney(d.kpis.awaitingTransfer.amount)} approved and ready to hand to accounting.`,
      href: '/transfers',
      cta: 'Go to exports',
    });
  }
  if (d.billing.last.missing > 0) {
    out.push({
      key: 'missing',
      tone: 'warn',
      title: `${pluralize(d.billing.last.missing, 'subcontract')} did not bill for ${formatMonth(d.billing.last.month)}`,
      detail: 'They were billing and still have work left to bill.',
      href: `/billing?period=${d.billing.last.month}`,
      cta: 'See who',
    });
  }
  // The single most serious cost or billing risk; the rest are listed further down the page.
  // A missed billing period already has its own line above.
  const risks = d.risks.filter((r) => !r.key.startsWith('missing:'));
  const risk = risks.find((r) => r.tone === 'block') ?? (who.focus === 'oversee' || who.focus === 'projects' ? risks[0] : undefined);
  if (risk) out.push({ key: 'risk', tone: risk.tone, title: risk.title, detail: risk.detail, href: risk.href, cta: 'Look into it' });
  if (d.kpis.onHold.count > 0) {
    out.push({
      key: 'hold',
      tone: 'neutral',
      title: `${pluralize(d.kpis.onHold.count, 'application')} waiting on a subcontractor`,
      detail: 'A correction was requested. They come back to the queue when the subcontractor answers.',
      href: '/applications?view=hold',
      cta: 'See them',
    });
  }

  const order = ORDER[who.focus];
  return out.sort((a, b) => order.indexOf(a.key) - order.indexOf(b.key));
}
