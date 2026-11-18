import { Download, ListTree } from 'lucide-react';
import { notFound } from 'next/navigation';
import { BackLink } from '@/components/records/page-parts';
import { buttonClass } from '@/components/ui/button';
import { EmptyState, Page, PageHeader, Panel, PanelHeader } from '@/components/ui/data';
import { formatMoney } from '@/lib/money';
import { cn, formatDateTime, pluralize } from '@/lib/utils';
import { getDb } from '@/db';
import { requireCtx } from '@/server/auth/session';
import { FORECAST_METHOD_HINT, FORECAST_METHOD_LABEL, FORECAST_METHODS } from '@/server/services/budget-calc';
import { getProjectBudget } from '@/server/services/budget';
import { AddLineButton, BudgetChangeButton, BudgetChangesList, LockButton, StartFromSubcontractsButton } from './budget-controls';
import { BudgetTable } from './budget-table';

export const metadata = { title: 'Budget' };

function Figure({ label, cents, note, tone }: { label: string; cents: number; note?: string; tone?: 'block' | 'pass' }) {
  return (
    <div className="min-w-0">
      <dt className="text-[11px] font-medium uppercase tracking-wide text-ink-3">{label}</dt>
      <dd className={cn('num mt-0.5 text-[17px] font-semibold leading-6', tone === 'block' && 'text-block', tone === 'pass' && 'text-pass')}>{formatMoney(Math.abs(cents))}</dd>
      {note ? <dd className="text-xs text-ink-3">{note}</dd> : null}
    </div>
  );
}

