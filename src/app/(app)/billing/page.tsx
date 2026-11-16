import { CalendarRange, ChevronLeft, ChevronRight, Download } from 'lucide-react';
import Link from '@/components/ui/link';
import { getDb } from '@/db';
import { CellBadge } from '@/components/records/billing';
import { Note } from '@/components/records/figures';
import { buttonClass } from '@/components/ui/button';
import { EmptyState, Money, Page, PageHeader, Panel, PanelHeader, Table, Td, Th } from '@/components/ui/data';
import { formatMoney } from '@/lib/money';
import { cn, formatMonth, pluralize } from '@/lib/utils';
import { can } from '@/server/auth/permissions';
import { requireCtx } from '@/server/auth/session';
import { CELL_LABEL, getBillingBoard, isMonth, monthOf, monthsEnding, shiftMonth, type BoardRow, type CellState, type PeriodSummary } from '@/server/services/billing';

export const metadata = { title: 'Billing periods' };

/** Attention first: what is missing or bounced, then what is still coming, then what is done. */
const ORDER: CellState[] = ['missing', 'rejected', 'due', 'on_hold', 'in_review', 'approved', 'not_started', 'complete', 'closed'];
const NOT_EXPECTED_REASON: Partial<Record<CellState, string>> = { not_started: 'not billing yet', complete: 'fully billed', closed: 'closed' };

