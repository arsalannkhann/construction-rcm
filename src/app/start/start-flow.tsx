'use client';

import { ArrowRight, BadgeCheck, Building2, ClipboardCheck, Compass, Info, LineChart, Loader2 } from 'lucide-react';
import { useEffect, useId, useState, useTransition } from 'react';
import { FormError } from '@/components/ui/form';
import { FOCUS_DETAIL, FOCUS_LABEL, kindNote, ORG_KIND_LABEL, regionNote } from '@/lib/onboarding';
import { cn } from '@/lib/utils';
import { ORG_KINDS, ORG_REGIONS, type MemberFocus, type OrgKind, type OrgProfile, type OrgRegion } from '@/server/types';
import { completeWelcomeAction, skipWelcomeAction } from '../onboarding-actions';

const FOCUS_ICON: Record<MemberFocus, typeof Compass> = { review: ClipboardCheck, approve: BadgeCheck, oversee: LineChart, projects: Building2 };
const REGION_CHOICE: Record<OrgRegion, string> = { us: 'United States', india: 'India', other: 'Elsewhere' };

/** What the server is doing while the example is built, shown in turn. Not a progress measure, and it does not claim to be one. */
const BUILDING = ['Generating about forty billing packages', 'Reading each one as it would read yours', 'Checking every figure against its subcontract', 'Recording five months of reviews and approvals'];

