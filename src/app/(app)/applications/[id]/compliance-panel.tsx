'use client';

import { CircleCheck, ExternalLink, LocateFixed, OctagonAlert, Plus, Scale, TriangleAlert } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Badge, EmptyState, Money } from '@/components/ui/data';
import { Field, Input, MoneyInput, Select } from '@/components/ui/form';
import { Dialog } from '@/components/ui/overlay';
import { useAction } from '@/lib/use-action';
import { cn, formatDate } from '@/lib/utils';
import { JURISDICTIONS } from '@/server/compliance/jurisdictions';
import type { ReviewData } from '@/server/services/queries';
import type { Tri, WaiverType } from '@/server/types';
import { WAIVER_TYPE_LABEL, WAIVER_TYPES } from '@/server/types';
import { addWaiverAction, updateWaiverAction } from '../actions';
import { EditableAmount } from './edit-amount';
import { useWorkspace } from './workspace';

type Waiver = ReviewData['waivers'][number];

export function CompliancePanel() {
  const ws = useWorkspace();
  const { data, editable } = ws;
  const [adding, setAdding] = useState(false);
  const state = data.project?.state ?? null;
  const jurisdiction = state ? JURISDICTIONS[state] : undefined;
  const related = data.findings.filter((f) => f.category === 'compliance');
  const general = related.filter((f) => !f.refs?.waiverId && f.status === 'open');

  return (
    <div className="space-y-5 px-5 py-4">
      <div className="flex items-start gap-2.5 rounded-lg border border-line bg-canvas/60 px-3.5 py-2.5">
        <Scale className="mt-0.5 size-4 shrink-0 text-ink-3" />
        <p className="text-xs leading-[18px] text-ink-2">
          <span className="font-medium text-ink">Pre-screening, not legal review.</span> The system classifies each waiver, checks that it is complete and that it agrees with the application, and recognises statutory form wording. It does not decide whether a waiver is valid or enforceable.
          Items marked “needs qualified review” have to be signed off by a controller or admin.
        </p>
      </div>

      {general.map((f) => (
        <div key={f.id} className={cn('flex items-start gap-2.5 rounded-lg border px-3.5 py-2.5', f.severity === 'blocking' ? 'border-block-line bg-block-soft/50' : 'border-warn-line bg-warn-soft/50')}>
          {f.severity === 'blocking' ? <OctagonAlert className="mt-0.5 size-4 shrink-0 text-block" /> : <TriangleAlert className="mt-0.5 size-4 shrink-0 text-warn" />}
          <div>
            <p className="text-[13px] font-medium text-ink">{f.title}</p>
            <p className="text-xs text-ink-2">{f.detail}</p>
            {f.action ? <p className="mt-1 text-xs text-ink">{f.action}</p> : null}
          </div>
        </div>
      ))}

      {data.waivers.length === 0 ? (
        <div className="rounded-lg border border-line">
          <EmptyState
            title="No lien waiver has been read from this package"
            description="If a waiver is in the package but could not be read, record its details by hand from the document."
            action={
              editable ? (
                <Button onClick={() => setAdding(true)}>
                  <Plus className="size-3.5" /> Record a waiver
                </Button>
              ) : null
            }
          />
        </div>
      ) : (
        <div className="space-y-3">
          {data.waivers.map((w) => (
            <WaiverCard key={w.id} waiver={w} findings={related.filter((f) => f.refs?.waiverId === w.id)} />
          ))}
          {editable ? (
            <Button size="sm" onClick={() => setAdding(true)}>
              <Plus className="size-3.5" /> Record another waiver
            </Button>
          ) : null}
        </div>
      )}

      <section className="rounded-lg border border-line">
        <div className="border-b border-line px-3.5 py-2.5">
          <h2 className="text-[13px] font-semibold">{jurisdiction ? `${jurisdiction.name}: what the pre-screen knows` : state ? `No statutory-form knowledge for ${state}` : 'Project state not set'}</h2>
          <p className="text-xs text-ink-3">
            {jurisdiction
              ? `${jurisdiction.statute}. Reference notes for the reviewer; read the statute for the governing text.`
              : state
                ? 'Statutory-form recognition covers Texas, California and Florida. Completeness and consistency checks still run.'
                : 'Set the state on the project so the waiver can be compared with that state’s statutory form.'}
          </p>
        </div>
        {jurisdiction ? (
          <div className="px-3.5 py-3">
            <ul className="list-disc space-y-1.5 pl-4 text-xs leading-[18px] text-ink-2 marker:text-ink-4">
              {jurisdiction.reviewerNotes.map((n, i) => (
                <li key={i}>{n}</li>
              ))}
            </ul>
            <a href={jurisdiction.sourceUrl} target="_blank" rel="noreferrer" className="mt-2.5 inline-flex items-center gap-1 text-xs font-medium text-accent hover:underline">
              Official statute text <ExternalLink className="size-3" />
            </a>
          </div>
        ) : null}
      </section>

      <AddWaiverDialog open={adding} onOpenChange={setAdding} />
    </div>
  );
}

