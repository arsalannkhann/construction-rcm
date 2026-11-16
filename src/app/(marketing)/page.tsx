import {
  ArrowRight,
  Calculator,
  CalendarClock,
  Check,
  FileCheck2,
  FileStack,
  History,
  Inbox,
  Landmark,
  ListChecks,
  Percent,
  ScanText,
  ShieldCheck,
  Upload,
  UserCheck,
} from 'lucide-react';
import type { Metadata } from 'next';
import Link from 'next/link';
import { Brand, BrandMark } from '@/components/brand';
import { HeroActions } from '@/components/marketing/hero-actions';
import { HeroPreview } from '@/components/marketing/hero-preview';
import { LegalLink } from '@/components/marketing/legal';
import { PartnerForm } from '@/components/marketing/partner-form';
import { RevealOnScroll } from '@/components/marketing/reveal';
import { SiteNav } from '@/components/marketing/site-nav';
import { TeamsTabs } from '@/components/marketing/teams-tabs';
import { TraceDemo } from '@/components/marketing/trace-demo';
import { cn } from '@/lib/utils';

export const metadata: Metadata = {
  title: { absolute: 'Zephric · Construction billing, without the busywork' },
  description:
    'Zephric helps construction finance teams organize payment applications, reconcile billing, identify discrepancies, and manage financial reviews in one intelligent workflow.',
};

const WRAP = 'mx-auto w-full max-w-[1200px] px-5 sm:px-8';

function Eyebrow({ children, dark }: { children: React.ReactNode; dark?: boolean }) {
  return (
    <p className={cn('flex items-center gap-2 text-[12.5px] font-medium uppercase tracking-[0.14em]', dark ? 'text-aqua' : 'text-accent')}>
      <span className={cn('h-px w-5', dark ? 'bg-aqua/60' : 'bg-accent/50')} />
      {children}
    </p>
  );
}

function H2({ children, dark, className }: { children: React.ReactNode; dark?: boolean; className?: string }) {
  return <h2 className={cn('mt-4 text-[32px] font-semibold leading-[1.08] tracking-[-0.03em] sm:text-[44px]', dark ? 'text-white' : 'text-ink', className)}>{children}</h2>;
}

const PROBLEMS = [
  { n: '01', title: 'Re-keyed by hand', body: 'Figures are copied out of PDFs into spreadsheets, line by line, for every subcontractor, every month.' },
  { n: '02', title: 'Checked from memory', body: 'Contract sums, change orders, retainage terms and last month’s billing all live in different places.' },
  { n: '03', title: 'Found too late', body: 'Discrepancies surface after review, or after payment, when they are slowest and hardest to unwind.' },
];

const STEPS = [
  { icon: Upload, title: 'Capture', body: 'Upload the pay application and its backup as PDFs. Each one is matched to its project and subcontract.' },
  { icon: ScanText, title: 'Read', body: 'Summary and continuation-sheet figures become structured lines, each linked back to its page.' },
  { icon: Calculator, title: 'Reconcile', body: 'Deterministic checks run against the contract, change orders, schedule of values and billing history.' },
  { icon: UserCheck, title: 'Review & approve', body: 'Reviewers resolve findings, request corrections and approve under role-based rules.' },
];

const CHECK_GROUPS = [
  { icon: Calculator, title: 'Arithmetic', body: 'Line totals, balances, sheet and grand totals recomputed from the lines themselves.' },
  { icon: Landmark, title: 'Contract & change orders', body: 'Original sum and net change matched to the subcontract and its approved change orders.' },
  { icon: ListChecks, title: 'Schedule of values', body: 'Scheduled values, unknown or missing lines, and billing beyond any line’s value.' },
  { icon: History, title: 'Billing history', body: 'Previous certificates and each line’s prior work matched to the last approved application.' },
  { icon: CalendarClock, title: 'Sequence', body: 'Duplicate numbers or periods, gaps and out-of-order billing periods.' },
  { icon: Percent, title: 'Retainage', body: 'Retainage withheld checked against the subcontract’s rate; releases tracked.' },
  { icon: FileStack, title: 'Documents', body: 'Missing pages, duplicate files, signatures and notarization flagged for a person to check.' },
  { icon: FileCheck2, title: 'Payment due', body: 'The current amount due recomputed from everything above, never taken on trust.' },
];