export function StartFlow({
  firstName,
  orgName,
  returning,
  focuses,
  initialFocus,
  askProfile,
  initialProfile,
  canSetUp,
  hasExample,
}: {
  firstName: string;
  orgName: string;
  returning: boolean;
  focuses: MemberFocus[];
  initialFocus: MemberFocus;
  askProfile: boolean;
  initialProfile: OrgProfile | null;
  canSetUp: boolean;
  hasExample: boolean;
}) {
  const [focus, setFocus] = useState<MemberFocus>(focuses.includes(initialFocus) ? initialFocus : focuses[0]!);
  const [kind, setKind] = useState<OrgKind>(initialProfile?.kind ?? 'general_contractor');
  const [region, setRegion] = useState<OrgRegion>(initialProfile?.region ?? 'us');
  const [error, setError] = useState<string | null>(null);
  const [going, setGoing] = useState<null | 'example' | 'real' | 'skip'>(null);
  const [, start] = useTransition();
  const [tick, setTick] = useState(0);
  const group = useId();

  useEffect(() => {
    if (going !== 'example' || hasExample) return;
    const id = window.setInterval(() => setTick((t) => (t + 1) % BUILDING.length), 3200);
    return () => window.clearInterval(id);
  }, [going, hasExample]);

  const go = (path: 'example' | 'real') => {
    if (going) return;
    setError(null);
    setGoing(path);
    start(async () => {
      const result = await completeWelcomeAction({ focus, path: path === 'real' && !canSetUp ? null : path, ...(askProfile ? { kind, region } : {}) });
      if (!result.ok) {
        setError(result.error);
        setGoing(null);
        return;
      }
      // A full page load: the session may now be in the example workspace, and nothing of this one should stay in memory.
      window.location.assign(result.data.next);
    });
  };

  const skip = () => {
    if (going) return;
    setGoing('skip');
    start(async () => {
      const result = await skipWelcomeAction();
      if (!result.ok) {
        setError(result.error);
        setGoing(null);
      } else window.location.assign(result.data.next);
    });
  };

  const note = askProfile ? [kindNote(kind), regionNote(region)].filter(Boolean) : [];

  return (
    <div className="animate-rise">
      <p className="text-[12.5px] font-medium uppercase tracking-[0.14em] text-accent">{returning ? 'Your preferences' : 'Welcome'}</p>
      <h1 className="mt-3 max-w-[720px] text-[32px] font-semibold leading-[1.1] tracking-[-0.03em] text-ink sm:text-[40px]">{returning ? 'Change what you see first' : `Welcome to Zephric, ${firstName}.`}</h1>
      <p className="mt-4 max-w-[640px] text-[16px] leading-[1.6] text-ink-2">
        {returning
          ? 'Your answers only change what Zephric shows you first. They never change what you are allowed to do.'
          : 'Zephric reads the billing packages your subcontractors send, checks every figure against your project records, and shows your team what needs attention before anyone approves. Two quick questions, then you choose where to begin.'}
      </p>

      <div className="mt-8 max-w-[760px]">
        <FormError message={error} />
      </div>

      <fieldset className="mt-8" disabled={going !== null}>
        <legend className="text-[15px] font-semibold text-ink">What will you mostly do here?</legend>
        <p className="mt-1 text-[13.5px] text-ink-3">This decides what your overview puts at the top. You can change it any time from Help.</p>
        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          {focuses.map((f) => {
            const Icon = FOCUS_ICON[f];
            const on = focus === f;
            return (
              <label
                key={f}
                className={cn(
                  'relative flex cursor-pointer items-start gap-3.5 rounded-xl border bg-surface p-4 transition-[border-color,box-shadow] has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-accent/40',
                  on ? 'border-ink shadow-[0_0_0_1px_var(--color-ink)]' : 'border-line hover:border-line-strong',
                )}
              >
                <input type="radio" name={`${group}-focus`} value={f} checked={on} onChange={() => setFocus(f)} className="sr-only" />
                <span className={cn('flex size-9 shrink-0 items-center justify-center rounded-lg transition-colors', on ? 'bg-ink text-white' : 'bg-sunken text-ink-2')}>
                  <Icon className="size-[18px]" strokeWidth={1.9} />
                </span>
                <span className="min-w-0">
                  <span className="block text-[14.5px] font-medium text-ink">{FOCUS_LABEL[f]}</span>
                  <span className="mt-0.5 block text-[13px] leading-[1.5] text-ink-2">{FOCUS_DETAIL[f]}</span>
                </span>
              </label>
            );
          })}
        </div>
      </fieldset>

      {askProfile ? (
        <fieldset className="mt-9" disabled={going !== null}>
          <legend className="text-[15px] font-semibold text-ink">About {orgName}</legend>
          <p className="mt-1 text-[13.5px] text-ink-3">So we can tell you plainly what fits today and what does not.</p>
          <div className="mt-4 grid gap-5 rounded-xl border border-line bg-surface p-4 sm:grid-cols-2 sm:p-5">
            <Choice label="We are a" name={`${group}-kind`} value={kind} onChange={setKind} options={ORG_KINDS.map((k) => ({ value: k, label: ORG_KIND_LABEL[k] }))} />
            <Choice label="Our projects are in" name={`${group}-region`} value={region} onChange={setRegion} options={ORG_REGIONS.map((r) => ({ value: r, label: REGION_CHOICE[r] }))} />
            {note.length ? (
              <div className="flex items-start gap-2.5 rounded-lg bg-canvas px-3.5 py-3 text-[13px] leading-[1.55] text-ink-2 sm:col-span-2" role="note" aria-live="polite">
                <Info className="mt-0.5 size-4 shrink-0 text-ink-3" />
                <div className="space-y-1.5">
                  {note.map((n) => (
                    <p key={n}>{n}</p>
                  ))}
                </div>
              </div>
            ) : null}
          </div>
        </fieldset>
      ) : null}

      <section className="mt-9" aria-labelledby={`${group}-begin`}>
        <h2 id={`${group}-begin`} className="text-[15px] font-semibold text-ink">
          Where would you like to begin?
        </h2>
        <p className="mt-1 text-[13.5px] text-ink-3">Whichever you pick, the other stays one click away.</p>
        <div className="mt-4 grid gap-4 md:grid-cols-2">
          <StartCard
            tone="accent"
            icon={<Compass className="size-5" strokeWidth={1.9} />}
            title="Explore a ready-made example"
            body="A practice workspace with fictitious projects and five months of billing, including pay applications with real problems to find. A short tour walks you through one."
            meta={hasExample ? 'Ready now · nothing to enter' : 'About a minute to prepare · nothing to enter'}
            cta={hasExample ? 'Open the example' : 'Explore the example'}
            busy={going === 'example'}
            disabled={going !== null}
            onClick={() => go('example')}
            footnote="Kept completely separate from your organisation. It is labelled on every screen and can be deleted in one step."
          />
          <StartCard
            icon={<Building2 className="size-5" strokeWidth={1.9} />}
            title={canSetUp ? 'Set up a real project' : 'Go to my workspace'}
            body={
              canSetUp
                ? 'Add your project, a subcontractor and the subcontract, then upload a billing package. A guide keeps your place and picks up from whatever is already there.'
                : 'See the billing on your projects. An admin, controller or project accountant sets up projects and subcontracts; you can upload billing packages and follow them.'
            }
            meta={canSetUp ? 'About 10 minutes · have a subcontract to hand' : 'Nothing to set up'}
            cta={canSetUp ? 'Set up my project' : 'Open my workspace'}
            busy={going === 'real'}
            disabled={going !== null}
            onClick={() => go('real')}
          />
        </div>
        <div role="status" aria-live="polite" className="mt-4 min-h-6 text-[13.5px] text-ink-2">
          {going === 'example' && !hasExample ? (
            <span className="inline-flex animate-in items-center gap-2">
              <Loader2 className="size-4 animate-spin text-ink-3" />
              <span>
                Preparing your example. <span key={tick} className="animate-in text-ink-3">{BUILDING[tick]}…</span>
              </span>
            </span>
          ) : null}
        </div>
      </section>

      <p className="mt-6 text-[13.5px] text-ink-3">
        {returning ? 'Nothing to change? ' : 'Rather look around on your own? '}
        <button type="button" onClick={skip} disabled={going !== null} className="focus-ring rounded font-medium text-ink-2 underline decoration-line-strong underline-offset-4 hover:text-ink hover:decoration-ink disabled:opacity-50">
          {going === 'skip' ? 'Opening…' : returning ? 'Back to the overview' : 'Skip for now'}
        </button>
      </p>
    </div>
  );
}

