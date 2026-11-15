'use client';

import { ListOrdered, Pencil } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { toast } from 'sonner';
import { ScheduleDifference } from '@/components/records/figures';
import { filledRows, ScheduleEditor, scheduleLinesFrom, scheduleRow, scheduleRowsTotal, type ScheduleRow } from '@/components/records/schedule-editor';
import { Button } from '@/components/ui/button';
import { Badge, EmptyState, Money, Panel, PanelHeader, Table, Td, Th } from '@/components/ui/data';
import { FormError } from '@/components/ui/form';
import { pluralize } from '@/lib/utils';
import { saveScheduleAction } from '../actions';

type Line = { id: string; itemNo: string; description: string; scheduledValue: number; changeOrderId: string | null };

export function SchedulePanel({ contractId, lines, contractSum, canWrite }: { contractId: string; lines: Line[]; contractSum: number; canWrite: boolean }) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [rows, setRows] = useState<ScheduleRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  // Lines that exist because of an approved change order follow the change order; only the contract's own lines are edited here.
  const base = lines.filter((l) => !l.changeOrderId);
  const fromChangeOrders = lines.filter((l) => l.changeOrderId);
  const changeOrderTotal = fromChangeOrders.reduce((total, l) => total + l.scheduledValue, 0);
  const total = lines.reduce((sum, l) => sum + l.scheduledValue, 0);
  const amountLabel = fromChangeOrders.length > 0 ? 'contract sum to date' : 'contract amount';

  const startEditing = () => {
    setRows(base.length > 0 ? base.map((l) => scheduleRow({ id: l.id, itemNo: l.itemNo, description: l.description, scheduledValue: l.scheduledValue })) : [scheduleRow({ itemNo: '1' }), scheduleRow({ itemNo: '2' }), scheduleRow({ itemNo: '3' })]);
    setError(null);
    setEditing(true);
  };

  const save = () => {
    const schedule = scheduleLinesFrom(rows);
    if (!schedule.ok) {
      setError(schedule.error);
      return;
    }
    setError(null);
    startTransition(async () => {
      let result: Awaited<ReturnType<typeof saveScheduleAction>>;
      try {
        result = await saveScheduleAction(contractId, schedule.lines);
      } catch {
        setError('The schedule could not be saved. Check your connection and try again.');
        return;
      }
      if (!result.ok) {
        // For example: a line with approved billing against it cannot be removed.
        setError(result.error);
        return;
      }
      toast.success('Schedule of values saved');
      setEditing(false);
      router.refresh();
    });
  };

  return (
    <Panel className="overflow-hidden">
      <PanelHeader
        title="Schedule of values"
        description={editing ? 'Saving re-checks every undecided application on this contract against the new schedule.' : 'The breakdown of the contract sum that each application is billed and verified against, line by line.'}
        actions={
          canWrite && !editing && lines.length > 0 ? (
            <Button size="sm" onClick={startEditing}>
              <Pencil className="size-3.5" />
              Edit schedule
            </Button>
          ) : null
        }
      />

      {editing ? (
        <div className="space-y-3 p-4">
          <FormError message={error} />
          {filledRows(rows).length > 0 || fromChangeOrders.length > 0 ? (
            <ScheduleDifference scheduleTotal={scheduleRowsTotal(rows) + changeOrderTotal} contractAmount={contractSum} amountLabel={amountLabel} saving />
          ) : null}
          <ScheduleEditor rows={rows} onChange={setRows} disabled={pending} />
          {fromChangeOrders.length > 0 ? (
            <div className="overflow-hidden rounded-lg border border-line">
              <p className="border-b border-line bg-canvas/60 px-3 py-2 text-xs text-ink-3">
                {fromChangeOrders.length === 1 ? 'This line comes from an approved change order.' : 'These lines come from approved change orders.'} To change or remove one, edit its change order below.
              </p>
              {/* Columns line up with the editor above. */}
              <Table className="table-fixed [&_tr:last-child>td]:border-b-0">
                <tbody>
                  {fromChangeOrders.map((l) => (
                    <tr key={l.id}>
                      <Td className="num w-28 pl-[23px] text-ink-2">{l.itemNo}</Td>
                      <Td className="pl-[17px]">{l.description}</Td>
                      <Td align="right" className="w-44 pr-[17px]">
                        <Money cents={l.scheduledValue} />
                      </Td>
                      <Td className="w-10" />
                    </tr>
                  ))}
                </tbody>
              </Table>
            </div>
          ) : null}
          <div className="flex items-center justify-end gap-2 pt-1">
            <Button variant="ghost" disabled={pending} onClick={() => setEditing(false)}>
              Cancel
            </Button>
            <Button variant="primary" loading={pending} onClick={save}>
              Save schedule
            </Button>
          </div>
        </div>
      ) : lines.length === 0 ? (
        <EmptyState
          icon={<ListOrdered />}
          title="No schedule of values on file"
          description="Applications on this contract cannot be checked line by line until its schedule is on file. Enter it here, or adopt it from the first pay application during review."
          action={
            canWrite ? (
              <Button variant="primary" onClick={startEditing}>
                Enter schedule
              </Button>
            ) : null
          }
        />
      ) : (
        <>
          {total !== contractSum ? (
            <div className="px-4 pt-3">
              <ScheduleDifference scheduleTotal={total} contractAmount={contractSum} amountLabel="contract sum to date" />
            </div>
          ) : null}
          <Table>
            <thead>
              <tr>
                <Th className="w-28 pl-4">Item no.</Th>
                <Th>Description of work</Th>
                <Th align="right" className="pr-4">
                  Scheduled value
                </Th>
              </tr>
            </thead>
            <tbody>
              {lines.map((l) => (
                <tr key={l.id}>
                  <Td className="num pl-4 text-ink-2">{l.itemNo}</Td>
                  <Td>
                    <span className="mr-2">{l.description}</span>
                    {l.changeOrderId ? <Badge>Change order</Badge> : null}
                  </Td>
                  <Td align="right" className="pr-4">
                    <Money cents={l.scheduledValue} />
                  </Td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <Td colSpan={2} className="border-b-0 pl-4 font-medium">
                  Total
                  <span className="ml-2 text-xs font-normal text-ink-3">{pluralize(lines.length, 'line')}</span>
                </Td>
                <Td align="right" className="border-b-0 pr-4 font-semibold">
                  <Money cents={total} />
                </Td>
              </tr>
            </tfoot>
          </Table>
        </>
      )}
    </Panel>
  );
}
