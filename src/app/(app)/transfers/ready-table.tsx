'use client';

import { FileSpreadsheet } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { batchExportAction } from '@/app/(app)/applications/actions';
import { Button } from '@/components/ui/button';
import { Badge, Money, Table, Td, Th } from '@/components/ui/data';
import { useAction } from '@/lib/use-action';
import { formatDate, formatRelative } from '@/lib/utils';

type Row = { id: string; applicationNumber: number | null; periodTo: string | null; approvedAmount: number | null; decidedAt: string | null; transferStatus: string; subcontractor: string; project: string; approvedBy: string };

export function ReadyTable({ rows, canExport }: { rows: Row[]; canExport: boolean }) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const { pending, run } = useAction();
  const all = selected.size === rows.length;
  const toggle = (id: string) =>
    setSelected((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const total = rows.filter((r) => selected.has(r.id)).reduce((t, r) => t + (r.approvedAmount ?? 0), 0);

  return (
    <>
      <Table>
        <thead>
          <tr>
            <Th className="w-9 pl-4">
              {canExport ? <input type="checkbox" className="size-3.5 accent-ink" checked={all} onChange={() => setSelected(all ? new Set() : new Set(rows.map((r) => r.id)))} aria-label="Select all" /> : null}
            </Th>
            <Th>Subcontractor</Th>
            <Th>Project</Th>
            <Th align="right">App.</Th>
            <Th>Period to</Th>
            <Th align="right">Approved</Th>
            <Th>Approved by</Th>
            <Th className="pr-4">Status</Th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id} className="hover:bg-canvas/60">
              <Td className="pl-4">{canExport ? <input type="checkbox" className="size-3.5 accent-ink" checked={selected.has(r.id)} onChange={() => toggle(r.id)} aria-label={`Select ${r.subcontractor} application ${r.applicationNumber}`} /> : null}</Td>
              <Td>
                <Link href={`/applications/${r.id}`} className="font-medium hover:underline">
                  {r.subcontractor}
                </Link>
              </Td>
              <Td className="text-ink-2">{r.project}</Td>
              <Td align="right">#{r.applicationNumber}</Td>
              <Td className="text-ink-2">{formatDate(r.periodTo)}</Td>
              <Td align="right">
                <Money cents={r.approvedAmount} className="font-medium" />
              </Td>
              <Td className="text-ink-2">
                {r.approvedBy}
                <span className="ml-1.5 text-xs text-ink-3">{formatRelative(r.decidedAt)}</span>
              </Td>
              <Td className="pr-4">{r.transferStatus === 'failed' ? <Badge tone="block">Last transfer failed</Badge> : <Badge tone="warn">Not transferred</Badge>}</Td>
            </tr>
          ))}
        </tbody>
      </Table>
      {canExport ? (
        <div className="flex items-center justify-between gap-4 border-t border-line px-4 py-3">
          <p className="text-xs text-ink-3">
            {selected.size === 0 ? 'Select applications to export them together.' : (
              <>
                {selected.size} selected · <Money cents={total} className="font-medium text-ink" />
              </>
            )}
          </p>
          <Button
            variant="primary"
            loading={pending}
            disabled={selected.size === 0}
            onClick={() =>
              run(() => batchExportAction([...selected]), {
                success: (d) => `Exported ${d.count} application${d.count === 1 ? '' : 's'} to ${d.filename}`,
                onSuccess: (d) => {
                  setSelected(new Set());
                  window.location.assign(`/api/transfers/${d.transferId}/download`);
                },
              })
            }
          >
            <FileSpreadsheet className="size-3.5" />
            Export summary CSV
          </Button>
        </div>
      ) : null}
    </>
  );
}