function Choice<T extends string>({ label, name, value, onChange, options }: { label: string; name: string; value: T; onChange: (v: T) => void; options: Array<{ value: T; label: string }> }) {
  return (
    <div role="radiogroup" aria-label={label}>
      <p className="text-[13px] font-medium text-ink-2">{label}</p>
      <div className="mt-2 flex flex-wrap gap-1.5">
        {options.map((o) => {
          const on = value === o.value;
          return (
            <label
              key={o.value}
              className={cn(
                'cursor-pointer rounded-full border px-3 py-1.5 text-[13px] transition-colors has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-accent/40',
                on ? 'border-ink bg-ink text-white' : 'border-line-strong bg-surface text-ink-2 hover:border-ink-4 hover:text-ink',
              )}
            >
              <input type="radio" name={name} value={o.value} checked={on} onChange={() => onChange(o.value)} className="sr-only" />
              {o.label}
            </label>
          );
        })}
      </div>
    </div>
  );
}

function StartCard({
  icon,
  title,
  body,
  meta,
  cta,
  footnote,
  tone,
  busy,
  disabled,
  onClick,
}: {
  icon: React.ReactNode;
  title: string;
  body: string;
  meta: string;
  cta: string;
  footnote?: string;
  tone?: 'accent';
  busy: boolean;
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <div className={cn('flex flex-col rounded-2xl border bg-surface p-5 shadow-card sm:p-6', tone === 'accent' ? 'border-accent-line' : 'border-line')}>
      <span className={cn('flex size-10 items-center justify-center rounded-xl', tone === 'accent' ? 'bg-accent-soft text-accent-ink' : 'bg-sunken text-ink-2')}>{icon}</span>
      <h3 className="mt-4 text-[18px] font-semibold tracking-[-0.015em] text-ink">{title}</h3>
      <p className="mt-2 flex-1 text-[14px] leading-[1.6] text-ink-2">{body}</p>
      <p className="mt-4 text-[12.5px] text-ink-3">{meta}</p>
      <button
        type="button"
        onClick={onClick}
        disabled={disabled}
        className={cn(
          'focus-ring group mt-4 inline-flex h-11 items-center justify-center gap-2 rounded-lg px-4 text-[14.5px] font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-60',
          tone === 'accent' ? 'bg-ink text-white hover:bg-ink/88' : 'border border-line-strong bg-surface text-ink hover:bg-sunken/70',
        )}
      >
        {busy ? <Loader2 className="size-4 animate-spin" aria-hidden /> : null}
        {cta}
        {busy ? null : <ArrowRight className="size-4 transition-transform group-hover:translate-x-0.5" />}
      </button>
      {footnote ? <p className="mt-3 text-[12px] leading-[1.5] text-ink-3">{footnote}</p> : null}
    </div>
  );
}
