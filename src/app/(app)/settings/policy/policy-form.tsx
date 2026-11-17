'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/data';
import { Checkbox, Input, MoneyInput, Select } from '@/components/ui/form';
import { useAction } from '@/lib/use-action';
import type { OrgSettings } from '@/server/types';
import { updatePolicyAction } from './actions';

const MAX_TOLERANCE_CENTS = 100_000;

/** 0.75 → "75", 0.755 → "75.5" */
const percentText = (fraction: number) => String(Math.round(fraction * 1000) / 10);

/** "75" or "75.5" → 75 / 75.5; null for anything that is not a percentage between 0 and 100. */
function parsePercent(text: string): number | null {
  const s = text.trim().replace(/%$/, '').trim();
  if (!/^\d{1,3}(\.\d)?$/.test(s)) return null;
  const n = Number(s);
  return n <= 100 ? n : null;
}

type Toggle = 'requireConditionalWaiver' | 'requirePriorUnconditionalWaiver' | 'requireSignature' | 'requireNotarization';

function Row({ title, explanation, htmlFor, error, children }: { title: string; explanation: string; htmlFor: string; error?: string | null; children: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-8 px-4 py-3.5">
      <div className="min-w-0">
        <label htmlFor={htmlFor} className="block text-[13px] font-medium text-ink">
          {title}
        </label>
        <p className="mt-0.5 max-w-xl text-xs text-ink-3">{explanation}</p>
        {error ? <p className="mt-1 text-xs text-block">{error}</p> : null}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}

export function PolicyForm({ initial, canEdit }: { initial: OrgSettings; canEdit: boolean }) {
  const initialPercent = percentText(initial.lowConfidenceThreshold);
  const [tolerance, setTolerance] = useState<number>(initial.toleranceCents);
  const [toggles, setToggles] = useState<Record<Toggle, boolean>>({
    requireConditionalWaiver: initial.requireConditionalWaiver,
    requirePriorUnconditionalWaiver: initial.requirePriorUnconditionalWaiver,
    requireSignature: initial.requireSignature,
    requireNotarization: initial.requireNotarization,
  });
  const [percent, setPercent] = useState(initialPercent);
  const [senderPolicy, setSenderPolicy] = useState<OrgSettings['unknownSenderPolicy']>(initial.unknownSenderPolicy);
  const [dueDay, setDueDay] = useState(String(initial.portalDueDay));
  const { pending, run } = useAction();

  const percentChanged = percent.trim() !== initialPercent;
  const parsedPercent = parsePercent(percent);
  const toleranceOk = tolerance >= 0 && tolerance <= MAX_TOLERANCE_CENTS;
  const percentOk = !percentChanged || parsedPercent !== null;
  const parsedDueDay = /^\d{1,2}$/.test(dueDay.trim()) ? Number(dueDay.trim()) : NaN;
  const dueDayOk = parsedDueDay >= 1 && parsedDueDay <= 28;
  const dirty =
    tolerance !== initial.toleranceCents ||
    percentChanged ||
    senderPolicy !== initial.unknownSenderPolicy ||
    dueDay.trim() !== String(initial.portalDueDay) ||
    (Object.keys(toggles) as Toggle[]).some((k) => toggles[k] !== initial[k]);
  const disabled = !canEdit || pending;

  const discard = () => {
    setTolerance(initial.toleranceCents);
    setToggles({
      requireConditionalWaiver: initial.requireConditionalWaiver,
      requirePriorUnconditionalWaiver: initial.requirePriorUnconditionalWaiver,
      requireSignature: initial.requireSignature,
      requireNotarization: initial.requireNotarization,
    });
    setPercent(initialPercent);
    setSenderPolicy(initial.unknownSenderPolicy);
    setDueDay(String(initial.portalDueDay));
  };

  const save = () => {
    if (!canEdit || !dirty || !toleranceOk || !percentOk || !dueDayOk || pending) return;
    run(
      () =>
        updatePolicyAction({
          toleranceCents: tolerance,
          ...toggles,
          unknownSenderPolicy: senderPolicy,
          portalDueDay: parsedDueDay,
          // Left exactly as stored unless it was edited, so a save never nudges it by rounding.
          lowConfidenceThreshold: percentChanged && parsedPercent !== null ? parsedPercent / 100 : initial.lowConfidenceThreshold,
        }),
      { success: 'Review policy saved' },
    );
  };

  const toggle = (key: Toggle, title: string, severity: 'Blocking' | 'Warning', explanation: string) => (
    <div className="px-4 py-3.5">
      <Checkbox
        checked={toggles[key]}
        disabled={disabled}
        onChange={(e) => setToggles((t) => ({ ...t, [key]: e.target.checked }))}
        label={
          <span className="flex flex-wrap items-center gap-2 font-medium">
            {title}
            <Badge tone={severity === 'Blocking' ? 'block' : 'warn'}>{severity}</Badge>
          </span>
        }
        description={<span className="mt-0.5 block max-w-xl">{explanation}</span>}
      />
    </div>
  );

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        save();
      }}
    >
      <div className="divide-y divide-line">
        <Row
          title="Rounding tolerance"
          htmlFor="policy-tolerance"
          explanation="Differences up to this amount between what a subcontractor claims and what is verified are treated as rounding, not as discrepancies."
          error={toleranceOk ? null : 'Enter an amount between $0.00 and $1,000.00.'}
        >
          <div className="w-32">
            <MoneyInput id="policy-tolerance" value={tolerance} allowBlank={false} disabled={disabled} onChange={(cents) => setTolerance(cents ?? 0)} />
          </div>
        </Row>

        {toggle(
          'requireConditionalWaiver',
          'Require a conditional lien waiver for the current payment',
          'Blocking',
          'A package without a waiver covering the payment requested gets a blocking finding, and the application cannot be approved while it is open.',
        )}
        {toggle(
          'requirePriorUnconditionalWaiver',
          'Expect an unconditional waiver for the previous payment',
          'Warning',
          'From application #2 onward, a package without an unconditional waiver for the previous payment gets a warning, which the approver has to acknowledge.',
        )}
        {toggle(
          'requireSignature',
          'Require the pay application to be signed',
          'Blocking',
          'An application whose certification is unsigned, or whose signature cannot be confirmed, gets a blocking finding until a signed copy arrives or a reviewer confirms the signature.',
        )}
        {toggle('requireNotarization', 'Require notarisation', 'Warning', 'An application without a completed notary block gets a warning, which the approver has to acknowledge.')}

        <Row
          title="Packages emailed from an unknown address"
          htmlFor="policy-sender"
          explanation="A package emailed from an address that is not the subcontractor’s contact on file, their email domain, or someone on your team. Anyone who knows the intake address can send to it, and sender addresses can be forged."
        >
          <div className="w-64">
            <Select id="policy-sender" value={senderPolicy} disabled={disabled} onChange={(e) => setSenderPolicy(e.target.value === 'reject' ? 'reject' : 'flag')}>
              <option value="flag">Accept, with a blocking finding</option>
              <option value="reject">Turn away, and notify reviewers</option>
            </Select>
          </div>
        </Row>

        <Row
          title="Subcontractor billing due day"
          htmlFor="policy-due-day"
          explanation="The day of the month each month’s application is due. Subcontractor portal links show it, and remind subcontractors with nothing in for the month in the five days before it and once after it."
          error={dueDayOk ? null : 'Enter a day from 1 to 28.'}
        >
          <div className="flex items-center gap-1.5">
            <span className="text-ink-3">Day</span>
            <Input id="policy-due-day" inputMode="numeric" className="num w-14 text-right" value={dueDay} disabled={disabled} aria-invalid={!dueDayOk} onChange={(e) => setDueDay(e.target.value)} />
          </div>
        </Row>

        <Row
          title="Low-confidence threshold"
          htmlFor="policy-confidence"
          explanation="Values read from a document with less confidence than this are flagged for a human check. A higher threshold flags more values."
          error={percentOk ? null : 'Enter a percentage between 0 and 100.'}
        >
          <div className="flex items-center gap-1.5">
            <Input
              id="policy-confidence"
              inputMode="decimal"
              className="num w-16 text-right"
              value={percent}
              disabled={disabled}
              aria-invalid={!percentOk}
              onChange={(e) => setPercent(e.target.value)}
            />
            <span className="text-ink-3">%</span>
          </div>
        </Row>
      </div>

      <div className="flex items-center justify-between gap-4 rounded-b-xl border-t border-line bg-canvas/60 px-4 py-3">
        <p className="text-xs text-ink-3">Saving a change to the checks re-checks every undecided application against the new policy. Applications already approved, rejected or voided are not changed.</p>
        {canEdit ? (
          <div className="flex shrink-0 items-center gap-2">
            {dirty ? (
              <Button variant="ghost" onClick={discard} disabled={pending}>
                Discard changes
              </Button>
            ) : null}
            <Button type="submit" variant="primary" loading={pending} disabled={!dirty || !toleranceOk || !percentOk || !dueDayOk}>
              Save policy
            </Button>
          </div>
        ) : null}
      </div>
    </form>
  );
}