export default async function BillingPage({ searchParams }: { searchParams: Promise<{ period?: string | string[] }> }) {
  const ctx = await requireCtx();
  const sp = await searchParams;
  const asked = Array.isArray(sp.period) ? sp.period[0] : sp.period;
  const current = monthOf(new Date());
  const selected = isMonth(asked) && asked <= current ? asked : current;
  const strip = monthsEnding(current, 6);
  const board = await getBillingBoard(await getDb(), ctx, { months: [...strip, selected], current });
  const at = board.months.indexOf(selected);
  const total = board.periods[at]!;
  const isCurrent = selected === current;
  const canExport = can(ctx.role, 'export:run');

  const sections = board.sections
    .map((s) => ({ ...s, period: s.periods[at]!, rows: s.rows.map((r) => ({ row: r, cell: r.cells[at]! })) }))
    .map((s) => ({ ...s, expected: s.rows.filter((r) => r.cell.expected).sort((a, b) => ORDER.indexOf(a.cell.state) - ORDER.indexOf(b.cell.state) || a.row.subcontractorName.localeCompare(b.row.subcontractorName)) }));
  const active = sections.filter((s) => s.expected.length > 0 || s.undated.length > 0);
  const quiet = sections.filter((s) => s.expected.length === 0 && s.undated.length === 0);

  return (
    <Page width="wide">
      <PageHeader
        title="Billing periods"
        description="Every subcontract expected to bill in a period: whether its application arrived, where it is, what was requested and approved, and which are missing."
      />

      <nav aria-label="Billing period" className="mb-4 flex flex-wrap items-center gap-2">
        <Link href={`/billing?period=${shiftMonth(selected, -1)}`} className={buttonClass({ variant: 'ghost', size: 'sm' })} aria-label="Previous period">
          <ChevronLeft className="size-3.5" />
        </Link>
        <div className="flex flex-wrap gap-1.5">
          {[...new Set([...(strip.includes(selected) ? [] : [selected]), ...strip])].map((m) => {
            const p = board.periods[board.months.indexOf(m)]!;
            const on = m === selected;
            return (
              <Link
                key={m}
                href={`/billing?period=${m}`}
                aria-current={on ? 'page' : undefined}
                className={cn('rounded-lg border px-3 py-1.5 text-left transition-colors', on ? 'border-ink bg-ink text-surface' : 'border-line bg-surface hover:border-line-strong')}
              >
                <span className="block text-[12.5px] font-medium">{formatMonth(m)}</span>
                <span className={cn('block text-[11px]', on ? 'text-surface/80' : 'text-ink-3')}>
                  {p.expected ? `${p.received}/${p.expected} received` : 'Nothing expected'}
                  {p.missing ? <span className={cn('ml-1 font-medium', on ? 'text-surface' : 'text-block')}>· {p.missing} missing</span> : null}
                </span>
              </Link>
            );
          })}
        </div>
        {selected < current ? (
          <Link href={`/billing?period=${shiftMonth(selected, 1)}`} className={buttonClass({ variant: 'ghost', size: 'sm' })} aria-label="Next period">
            <ChevronRight className="size-3.5" />
          </Link>
        ) : null}
      </nav>

      <Summary p={total} isCurrent={isCurrent} />

      <Note className="mt-4">
        {isCurrent
          ? `${formatMonth(selected)} is the current period, so a subcontract that has not sent its application yet is shown as not received yet, not missing.`
          : `A subcontract is missing for ${formatMonth(selected)} when it had already been billing, is still active with work left to bill, and sent nothing for this period.`}{' '}
        A period is the month of the application’s “period to” date.
      </Note>

      {board.sections.length === 0 ? (
        <Panel className="mt-4">
          <EmptyState
            icon={<CalendarRange />}
            title="No subcontracts to track yet"
            description="Billing periods fill in once a project has subcontracts and their applications start arriving."
            action={
              <Link href="/projects" className={buttonClass({ variant: 'primary' })}>
                Go to projects
              </Link>
            }
          />
        </Panel>
      ) : null}

      <div className="mt-4 space-y-4">
        {active.map((s) => (
          <Panel key={s.project.id} className="overflow-hidden">
            <PanelHeader
              title={
                <Link href={`/projects/${s.project.id}`} className="hover:underline">
                  {s.project.name}
                  {s.project.number ? <span className="ml-1.5 font-normal text-ink-3">{s.project.number}</span> : null}
                </Link>
              }
              description={`${s.period.received} of ${pluralize(s.period.expected, 'expected application')} received · ${s.period.approved} approved${s.period.missing ? ` · ${s.period.missing} missing` : ''}`}
              actions={
                canExport && s.period.approved > 0 ? (
                  <a href={`/api/billing/rollup?project=${encodeURIComponent(s.project.id)}&period=${selected}`} className={buttonClass({ variant: 'secondary', size: 'sm' })} download>
                    <Download className="size-3.5" />
                    Approved billing (CSV)
                  </a>
                ) : null
              }
            />
            {s.expected.length > 0 ? (
              <Table>
                <thead>
                  <tr>
                    <Th className="pl-4">Subcontractor</Th>
                    <Th>Contract</Th>
                    <Th>Status</Th>
                    <Th>Application</Th>
                    <Th align="right">Requested</Th>
                    <Th align="right" className="pr-4">
                      Approved
                    </Th>
                  </tr>
                </thead>
                <tbody className="[&_tr:last-child>td]:border-b-0">
                  {s.expected.map(({ row, cell }) => (
                    <Row key={row.id} row={row} cell={cell} />
                  ))}
                </tbody>
                <tfoot>
                  <tr className="bg-canvas/60">
                    <Td className="pl-4 text-[11px] font-medium uppercase tracking-wide text-ink-3" colSpan={4}>
                      Period total
                    </Td>
                    <Td align="right" className="font-medium">
                      <Money cents={s.period.requested} />
                    </Td>
                    <Td align="right" className="pr-4 font-medium">
                      <Money cents={s.period.approvedAmount} />
                    </Td>
                  </tr>
                </tfoot>
              </Table>
            ) : null}
            <NotExpected rows={s.rows.filter((r) => !r.cell.expected)} />
            {s.undated.length > 0 ? (
              <p className="border-t border-line px-4 py-2.5 text-xs text-warn">
                {pluralize(s.undated.length, 'application')} on this project {s.undated.length === 1 ? 'has' : 'have'} no billing period read, so {s.undated.length === 1 ? 'it is' : 'they are'} in no month:{' '}
                {s.undated.map((u, i) => (
                  <span key={u.id}>
                    {i > 0 ? ', ' : ''}
                    <Link href={`/applications/${u.id}`} className="font-medium underline">
                      {u.applicationNumber !== null ? `#${u.applicationNumber}` : 'number not read'}
                    </Link>
                  </span>
                ))}
                .
              </p>
            ) : null}
          </Panel>
        ))}
      </div>

      {quiet.length > 0 ? (
        <p className="mt-4 text-xs text-ink-3">
          Nothing expected for {formatMonth(selected)} on{' '}
          {quiet.map((s, i) => (
            <span key={s.project.id}>
              {i > 0 ? (i === quiet.length - 1 ? ' and ' : ', ') : ''}
              <Link href={`/projects/${s.project.id}`} className="font-medium text-ink-2 hover:underline">
                {s.project.name}
              </Link>
            </span>
          ))}
          .
        </p>
      ) : null}
    </Page>
  );
}