function WaiverCard({ waiver: w, findings }: { waiver: Waiver; findings: ReviewData['findings'] }) {
  const ws = useWorkspace();
  const { data, editable } = ws;
  const { pending, run } = useAction();
  const open = findings.filter((f) => f.status === 'open');
  const passed = findings.filter((f) => f.status === 'passed');
  const doc = data.documents.find((d) => d.id === w.documentId);
  const form = w.formState ? JURISDICTIONS[w.formState] : undefined;
  const patch = (p: Parameters<typeof updateWaiverAction>[1], done?: () => void) => run(() => updateWaiverAction(w.id, p), { success: 'Waiver corrected', onSuccess: done });

  return (
    <article className="rounded-lg border border-line">
      <header className="flex flex-wrap items-center gap-2 border-b border-line px-3.5 py-2.5">
        <h3 className="text-[13px] font-semibold">{WAIVER_TYPE_LABEL[w.waiverType as WaiverType] ?? w.waiverType}</h3>
        {form ? <Badge tone="pass">{form.name} statutory wording recognised</Badge> : <Badge tone="neutral">No statutory form recognised</Badge>}
        <span className="flex-1" />
        <span className="text-[11px] text-ink-3">
          {doc?.filename}, page {w.page}
        </span>
        <Button size="sm" onClick={() => ws.show(ws.spotForWaiver(w.id))}>
          <LocateFixed className="size-3.5" /> Show
        </Button>
      </header>

      <dl className="grid grid-cols-2 gap-x-6 gap-y-3 px-3.5 py-3 text-[13px]">
        <Item label="Type">
          {editable ? (
            <Select value={w.waiverType} disabled={pending} onChange={(e) => patch({ waiverType: e.target.value as WaiverType })} className="h-7 text-xs">
              {WAIVER_TYPES.map((t) => (
                <option key={t} value={t}>
                  {WAIVER_TYPE_LABEL[t]}
                </option>
              ))}
            </Select>
          ) : (
            WAIVER_TYPE_LABEL[w.waiverType as WaiverType]
          )}
        </Item>
        <Item label="Amount">
          <EditableAmount value={w.amount} extracted={w.extracted?.amount.value} editable={editable} label="Waiver amount (as on the document)" pending={pending} onSave={(edit, close) => patch({ amount: edit.value }, close)}>
            <Money cents={w.amount} blank={editable ? 'Enter' : 'Not stated'} />
          </EditableAmount>
          {data.app.claimedAmount !== null && w.amount !== null && w.amount !== data.app.claimedAmount ? <span className="ml-2 text-xs text-block">Application requests <Money cents={data.app.claimedAmount} /></span> : null}
        </Item>
        <Item label="Claimant">
          <TextEdit value={w.claimant} editable={editable} onSave={(v, close) => patch({ claimant: v || null }, close)} />
        </Item>
        <Item label="Through date">
          <TextEdit value={w.throughDate} display={w.throughDate ? formatDate(w.throughDate) : null} type="date" editable={editable} blank={w.formState === 'TX' ? 'Not on the Texas form' : 'Not stated'} onSave={(v, close) => patch({ throughDate: v || null }, close)} />
        </Item>
        <Item label="Signed">
          {editable ? (
            <Select value={w.signed ?? 'unclear'} disabled={pending} onChange={(e) => patch({ signed: e.target.value as Tri })} className="h-7 w-52 text-xs">
              <option value="yes">Yes, signed</option>
              <option value="no">No, the signature is blank</option>
              <option value="unclear">Could not be confirmed</option>
            </Select>
          ) : (
            { yes: 'Yes', no: 'No', unclear: 'Could not be confirmed' }[(w.signed as Tri | null) ?? 'unclear']
          )}
          {w.signerName ? <span className="ml-2 text-xs text-ink-3">{w.signerName}{w.signerTitle ? `, ${w.signerTitle}` : ''}</span> : null}
        </Item>
        <Item label="Customer / owner">
          <span className="text-ink-2">{[w.customer, w.owner].filter(Boolean).join(' / ') || <span className="text-ink-4">Not stated</span>}</span>
        </Item>
        {w.exceptions ? (
          <Item label="Exceptions listed" className="col-span-2">
            <span className="text-ink-2">{w.exceptions}</span>
          </Item>
        ) : null}
      </dl>

      {open.length > 0 || passed.length > 0 ? (
        <ul className="space-y-1.5 border-t border-line px-3.5 py-3">
          {open.map((f) => (
            <li key={f.id} className="flex items-start gap-2 text-xs leading-[18px]">
              {f.severity === 'blocking' ? <OctagonAlert className="mt-0.5 size-3.5 shrink-0 text-block" /> : <TriangleAlert className="mt-0.5 size-3.5 shrink-0 text-warn" />}
              <span>
                <span className="font-medium text-ink">{f.title}.</span> <span className="text-ink-2">{f.detail}</span>
                {f.needsQualifiedReview ? <span className="ml-1 font-medium text-accent-ink">Needs qualified review.</span> : null}
              </span>
            </li>
          ))}
          {passed.map((f) => (
            <li key={f.id} className="flex items-start gap-2 text-xs leading-[18px] text-ink-3">
              <CircleCheck className="mt-0.5 size-3.5 shrink-0 text-pass" />
              <span>
                <span className="text-ink-2">{f.title}.</span> {f.detail}
              </span>
            </li>
          ))}
          {open.length > 0 ? (
            <li className="pt-1">
              <button className="text-xs font-medium text-accent hover:underline" onClick={() => ws.setTab('findings')}>
                Resolve these in Findings
              </button>
            </li>
          ) : null}
        </ul>
      ) : null}
    </article>
  );
}

