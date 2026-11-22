'use client';

import { ArrowLeft, ArrowRight, Check, CircleCheck, FileStack, Lock, LocateFixed, Mail, OctagonAlert, RotateCcw, ScanText, ShieldCheck, TriangleAlert, UserCheck } from 'lucide-react';
import Link from 'next/link';
import { useCallback, useId, useRef, useState } from 'react';
import type { SampleFinding, SampleSnapshot, SampleSource } from '@/content/sample-types';
import { formatBps, formatDelta, formatMoney } from '@/lib/money';
import { cn, formatDate, formatMonth } from '@/lib/utils';
import { CLAIMED_FIELD_LINE, type ClaimedField } from '@/server/types';
import { SampleDocument, type SampleTarget } from './sample-document';

/**
 * The public sample workflow: one fictitious billing package, followed from
 * arrival to decision. Everything shown about the package (what was read,
 * what was checked, what was found, the correction wording) is the product's
 * own output for this PDF, saved as a snapshot. What the visitor does here
 * (writing a reason, approving) happens in this browser tab only: nothing is
 * stored, sent or approved, and the page says so where it matters.
 */

const STEPS = [
  { key: 'arrives', label: 'Arrives', icon: FileStack },
  { key: 'read', label: 'Read', icon: ScanText },
  { key: 'checked', label: 'Checked', icon: ShieldCheck },
  { key: 'decide', label: 'Decided', icon: UserCheck },
] as const;

const MIN_REASON = 10;

