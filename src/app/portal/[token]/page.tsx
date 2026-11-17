import { CircleAlert, FileText, Link2Off, MessageSquareText } from 'lucide-react';
import type { Metadata } from 'next';
import { headers } from 'next/headers';
import { Brand } from '@/components/brand';
import { Badge, Money, Panel } from '@/components/ui/data';
import { cn, formatDate } from '@/lib/utils';
import { lookUpPortal, PORTAL_LIMITED, PORTAL_NOT_FOUND } from '@/server/portal-http';
import { getPortalView, longMonth, PORTAL_STATUS_LABEL, type PortalPeriod, type PortalStatus, type PortalSubmission } from '@/server/services/portal';
import { getDb } from '@/db';
import { PortalUpload } from './portal-upload';

export const dynamic = 'force-dynamic';

// The link is the credential: keep it out of search engines and out of the Referer header.
export const metadata: Metadata = { title: 'Billing portal', robots: { index: false, follow: false }, referrer: 'no-referrer' };

const TONE: Record<PortalStatus, 'neutral' | 'accent' | 'warn' | 'pass' | 'block' | 'muted'> = {
  received: 'neutral',
  in_review: 'accent',
  waiting_on_you: 'warn',
  approved: 'pass',
  rejected: 'block',
  replaced: 'muted',
  withdrawn: 'muted',
};

const VIA: Record<string, string> = { portal: 'through this page', email: 'by email', upload: 'by upload' };

function Frame({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-dvh bg-canvas">
      <header className="border-b border-line bg-surface">
        <div className="mx-auto flex max-w-3xl items-center justify-between gap-4 px-4 py-3.5 sm:px-6">
          <Brand className="h-[22px]" />
          <span className="text-xs text-ink-3">Billing portal</span>
        </div>
      </header>
      <main className="mx-auto max-w-3xl px-4 py-6 sm:px-6 sm:py-8">{children}</main>
    </div>
  );
}

function Closed({ message }: { message: string }) {
  return (
    <Frame>
      <Panel className="mx-auto max-w-md p-6 text-center">
        <div className="mx-auto flex size-10 items-center justify-center rounded-full bg-sunken text-ink-3">
          <Link2Off className="size-[18px]" />
        </div>
        <p className="mt-3 text-sm font-medium">This link cannot be used</p>
        <p className="mt-1 text-[13px] text-ink-2">{message}</p>
      </Panel>
    </Frame>
  );
}

/** What the subcontractor most needs to know about this month and last. */
function PeriodNote({ current, previous, orgName, today }: { current: PortalPeriod; previous: PortalPeriod; orgName: string; today: string }) {
  const notes: Array<{ tone: 'accent' | 'warn' | 'pass' | 'neutral'; text: string }> = [];
  const month = longMonth(current.month);
  if (current.state === 'due') {
    notes.push(
      today > current.dueOn
        ? { tone: 'warn', text: `Your application for the period ending ${month} was due on ${formatDate(current.dueOn)} and ${orgName} has not received it.` }
        : { tone: 'accent', text: `Your application for the period ending ${month} is due on ${formatDate(current.dueOn)}.` },
    );
  } else if (current.state === 'in_review' || current.state === 'on_hold' || current.state === 'approved') {
    notes.push({ tone: 'pass', text: `${orgName} has your application for the period ending ${month}.` });
  } else if (current.state === 'rejected') {
    notes.push({ tone: 'warn', text: `Your application for the period ending ${month} was rejected. See the message below, then send a corrected one.` });
  } else if (current.state === 'not_started') {
    notes.push({ tone: 'neutral', text: `Send your first application when it is ready. Each month’s is due by ${formatDate(current.dueOn)} for that month.` });
  } else if (current.state === 'complete') {
    notes.push({ tone: 'neutral', text: 'This subcontract is fully billed.' });
  }
  if (previous.state === 'missing') notes.push({ tone: 'warn', text: `${orgName} has no application from you for the period ending ${longMonth(previous.month)}.` });
  if (notes.length === 0) return null;
  const cls = { accent: 'border-accent-line bg-accent-soft text-accent-ink', warn: 'border-warn-line bg-warn-soft text-warn', pass: 'border-pass-line bg-pass-soft text-pass', neutral: 'border-line bg-surface text-ink-2' };
  return (
    <div className="space-y-2">
      {notes.map((n) => (
        <p key={n.text} className={cn('rounded-lg border px-3.5 py-2.5 text-[13px]', cls[n.tone])}>
          {n.text}
        </p>
      ))}
    </div>
  );
}

