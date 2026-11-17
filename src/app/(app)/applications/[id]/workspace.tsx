'use client';

import { ArrowLeft, PanelLeftClose, PanelLeftOpen } from 'lucide-react';
import Link from '@/components/ui/link';
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { Money, StatusBadge } from '@/components/ui/data';
import { Tooltip } from '@/components/ui/overlay';
import { formatDelta } from '@/lib/money';
import { cn, formatDate, formatRelative } from '@/lib/utils';
import type { ReviewData } from '@/server/services/queries';
import type { BBox } from '@/server/types';
import { OPEN_STATUSES } from '@/server/types';
import { ActivityPanel } from './activity-panel';
import { CompliancePanel } from './compliance-panel';
import { DecisionBar } from './decision';
import { DocumentViewer, type ViewerTarget } from './document-viewer';
import { FindingsPanel } from './findings-panel';
import { LinesPanel } from './lines-panel';
import { MatchingPanel } from './matching-panel';
import { SummaryPanel } from './summary-panel';

export type Permissions = { review: boolean; approve: boolean; signoff: boolean; records: boolean; exportRun: boolean; upload: boolean; comment: boolean };
export type Extras = {
  me: { id: string; name: string };
  emailConfigured: boolean;
  procore: { configured: boolean; connected: boolean; available: boolean; reason: string | null; warning: string | null };
};
export type TabKey = 'findings' | 'summary' | 'lines' | 'compliance' | 'activity';
type Spot = { documentId: string; page: number; bbox?: BBox | null };

type Workspace = {
  data: ReviewData;
  perms: Permissions;
  extras: Extras;
  /** The figures can still be changed. */
  editable: boolean;
  tab: TabKey;
  setTab: (tab: TabKey) => void;
  /** Scroll the document viewer to a spot and flash it. */
  show: (spot: Spot | null) => void;
  /** Jump to a row on the schedule tab. */
  focusLine: (lineId: string) => void;
  focusedLine: { id: string; nonce: number } | null;
  spotForField: (key: string) => Spot | null;
  spotForLine: (lineId: string) => Spot | null;
  spotForWaiver: (waiverId: string) => Spot | null;
};

const Ctx = createContext<Workspace | null>(null);
export function useWorkspace(): Workspace {
  const value = useContext(Ctx);
  if (!value) throw new Error('useWorkspace must be used inside ReviewWorkspace');
  return value;
}