export function SampleWorkflow({ snapshot: s }: { snapshot: SampleSnapshot }) {
  const [step, setStep] = useState(0);
  const [page, setPage] = useState(1);
  const [target, setTarget] = useState<SampleTarget | null>(null);
  const [picked, setPicked] = useState<string | null>(null);
  const nonce = useRef(0);
  const pane = useRef<HTMLDivElement>(null);

  const show = useCallback((source: SampleSource | null, key: string) => {
    if (!source) return;
    setPicked(key);
    setPage(source.page);
    setTarget({ page: source.page, bbox: source.bbox, nonce: ++nonce.current });
  }, []);

  const go = (next: number) => {
    setStep(next);
    setPicked(null);
    if (next === 0) {
      setTarget(null);
      setPage(1);
    }
    // Onto the checks: start on the figure the first finding is about, so the document already shows it.
    const first = s.findings[0];
    if (next === 2 && first?.source) show(first.source, first.id);
    pane.current?.scrollTo({ top: 0 });
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <nav aria-label="Sample workflow steps" className="shrink-0 border-b border-line bg-surface">
        <ol className="mx-auto flex w-full max-w-[1400px] items-stretch gap-1 overflow-x-auto px-3 sm:px-6">
          {STEPS.map((st, i) => {
            const on = i === step;
            const done = i < step;
            return (
              <li key={st.key} className="flex shrink-0 items-center">
                <button
                  type="button"
                  onClick={() => go(i)}
                  aria-current={on ? 'step' : undefined}
                  className={cn('focus-ring relative flex h-12 items-center gap-2 rounded-md px-2.5 text-[13.5px] transition-colors sm:px-3', on ? 'font-medium text-ink' : done ? 'text-ink-2 hover:text-ink' : 'text-ink-3 hover:text-ink-2')}
                >
                  <span className={cn('flex size-5 items-center justify-center rounded-full text-[10.5px] font-semibold', done ? 'bg-aqua text-white' : on ? 'bg-ink text-white' : 'border border-line-strong text-ink-3')}>
                    {done ? <Check className="size-3" strokeWidth={3} /> : i + 1}
                  </span>
                  {st.label}
                  {on ? <span className="absolute inset-x-2 -bottom-px h-0.5 rounded-full bg-ink" /> : null}
                </button>
                {i < STEPS.length - 1 ? <span aria-hidden className="mx-0.5 hidden h-px w-5 bg-line-strong sm:block" /> : null}
              </li>
            );
          })}
        </ol>
      </nav>

      <div className="mx-auto grid min-h-0 w-full max-w-[1400px] flex-1 grid-cols-[minmax(0,1fr)] lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] xl:grid-cols-[minmax(0,1.05fr)_minmax(0,1fr)]">
        <SampleDocument document={s.document} page={page} onPage={(p) => { setPage(p); setTarget(null); setPicked(null); }} target={target} className="h-[46vh] min-w-0 border-b border-line lg:h-auto lg:border-b-0 lg:border-r" />

        <div ref={pane} className="min-h-0 min-w-0 overflow-y-auto bg-surface">
          <div key={step} className="mx-auto w-full max-w-[640px] animate-rise px-5 pb-10 pt-6 sm:px-8 sm:pt-8">
            {step === 0 ? <Arrives s={s} /> : null}
            {step === 1 ? <Read s={s} picked={picked} onShow={show} /> : null}
            {step === 2 ? <Checked s={s} picked={picked} onShow={show} /> : null}
            {step === 3 ? <Decide s={s} onShow={show} onRestart={() => go(0)} /> : null}

            {step < 3 ? (
              <div className="mt-8 flex items-center gap-2 border-t border-line pt-5">
                {step > 0 ? (
                  <button type="button" onClick={() => go(step - 1)} className="focus-ring inline-flex h-10 items-center gap-1.5 rounded-lg border border-line-strong px-3.5 text-[14px] font-medium text-ink hover:bg-sunken/70">
                    <ArrowLeft className="size-4" />
                    Back
                  </button>
                ) : null}
                <button type="button" onClick={() => go(step + 1)} className="focus-ring group inline-flex h-10 items-center gap-2 rounded-lg bg-ink px-4 text-[14px] font-medium text-white hover:bg-ink/88">
                  {['Read the package', 'Check the figures', 'Decide what to do'][step]}
                  <ArrowRight className="size-4 transition-transform group-hover:translate-x-0.5" />
                </button>
              </div>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}

function Kicker({ n, children }: { n: number; children: React.ReactNode }) {
  return (
    <p className="text-[12px] font-medium uppercase tracking-[0.12em] text-accent">
      Step {n} of {STEPS.length} · {children}
    </p>
  );
}

function Title({ children }: { children: React.ReactNode }) {
  return <h1 className="mt-2 text-[24px] font-semibold leading-[1.15] tracking-[-0.025em] text-ink sm:text-[28px]">{children}</h1>;
}

function Lead({ children }: { children: React.ReactNode }) {
  return <p className="mt-3 text-[15px] leading-[1.6] text-ink-2">{children}</p>;
}

// ── 1. Arrives ──────────────────────────────────────────────────────────────

function Arrives({ s }: { s: SampleSnapshot }) {
  const c = s.contract;
  return (
    <>
      <Kicker n={1}>The package arrives</Kicker>
      <Title>
        {s.parties.subcontractor} sends pay application #{s.application.number}
      </Title>
      <Lead>
        One PDF, the way subcontractors already send them: the pay application, its schedule of values and a lien waiver, for work on {s.parties.project} through {formatDate(s.application.periodTo)}. They are asking for{' '}
        <strong className="num font-semibold text-ink">{formatMoney(s.application.requested)}</strong>.
      </Lead>
      <p className="mt-3 text-[14px] leading-[1.6] text-ink-3">The document is on this page as it arrived. Use the page buttons above it to look through all three parts.</p>

      <section className="mt-7 rounded-xl border border-line bg-canvas p-4 sm:p-5" aria-labelledby="sample-records">
        <h2 id="sample-records" className="text-[13px] font-semibold text-ink">
          What {s.parties.generalContractor} already has on record
        </h2>
        <p className="mt-1 text-[13px] leading-[1.55] text-ink-3">The package is checked against these, not against what it says about itself.</p>
        <dl className="num mt-4 grid grid-cols-2 gap-x-6 gap-y-3 text-[13px]">
          <Fact label="Subcontract">
            {s.parties.contractNumber} · {s.parties.contractTitle}
          </Fact>
          <Fact label="Retainage">{formatBps(c.retainageWorkBps)} of work and stored material</Fact>
          <Fact label="Original contract">{formatMoney(c.originalAmount)}</Fact>
          <Fact label="Approved change orders">{formatMoney(c.approvedChangeOrders)}</Fact>
        </dl>
        <h3 className="mt-5 text-[11px] font-medium uppercase tracking-[0.08em] text-ink-3">Billing already approved</h3>
        <ul className="num mt-2 divide-y divide-line rounded-lg border border-line bg-surface text-[13px]">
          {c.history.map((h) => (
            <li key={h.number} className="flex items-center justify-between gap-3 px-3 py-2">
              <span className="text-ink-2">
                Application #{h.number} · {formatMonth(h.periodTo)}
              </span>
              <span className="font-medium text-ink">{formatMoney(h.approved)}</span>
            </li>
          ))}
          <li className="flex items-center justify-between gap-3 bg-canvas/60 px-3 py-2">
            <span className="text-ink-2">Approved for payment so far</span>
            <span className="font-semibold text-ink">{formatMoney(c.history.reduce((t, h) => t + h.approved, 0))}</span>
          </li>
        </ul>
      </section>
    </>
  );
}

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="text-[11px] font-medium uppercase tracking-[0.08em] text-ink-3">{label}</dt>
      <dd className="mt-0.5 text-ink">{children}</dd>
    </div>
  );
}

// ── 2. Read ─────────────────────────────────────────────────────────────────

function Read({ s, picked, onShow }: { s: SampleSnapshot; picked: string | null; onShow: (source: SampleSource | null, key: string) => void }) {
  const [tab, setTab] = useState<'summary' | 'lines'>('summary');
  return (
    <>
      <Kicker n={2}>Reading</Kicker>
      <Title>Every figure is read, and stays tied to its place on the page</Title>
      <Lead>
        Zephric read {s.summary.length} summary figures and {s.lines.length} schedule of values lines from this PDF. Point at any row and the document shows where it is printed, so a reviewer checks the source and not a retyped copy.
      </Lead>

      <div role="tablist" aria-label="What was read" className="mt-6 inline-flex gap-1 rounded-full border border-line bg-canvas p-1">
        {(
          [
            ['summary', `Application summary (${s.summary.length})`],
            ['lines', `Schedule of values (${s.lines.length})`],
          ] as const
        ).map(([key, label]) => (
          <button key={key} type="button" role="tab" aria-selected={tab === key} onClick={() => setTab(key)} className={cn('focus-ring rounded-full px-3.5 py-1.5 text-[13px] font-medium transition-colors', tab === key ? 'bg-ink text-white' : 'text-ink-2 hover:text-ink')}>
            {label}
          </button>
        ))}
      </div>

      {tab === 'summary' ? (
        <ul className="num mt-3 overflow-hidden rounded-xl border border-line text-[13.5px]">
          {s.summary.map((row) => (
            <ReadRow key={row.key} on={picked === row.key} onShow={() => onShow(row.source, row.key)} lead={CLAIMED_FIELD_LINE[row.key as ClaimedField] ?? ''} label={row.label} value={formatMoney(row.onDocument)} />
          ))}
        </ul>
      ) : (
        <ul className="num mt-3 overflow-hidden rounded-xl border border-line text-[13.5px]">
          {s.lines.map((line) => (
            <ReadRow
              key={line.itemNo}
              on={picked === `line:${line.itemNo}`}
              onShow={() => onShow(line.source, `line:${line.itemNo}`)}
              lead={line.itemNo}
              label={line.description}
              sub={`${formatMoney(line.thisPeriod)} this period · ${line.percent}% complete`}
              value={formatMoney(line.completedToDate)}
            />
          ))}
        </ul>
      )}

      <p className="mt-4 flex items-start gap-2 text-[13px] leading-[1.55] text-ink-3">
        <ScanText className="mt-0.5 size-4 shrink-0 text-ink-4" />
        This PDF has a text layer, so it was read by rules, with no AI involved. For scanned documents there is an AI-assisted reader, not yet measured on real documents. Either way, what is read is then checked the same way, and anything uncertain is flagged for a person instead of guessed.
      </p>
    </>
  );
}

function ReadRow({ on, onShow, lead, label, sub, value }: { on: boolean; onShow: () => void; lead: string; label: string; sub?: string; value: string }) {
  return (
    <li className="border-b border-line last:border-0">
      <button type="button" onClick={onShow} onMouseEnter={onShow} onFocus={onShow} aria-pressed={on} className={cn('focus-ring flex w-full items-center gap-3 px-3.5 py-2.5 text-left transition-colors', on ? 'bg-accent-soft/70' : 'hover:bg-canvas')}>
        <span className="w-7 shrink-0 font-mono text-[11px] text-ink-4">{lead}</span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-ink">{label}</span>
          {sub ? <span className="block truncate text-[12px] text-ink-3">{sub}</span> : null}
        </span>
        <span className={cn('shrink-0 font-medium', on ? 'text-accent-ink' : 'text-ink')}>{value}</span>
        <LocateFixed className={cn('size-3.5 shrink-0 transition-opacity', on ? 'text-accent opacity-100' : 'opacity-0')} aria-hidden />
      </button>
    </li>
  );
}

// ── 3. Checked ──────────────────────────────────────────────────────────────

function Checked({ s, picked, onShow }: { s: SampleSnapshot; picked: string | null; onShow: (source: SampleSource | null, key: string) => void }) {
  const a = s.application;
  return (
    <>
      <Kicker n={3}>Checking</Kicker>
      <Title>Every figure is recomputed from the records</Title>
      <Lead>
        The arithmetic, the contract sum, the change orders, each schedule line, retainage and the billing already approved were all worked out again from {s.parties.generalContractor}’s own records. The same figures always give the same result.
      </Lead>

      <dl className="num mt-6 grid grid-cols-3 overflow-hidden rounded-xl border border-line text-[13px]">
        <div className="border-r border-line px-2.5 py-3 sm:px-3.5">
          <dt className="text-[11px] font-medium uppercase tracking-[0.08em] text-ink-3">Requested</dt>
          <dd className="mt-1 whitespace-nowrap text-[13.5px] font-medium text-ink sm:text-[17px]">{formatMoney(a.requested)}</dd>
        </div>
        <div className="border-r border-line px-2.5 py-3 sm:px-3.5">
          <dt className="text-[11px] font-medium uppercase tracking-[0.08em] text-ink-3">Verified</dt>
          <dd className="mt-1 whitespace-nowrap text-[13.5px] font-semibold text-ink sm:text-[17px]">{formatMoney(a.verified)}</dd>
        </div>
        <div className="bg-block-soft/50 px-2.5 py-3 sm:px-3.5">
          <dt className="text-[11px] font-medium uppercase tracking-[0.08em] text-ink-3">Difference</dt>
          <dd className="mt-1 whitespace-nowrap text-[13.5px] font-semibold text-block sm:text-[17px]">{formatDelta(a.difference)}</dd>
        </div>
      </dl>

      <p className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-[13px]">
        <span className="inline-flex items-center gap-1.5 font-medium text-pass">
          <CircleCheck className="size-4" /> {s.checks.passed} checks passed
        </span>
        <span className="font-medium text-block">{s.checks.blocking} blocking</span>
        <span className="font-medium text-warn">
          {s.checks.warnings} warning{s.checks.warnings === 1 ? '' : 's'}
        </span>
      </p>

      <h2 className="mt-7 text-[11px] font-medium uppercase tracking-[0.08em] text-ink-3">What needs attention</h2>
      <div className="mt-2 space-y-3">
        {s.findings.map((f) => (
          <FindingCard key={f.id} finding={f} on={picked === f.id} onShow={() => onShow(f.source, f.id)} />
        ))}
      </div>

      <p className="mt-5 text-[13px] leading-[1.55] text-ink-3">
        <span className="font-medium text-ink-2">Nothing open in:</span> {s.checks.passedGroups.join(' · ')}.
      </p>
    </>
  );
}

function FindingCard({ finding: f, on, onShow, compact }: { finding: SampleFinding; on?: boolean; onShow: () => void; compact?: boolean }) {
  const blocking = f.severity === 'blocking';
  return (
    <article className={cn('rounded-xl border bg-surface transition-shadow', blocking ? 'border-block-line' : 'border-warn-line', on && 'shadow-[0_0_0_3px_rgb(31_79_209/0.14)]')}>
      <header className={cn('flex items-start gap-2.5 rounded-t-xl px-4 py-3', blocking ? 'bg-block-soft/60' : 'bg-warn-soft/60')}>
        {blocking ? <OctagonAlert className="mt-0.5 size-4 shrink-0 text-block" /> : <TriangleAlert className="mt-0.5 size-4 shrink-0 text-warn" />}
        <div className="min-w-0">
          <h3 className="text-[14px] font-semibold leading-snug text-ink">{f.title}</h3>
          <p className="mt-0.5 text-[12px] text-ink-3">
            <span className={cn('font-medium', blocking ? 'text-block' : 'text-warn')}>{blocking ? 'Blocking' : 'Warning'}</span> · {f.category}
          </p>
        </div>
      </header>
      {compact ? null : (
        <div className="space-y-3 px-4 py-3.5">
          <p className="text-[13.5px] leading-[1.6] text-ink-2">{f.message}</p>
          {f.expected || f.onDocument ? (
            <dl className="num grid grid-cols-3 overflow-hidden rounded-lg border border-line text-[12px] sm:text-[13px]">
              <Figure label="Expected" value={f.expected} />
              <Figure label="On the document" value={f.onDocument} />
              <Figure label="Difference" value={f.difference} tone="block" last />
            </dl>
          ) : null}
          {f.whatToDo ? (
            <p className="text-[13px] leading-[1.55] text-ink-2">
              <span className="font-medium text-ink">What to do:</span> {f.whatToDo}
            </p>
          ) : null}
          {f.source ? (
            <button type="button" onClick={onShow} className={cn('focus-ring inline-flex h-8 items-center gap-1.5 rounded-md border px-2.5 text-[13px] font-medium transition-colors', on ? 'border-accent-line bg-accent-soft text-accent-ink' : 'border-line-strong text-ink hover:bg-sunken/70')}>
              <LocateFixed className="size-3.5" />
              Show in document
            </button>
          ) : null}
        </div>
      )}
    </article>
  );
}

function Figure({ label, value, tone, last }: { label: string; value: string | null; tone?: 'block'; last?: boolean }) {
  return (
    <div className={cn('px-2 py-2 sm:px-3', !last && 'border-r border-line')}>
      <dt className="text-[10.5px] font-medium uppercase tracking-[0.07em] text-ink-3">{label}</dt>
      <dd className={cn('mt-0.5 whitespace-nowrap font-medium', tone === 'block' ? 'text-block' : 'text-ink')}>{value ?? '—'}</dd>
    </div>
  );
}

// ── 4. Decide ───────────────────────────────────────────────────────────────

function Decide({ s, onShow, onRestart }: { s: SampleSnapshot; onShow: (source: SampleSource | null, key: string) => void; onRestart: () => void }) {
  const [mode, setMode] = useState<'correction' | 'approve'>('correction');
  const [reasons, setReasons] = useState<Record<string, string>>({});
  const [acknowledged, setAcknowledged] = useState(false);
  const [approved, setApproved] = useState(false);
  const id = useId();
  const a = s.application;
  const blocking = s.findings.filter((f) => f.severity === 'blocking');
  const warnings = s.findings.filter((f) => f.severity === 'warning');
  const ready = blocking.every((f) => (reasons[f.id] ?? '').trim().length >= MIN_REASON) && (warnings.length === 0 || acknowledged);
  const over = formatMoney(Math.abs(a.difference));

  if (approved) {
    return (
      <>
        <Kicker n={4}>Decided</Kicker>
        <div className="mt-4 rounded-2xl border border-pass-line bg-pass-soft/60 p-5 sm:p-6">
          <span className="flex size-10 items-center justify-center rounded-full bg-pass text-white">
            <Check className="size-5" strokeWidth={2.5} />
          </span>
          <h1 className="num mt-4 text-[24px] font-semibold leading-[1.15] tracking-[-0.025em] text-ink sm:text-[28px]">Approved for {formatMoney(a.verified)}</h1>
          <p className="mt-2 text-[15px] leading-[1.6] text-ink-2">
            That is <strong className="num font-semibold text-ink">{over}</strong> less than was requested: the amount that would otherwise have been paid a second time.
          </p>
        </div>
        <h2 className="mt-7 text-[13px] font-semibold text-ink">What the product does at this point</h2>
        <ul className="mt-3 space-y-2.5 text-[14px] leading-[1.55] text-ink-2">
          {[
            'Recomputes every figure once more at the moment of approval, and refuses if anything changed since you looked.',
            'Keeps the decision, who made it and the written reasons in an audit trail that shows if it is ever altered.',
            'Makes the approval record available as a PDF, CSV or JSON file for your accounting system.',
          ].map((t) => (
            <li key={t} className="flex gap-2.5">
              <Check className="mt-1 size-4 shrink-0 text-aqua-ink" strokeWidth={2.5} />
              {t}
            </li>
          ))}
        </ul>
        <p className="mt-4 rounded-lg bg-canvas px-3.5 py-2.5 text-[13px] leading-[1.55] text-ink-3">This was a sample. Nothing was saved, sent or approved anywhere, and the reasons you typed never left this browser tab.</p>
        <NextSteps onRestart={onRestart} />
      </>
    );
  }

  return (
    <>
      <Kicker n={4}>Deciding</Kicker>
      <Title>The software checks. A person decides.</Title>
      <Lead>
        Zephric never approves anything by itself. With {blocking.length} blocking finding{blocking.length === 1 ? '' : 's'} open, approving the requested {formatMoney(a.requested)} is refused. Here are the two things a reviewer usually does next. Try either.
      </Lead>

      <div role="tablist" aria-label="Ways forward" className="mt-6 grid gap-2 sm:grid-cols-2">
        {(
          [
            ['correction', Mail, 'Ask for a correction', 'Send it back with exactly what to fix.'],
            ['approve', UserCheck, 'Approve the verified amount', `Pay the ${formatMoney(a.verified)} the records support.`],
          ] as const
        ).map(([key, Icon, title, sub]) => (
          <button
            key={key}
            type="button"
            role="tab"
            id={`${id}-${key}-tab`}
            aria-selected={mode === key}
            aria-controls={`${id}-panel`}
            onClick={() => setMode(key)}
            className={cn('focus-ring flex items-start gap-3 rounded-xl border p-3.5 text-left transition-[border-color,box-shadow]', mode === key ? 'border-ink shadow-[0_0_0_1px_var(--color-ink)]' : 'border-line hover:border-line-strong')}
          >
            <span className={cn('flex size-8 shrink-0 items-center justify-center rounded-lg', mode === key ? 'bg-ink text-white' : 'bg-sunken text-ink-2')}>
              <Icon className="size-4" />
            </span>
            <span className="min-w-0">
              <span className="block text-[14px] font-medium text-ink">{title}</span>
              <span className="num mt-0.5 block text-[12.5px] leading-[1.45] text-ink-3">{sub}</span>
            </span>
          </button>
        ))}
      </div>

      <div id={`${id}-panel`} role="tabpanel" aria-labelledby={`${id}-${mode}-tab`} className="mt-4">
        {mode === 'correction' ? (
          <div>
            <p className="text-[14px] leading-[1.6] text-ink-2">Zephric drafts the request from the findings, naming each figure and why it is wrong, so the subcontractor knows exactly what to resubmit. The reviewer can edit it before sending.</p>
            {s.correction ? (
              <figure className="mt-4 overflow-hidden rounded-xl border border-line">
                <figcaption className="border-b border-line bg-canvas px-4 py-2.5 text-[13px]">
                  <span className="text-ink-3">Subject:</span> <span className="font-medium text-ink">{s.correction.subject}</span>
                </figcaption>
                <pre className="max-h-[340px] overflow-auto whitespace-pre-wrap px-4 py-3.5 font-sans text-[13px] leading-[1.6] text-ink-2">{s.correction.body}</pre>
              </figure>
            ) : null}
            <p className="mt-3 flex items-start gap-2 text-[13px] leading-[1.55] text-ink-3">
              <Lock className="mt-0.5 size-3.5 shrink-0 text-ink-4" />
              Not sent: this is a sample. In the product the application then waits under “Awaiting subcontractor”, and the revised package is read and checked from the beginning when it arrives.
            </p>
            <NextSteps onRestart={onRestart} />
          </div>
        ) : (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (ready) setApproved(true);
            }}
          >
            <p className="text-[14px] leading-[1.6] text-ink-2">
              Someone with approval rights (a controller, admin or owner) can approve what the records support instead of what was asked for. Each blocking finding has to be set aside with a written reason, which stays on the approval record. Project accountants cannot do this.
            </p>
            <div className="mt-4 space-y-3">
              {blocking.map((f) => (
                <div key={f.id} className="rounded-xl border border-line p-3.5">
                  <div className="flex items-start justify-between gap-3">
                    <label htmlFor={`${id}-${f.id}`} className="text-[13.5px] font-medium leading-snug text-ink">
                      {f.title}
                    </label>
                    <button type="button" onClick={() => onShow(f.source, f.id)} className="focus-ring shrink-0 rounded text-[12px] font-medium text-accent hover:underline">
                      Show in document
                    </button>
                  </div>
                  <textarea
                    id={`${id}-${f.id}`}
                    rows={2}
                    value={reasons[f.id] ?? ''}
                    onChange={(e) => setReasons((r) => ({ ...r, [f.id]: e.target.value }))}
                    placeholder="Why this can be set aside, in your own words"
                    className="focus-ring mt-2 block w-full resize-y rounded-lg border border-line-strong bg-surface px-3 py-2 text-[13.5px] leading-[1.5] text-ink placeholder:text-ink-4"
                  />
                  <p className="mt-1 text-[12px] text-ink-3">{(reasons[f.id] ?? '').trim().length >= MIN_REASON ? 'Reason recorded.' : `A real reason, at least ${MIN_REASON} characters.`}</p>
                </div>
              ))}
              {warnings.length ? (
                <label className="flex cursor-pointer items-start gap-2.5 rounded-xl border border-line p-3.5 text-[13.5px] leading-[1.5] text-ink-2">
                  <input type="checkbox" checked={acknowledged} onChange={(e) => setAcknowledged(e.target.checked)} className="mt-0.5 size-4 shrink-0 accent-[var(--color-ink)]" />
                  <span>
                    I have seen the warning{warnings.length === 1 ? '' : 's'}: <span className="text-ink">{warnings.map((w) => w.title).join('; ')}</span>.
                  </span>
                </label>
              ) : null}
            </div>
            <div className="mt-5 flex flex-wrap items-center gap-3">
              <button type="submit" disabled={!ready} className="focus-ring num inline-flex h-11 items-center gap-2 rounded-lg bg-ink px-4 text-[14.5px] font-medium text-white transition-colors hover:bg-ink/88 disabled:cursor-not-allowed disabled:bg-ink/35">
                {ready ? <Check className="size-4" /> : <Lock className="size-4" />}
                Approve {formatMoney(a.verified)}
              </button>
              <span className="text-[13px] text-ink-3">{ready ? 'Nothing is saved: this is a sample.' : 'Locked until each blocking finding has a reason.'}</span>
            </div>
          </form>
        )}
      </div>
    </>
  );
}

