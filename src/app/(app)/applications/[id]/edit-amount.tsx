'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { MoneyInput, Textarea } from '@/components/ui/form';
import { Popover } from '@/components/ui/overlay';
import { formatMoney } from '@/lib/money';
import { cn } from '@/lib/utils';

export type AmountEdit = { value: number | null; kind: 'correction' | 'adjustment'; note: string | null };

/**
 * A figure that can be clicked to change it. When `askKind` is set the
 * reviewer says whether they are fixing a misread or changing what will be
 * approved — the two are recorded differently.
 */
export function EditableAmount({
  value,
  extracted,
  editable,
  askKind,
  label,
  pending,
  onSave,
  className,
  children,
}: {
  value: number | null;
  /** What the document reader originally produced, if different. */
  extracted?: number | null;
  editable: boolean;
  askKind?: boolean;
  label: string;
  pending?: boolean;
  onSave: (edit: AmountEdit, close: () => void) => void;
  className?: string;
  children?: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<number | null>(value);
  const [kind, setKind] = useState<'correction' | 'adjustment'>('correction');
  const [note, setNote] = useState('');

  const display = children ?? <span className="num">{formatMoney(value)}</span>;
  if (!editable) return <span className={className}>{display}</span>;

  return (
    <Popover
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (o) {
          setDraft(value);
          setKind('correction');
          setNote('');
        }
      }}
      align="end"
      className="w-72"
      trigger={
        <button
          className={cn('focus-ring -mx-1 rounded px-1 text-right decoration-ink-4 decoration-dotted underline-offset-4 hover:bg-accent-soft hover:underline', className)}
          aria-label={`Edit ${label}`}
        >
          {display}
        </button>
      }
    >
      <form
        className="space-y-2.5"
        onSubmit={(e) => {
          e.preventDefault();
          onSave({ value: draft, kind, note: note.trim() || null }, () => setOpen(false));
        }}
      >
        <div className="text-xs font-medium text-ink">{label}</div>
        <MoneyInput autoFocus value={draft} onChange={setDraft} />
        {extracted !== undefined && extracted !== value ? <p className="text-[11px] text-ink-3">Originally read as {formatMoney(extracted)}.</p> : null}
        {askKind ? (
          <fieldset className="space-y-1.5">
            <legend className="sr-only">Why are you changing this?</legend>
            {(
              [
                ['correction', 'The document was misread', 'The figure on the page is different from what was read.'],
                ['adjustment', 'Adjust the approved amount', 'The document says this, but a different amount will be approved.'],
              ] as const
            ).map(([k, title, hint]) => (
              <label key={k} className={cn('flex cursor-pointer gap-2 rounded-md border px-2 py-1.5', kind === k ? 'border-accent bg-accent-soft/50' : 'border-line hover:bg-sunken/50')}>
                <input type="radio" name="kind" className="mt-0.5 accent-ink" checked={kind === k} onChange={() => setKind(k)} />
                <span>
                  <span className="block text-xs font-medium text-ink">{title}</span>
                  <span className="block text-[11px] leading-4 text-ink-3">{hint}</span>
                </span>
              </label>
            ))}
            {kind === 'adjustment' ? <Textarea className="min-h-14 text-xs" placeholder="Reason (required). Shown on the approval record." value={note} onChange={(e) => setNote(e.target.value)} /> : null}
          </fieldset>
        ) : null}
        <div className="flex justify-end gap-1.5">
          <Button size="sm" variant="ghost" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button size="sm" variant="primary" type="submit" loading={pending} disabled={draft === value || (askKind && kind === 'adjustment' && note.trim().length < 3)}>
            Save
          </Button>
        </div>
      </form>
    </Popover>
  );
}
