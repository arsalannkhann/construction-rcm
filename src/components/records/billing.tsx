import Link from '@/components/ui/link';
import { Badge, Money } from '@/components/ui/data';
import { formatMoney, formatMoneyCompact } from '@/lib/money';
import { cn, formatMonth } from '@/lib/utils';
import type { BoardCell, BoardSection, CellState } from '@/server/services/billing';
import { CELL_LABEL } from '@/server/services/billing';
import { budgetStanding, type CostPosition } from '@/server/services/cost';

const CELL_TONE: Record<CellState, 'pass' | 'accent' | 'neutral' | 'block' | 'warn' | 'muted'> = {
  approved: 'pass',
  in_review: 'accent',
  on_hold: 'neutral',
  rejected: 'block',
  missing: 'block',
  due: 'warn',
  not_started: 'muted',
  complete: 'muted',
  closed: 'muted',
};

export function CellBadge({ state, className }: { state: CellState; className?: string }) {
  return (
    <Badge tone={CELL_TONE[state]} dot={state !== 'not_started' && state !== 'complete' && state !== 'closed'} className={className}>
      {CELL_LABEL[state]}
    </Badge>
  );
}

/** Short month label for grid headers: "Nov ’26". */
function shortMonth(month: string) {
  const [name, year] = formatMonth(month).split(' ');
  return `${name} ’${year!.slice(2)}`;
}