function Item({ label, children, className }: { label: string; children: React.ReactNode; className?: string }) {
  return (
    <div className={className}>
      <dt className="mb-0.5 text-[10.5px] font-medium uppercase tracking-wide text-ink-3">{label}</dt>
      <dd className="min-w-0">{children}</dd>
    </div>
  );
}

function TextEdit({ value, display, editable, type = 'text', blank = 'Not stated', onSave }: { value: string | null; display?: string | null; editable: boolean; type?: 'text' | 'date'; blank?: string; onSave: (v: string, close: () => void) => void }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value ?? '');
  if (editing) {
    return (
      <form
        className="flex items-center gap-1.5"
        onSubmit={(e) => {
          e.preventDefault();
          onSave(draft.trim(), () => setEditing(false));
        }}
      >
        <Input autoFocus type={type} value={draft} onChange={(e) => setDraft(e.target.value)} className="h-7 text-xs" />
        <Button size="sm" variant="primary" type="submit">
          Save
        </Button>
        <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>
          Cancel
        </Button>
      </form>
    );
  }
  const shown = display ?? value;
  if (!editable) return <span className={cn(!shown && 'text-ink-4')}>{shown || blank}</span>;
  return (
    <button
      className={cn('focus-ring -mx-1 rounded px-1 text-left decoration-ink-4 decoration-dotted underline-offset-4 hover:bg-accent-soft hover:underline', !shown && 'text-ink-4')}
      onClick={() => {
        setDraft(value ?? '');
        setEditing(true);
      }}
    >
      {shown || blank}
    </button>
  );
}

function AddWaiverDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const { data } = useWorkspace();
  const { pending, run } = useAction();
  const blank = { documentId: data.documents[0]?.id ?? '', waiverType: 'conditional_progress' as WaiverType, claimant: data.subcontractor?.name ?? '', throughDate: data.app.periodTo ?? '', amount: null as number | null, signed: 'unclear' as Tri };
  const [form, setForm] = useState(blank);
  useEffect(() => {
    if (open) setForm(blank);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Record a lien waiver by hand"
      description="Enter what the document says. The original stays attached, and this entry is recorded under your name."
      footer={
        <>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            variant="primary"
            loading={pending}
            disabled={!form.documentId}
            onClick={() =>
              run(() => addWaiverAction(data.app.id, form.documentId, { waiverType: form.waiverType, claimant: form.claimant || null, throughDate: form.throughDate || null, amount: form.amount, signed: form.signed }), {
                success: 'Waiver recorded',
                onSuccess: () => onOpenChange(false),
              })
            }
          >
            Record waiver
          </Button>
        </>
      }
    >
      <div className="grid grid-cols-2 gap-3">
        <Field label="Document containing the waiver" className="col-span-2">
          <Select value={form.documentId} onChange={(e) => setForm((f) => ({ ...f, documentId: e.target.value }))}>
            {data.documents.map((d) => (
              <option key={d.id} value={d.id}>
                {d.filename}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Type" className="col-span-2">
          <Select value={form.waiverType} onChange={(e) => setForm((f) => ({ ...f, waiverType: e.target.value as WaiverType }))}>
            {WAIVER_TYPES.map((t) => (
              <option key={t} value={t}>
                {WAIVER_TYPE_LABEL[t]}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Claimant">
          <Input value={form.claimant} onChange={(e) => setForm((f) => ({ ...f, claimant: e.target.value }))} />
        </Field>
        <Field label="Amount">
          <MoneyInput value={form.amount} onChange={(v) => setForm((f) => ({ ...f, amount: v }))} />
        </Field>
        <Field label="Through date" optional>
          <Input type="date" value={form.throughDate} onChange={(e) => setForm((f) => ({ ...f, throughDate: e.target.value }))} />
        </Field>
        <Field label="Signed">
          <Select value={form.signed} onChange={(e) => setForm((f) => ({ ...f, signed: e.target.value as Tri }))}>
            <option value="yes">Yes, signed</option>
            <option value="no">No, the signature is blank</option>
            <option value="unclear">Cannot tell</option>
          </Select>
        </Field>
      </div>
    </Dialog>
  );
}