export default async function BudgetPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await requireCtx();
  const budget = await getProjectBudget(await getDb(), ctx, id);
  if (!budget) notFound();
  const { project, locked, lines, unassigned, totals, changes, contracts, suggestions, canWrite, canUnlock, canExport } = budget;
  const lineRefs = lines.map((l) => ({ id: l.id, costCode: l.costCode, description: l.description, budget: l.budget }));
  const addLine = (variant: 'primary' | 'secondary') => <AddLineButton projectId={project.id} contracts={contracts} lines={lineRefs} suggestions={suggestions} locked={locked !== null} singleBudget={project.singleBudget} variant={variant} />;

  return (
    <Page width="wide">
      <PageHeader
        back={<BackLink href={`/projects/${project.id}`}>{project.name}</BackLink>}
        title="Budget by cost code"
        description="What is set aside for each part of the subcontracted work, what is committed and billed against it, and what is forecast to finish it."
        actions={
          lines.length ? (
            <div className="flex flex-wrap gap-2">
              {canExport ? (
                <a href={`/api/budget/export?project=${project.id}`} className={buttonClass({ variant: 'ghost' })}>
                  <Download className="size-3.5" />
                  CSV
                </a>
              ) : null}
              {canWrite ? <LockButton projectId={project.id} locked={locked !== null} canUnlock={canUnlock} /> : null}
              {canWrite ? addLine('primary') : null}
            </div>
          ) : null
        }
      />

      {lines.length === 0 ? (
        <Panel>
          <EmptyState
            icon={<ListTree />}
            title="Split the budget by cost code"
            description={
              project.singleBudget !== null
                ? `This project has one budget of ${formatMoney(project.singleBudget)}. Split it into lines by cost code and assign each subcontract to a line, to see which part of the work is over and what it will take to finish. Whatever you do not give a line goes to contingency, so the total stays the same.`
                : 'Set a budget for each part of the subcontracted work by cost code and assign each subcontract to a line, to see which part of the work is over and what it will take to finish.'
            }
            action={
              canWrite ? (
                <div className="flex flex-wrap justify-center gap-2">
                  {contracts.length ? <StartFromSubcontractsButton projectId={project.id} count={contracts.length} singleBudget={project.singleBudget} /> : null}
                  {addLine(contracts.length ? 'secondary' : 'primary')}
                </div>
              ) : (
                <p className="text-[13px] text-ink-3">Someone who keeps the records can set it up.</p>
              )
            }
          />
        </Panel>
      ) : (
        <div className="space-y-5">
          <Panel>
            <div className="grid gap-x-8 gap-y-5 p-4 lg:grid-cols-2">
              <div>
                <p className="mb-2 text-xs font-medium text-ink-2">From records</p>
                <dl className="grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-4">
                  <Figure label="Budget" cents={totals.budget} note={totals.changes ? `${formatMoney(totals.original)} original` : `${pluralize(lines.length, 'line')}`} />
                  <Figure label="Committed" cents={totals.committed} note={`${pluralize(contracts.length, 'subcontract')}`} />
                  <Figure label="Pending" cents={totals.pending} note="change orders" />
                  <Figure label="Billed to date" cents={totals.billed} note="completed and stored, approved" />
                </dl>
              </div>
              <div className="lg:border-l lg:border-line lg:pl-8">
                <p className="mb-2 text-xs font-medium text-ink-2">Forecast</p>
                <dl className="grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-4">
                  <Figure label="Still to commit" cents={totals.stillToCommit} note="by each line’s method" />
                  <Figure label="At completion" cents={totals.atCompletion} note="projected plus still to commit" />
                  <Figure label="To complete" cents={totals.toComplete} note="at completion less billed" />
                  <Figure label={totals.variance < 0 ? 'Over budget' : 'Under budget'} cents={totals.variance} note="estimate at completion against budget" tone={totals.variance < 0 ? 'block' : totals.variance > 0 ? 'pass' : undefined} />
                </dl>
              </div>
            </div>
            <div className="flex flex-wrap items-center justify-between gap-2 border-t border-line px-4 py-2.5 text-xs text-ink-3">
              <span>
                {locked
                  ? `Locked ${formatDateTime(locked.at)}${locked.by ? ` by ${locked.by}` : ''}: original budgets are fixed and money moves by budget changes.`
                  : 'Not locked: original budgets can still be changed. Lock the budget once it is agreed.'}
              </span>
              {unassigned ? (
                <span className="font-medium text-warn">
                  {pluralize(unassigned.contractIds.length, 'subcontract')} on no line: {formatMoney(unassigned.committed)}
                </span>
              ) : null}
            </div>
          </Panel>

          <Panel className="overflow-hidden">
            <BudgetTable
              projectId={project.id}
              lines={lines.map((l) => ({ ...l, forecastAt: l.forecastAt?.toISOString() ?? null }))}
              unassigned={unassigned}
              totals={totals}
              contracts={contracts}
              suggestions={suggestions}
              locked={locked !== null}
              canWrite={canWrite}
            />
          </Panel>

          <Panel className="overflow-hidden">
            <PanelHeader
              title="Budget changes"
              description="Money moved between lines, or added to or taken from the budget, each with its reason."
              actions={canWrite ? <BudgetChangeButton projectId={project.id} lines={lineRefs} /> : null}
            />
            {changes.length ? (
              <BudgetChangesList
                canWrite={canWrite}
                changes={changes.map((c) => ({
                  id: c.id,
                  from: c.from ? { costCode: c.from.costCode, description: c.from.description } : null,
                  to: c.to ? { costCode: c.to.costCode, description: c.to.description } : null,
                  amount: c.amount,
                  reason: c.reason,
                  status: c.status,
                  createdAt: c.createdAt.toISOString(),
                  createdBy: c.createdBy,
                  voidedAt: c.voidedAt?.toISOString() ?? null,
                  voidedBy: c.voidedBy,
                }))}
              />
            ) : (
              <p className="px-4 pb-4 pt-1 text-[13px] text-ink-3">None yet.</p>
            )}
          </Panel>

          <Panel>
            <PanelHeader title="How the forecast works" />
            <div className="space-y-3 px-4 pb-4 text-[13px] text-ink-2">
              <p>
                Budget, committed, pending and billed come from records: the budget lines and changes, the subcontracts and their change orders, and the applications you approved. What is still to be committed on a line is a forecast, made by
                the method chosen for that line; the estimate at completion, the cost to complete and the over or under follow from it.
              </p>
              <ul className="grid gap-2 sm:grid-cols-3">
                {FORECAST_METHODS.map((m) => (
                  <li key={m} className="rounded-lg border border-line px-3 py-2">
                    <p className="font-medium text-ink">{FORECAST_METHOD_LABEL[m]}</p>
                    <p className="text-xs text-ink-3">{FORECAST_METHOD_HINT[m]}</p>
                  </li>
                ))}
              </ul>
            </div>
          </Panel>
        </div>
      )}
    </Page>
  );
}
