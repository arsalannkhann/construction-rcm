import { ArrowRight, Calculator, CalendarClock, Check, FileCheck2, FileStack, History, Inbox, Landmark, ListChecks, Minus, Percent, ScanText, Upload, UserCheck } from 'lucide-react';
import type { Metadata } from 'next';
import Link from 'next/link';
import { Brand, BrandMark } from '@/components/brand';
import { HeroActions } from '@/components/marketing/hero-actions';
import { HeroPreview, type HeroSample } from '@/components/marketing/hero-preview';
import { LegalLink } from '@/components/marketing/legal';
import { PartnerForm } from '@/components/marketing/partner-form';
import { RevealOnScroll } from '@/components/marketing/reveal';
import { SiteNav } from '@/components/marketing/site-nav';
import { TeamsTabs } from '@/components/marketing/teams-tabs';
import type { SampleSnapshot } from '@/content/sample-types';
import snapshot from '@/content/sample-workflow.json';
import { formatDelta, formatMoney } from '@/lib/money';
import { cn, formatDate } from '@/lib/utils';
import { CLAIMED_FIELD_LINE, type ClaimedField } from '@/server/types';

const TAGLINE = 'Review construction billing with confidence';
const SUMMARY = 'Zephric reads the billing packages your subcontractors send, checks every figure against your project records, and shows your team what needs attention before anyone approves.';