function NextSteps({ onRestart }: { onRestart: () => void }) {
  return (
    <section className="mt-8 rounded-2xl bg-navy p-5 text-white sm:p-6" aria-labelledby="sample-next">
      <h2 id="sample-next" className="text-[18px] font-semibold tracking-[-0.015em]">
        See it on your own documents
      </h2>
      <p className="mt-2 text-[14px] leading-[1.6] text-white/65">We are inviting a small number of general contractors to supervised pilots on their own pay applications. Or create an account and explore a full example workspace with five months of billing.</p>
      <div className="mt-5 flex flex-wrap gap-2.5">
        <Link href="/#partner" className="focus-ring group inline-flex h-11 items-center gap-2 rounded-full bg-white px-5 text-[14.5px] font-medium text-ink hover:bg-white/90">
          Become a design partner
          <ArrowRight className="size-4 transition-transform group-hover:translate-x-0.5" />
        </Link>
        <Link href="/signup" className="focus-ring inline-flex h-11 items-center rounded-full border border-white/20 px-5 text-[14.5px] font-medium text-white hover:border-white/40 hover:bg-white/5">
          Create an account
        </Link>
        <button type="button" onClick={onRestart} className="focus-ring inline-flex h-11 items-center gap-2 rounded-full px-3 text-[14px] font-medium text-white/70 hover:text-white">
          <RotateCcw className="size-4" />
          Start again
        </button>
      </div>
    </section>
  );
}
