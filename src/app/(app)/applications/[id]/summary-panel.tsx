'use client';

import { Check, CircleCheck, CircleHelp, LocateFixed, TriangleAlert } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Badge, Money } from '@/components/ui/data';
import { Input } from '@/components/ui/form';
import { Tooltip } from '@/components/ui/overlay';
import { formatDelta } from '@/lib/money';
import { useAction } from '@/lib/use-action';
import { cn, formatDate } from '@/lib/utils';
import type { ClaimedField } from '@/server/types';
import { CLAIMED_FIELD_LABEL, CLAIMED_FIELD_LINE, CLAIMED_FIELDS } from '@/server/types';
import { confirmSignatureAction, updateHeaderAction } from '../actions';
import { EditableAmount } from './edit-amount';
import { useWorkspace } from './workspace';

const ENGINE_LABEL = (engine: string | null) => {
  if (!engine) return 'Not read automatically';
  if (engine.startsWith('claude')) return `AI document reading (${engine.split(':')[1] ?? 'Claude'}), cross-checked against the text layer`;
  if (engine === 'text-layer') return 'Rule-based text reader (AI reading is not configured)';
  return engine;
};

export function SummaryPanel() {
  const ws = useWorkspace();
  const { data, editable } = ws;
  const { app } = data;
  const { pending, run } = useAction();
  const decided = app.status === 'approved';
  const verified = decided ? app.approvedRecord?.approved : app.verified;
  const failing = new Set(data.findings.filter((f) => f.status === 'open' && f.refs?.field).map((f) => f.refs!.field!));

  return (
    <div className="space-y-6 px-5 py-4">
      <section>
        <div className="mb-2 flex items-baseline justify-between">
          <h2 className="text-[11px] font-semibold uppercase tracking-wide text-ink-2">Application summary</h2>
          <p className="text-[11px] text-ink-3">{editable ? 'Click a submitted figure to correct it. Click the marker to see it on the page.' : 'Figures are locked.'}</p>
        </div>
        <div className="overflow-hidden rounded-lg border border-line">
          <table className="w-full text-[13px]">
            <thead>
              <tr className="bg-canvas/70 text-[10.5px] font-medium uppercase tracking-wide text-ink-3">
                <th className="w-9 py-1.5 pl-3 text-left">Line</th>
                <th className="py-1.5 text-left"> </th>
                <th className="py-1.5 pr-3 text-right">As submitted</th>
                <th className="py-1.5 pr-3 text-right">{decided ? 'Approved' : 'Verified'}</th>
                <th className="w-28 py-1.5 pr-3 text-right">Difference</th>
              </tr>
            </thead>
            <tbody>
              {(CLAIMED_FIELDS as readonly ClaimedField[]).map((field) => {
                const submitted = app.claimed[field];
                const ours = verified?.[field] ?? null;
                const diff = submitted !== null && ours !== null ? submitted - ours : null;
                const evidence = app.evidence?.[field];
                const spot = ws.spotForField(field);
                const shaky = evidence && evidence.confidence < 0.75;
                const sub = field === 'retainageWork' || field === 'retainageStored';
                const bottom = field === 'currentPaymentDue';
                const wrong = failing.has(field);
                return (
                  <tr key={field} className={cn('group border-t border-line', bottom && 'bg-canvas/60 font-medium', wrong && 'bg-block-soft/40')}>
                    <td className="num py-2 pl-3 align-top text-xs text-ink-3">{CLAIMED_FIELD_LINE[field]}</td>
                    <td className={cn('py-2 align-top', sub && 'pl-4 text-ink-2')}>
                      <span className="flex items-center gap-1.5">
                        {CLAIMED_FIELD_LABEL[field]}
                        {spot ? (
                          <Tooltip content={evidence?.source ? `Read from “${evidence.source}” on page ${evidence.page}` : `Page ${spot.page}`}>
                            <button className="focus-ring rounded p-0.5 text-ink-4 opacity-0 hover:text-accent focus-visible:opacity-100 group-hover:opacity-100" onClick={() => ws.show(spot)} aria-label={`Show ${CLAIMED_FIELD_LABEL[field]} in the document`}>
                              <LocateFixed className="size-3.5" />
                            </button>
                          </Tooltip>
                        ) : null}
                      </span>
                    </td>
                    <td className="py-2 pr-3 text-right align-top">
                      <span className="inline-flex items-center gap-1">
                        {shaky ? (
                          <Tooltip content="Read with low confidence. Check it against the page.">
                            <CircleHelp className="size-3.5 text-warn" />
                          </Tooltip>
                        ) : null}
                        <EditableAmount
                          value={submitted}
                          editable={editable}
                          label={`Line ${CLAIMED_FIELD_LINE[field]} · ${CLAIMED_FIELD_LABEL[field]} (as on the document)`}
                          pending={pending}
                          onSave={(edit, close) => run(() => updateHeaderAction(app.id, { [field]: edit.value }), { success: 'Corrected', onSuccess: close })}
                        >
                          <Money cents={submitted} blank={editable ? 'Enter' : '—'} className={cn(submitted === null && 'text-ink-4')} />
                        </EditableAmount>
                      </span>
                    </td>
                    <td className="py-2 pr-3 text-right align-top">
                      <Money cents={ours} />
                    </td>
                    <td className="py-2 pr-3 text-right align-top">
                      {diff === null ? <span className="text-ink-4">—</span> : diff === 0 ? <Check className="ml-auto size-3.5 text-pass" aria-label="Matches" /> : <span className={cn('num', wrong ? 'font-medium text-block' : 'text-ink-2')}>{formatDelta(diff)}</span>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {verified ? (
          <p className="mt-2 text-xs text-ink-3">
            “{decided ? 'Approved' : 'Verified'}” is recomputed from the contract, approved change orders, {verified.priorApplicationNumber !== null ? `billing approved through application #${verified.priorApplicationNumber}` : 'no prior billing'} and this period’s line items
            {verified.excludedLines ? `, excluding ${verified.excludedLines} line${verified.excludedLines === 1 ? '' : 's'} that are not on the contract` : ''}. It does not rely on any total printed on the submission.
          </p>
        ) : null}
      </section>

      <section className="grid grid-cols-2 gap-x-8 gap-y-4">
        <div>
          <h2 className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-ink-2">Identification</h2>
          <dl className="space-y-2.5">
            <Row label="Application number">
              <InlineText
                value={app.applicationNumber === null ? '' : String(app.applicationNumber)}
                editable={editable}
                inputMode="numeric"
                placeholder="Enter"
                onSave={(v, close) => run(() => updateHeaderAction(app.id, { applicationNumber: v.trim() === '' ? null : Number(v) }), { success: 'Corrected', onSuccess: close })}
                onLocate={ws.spotForField('applicationNumber') ? () => ws.show(ws.spotForField('applicationNumber')) : undefined}
              />
            </Row>
            <Row label="Period to">
              <InlineText
                value={app.periodTo ?? ''}
                display={app.periodTo ? formatDate(app.periodTo) : ''}
                type="date"
                editable={editable}
                placeholder="Enter"
                onSave={(v, close) => run(() => updateHeaderAction(app.id, { periodTo: v || null }), { success: 'Corrected', onSuccess: close })}
                onLocate={ws.spotForField('periodTo') ? () => ws.show(ws.spotForField('periodTo')) : undefined}
              />
            </Row>
            <Row label="Signature">
              <span className="flex flex-wrap items-center gap-2">
                {app.signed === 'yes' ? (
                  <Badge tone="pass">
                    <CircleCheck className="size-3" /> Detected{app.stated?.signerName ? ` · ${app.stated.signerName}` : ''}
                  </Badge>
                ) : app.signatureConfirmedAt ? (
                  <Badge tone="pass">
                    <CircleCheck className="size-3" /> Confirmed by {app.signatureConfirmedBy ? (data.people[app.signatureConfirmedBy] ?? 'reviewer') : 'reviewer'}
                  </Badge>
                ) : app.signed === 'no' ? (
                  <Badge tone="block">Not signed</Badge>
                ) : (
                  <Badge tone="warn">
                    <TriangleAlert className="size-3" /> Not confirmed
                  </Badge>
                )}
                {ws.spotForField('signed') ? (
                  <button className="text-xs text-accent hover:underline" onClick={() => ws.show(ws.spotForField('signed'))}>
                    Show
                  </button>
                ) : null}
                {editable && app.signed !== 'yes' ? (
                  <Button size="sm" loading={pending} onClick={() => run(() => confirmSignatureAction(app.id, !app.signatureConfirmedAt), { success: app.signatureConfirmedAt ? 'Confirmation withdrawn' : 'Signature confirmed' })}>
                    {app.signatureConfirmedAt ? 'Withdraw confirmation' : 'I can see the signature'}
                  </Button>
                ) : null}
              </span>
            </Row>
            <Row label="Notarised">{app.notarized === 'yes' ? 'Yes, a completed notary block was detected' : app.notarized === 'no' ? 'No notary block' : 'Could not be confirmed'}</Row>
          </dl>
        </div>

        <div>
          <h2 className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-ink-2">As stated on the documents</h2>
          <dl className="space-y-2.5">
            <Row label="From">
              <Stated stated={app.stated?.contractorName} record={data.subcontractor?.name} />
            </Row>
            <Row label="Project">
              <Stated stated={app.stated?.projectName} record={data.project?.name} />
            </Row>
            <Row label="Contract no.">
              <Stated stated={app.stated?.contractNumber} record={data.contract?.number} />
            </Row>
            <Row label="Addressed to">{app.stated?.toName ?? <span className="text-ink-4">Not stated</span>}</Row>
            <Row label="Read by">
              <span className="text-xs text-ink-2">{ENGINE_LABEL(app.engine)}</span>
            </Row>
          </dl>
        </div>
      </section>
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[120px_1fr] items-baseline gap-3">
      <dt className="text-xs text-ink-3">{label}</dt>
      <dd className="min-w-0 text-[13px] text-ink">{children}</dd>
    </div>
  );
}

function Stated({ stated, record }: { stated?: string | null; record?: string | null }) {
  if (!stated) return <span className="text-ink-4">Not stated</span>;
  const same = record && stated.trim().toLowerCase() === record.trim().toLowerCase();
  return (
    <span>
      {stated}
      {record && !same ? <span className="block text-xs text-ink-3">Matched to: {record}</span> : null}
    </span>
  );
}

function InlineText({
  value,
  display,
  editable,
  type = 'text',
  inputMode,
  placeholder,
  onSave,
  onLocate,
}: {
  value: string;
  display?: string;
  editable: boolean;
  type?: 'text' | 'date';
  inputMode?: 'numeric';
  placeholder?: string;
  onSave: (value: string, close: () => void) => void;
  onLocate?: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  if (editing) {
    return (
      <form
        className="flex items-center gap-1.5"
        onSubmit={(e) => {
          e.preventDefault();
          onSave(draft, () => setEditing(false));
        }}
      >
        <Input autoFocus type={type} inputMode={inputMode} value={draft} onChange={(e) => setDraft(e.target.value)} className="h-7 w-40" />
        <Button size="sm" variant="primary" type="submit">
          Save
        </Button>
        <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>
          Cancel
        </Button>
      </form>
    );
  }
  return (
    <span className="flex items-center gap-2">
      {editable ? (
        <button
          className={cn('focus-ring -mx-1 rounded px-1 decoration-ink-4 decoration-dotted underline-offset-4 hover:bg-accent-soft hover:underline', !value && 'text-ink-4')}
          onClick={() => {
            setDraft(value);
            setEditing(true);
          }}
        >
          {(display ?? value) || placeholder}
        </button>
      ) : (
        <span className={cn(!value && 'text-ink-4')}>{(display ?? value) || 'Not read'}</span>
      )}
      {onLocate ? (
        <button className="text-xs text-accent hover:underline" onClick={onLocate}>
          Show
        </button>
      ) : null}
    </span>
  );
}