function GridCell({ cell }: { cell: BoardCell }) {
  const app = cell.application;
  if (app) {
    const amount = cell.state === 'approved' ? app.approvedAmount : app.claimedAmount;
    return (
      <Link
        href={`/applications/${app.id}`}
        className="group flex flex-col items-start gap-0.5 rounded-md px-1.5 py-1 hover:bg-canvas"
        title={`${CELL_LABEL[cell.state]}${app.applicationNumber !== null ? `, application #${app.applicationNumber}` : ''}${amount !== null ? `, ${formatMoney(amount)}` : ''}${cell.others ? ` (and ${cell.others} more for this period)` : ''}`}
      >
        <span className="flex items-center gap-1.5 text-[11.5px] font-medium">
          <span className={cn('size-1.5 shrink-0 rounded-full', DOT[cell.state])} />
          <span className="group-hover:underline">{app.applicationNumber !== null ? `#${app.applicationNumber}` : 'No.?'}</span>
          {cell.others ? <span className="text-ink-3">+{cell.others}</span> : null}
        </span>
        <span className="num text-[11px] text-ink-3">{formatMoneyCompact(amount)}</span>
      </Link>
    );
  }
  if (cell.state === 'missing') return <span className="block px-1.5 text-[11.5px] font-medium text-block">Missing</span>;
  if (cell.state === 'due') return <span className="block px-1.5 text-[11.5px] text-warn">Due</span>;
  if (cell.state === 'complete') return <span className="block px-1.5 text-[11px] text-ink-4">Billed</span>;
  return <span className="block px-1.5 text-ink-4">—</span>;
}

const DOT: Record<CellState, string> = {
  approved: 'bg-pass',
  in_review: 'bg-accent',
  on_hold: 'bg-ink-3',
  rejected: 'bg-block',
  missing: 'bg-block',
  due: 'bg-warn',
  not_started: 'bg-ink-4',
  complete: 'bg-ink-4',
  closed: 'bg-ink-4',
};

/** Subcontracts down, billing periods across. Each cell links to the application for that period. */
export function BillingGrid({ section, months, linkPeriods = true }: { section: BoardSection; months: string[]; linkPeriods?: boolean }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[640px] border-collapse text-[13px]">
        <thead>
          <tr className="border-b border-line">
            <th className="py-2 pl-4 pr-2 text-left text-[11px] font-medium uppercase tracking-wide text-ink-3">Subcontract</th>
            {months.map((m) => (
              <th key={m} className="w-[88px] px-1 py-2 text-left text-[11px] font-medium uppercase tracking-wide text-ink-3">
                {linkPeriods ? (
                  <Link href={`/billing?period=${m}`} className="px-1.5 hover:underline">
                    {shortMonth(m)}
                  </Link>
                ) : (
                  <span className="px-1.5">{shortMonth(m)}</span>
                )}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {section.rows.map((r) => (
            <tr key={r.id} className="border-b border-line last:border-b-0">
              <td className="py-1.5 pl-4 pr-2 align-top">
                <Link href={`/contracts/${r.id}`} className="font-medium hover:underline">
                  {r.subcontractorName}
                </Link>
                <div className="text-xs text-ink-3">
                  {r.number}
                  {r.status === 'closed' ? ' · Closed' : ''}
                </div>
              </td>
              {r.cells.map((c) => (
                <td key={c.month} className="px-1 py-1.5 align-top">
                  <GridCell cell={c} />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr className="border-t border-line bg-canvas/60">
            <td className="py-2 pl-4 pr-2 text-[11px] font-medium uppercase tracking-wide text-ink-3">Approved</td>
            {section.periods.map((p) => (
              <td key={p.month} className="px-1 py-2">
                <span className="num block px-1.5 text-[11.5px] font-medium">{p.approvedAmount ? formatMoneyCompact(p.approvedAmount) : '—'}</span>
                <span className="block px-1.5 text-[11px] text-ink-3">
                  {p.received}/{p.expected}
                  {p.missing ? <span className="ml-1 font-medium text-block">{p.missing} missing</span> : null}
                </span>
              </td>
            ))}
          </tr>
        </tfoot>
      </table>
    </div>
  );
}

/** "$120,000 under" / "$45,000 over" against the budget, or nothing without one. */
export function BudgetStandingBadge({ cost, className }: { cost: CostPosition; className?: string }) {
  const standing = budgetStanding(cost);
  if (standing === 'none' || cost.remaining === null) return null;
  if (standing === 'over') return <Badge tone="block" className={className}>{formatMoneyCompact(-cost.remaining)} over budget</Badge>;
  if (standing === 'near') return <Badge tone="warn" className={className}>{cost.percentOfBudget}% of budget</Badge>;
  return <Badge tone="pass" className={className}>{formatMoneyCompact(cost.remaining)} under budget</Badge>;
}

/**
 * Budget against committed and pending changes, drawn as one bar: committed,
 * then pending changes, against the budget line.
 */
export function CostBar({ cost }: { cost: CostPosition }) {
  const scale = Math.max(cost.budget ?? 0, cost.projected, 1);
  const pct = (v: number) => `${Math.max(0, Math.min(100, (v / scale) * 100))}%`;
  const pending = Math.max(0, cost.pendingChanges);
  return (
    <div className="relative h-2.5 w-full overflow-hidden rounded-full bg-sunken" aria-hidden>
      <div className="absolute inset-y-0 left-0 rounded-l-full bg-ink-2" style={{ width: pct(cost.committed) }} />
      {pending > 0 ? <div className="absolute inset-y-0 bg-warn/70" style={{ left: pct(cost.committed), width: pct(pending) }} /> : null}
      {cost.budget !== null ? <div className={cn('absolute inset-y-0 w-0.5', cost.projected > cost.budget ? 'bg-block' : 'bg-ink')} style={{ left: `calc(${pct(cost.budget)} - 1px)` }} /> : null}
    </div>
  );
}

export function CostLegend({ cost }: { cost: CostPosition }) {
  return (
    <ul className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-ink-3">
      <li className="flex items-center gap-1.5">
        <span className="size-2 rounded-sm bg-ink-2" /> Committed <Money cents={cost.committed} className="text-ink-2" />
      </li>
      {cost.pendingChanges !== 0 ? (
        <li className="flex items-center gap-1.5">
          <span className="size-2 rounded-sm bg-warn/70" /> Pending changes <Money cents={cost.pendingChanges} className="text-ink-2" />
        </li>
      ) : null}
      {cost.budget !== null ? (
        <li className="flex items-center gap-1.5">
          <span className="h-2.5 w-0.5 bg-ink" /> Budget <Money cents={cost.budget} className="text-ink-2" />
        </li>
      ) : null}
    </ul>
  );
}