function Submission({ s, orgName }: { s: PortalSubmission; orgName: string }) {
  const title = s.applicationNumber !== null ? `Application #${s.applicationNumber}` : 'Billing package';
  return (
    <li className="px-4 py-4">
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-1.5">
        <div className="min-w-0">
          <p className="text-[14px] font-medium text-ink">
            {title}
            {s.periodTo ? <span className="font-normal text-ink-2"> · period ending {formatDate(s.periodTo)}</span> : null}
          </p>
          <p className="mt-0.5 text-xs text-ink-3">
            Received {formatDate(s.receivedAt.toISOString().slice(0, 10))} {VIA[s.via] ?? ''}
            {s.decidedAt ? ` · ${s.status === 'approved' ? 'approved' : 'rejected'} ${formatDate(s.decidedAt.toISOString().slice(0, 10))}` : ''}
          </p>
        </div>
        <Badge tone={TONE[s.status]} dot>
          {PORTAL_STATUS_LABEL[s.status]}
        </Badge>
      </div>

      {s.requested !== null || s.approved !== null ? (
        <dl className="mt-3 flex flex-wrap gap-x-8 gap-y-2">
          {s.requested !== null ? (
            <div>
              <dt className="text-[11px] uppercase tracking-wide text-ink-3">Requested this period</dt>
              <dd className="text-[14px]">
                <Money cents={s.requested} />
              </dd>
            </div>
          ) : null}
          {s.approved !== null ? (
            <div>
              <dt className="text-[11px] uppercase tracking-wide text-ink-3">Approved this period</dt>
              <dd className="text-[14px] font-medium">
                <Money cents={s.approved} />
              </dd>
            </div>
          ) : null}
        </dl>
      ) : null}

      {s.messages.length > 0 ? (
        <div className={cn('mt-3 space-y-2 rounded-lg border p-3', s.status === 'waiting_on_you' ? 'border-warn-line bg-warn-soft/60' : 'border-line bg-canvas')}>
          <p className="flex items-center gap-1.5 text-xs font-medium text-ink-2">
            <MessageSquareText className="size-3.5" />
            {s.status === 'waiting_on_you' ? `What ${orgName} needs from you` : `From ${orgName}`}
          </p>
          {s.messages.map((m) => (
            <div key={`${m.at.toISOString()}-${m.subject}`} className="text-[13px]">
              <p className="font-medium text-ink">
                {m.subject} <span className="font-normal text-ink-3">· {formatDate(m.at.toISOString().slice(0, 10))}</span>
              </p>
              <p className="mt-0.5 whitespace-pre-line text-ink-2">{m.body}</p>
            </div>
          ))}
        </div>
      ) : s.status === 'waiting_on_you' ? (
        <p className="mt-3 flex items-center gap-1.5 text-[13px] text-warn">
          <CircleAlert className="size-3.5" />
          {orgName} is waiting on something from you. Contact them for the details.
        </p>
      ) : null}

      {s.files.length > 0 ? (
        <ul className="mt-3 flex flex-wrap gap-1.5">
          {s.files.map((f, i) => (
            <li key={`${f}-${i}`} className="inline-flex max-w-full items-center gap-1 rounded-md border border-line bg-surface px-2 py-0.5 text-xs text-ink-2">
              <FileText className="size-3 shrink-0 text-ink-3" />
              <span className="truncate">{f}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </li>
  );
}

export default async function PortalPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const found = await lookUpPortal(token, await headers());
  if (!found.ok) return <Closed message={found.reason === 'limited' ? PORTAL_LIMITED : PORTAL_NOT_FOUND} />;
  const now = new Date();
  const view = await getPortalView(await getDb(), found.access, now);
  const { access } = view;

  return (
    <Frame>
      <div className="space-y-5">
        <div>
          <p className="text-xs font-medium uppercase tracking-[0.12em] text-ink-3">Billing for {access.orgName}</p>
          <h1 className="mt-1.5 text-[22px] font-semibold leading-tight tracking-[-0.015em] text-ink">{access.subcontractorName}</h1>
          <p className="mt-1 text-[13px] text-ink-2">
            {access.projectName}
            {access.projectNumber ? ` (${access.projectNumber})` : ''} · {access.contractNumber}, {access.contractTitle}
          </p>
        </div>

        <PeriodNote current={view.current} previous={view.previous} orgName={access.orgName} today={now.toISOString().slice(0, 10)} />

        {access.open ? (
          <Panel className="p-4">
            <h2 className="mb-3 text-[14px] font-semibold text-ink">Send an application</h2>
            <PortalUpload token={token} orgName={access.orgName} />
          </Panel>
        ) : (
          <p className="rounded-lg border border-line bg-surface px-3.5 py-2.5 text-[13px] text-ink-2">This subcontract is closed, so {access.orgName} is not taking billing for it here. Contact them directly.</p>
        )}

        <Panel className="overflow-hidden">
          <div className="border-b border-line px-4 py-3">
            <h2 className="text-[14px] font-semibold text-ink">Your applications</h2>
            <p className="mt-0.5 text-xs text-ink-3">Everything {access.orgName} has received on this subcontract, newest first, however it was sent.</p>
          </div>
          {view.submissions.length === 0 ? (
            <p className="px-4 py-6 text-[13px] text-ink-3">Nothing yet. What you send appears here.</p>
          ) : (
            <ul className="divide-y divide-line">
              {view.submissions.map((s) => (
                <Submission key={s.key} s={s} orgName={access.orgName} />
              ))}
            </ul>
          )}
        </Panel>

        <div className="space-y-1.5 text-xs text-ink-3">
          <p>Approved means {access.orgName} has accepted the figures. Payment is made under your subcontract, not through this page.</p>
          <p>Anyone with this link can send billing for this subcontract and see its status, so keep it to yourself. If it has been shared by mistake, ask {access.orgName} to replace it.</p>
        </div>
      </div>
    </Frame>
  );
}