const RULES = [
  'Open blocking findings refuse approval.',
  'Overriding one requires a written reason, kept with the approval record.',
  'Open warnings must be acknowledged before approving.',
  'Every figure is recomputed again at the moment of approval.',
  'Only roles with approval permission can approve.',
  'Lien waiver checks are a pre-screen. They do not determine legal validity.',
];

const TIMELINE: Array<{ title: string; detail: string; tone: 'neutral' | 'block' | 'pass' }> = [
  { title: 'Received · Apex Concrete, Inc.', detail: 'Pay application No. 007 · 3 pages · matched to SC-014', tone: 'neutral' },
  { title: 'Checks complete', detail: '1 blocking finding: too little retainage withheld', tone: 'block' },
  { title: 'Correction requested · Project accountant', detail: 'Retainage billed $30,000.00; the 10% rate requires $35,000.00', tone: 'neutral' },
  { title: 'Revised application received', detail: 'Retainage $35,000.00 · current due $65,000.00', tone: 'neutral' },
  { title: 'Approved · Controller', detail: 'All figures recomputed at approval · $65,000.00', tone: 'pass' },
];

const SUBCONTRACTS = [
  { name: 'Apex Concrete, Inc.', billed: 350_000, value: 525_000, open: 1 },
  { name: 'Northline Electrical', billed: 212_400, value: 610_000, open: 0 },
  { name: 'Summit Mechanical', billed: 148_000, value: 740_000, open: 2 },
  { name: 'Ridgeway Steel', billed: 416_000, value: 605_000, open: 0 },
];

const COMPAT = [
  {
    status: 'Available now',
    dot: 'bg-aqua',
    items: ['PDF pay applications and backup (G702 / G703 style)', 'Schedule of values entry, or paste from a spreadsheet', 'Exports: approval record (PDF), CSV and JSON'],
  },
  {
    status: 'Built, in verification',
    dot: 'bg-[#d99a2b]',
    items: ['Procore invoice export (sandbox verification pending)', 'Email intake for subcontractor submissions', 'AI-assisted reading of scanned documents'],
  },
  {
    status: 'In development or exploring',
    dot: 'bg-ink-4',
    items: ['Mobile companion for capture and status', 'Accounting system connections'],
  },
];

const FAQ = [
  {
    q: 'What is Zephric?',
    a: 'Zephric is an early-stage company building billing review software for construction. The core workflow (upload, reading, reconciliation, review, approval and export) is built and in testing, and we are preparing supervised pilots with a small number of design partners. The previews on this page use illustrative data.',
  },
  {
    q: 'Who is it for?',
    a: 'General contractors and construction finance teams (project accountants, controllers and CFOs) who receive and approve subcontractor pay applications. Subcontractors benefit from clearer, line-level correction requests without needing another login.',
  },
  {
    q: 'Does it replace our accounting software?',
    a: 'No. Zephric handles the review and reconciliation work before payment, and exports approved figures for the systems you already use.',
  },
  {
    q: 'Does AI decide whether the numbers are right?',
    a: 'No. Every check is deterministic: the arithmetic and reconciliation are computed from the figures, the same way every time. AI may help read a document, but whatever it reads is recomputed and checked, and a person makes every approval decision.',
  },
  {
    q: 'How accurate is the document reading?',
    a: 'Reading PDFs that contain a text layer works today. AI-assisted reading of scanned documents is built, and we are measuring it on real documents before publishing any accuracy figures. Anything uncertain is flagged for review rather than guessed.',
  },
  {
    q: 'Does it work with Procore?',
    a: 'A Procore invoice export is built and is waiting on sandbox verification. Zephric works on the documents themselves, so it does not depend on any one platform. We do not claim an official partnership with any software vendor.',
  },
  {
    q: 'How is our data kept separate and secure?',
    a: 'Every record belongs to one organization, and every request is checked against the signed-in member’s organization and role. Sign-in supports two-step verification. We do not claim SOC 2 or other certifications.',
  },
  {
    q: 'Can teams outside the United States take part?',
    a: 'Yes. We are focusing first on the United States and India, and welcome conversations elsewhere. Local billing practices, retention terms and supporting documents need to be evaluated for each market.',
  },
];