function Summary({ p, isCurrent }: { p: PeriodSummary; isCurrent: boolean }) {
  const items: Array<{ label: string; value: React.ReactNode; note?: string; tone?: 'block' | 'warn' }> = [
    { label: 'Expected', value: p.expected, note: 'subcontracts due to bill' },
    { label: 'Received', value: p.received, note: p.rejected ? `${pluralize(p.rejected, 'rejected')}, not resent` : 'applications in' },
    { label: 'Approved', value: p.approved, note: `${p.inReview} still in review` },
    isCurrent
      ? { label: 'Not received yet', value: p.due, note: 'period still open', tone: p.due ? 'warn' : undefined }
      : { label: 'Missing', value: p.missing, note: p.missing ? 'had been billing, sent nothing' : 'none missed', tone: p.missing ? 'block' : undefined },
    { label: 'Requested', value: formatMoney(p.requested), note: 'on applications received' },
    { label: 'Approved for payment', value: formatMoney(p.approvedAmount), note: 'this period' },
  ];
  return (
    <dl className="grid grid-cols-2 gap-px overflow-hidden rounded-xl border border-line bg-line shadow-card sm:grid-cols-3 xl:grid-cols-6">
      {items.map((i) => (
        <div key={i.label} className="min-w-0 bg-surface px-4 py-3">
          <dt className="text-[11px] font-medium uppercase tracking-wide text-ink-3">{i.label}</dt>
          <dd className={cn('num mt-1 text-[17px] font-semibold leading-6', i.tone === 'block' && 'text-block', i.tone === 'warn' && 'text-warn')}>{i.value}</dd>
          {i.note ? <dd className="mt-0.5 text-xs text-ink-3">{i.note}</dd> : null}
        </div>
      ))}
    </dl>
  );
}

function Row({ row, cell }: { row: BoardRow; cell: BoardRow['cells'][number] }) {
  const app = cell.application;
  return (
    <tr className="hover:bg-canvas/60">
      <Td className="pl-4">
        <Link href={`/contracts/${row.id}`} className="font-medium hover:underline">
          {row.subcontractorName}
        </Link>
      </Td>
      <Td>
        <Link href={`/contracts/${row.id}`} className="hover:underline">
          {row.number}
        </Link>
        <div className="text-xs text-ink-3">{row.title}</div>
      </Td>
      <Td>
        <CellBadge state={cell.state} />
      </Td>
      <Td>
        {app ? (
          <Link href={`/applications/${app.id}`} className="hover:underline">
            {app.applicationNumber !== null ? `#${app.applicationNumber}` : 'Number not read'}
          </Link>
        ) : (
          <span className="text-ink-4">—</span>
        )}
        {cell.others ? <div className="text-xs text-ink-3">and {pluralize(cell.others, 'other')} for this period</div> : null}
      </Td>
      <Td align="right">{app && cell.state !== 'rejected' ? <Money cents={app.claimedAmount} /> : <span className="text-ink-4">—</span>}</Td>
      <Td align="right" className="pr-4">
        {cell.state === 'approved' ? <Money cents={app!.approvedAmount} /> : <span className="text-ink-4">—</span>}
      </Td>
    </tr>
  );
}

function NotExpected({ rows }: { rows: Array<{ row: BoardRow; cell: BoardRow['cells'][number] }> }) {
  if (rows.length === 0) return null;
  return (
    <p className="border-t border-line px-4 py-2.5 text-xs text-ink-3">
      Not expected this period:{' '}
      {rows.map(({ row, cell }, i) => (
        <span key={row.id}>
          {i > 0 ? '; ' : ''}
          <Link href={`/contracts/${row.id}`} className="text-ink-2 hover:underline">
            {row.subcontractorName} {row.number}
          </Link>{' '}
          ({NOT_EXPECTED_REASON[cell.state] ?? CELL_LABEL[cell.state].toLowerCase()})
        </span>
      ))}
    </p>
  );
}