export function ReviewWorkspace({ data, perms, extras }: { data: ReviewData; perms: Permissions; extras: Extras }) {
  const { app } = data;
  const editable = perms.review && (OPEN_STATUSES as string[]).includes(app.status);
  const open = data.findings.filter((f) => f.status === 'open');
  const blocking = open.filter((f) => f.severity === 'blocking').length;
  const warnings = open.filter((f) => f.severity === 'warning').length;

  const [tab, setTab] = useState<TabKey>(open.length > 0 || !['approved', 'rejected', 'void'].includes(app.status) ? 'findings' : 'summary');
  const [target, setTarget] = useState<ViewerTarget | null>(null);
  const [focusedLine, setFocusedLine] = useState<{ id: string; nonce: number } | null>(null);
  const [viewerOpen, setViewerOpen] = useState(true);
  // Side by side needs room: on a narrow window the review opens on its own, and the documents are one click away.
  useEffect(() => {
    if (window.matchMedia('(max-width: 1023px)').matches) setViewerOpen(false);
  }, []);

  const show = useCallback((spot: Spot | null) => {
    if (!spot) return;
    setViewerOpen(true);
    setTarget({ ...spot, nonce: Date.now() });
  }, []);
  const focusLine = useCallback((lineId: string) => {
    setTab('lines');
    setFocusedLine({ id: lineId, nonce: Date.now() });
  }, []);

  const value = useMemo<Workspace>(() => {
    const spotForField = (key: string): Spot | null => {
      const ev = data.app.evidence?.[key];
      return ev ? { documentId: ev.documentId, page: ev.page, bbox: ev.bbox ?? null } : null;
    };
    const spotForLine = (lineId: string): Spot | null => {
      const x = data.lines.find((l) => l.id === lineId)?.extracted;
      return x ? { documentId: x.documentId, page: x.page, bbox: x.bbox ?? null } : null;
    };
    const spotForWaiver = (waiverId: string): Spot | null => {
      const w = data.waivers.find((x) => x.id === waiverId);
      if (!w) return null;
      return { documentId: w.documentId, page: w.page, bbox: w.extracted?.amount.bbox ?? w.extracted?.waiverType.bbox ?? null };
    };
    return { data, perms, extras, editable, tab, setTab, show, focusLine, focusedLine, spotForField, spotForLine, spotForWaiver };
  }, [data, perms, extras, editable, tab, show, focusLine, focusedLine]);

  const title = data.subcontractor?.name ?? app.stated?.contractorName ?? 'Unidentified subcontractor';
  const decided = app.status === 'approved';
  // The figure shown beside "Requested" minus the request, as on the list: −$10.00 means $10.00 less than asked for.
  const shownAmount = decided ? app.approvedAmount : app.verifiedAmount;
  const difference = app.claimedAmount !== null && shownAmount !== null ? shownAmount - app.claimedAmount : null;

  const tabs: Array<{ key: TabKey; label: string; count?: number; tone?: 'block' | 'warn' | 'pass' }> = [
    // Once approved, anything still open was acknowledged by the approver; it is no longer work to do.
    // Once rejected or voided, nothing will be paid: the count stays, without the colour that asks for action.
    decided
      ? { key: 'findings', label: 'Findings', count: 0, tone: 'pass' }
      : app.status === 'rejected' || app.status === 'void'
        ? { key: 'findings', label: 'Findings', count: open.filter((f) => f.severity !== 'info').length }
        : { key: 'findings', label: 'Findings', count: open.filter((f) => f.severity !== 'info').length, tone: blocking ? 'block' : warnings ? 'warn' : 'pass' },
    { key: 'summary', label: 'Summary' },
    { key: 'lines', label: 'Schedule of values', count: data.lines.length },
    { key: 'compliance', label: 'Lien waivers', count: data.waivers.length },
    { key: 'activity', label: 'Activity' },
  ];

  return (
    <Ctx.Provider value={value}>
      <div className="flex h-full min-h-0 flex-col bg-surface">
        <header className="shrink-0 border-b border-line px-5 pb-3 pt-3.5">
          {/* On a narrow window the decision buttons move under the title instead of squeezing it. */}
          <div className="flex flex-wrap items-start gap-3">
            <Tooltip content="Back to pay applications" side="bottom">
              <Link href="/applications" className="focus-ring -ml-1.5 mt-0.5 rounded-md p-1.5 text-ink-3 hover:bg-sunken hover:text-ink" aria-label="Back to pay applications">
                <ArrowLeft className="size-4" />
              </Link>
            </Tooltip>
            <div className="min-w-0 flex-1 basis-[20rem]">
              <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
                <h1 className="truncate text-[17px] font-semibold leading-6 text-ink">
                  {title}
                  <span className="font-normal text-ink-3"> · Application {app.applicationNumber !== null ? `#${app.applicationNumber}` : '(number not read)'}</span>
                </h1>
                <StatusBadge status={app.status} />
                {app.status === 'on_hold' && app.holdSince ? <span className="text-xs text-ink-3">since {formatRelative(app.holdSince)}</span> : null}
              </div>
              <p className="mt-0.5 truncate text-xs text-ink-3">
                {data.project ? (
                  <Link href={`/projects/${data.project.id}`} className="hover:text-ink hover:underline">
                    {data.project.name}
                  </Link>
                ) : (
                  'No project matched'
                )}
                {data.contract ? (
                  <>
                    {' · '}
                    <Link href={`/contracts/${data.contract.id}`} className="hover:text-ink hover:underline">
                      {data.contract.number} {data.contract.title}
                    </Link>
                  </>
                ) : null}
                {app.periodTo ? ` · Period to ${formatDate(app.periodTo)}` : ''}
                {` · Received ${formatRelative(app.receivedAt)} ${app.receivedVia === 'portal' ? 'through the subcontractor portal' : `by ${app.receivedVia}`}`}
              </p>
            </div>
            <DecisionBar />
          </div>

          {data.contract ? (
            <dl className="mt-3 flex flex-wrap items-end gap-x-8 gap-y-2 pl-9">
              <Figure label="Requested">
                <Money cents={app.claimedAmount} className="text-[15px] font-medium" blank="Not read" />
              </Figure>
              <Figure label={decided ? 'Approved' : 'Verified'}>
                <Money cents={decided ? app.approvedAmount : app.verifiedAmount} className="text-[15px] font-semibold" />
              </Figure>
              <Figure label="Difference">
                {difference === null ? (
                  <span className="text-[15px] text-ink-4">—</span>
                ) : difference === 0 ? (
                  <span className="text-[15px] font-medium text-pass">None</span>
                ) : (
                  <span className={cn('num text-[15px] font-medium', 'text-block')}>{formatDelta(difference)}</span>
                )}
              </Figure>
              <Figure label="Retainage held">
                <Money cents={decided ? app.approvedRetainage : (app.verified?.retainageTotal ?? null)} className="text-[15px] text-ink-2" />
              </Figure>
              {!decided ? (
                <Figure label="Checks">
                  <span className="flex items-center gap-2 text-[13px]">
                    {blocking ? <span className="font-medium text-block">{blocking} blocking</span> : null}
                    {warnings ? <span className="font-medium text-warn">{warnings} warning{warnings === 1 ? '' : 's'}</span> : null}
                    {!blocking && !warnings ? <span className="font-medium text-pass">All clear</span> : null}
                    <span className="text-ink-3">{data.findings.filter((f) => f.status === 'passed').length} passed</span>
                  </span>
                </Figure>
              ) : null}
            </dl>
          ) : null}
        </header>

        <div className="flex min-h-0 flex-1">
          {viewerOpen ? (
            <section className="min-w-0 basis-[46%] border-r border-line" aria-label="Documents">
              <DocumentViewer documents={data.documents} target={target} onNavigate={(spot) => show(spot)} canRemove={editable} rereadFor={editable ? data.app.id : null} />
            </section>
          ) : null}

          <section className="flex min-w-0 flex-1 flex-col" aria-label="Review">
            {data.contract ? (
              <>
                <div className="flex shrink-0 items-center gap-1 overflow-x-auto border-b border-line px-3" role="tablist">
                  <Tooltip content={viewerOpen ? 'Hide documents' : 'Show documents'} side="bottom">
                    <button className="focus-ring mr-1 rounded-md p-1.5 text-ink-3 hover:bg-sunken hover:text-ink" onClick={() => setViewerOpen((v) => !v)} aria-label={viewerOpen ? 'Hide documents' : 'Show documents'}>
                      {viewerOpen ? <PanelLeftClose className="size-4" /> : <PanelLeftOpen className="size-4" />}
                    </button>
                  </Tooltip>
                  {tabs.map((t) => (
                    <button
                      key={t.key}
                      role="tab"
                      aria-selected={tab === t.key}
                      onClick={() => setTab(t.key)}
                      className={cn(
                        'focus-ring relative flex h-10 shrink-0 items-center gap-1.5 whitespace-nowrap px-2.5 text-[13px] transition-colors',
                        tab === t.key ? 'font-medium text-ink' : 'text-ink-3 hover:text-ink',
                      )}
                    >
                      {t.label}
                      {t.count !== undefined ? (
                        <span
                          className={cn(
                            'num rounded-full px-1.5 text-[10px] font-semibold leading-4',
                            t.tone === 'block' ? 'bg-block text-white' : t.tone === 'warn' ? 'bg-warn text-white' : t.tone === 'pass' && t.count === 0 ? 'bg-pass-soft text-pass' : 'bg-sunken text-ink-2',
                          )}
                        >
                          {t.tone === 'pass' && t.count === 0 ? '✓' : t.count}
                        </span>
                      ) : null}
                      {tab === t.key ? <span className="absolute inset-x-2 -bottom-px h-0.5 rounded-full bg-ink" /> : null}
                    </button>
                  ))}
                </div>
                <div className="min-h-0 flex-1 overflow-y-auto" role="tabpanel">
                  {tab === 'findings' ? <FindingsPanel /> : null}
                  {tab === 'summary' ? <SummaryPanel /> : null}
                  {tab === 'lines' ? <LinesPanel /> : null}
                  {tab === 'compliance' ? <CompliancePanel /> : null}
                  {tab === 'activity' ? <ActivityPanel /> : null}
                </div>
              </>
            ) : (
              <div className="min-h-0 flex-1 overflow-y-auto">
                <MatchingPanel />
              </div>
            )}
          </section>
        </div>
      </div>
    </Ctx.Provider>
  );
}

function Figure({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="text-[10.5px] font-medium uppercase tracking-wide text-ink-3">{label}</dt>
      <dd className="mt-0.5 leading-5">{children}</dd>
    </div>
  );
}