export default function HomePage() {
  return (
    <div className="overflow-x-clip bg-canvas text-[15px] leading-[1.6] text-ink">
      <a href="#main" className="sr-only z-[60] rounded-md bg-ink px-3 py-2 text-white focus:not-sr-only focus:fixed focus:left-4 focus:top-4">
        Skip to content
      </a>
      <SiteNav />
      <RevealOnScroll />

      <main id="main">
        {/* Hero */}
        <section className="relative pb-20 pt-28 sm:pb-28 sm:pt-36">
          <div aria-hidden className="ledger-grid pointer-events-none absolute inset-0 [mask-image:radial-gradient(ellipse_80%_70%_at_50%_0%,#000_30%,transparent_80%)]" />
          <div aria-hidden className="pointer-events-none absolute -top-40 left-1/2 h-[520px] w-[900px] -translate-x-1/2 rounded-full bg-[radial-gradient(closest-side,rgb(31_79_209/0.10),transparent)]" />
          <div className={cn(WRAP, 'relative grid items-center gap-14 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.12fr)] lg:gap-12')}>
            <div className="max-w-[560px]">
              <p className="inline-flex animate-rise items-center gap-2 rounded-full border border-line bg-surface/80 py-1 pl-1.5 pr-3 text-[13px] text-ink-2 backdrop-blur">
                <span className="relative flex size-5 items-center justify-center rounded-full bg-aqua-soft">
                  <span className="absolute size-2 animate-ping rounded-full bg-aqua/50 motion-reduce:hidden" />
                  <span className="size-1.5 rounded-full bg-aqua" />
                </span>
                Now inviting design partners
              </p>
              <h1 className="mt-6 animate-rise text-[42px] font-semibold leading-[1.02] tracking-[-0.04em] text-ink [animation-delay:60ms] sm:text-[60px] lg:text-[54px] xl:text-[66px]">
                Construction billing, <span className="text-ink-3">without the busywork.</span>
              </h1>
              <p className="mt-6 max-w-[500px] animate-rise text-[17px] leading-[1.6] text-ink-2 [animation-delay:120ms] sm:text-[18px]">
                Zephric helps construction finance teams organize payment applications, reconcile billing, identify discrepancies, and manage financial reviews in one intelligent workflow.
              </p>
              <div className="mt-9 animate-rise [animation-delay:180ms]">
                <HeroActions />
              </div>
              <ul className="mt-10 flex animate-rise flex-wrap gap-x-6 gap-y-2 text-[13.5px] text-ink-3 [animation-delay:240ms]">
                {['Every figure recomputed', 'People approve, not software', 'Built for subcontractor pay applications'].map((t) => (
                  <li key={t} className="flex items-center gap-2">
                    <Check className="size-3.5 text-aqua-ink" strokeWidth={2.5} />
                    {t}
                  </li>
                ))}
              </ul>
            </div>
            <div className="animate-rise [animation-delay:200ms] lg:pl-4">
              <HeroPreview />
            </div>
          </div>
        </section>

        {/* Problem */}
        <section id="problem" className="border-t border-line bg-surface py-20 sm:py-28">
          <div className={WRAP}>
            <div className="grid gap-10 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)] lg:gap-20">
              <div data-reveal>
                <Eyebrow>The problem</Eyebrow>
                <H2>The work between the PDF and the payment.</H2>
              </div>
              <p data-reveal className="self-end text-[17px] leading-[1.65] text-ink-2" style={{ '--reveal-delay': '80ms' } as React.CSSProperties}>
                Every month, each subcontractor’s pay application arrives as a PDF. Before anyone can approve it, someone re-keys the figures and checks them against the contract, the change orders and last month’s application. It is slow, it is
                error-prone, and the payment waits while it happens.
              </p>
            </div>
            <div className="mt-14 grid gap-px overflow-hidden rounded-2xl border border-line bg-line md:grid-cols-3">
              {PROBLEMS.map((p, i) => (
                <div key={p.n} data-reveal className="bg-surface p-7 sm:p-8" style={{ '--reveal-delay': `${i * 90}ms` } as React.CSSProperties}>
                  <p className="num font-mono text-[12px] text-ink-4">{p.n}</p>
                  <h3 className="mt-6 text-[18px] font-semibold tracking-[-0.01em] text-ink">{p.title}</h3>
                  <p className="mt-2 text-[15px] leading-[1.6] text-ink-2">{p.body}</p>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* Workflow */}
        <section id="workflow" className="scroll-mt-16 py-20 sm:py-28">
          <div className={WRAP}>
            <div data-reveal className="max-w-[720px]">
              <Eyebrow>How it works</Eyebrow>
              <H2>From inbox to approval in one workflow.</H2>
              <p className="mt-5 text-[17px] leading-[1.65] text-ink-2">One pay application, one path: captured once, read once, checked every time, and decided by a person.</p>
            </div>
            <ol className="relative mt-14 grid gap-4 md:grid-cols-2 lg:grid-cols-4">
              <div aria-hidden className="brand-gradient absolute left-8 right-8 top-[38px] hidden h-px opacity-40 lg:block" />
              {STEPS.map((s, i) => (
                <li key={s.title} data-reveal className="relative rounded-2xl border border-line bg-surface p-6 shadow-card" style={{ '--reveal-delay': `${i * 90}ms` } as React.CSSProperties}>
                  <div className="flex items-center justify-between">
                    <span className="flex size-10 items-center justify-center rounded-xl border border-line bg-canvas text-ink">
                      <s.icon className="size-[18px]" />
                    </span>
                    <span className="num font-mono text-[12px] text-ink-4">0{i + 1}</span>
                  </div>
                  <h3 className="mt-6 text-[17px] font-semibold text-ink">{s.title}</h3>
                  <p className="mt-2 text-[14.5px] leading-[1.6] text-ink-2">{s.body}</p>
                </li>
              ))}
            </ol>
          </div>
        </section>

        {/* Document intelligence */}
        <section id="product" className="scroll-mt-16 border-t border-line bg-surface py-20 sm:py-28">
          <div className={WRAP}>
            <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] lg:gap-20">
              <div data-reveal>
                <Eyebrow>Document intelligence</Eyebrow>
                <H2>Every figure, traceable to its source.</H2>
              </div>
              <div data-reveal className="self-end" style={{ '--reveal-delay': '80ms' } as React.CSSProperties}>
                <p className="text-[17px] leading-[1.65] text-ink-2">
                  Zephric turns pay applications and continuation sheets into structured lines, and keeps each figure linked to the page it came from. Reviewers check evidence, not a retyped copy.
                </p>
                <p className="mt-4 flex items-start gap-2 text-[13.5px] leading-[1.6] text-ink-3">
                  <ShieldCheck className="mt-0.5 size-4 shrink-0 text-aqua-ink" />
                  Reading PDFs with a text layer works today. AI-assisted reading of scans is built and being measured on real documents before we publish accuracy figures.
                </p>
              </div>
            </div>
            <div data-reveal className="mt-12" style={{ '--reveal-delay': '120ms' } as React.CSSProperties}>
              <TraceDemo />
            </div>
          </div>
        </section>

        {/* Reconciliation */}
        <section id="reconciliation" className="relative overflow-hidden bg-navy py-20 text-white sm:py-28">
          <div aria-hidden className="ledger-grid-dark pointer-events-none absolute inset-0 [mask-image:linear-gradient(to_bottom,#000,transparent_85%)]" />
          <div className={cn(WRAP, 'relative')}>
            <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] lg:gap-20">
              <div data-reveal>
                <Eyebrow dark>Reconciliation</Eyebrow>
                <H2 dark>Arithmetic is computed, never guessed.</H2>
              </div>
              <p data-reveal className="self-end text-[17px] leading-[1.65] text-white/65" style={{ '--reveal-delay': '80ms' } as React.CSSProperties}>
                Every check is deterministic: the same figures always give the same result, and each finding shows the numbers behind it. AI never decides whether a pay application adds up.
              </p>
            </div>
            <div className="mt-14 grid gap-px overflow-hidden rounded-2xl border border-navy-line bg-navy-line sm:grid-cols-2 lg:grid-cols-4">
              {CHECK_GROUPS.map((g, i) => (
                <div key={g.title} data-reveal className="group bg-navy-2 p-6 transition-colors hover:bg-[#121d33]" style={{ '--reveal-delay': `${(i % 4) * 70}ms` } as React.CSSProperties}>
                  <g.icon className="size-5 text-aqua transition-transform duration-300 group-hover:-translate-y-0.5" />
                  <h3 className="mt-5 text-[15.5px] font-semibold text-white">{g.title}</h3>
                  <p className="mt-1.5 text-[14px] leading-[1.6] text-white/55">{g.body}</p>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* Human review */}
        <section id="review" className="py-20 sm:py-28">
          <div className={cn(WRAP, 'grid items-start gap-12 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.05fr)] lg:gap-20')}>
            <div data-reveal>
              <Eyebrow>Human review and approvals</Eyebrow>
              <H2>Software checks. People decide.</H2>
              <p className="mt-5 text-[17px] leading-[1.65] text-ink-2">Zephric prepares the decision; your team makes it. Approval rules are enforced by the system, not left to a checklist.</p>
              <ul className="mt-8 space-y-3">
                {RULES.map((r) => (
                  <li key={r} className="flex items-start gap-3 text-[15px] text-ink">
                    <span className="mt-1 flex size-4 shrink-0 items-center justify-center rounded-full bg-ink text-white">
                      <Check className="size-2.5" strokeWidth={3} />
                    </span>
                    {r}
                  </li>
                ))}
              </ul>
            </div>
            <div data-reveal className="rounded-2xl border border-line bg-surface p-6 shadow-float sm:p-7" style={{ '--reveal-delay': '100ms' } as React.CSSProperties}>
              <div className="flex items-center justify-between">
                <p className="text-[13px] font-semibold text-ink">Activity · No. 007</p>
                <span className="rounded-full border border-line bg-sunken px-2 py-0.5 text-[10px] font-medium uppercase tracking-[0.1em] text-ink-3">Illustrative</span>
              </div>
              <ol className="relative mt-6 space-y-6 before:absolute before:bottom-2 before:left-[7px] before:top-2 before:w-px before:bg-line">
                {TIMELINE.map((t) => (
                  <li key={t.title} className="relative pl-8">
                    <span
                      className={cn(
                        'absolute left-0 top-1 flex size-[15px] items-center justify-center rounded-full border-2 border-surface',
                        t.tone === 'block' ? 'bg-block' : t.tone === 'pass' ? 'bg-aqua' : 'bg-ink-4',
                      )}
                    />
                    <p className="text-[14px] font-medium text-ink">{t.title}</p>
                    <p className="num mt-0.5 text-[13px] text-ink-3">{t.detail}</p>
                  </li>
                ))}
              </ol>
            </div>
          </div>
        </section>

        {/* Project visibility */}
        <section id="visibility" className="border-t border-line bg-surface py-20 sm:py-28">
          <div className={cn(WRAP, 'grid items-center gap-12 lg:grid-cols-[minmax(0,1.05fr)_minmax(0,1fr)] lg:gap-20')}>
            <div data-reveal className="order-2 rounded-2xl border border-line bg-canvas p-5 sm:p-6 lg:order-1">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-[15px] font-semibold text-ink">Riverside Medical, Phase 2</p>
                  <p className="text-[12.5px] text-ink-3">4 subcontracts</p>
                </div>
                <span className="rounded-full border border-line bg-surface px-2 py-0.5 text-[10px] font-medium uppercase tracking-[0.1em] text-ink-3">Illustrative</span>
              </div>
              <div className="num mt-5 grid grid-cols-3 gap-2">
                {[
                  ['Contract value', '$2,480,000'],
                  ['Billed to date', '$1,126,400'],
                  ['Retainage held', '$112,640'],
                ].map(([k, v]) => (
                  <div key={k} className="rounded-xl border border-line bg-surface p-3">
                    <p className="text-[11.5px] text-ink-3">{k}</p>
                    <p className="mt-1 text-[15px] font-semibold tracking-[-0.01em] text-ink sm:text-[17px]">{v}</p>
                  </div>
                ))}
              </div>
              <ul className="mt-3 divide-y divide-line rounded-xl border border-line bg-surface">
                {SUBCONTRACTS.map((s) => {
                  const pct = Math.round((s.billed / s.value) * 100);
                  return (
                    <li key={s.name} className="flex items-center gap-4 px-4 py-3">
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center justify-between gap-3">
                          <p className="truncate text-[13.5px] font-medium text-ink">{s.name}</p>
                          <p className="num shrink-0 text-[12.5px] text-ink-3">{pct}% billed</p>
                        </div>
                        <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-sunken">
                          <div className="h-full rounded-full bg-accent" style={{ width: `${pct}%` }} />
                        </div>
                      </div>
                      <span className={cn('w-[74px] shrink-0 text-right text-[12px]', s.open ? 'font-medium text-block' : 'text-ink-4')}>{s.open ? `${s.open} open` : 'Clear'}</span>
                    </li>
                  );
                })}
              </ul>
            </div>
            <div data-reveal className="order-1 lg:order-2">
              <Eyebrow>Project billing visibility</Eyebrow>
              <H2>Know where every subcontract stands.</H2>
              <p className="mt-5 text-[17px] leading-[1.65] text-ink-2">
                Contract value, approved change orders, billed to date, retainage held and what is waiting on review, for every project and subcontract. Positions are computed from approved applications, so they always agree with what was approved.
              </p>
            </div>
          </div>
        </section>

        {/* Teams */}
        <section id="teams" className="scroll-mt-16 py-20 sm:py-28">
          <div className={WRAP}>
            <div data-reveal className="max-w-[720px]">
              <Eyebrow>Who it’s for</Eyebrow>
              <H2>Built for both sides of the pay application.</H2>
            </div>
            <div data-reveal className="mt-10" style={{ '--reveal-delay': '80ms' } as React.CSSProperties}>
              <TeamsTabs />
            </div>
          </div>
        </section>

        {/* Compatibility */}
        <section id="compatibility" className="border-t border-line bg-surface py-20 sm:py-28">
          <div className={WRAP}>
            <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] lg:gap-20">
              <div data-reveal>
                <Eyebrow>Compatibility</Eyebrow>
                <H2>Works alongside what you already use.</H2>
              </div>
              <p data-reveal className="self-end text-[17px] leading-[1.65] text-ink-2" style={{ '--reveal-delay': '80ms' } as React.CSSProperties}>
                Zephric works on the documents themselves, so there is nothing to migrate. Every connection is labelled for exactly where it stands today.
              </p>
            </div>
            <div className="mt-12 grid gap-4 md:grid-cols-3">
              {COMPAT.map((c, i) => (
                <div key={c.status} data-reveal className="rounded-2xl border border-line bg-canvas p-6" style={{ '--reveal-delay': `${i * 90}ms` } as React.CSSProperties}>
                  <p className="flex items-center gap-2 text-[13px] font-semibold text-ink">
                    <span className={cn('size-2 rounded-full', c.dot)} />
                    {c.status}
                  </p>
                  <ul className="mt-5 space-y-3">
                    {c.items.map((item) => (
                      <li key={item} className="text-[14.5px] leading-[1.5] text-ink-2">
                        {item}
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* Design partners */}
        <section id="partner" className="scroll-mt-16 py-20 sm:py-28">
          <div className={cn(WRAP, 'grid items-start gap-12 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)] lg:gap-20')}>
            <div data-reveal className="lg:sticky lg:top-28">
              <Eyebrow>Design partners</Eyebrow>
              <H2>Shape Zephric with us.</H2>
              <p className="mt-5 text-[17px] leading-[1.65] text-ink-2">
                We are working with a small number of general contractors and construction finance teams on supervised pilots, using their own pay applications.
              </p>
              <div className="mt-8 grid gap-6 sm:grid-cols-2">
                <div>
                  <p className="text-[13px] font-semibold uppercase tracking-[0.1em] text-ink-3">What you get</p>
                  <ul className="mt-3 space-y-2.5 text-[15px] text-ink">
                    {['Direct access to the founders', 'A supervised pilot on your documents', 'A say in what is built next'].map((t) => (
                      <li key={t} className="flex gap-2.5">
                        <Check className="mt-1 size-4 shrink-0 text-aqua-ink" strokeWidth={2.5} />
                        {t}
                      </li>
                    ))}
                  </ul>
                </div>
                <div>
                  <p className="text-[13px] font-semibold uppercase tracking-[0.1em] text-ink-3">What we ask</p>
                  <ul className="mt-3 space-y-2.5 text-[15px] text-ink">
                    {['A walkthrough of your billing workflow', 'Sample pay applications to test with', 'Candid feedback as we iterate'].map((t) => (
                      <li key={t} className="flex gap-2.5">
                        <ArrowRight className="mt-1 size-4 shrink-0 text-ink-4" />
                        {t}
                      </li>
                    ))}
                  </ul>
                </div>
              </div>
              <p className="mt-8 text-[13.5px] leading-[1.6] text-ink-3">An inquiry does not guarantee access and creates no commercial agreement.</p>
            </div>
            <div data-reveal style={{ '--reveal-delay': '100ms' } as React.CSSProperties}>
              <PartnerForm />
            </div>
          </div>
        </section>

        {/* FAQ */}
        <section id="faq" className="scroll-mt-16 border-t border-line bg-surface py-20 sm:py-28">
          <div className={cn(WRAP, 'grid gap-10 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.6fr)] lg:gap-20')}>
            <div data-reveal>
              <Eyebrow>FAQ</Eyebrow>
              <H2>Straight answers.</H2>
              <p className="mt-5 text-[16px] leading-[1.65] text-ink-2">
                Something else on your mind?{' '}
                <a href="#partner" className="font-medium text-ink underline decoration-line-strong underline-offset-4 hover:decoration-ink">
                  Ask us directly
                </a>
                .
              </p>
            </div>
            <div data-reveal className="divide-y divide-line border-y border-line" style={{ '--reveal-delay': '80ms' } as React.CSSProperties}>
              {FAQ.map((f) => (
                <details key={f.q} className="group">
                  <summary className="focus-ring flex list-none items-center justify-between gap-6 rounded-md py-5 text-[16.5px] font-medium text-ink [&::-webkit-details-marker]:hidden">
                    {f.q}
                    <span className="relative size-4 shrink-0 text-ink-3 transition-transform duration-300 group-open:rotate-45">
                      <span className="absolute left-0 top-1/2 h-px w-4 -translate-y-1/2 bg-current" />
                      <span className="absolute left-1/2 top-0 h-4 w-px -translate-x-1/2 bg-current" />
                    </span>
                  </summary>
                  <p className="pb-6 pr-10 text-[15px] leading-[1.7] text-ink-2">{f.a}</p>
                </details>
              ))}
            </div>
          </div>
        </section>

        {/* Final call to action */}
        <section className="relative overflow-hidden bg-navy py-24 text-white sm:py-32">
          <div aria-hidden className="ledger-grid-dark pointer-events-none absolute inset-0 [mask-image:radial-gradient(ellipse_60%_80%_at_50%_100%,#000_20%,transparent_75%)]" />
          <div className={cn(WRAP, 'relative flex flex-col items-center text-center')}>
            <div data-reveal className="group flex size-16 items-center justify-center rounded-2xl border border-navy-line bg-navy-2">
              <BrandMark className="size-9 transition-transform duration-500 group-hover:rotate-[-8deg] group-hover:scale-105" />
            </div>
            <h2 data-reveal className="mt-8 max-w-[760px] text-[34px] font-semibold leading-[1.08] tracking-[-0.03em] sm:text-[52px]" style={{ '--reveal-delay': '80ms' } as React.CSSProperties}>
              Spend month-end on decisions, not data entry.
            </h2>
            <p data-reveal className="mt-5 max-w-[560px] text-[17px] leading-[1.6] text-white/60" style={{ '--reveal-delay': '140ms' } as React.CSSProperties}>
              Tell us how billing works on your projects today. We will tell you honestly whether Zephric can help yet.
            </p>
            <div data-reveal className="mt-10 flex flex-col gap-3 sm:flex-row" style={{ '--reveal-delay': '200ms' } as React.CSSProperties}>
              <a href="#partner" className="focus-ring group inline-flex h-12 items-center justify-center gap-2 rounded-full bg-white px-6 text-[15px] font-medium text-ink transition-colors hover:bg-white/90">
                Become a Design Partner
                <ArrowRight className="size-4 transition-transform group-hover:translate-x-0.5" />
              </a>
              <Link href="/login" className="focus-ring inline-flex h-12 items-center justify-center gap-2 rounded-full border border-white/15 px-6 text-[15px] font-medium text-white transition-colors hover:border-white/30 hover:bg-white/5">
                <Inbox className="size-4 text-white/60" />
                Sign in to Zephric
              </Link>
            </div>
          </div>
        </section>
      </main>

      <footer className="border-t border-line bg-canvas">
        <div className={cn(WRAP, 'flex flex-col gap-6 py-10 sm:flex-row sm:items-center')}>
          <Link href="/" className="focus-ring -m-1 w-fit rounded-md p-1" aria-label="Zephric home">
            <Brand className="h-6" />
          </Link>
          <p className="text-[13px] text-ink-3 sm:ml-4">© 2026 Zephric. Previews use illustrative data.</p>
          <nav aria-label="Footer" className="flex flex-wrap gap-x-5 gap-y-2 text-[13px] text-ink-2 sm:ml-auto">
            <LegalLink which="privacy" className="focus-ring rounded hover:text-ink">
              Privacy
            </LegalLink>
            <LegalLink which="terms" className="focus-ring rounded hover:text-ink">
              Terms
            </LegalLink>
            <Link href="/login" className="focus-ring rounded hover:text-ink">
              Sign in
            </Link>
          </nav>
        </div>
      </footer>
    </div>
  );
}