export const metadata: Metadata = {
  title: { absolute: `Zephric · ${TAGLINE}` },
  description: SUMMARY,
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

/**
 * The hero preview's content, taken from the sample workflow's snapshot: the
 * product's own reading and findings for the sample package (src/content/sample-types.ts).
 * Nothing in the preview is typed in here.
 */
function heroSample(s: SampleSnapshot): HeroSample {
  const shown: ClaimedField[] = ['originalContractSum', 'netChangeOrders', 'contractSumToDate', 'totalCompletedStored', 'retainageTotal', 'totalEarnedLessRetainage', 'lessPreviousCertificates', 'currentPaymentDue'];
  return {
    subcontractor: s.parties.subcontractor,
    project: s.parties.project,
    period: formatDate(s.application.periodTo),
    applicationNumber: s.application.number,
    pages: s.document.pages.map((p) => p.label),
    lines: shown.flatMap((key) => {
      const row = s.summary.find((r) => r.key === key);
      return row ? [{ n: CLAIMED_FIELD_LINE[key], label: row.label, value: formatMoney(row.onDocument), agrees: row.agrees }] : [];
    }),
    figuresRead: s.summary.length + s.lines.length,
    requested: formatMoney(s.application.requested),
    verified: formatMoney(s.application.verified),
    difference: formatDelta(s.application.difference),
    passed: s.checks.passed,
    findings: s.findings.map((f) => ({ severity: f.severity, title: f.title, detail: f.expected && f.onDocument ? `${f.onDocument} on the document, ${f.expected} expected` : f.category })),
  };
}

const STEPS = [
  { icon: Upload, title: 'Arrives', body: 'Upload the pay application and its backup as PDFs, or let the subcontractor send them through their own private link. Each package is matched to its project and subcontract.' },
  { icon: ScanText, title: 'Read', body: 'The summary figures and every schedule of values line become structured data, each one tied to the place it is printed.' },
  { icon: Calculator, title: 'Checked', body: 'Every figure is worked out again from the contract, approved change orders, retainage terms and the billing you already approved.' },
  { icon: UserCheck, title: 'Decided', body: 'Reviewers see what is wrong, why it matters and what to do. They ask for corrections or approve, under rules the system enforces.' },
];

const CHECK_GROUPS = [
  { icon: Calculator, title: 'Arithmetic', body: 'Line totals, balances, sheet and grand totals recomputed from the lines themselves.' },
  { icon: Landmark, title: 'Contract & change orders', body: 'Original sum and net change matched to the subcontract and its approved change orders.' },
  { icon: ListChecks, title: 'Schedule of values', body: 'Scheduled values, unknown or missing lines, and billing beyond any line’s value.' },
  { icon: History, title: 'Billing history', body: 'Previous certificates and each line’s prior work matched to the last approved application.' },
  { icon: CalendarClock, title: 'Sequence', body: 'Duplicate numbers or periods, gaps and out-of-order billing periods.' },
  { icon: Percent, title: 'Retainage', body: 'Retainage withheld checked against the subcontract’s rate; releases tracked.' },
  { icon: FileStack, title: 'Lien waiver & documents', body: 'The waiver in the package pre-screened in the same review: amount, through date, claimant and signature. Missing pages and duplicate files flagged.' },
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

/** Where each part of the product stands. Kept in step with the README’s “What is and is not verified”. */
const STATUS = [
  {
    title: 'Working today',
    note: 'Built, tested and usable now.',
    dot: 'bg-aqua',
    items: [
      'Reading PDF pay applications that have a text layer',
      'Checks against the contract, change orders, schedule of values, retainage and approved billing',
      'Review, correction requests and role-based approval, with two-step sign-in',
      'Approval records exported as PDF, CSV and JSON',
      'A private upload link for each subcontractor, with no account to create',
    ],
  },
  {
    title: 'Built, not yet proven',
    note: 'Finished in code. Not yet run on real projects.',
    dot: 'bg-[#d99a2b]',
    items: [
      'AI-assisted reading of scanned documents: run on generated test documents only, so accuracy on real ones is unmeasured',
      'Procore invoice export: built from Procore’s public documentation, never run against a live Procore account',
      'Email in and out (packages by email, correction requests, reminders): not yet connected to a mail provider on the hosted service',
      'Mobile app for capture and simple approvals: tested on an emulator, not on real phones',
    ],
  },
  {
    title: 'Not built',
    note: 'Ask us, and we will say where it sits.',
    dot: 'bg-ink-4',
    items: ['Connections to accounting systems beyond file export', 'Single sign-on', 'Billing formats, currencies and retention rules outside the United States', 'Statutory lien waiver forms beyond Texas, California and Florida'],
  },
];

const NOT_DOING = ['Move money or make payments', 'Decide whether a lien waiver is legally valid', 'Replace your accounting system', 'Approve anything by itself'];

const FAQ = [
  {
    q: 'What is Zephric?',
    a: 'Zephric is an early-stage company building billing review software for construction. The core workflow (upload, reading, checking, review, approval and export) is built and tested, and we are preparing supervised pilots with a small number of design partners. We have no customer results or certifications to quote yet.',
  },
  {
    q: 'Do I need an account to see it?',
    a: 'No. The sample workflow is open to everyone: one fictitious billing package, read and checked by the product, that you can step through from arrival to decision. An account adds a full example workspace with five months of billing, and your own projects.',
  },
  {
    q: 'Does it replace our accounting software?',
    a: 'No. Zephric handles the review and reconciliation work before payment, and exports approved figures for the systems you already use.',
  },
  {
    q: 'We already use a billing or payment portal. Does Zephric replace it?',
    a: 'No. A portal is where subcontractors enter their billing and where payments and signed waivers change hands. Zephric does the checking that comes before: it reads the PDF package as it was sent, so subcontractors do not change how they bill, and it exports the approved figures as files. It does not move money.',
  },
  {
    q: 'Does AI decide whether the numbers are right?',
    a: 'No. Every check is deterministic: the arithmetic and reconciliation are computed from the figures, the same way every time. AI may help read a scanned document, but whatever it reads is recomputed and checked, and a person makes every approval decision.',
  },
  {
    q: 'How accurate is the document reading?',
    a: 'Reading PDFs that contain a text layer works today. AI-assisted reading of scanned documents is built, and we are measuring it on real documents before publishing any accuracy figures. Anything uncertain is flagged for review rather than guessed.',
  },
  {
    q: 'How is our data kept separate and secure?',
    a: 'Every record belongs to one organization, and every request is checked against the signed-in member’s organization and role. Sign-in supports two-step verification. We do not claim SOC 2 or other certifications.',
  },
  {
    q: 'Can teams outside the United States take part?',
    a: 'Yes, as design partners. Today Zephric reads US-style pay applications in US dollars, and recognizes statutory lien waiver forms for three states. Local billing practices, retention terms and supporting documents need to be worked through for each market, and we would rather do that with you than guess.',
  },
];

export default function HomePage() {
  const sample = snapshot as SampleSnapshot;
  const blocking = sample.findings.filter((f) => f.severity === 'blocking');
  const timeline: Array<{ title: string; detail: string; tone: 'neutral' | 'block' | 'pass' }> = [
    { title: `Received · ${sample.parties.subcontractor}`, detail: `Pay application #${sample.application.number} · ${sample.document.pageCount} pages · matched to ${sample.parties.contractNumber}`, tone: 'neutral' },
    { title: 'Checks complete', detail: `${blocking.length} blocking findings: ${blocking[0]?.title.toLowerCase() ?? ''}`, tone: 'block' },
    { title: 'Correction requested · Project accountant', detail: `Line 7 understates what was already certified by ${formatMoney(Math.abs(sample.application.difference))}`, tone: 'neutral' },
    { title: 'Revised application received', detail: `Read and checked again from the beginning · current due ${formatMoney(sample.application.verified)}`, tone: 'neutral' },
    { title: 'Approved · Controller', detail: `All figures recomputed at approval · ${formatMoney(sample.application.verified)}`, tone: 'pass' },
  ];
  return (
    <div className="overflow-x-clip bg-canvas text-[15px] leading-[1.6] text-ink">
      <a href="#main" className="sr-only z-[60] rounded-md bg-ink px-3 py-2 text-white focus:not-sr-only focus:fixed focus:left-4 focus:top-4">
        Skip to content
      </a>
      <SiteNav />
      <RevealOnScroll />

      <main id="main">
        {/* Hero */}
        <section className="relative pb-16 pt-28 sm:pb-24 sm:pt-36">
          <div aria-hidden className="ledger-grid pointer-events-none absolute inset-0 [mask-image:radial-gradient(ellipse_80%_70%_at_50%_0%,#000_30%,transparent_80%)]" />
          <div aria-hidden className="pointer-events-none absolute -top-40 left-1/2 h-[520px] w-[900px] -translate-x-1/2 rounded-full bg-[radial-gradient(closest-side,rgb(31_79_209/0.10),transparent)]" />
          <div className={cn(WRAP, 'relative grid items-center gap-12 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.14fr)] lg:gap-10')}>
            <div className="max-w-[560px]">
              <p className="inline-flex animate-rise items-center gap-2 rounded-full border border-line bg-surface/80 py-1 pl-1.5 pr-3 text-[13px] text-ink-2 backdrop-blur">
                <span className="relative flex size-5 shrink-0 items-center justify-center rounded-full bg-aqua-soft">
                  <span className="absolute size-2 animate-ping rounded-full bg-aqua/50 motion-reduce:hidden" />
                  <span className="size-1.5 rounded-full bg-aqua" />
                </span>
                For general contractors’ finance teams · inviting design partners
              </p>
              <h1 className="mt-6 animate-rise text-[40px] font-semibold leading-[1.03] tracking-[-0.04em] text-ink [animation-delay:60ms] sm:text-[58px] lg:text-[50px] xl:text-[62px]">
                Review construction billing <span className="text-ink-3">with confidence.</span>
              </h1>
              <p className="mt-6 max-w-[520px] animate-rise text-[17px] leading-[1.6] text-ink-2 [animation-delay:120ms] sm:text-[18px]">{SUMMARY}</p>
              <div className="mt-9 animate-rise [animation-delay:180ms]">
                <HeroActions />
              </div>
              <ul className="mt-9 flex animate-rise flex-wrap gap-x-6 gap-y-2 text-[13.5px] text-ink-3 [animation-delay:240ms]">
                {['The sample needs no account', 'Findings point to the figure on the page', 'People approve, never the software'].map((t) => (
                  <li key={t} className="flex items-center gap-2">
                    <Check className="size-3.5 text-aqua-ink" strokeWidth={2.5} />
                    {t}
                  </li>
                ))}
              </ul>
            </div>
            <div className="animate-rise [animation-delay:200ms]">
              <HeroPreview sample={heroSample(sample)} />
            </div>
          </div>
        </section>

        {/* How it works */}
        <section id="workflow" className="scroll-mt-16 border-t border-line bg-surface py-20 sm:py-28">
          <div className={WRAP}>
            <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)] lg:gap-20">
              <div data-reveal>
                <Eyebrow>How it works</Eyebrow>
                <H2>From the PDF in your inbox to a decision you can stand behind.</H2>
              </div>
              <p data-reveal className="self-end text-[17px] leading-[1.65] text-ink-2" style={{ '--reveal-delay': '80ms' } as React.CSSProperties}>
                Every month each subcontractor’s billing arrives as a PDF. Someone re-keys it, checks it from memory against the contract and last month’s application, and the problems surface late. Zephric does the reading and the checking, and leaves the judgment to your team.
              </p>
            </div>
            <ol className="relative mt-14 grid gap-4 md:grid-cols-2 lg:grid-cols-4">
              <div aria-hidden className="brand-gradient absolute left-8 right-8 top-[38px] hidden h-px opacity-40 lg:block" />
              {STEPS.map((step, i) => (
                <li key={step.title} data-reveal className="relative rounded-2xl border border-line bg-canvas p-6" style={{ '--reveal-delay': `${i * 90}ms` } as React.CSSProperties}>
                  <div className="flex items-center justify-between">
                    <span className="flex size-10 items-center justify-center rounded-xl border border-line bg-surface text-ink">
                      <step.icon className="size-[18px]" />
                    </span>
                    <span className="num font-mono text-[12px] text-ink-4">0{i + 1}</span>
                  </div>
                  <h3 className="mt-6 text-[17px] font-semibold text-ink">{step.title}</h3>
                  <p className="mt-2 text-[14.5px] leading-[1.6] text-ink-2">{step.body}</p>
                </li>
              ))}
            </ol>
            <p data-reveal className="mt-8 text-[15px] text-ink-2">
              <Link href="/sample" className="focus-ring group inline-flex items-center gap-1.5 rounded font-medium text-ink underline decoration-line-strong underline-offset-4 hover:decoration-ink">
                Follow these four steps on a sample document
                <ArrowRight className="size-4 transition-transform group-hover:translate-x-0.5" />
              </Link>
              <span className="text-ink-3"> · about two minutes, no account</span>
            </p>
          </div>
        </section>

        {/* Reconciliation */}
        <section id="checks" className="relative overflow-hidden bg-navy py-20 text-white sm:py-28">
          <div aria-hidden className="ledger-grid-dark pointer-events-none absolute inset-0 [mask-image:linear-gradient(to_bottom,#000,transparent_85%)]" />
          <div className={cn(WRAP, 'relative')}>
            <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] lg:gap-20">
              <div data-reveal>
                <Eyebrow dark>What gets checked</Eyebrow>
                <H2 dark>Arithmetic is computed, never guessed.</H2>
              </div>
              <p data-reveal className="self-end text-[17px] leading-[1.65] text-white/65" style={{ '--reveal-delay': '80ms' } as React.CSSProperties}>
                Every check is deterministic: the same figures always give the same result, and each finding shows the numbers behind it. AI may help read a scanned page. It never decides whether a pay application adds up.
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
              <div className="flex items-center justify-between gap-3">
                <p className="text-[13px] font-semibold text-ink">Activity · application #{sample.application.number}</p>
                <span className="rounded-full border border-line bg-sunken px-2 py-0.5 text-[10px] font-medium uppercase tracking-[0.1em] text-ink-3">Illustrative</span>
              </div>
              <ol className="relative mt-6 space-y-6 before:absolute before:bottom-2 before:left-[7px] before:top-2 before:w-px before:bg-line">
                {timeline.map((t) => (
                  <li key={t.title} className="relative pl-8">
                    <span className={cn('absolute left-0 top-1 flex size-[15px] items-center justify-center rounded-full border-2 border-surface', t.tone === 'block' ? 'bg-block' : t.tone === 'pass' ? 'bg-aqua' : 'bg-ink-4')} />
                    <p className="text-[14px] font-medium text-ink">{t.title}</p>
                    <p className="num mt-0.5 text-[13px] text-ink-3">{t.detail}</p>
                  </li>
                ))}
              </ol>
              <p className="mt-6 border-t border-line pt-4 text-[12.5px] leading-[1.55] text-ink-3">The first two entries are what the product found on the sample package. The rest show how a correction usually plays out.</p>
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

        {/* Where it stands */}
        <section id="status" className="scroll-mt-16 border-t border-line bg-surface py-20 sm:py-28">
          <div className={WRAP}>
            <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] lg:gap-20">
              <div data-reveal>
                <Eyebrow>Where it stands</Eyebrow>
                <H2>What works today, and what does not yet.</H2>
              </div>
              <p data-reveal className="self-end text-[17px] leading-[1.65] text-ink-2" style={{ '--reveal-delay': '80ms' } as React.CSSProperties}>
                Zephric is early. Here is where each part stands, so you can judge it on what exists and not on what a slide says. It works on the documents themselves, so there is nothing to migrate to find out.
              </p>
            </div>
            <div className="mt-12 grid gap-4 md:grid-cols-3">
              {STATUS.map((c, i) => (
                <div key={c.title} data-reveal className="rounded-2xl border border-line bg-canvas p-6" style={{ '--reveal-delay': `${i * 90}ms` } as React.CSSProperties}>
                  <p className="flex items-center gap-2 text-[14px] font-semibold text-ink">
                    <span className={cn('size-2 rounded-full', c.dot)} />
                    {c.title}
                  </p>
                  <p className="mt-1 text-[13px] text-ink-3">{c.note}</p>
                  <ul className="mt-5 space-y-3 border-t border-line pt-5">
                    {c.items.map((item) => (
                      <li key={item} className="text-[14.5px] leading-[1.5] text-ink-2">
                        {item}
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
            <div data-reveal className="mt-4 flex flex-col gap-4 rounded-2xl border border-line bg-canvas p-6 lg:flex-row lg:items-center lg:gap-10">
              <p className="shrink-0 text-[14px] font-semibold text-ink">What Zephric does not do</p>
              <ul className="flex flex-wrap gap-x-7 gap-y-2 text-[14.5px] text-ink-2">
                {NOT_DOING.map((t) => (
                  <li key={t} className="flex items-center gap-2">
                    <Minus className="size-3.5 text-ink-4" />
                    {t}
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </section>

        {/* Design partners */}
        <section id="partner" className="scroll-mt-16 py-20 sm:py-28">
          <div className={cn(WRAP, 'grid items-start gap-12 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)] lg:gap-20')}>
            <div data-reveal className="lg:sticky lg:top-28">
              <Eyebrow>Design partners and demonstrations</Eyebrow>
              <H2>Shape Zephric with us.</H2>
              <p className="mt-5 text-[17px] leading-[1.65] text-ink-2">
                We are inviting a small number of general contractors and construction finance teams to supervised pilots on their own pay applications. If you would rather just see it first, ask for a demonstration with the same form.
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
              See what it finds on a sample. Then tell us about yours.
            </h2>
            <p data-reveal className="mt-5 max-w-[560px] text-[17px] leading-[1.6] text-white/60" style={{ '--reveal-delay': '140ms' } as React.CSSProperties}>
              The sample takes two minutes and no account. If it looks like your month-end, tell us how billing works on your projects and we will say honestly whether Zephric can help yet.
            </p>
            <div data-reveal className="mt-10 flex flex-col gap-3 sm:flex-row" style={{ '--reveal-delay': '200ms' } as React.CSSProperties}>
              <Link href="/sample" className="focus-ring group inline-flex h-12 items-center justify-center gap-2 rounded-full bg-white px-6 text-[15px] font-medium text-ink transition-colors hover:bg-white/90">
                Explore a sample workflow
                <ArrowRight className="size-4 transition-transform group-hover:translate-x-0.5" />
              </Link>
              <a href="#partner" className="focus-ring inline-flex h-12 items-center justify-center gap-2 rounded-full border border-white/15 px-6 text-[15px] font-medium text-white transition-colors hover:border-white/30 hover:bg-white/5">
                Become a design partner
              </a>
              <Link href="/login" className="focus-ring inline-flex h-12 items-center justify-center gap-2 rounded-full px-4 text-[15px] font-medium text-white/70 transition-colors hover:text-white">
                <Inbox className="size-4 text-white/50" />
                Sign in
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
          <p className="text-[13px] text-ink-3 sm:ml-4">© 2026 Zephric. Previews use fictitious sample data.</p>
          <nav aria-label="Footer" className="flex flex-wrap gap-x-5 gap-y-2 text-[13px] text-ink-2 sm:ml-auto">
            <LegalLink which="privacy" className="focus-ring rounded hover:text-ink">
              Privacy
            </LegalLink>
            <LegalLink which="terms" className="focus-ring rounded hover:text-ink">
              Terms
            </LegalLink>
            <Link href="/sample" className="focus-ring rounded hover:text-ink">
              Sample workflow
            </Link>
            <Link href="/login" className="focus-ring rounded hover:text-ink">
              Sign in
            </Link>
          </nav>
        </div>
      </footer>
    </div>
  );
}
