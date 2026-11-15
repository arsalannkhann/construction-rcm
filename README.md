# Construction RCM

Revenue cycle management for commercial general contractors. A subcontractor's
billing package comes in; the system reads it, works out which subcontract it
belongs to, recomputes every figure from the contract and the approved billing
history, pre-screens the lien waiver, and puts what it found in front of a
reviewer next to the original documents. A controller approves, and the
approved record is exported or pushed to a connected system. Everything along
the way is kept in a tamper-evident audit trail.

It is not an ERP, a payment system or a document store. No money moves from it,
and it does not make legal determinations.

## Quick start

Requires Node 20.9+ and pnpm. Nothing else: no database server, no API keys.

```bash
pnpm install
```

```bash
pnpm dev
```

Open http://localhost:3000, choose **Set up your company**, then on the
overview page choose **Create the demo workspace**. It builds in a few seconds.

Alternatively, create a sign-in and the demo workspace from the terminal (stop
the dev server first, because the embedded database opens in one process at a
time). The script prints the generated password once:

```bash
pnpm seed:demo
```

```bash
pnpm test
```

To run the same suite against a real PostgreSQL server (downloaded and started
for the run, then removed):

```bash
pnpm test:pg
```

Running it for a customer is different: see
[docs/operations.md](docs/operations.md) for deployment, backups, recovery,
monitoring and onboarding the first customer.

## What to look at first

In the demo workspace (fictitious companies; a separate organisation from your
own):

1. **Pay applications** lists what needs attention. Open *Lone Star Electric
   #5*: it re-bills $18,400 that was already certified. Click **Show in
   document** on a finding and the figure is highlighted on the page.
2. *Hill Country Mechanical #4* withholds retainage at 5% against a 10%
   contract. *Pacific Steel Erectors #5* bills a change order that is still
   pending; approve the change order on the contract and the finding clears by
   itself.
3. **Upload package**, download *Gulfstream Plumbing, with three problems*,
   and upload it. Watch it get read, matched and checked. Override the
   findings with a reason (owners, admins and controllers can; project
   accountants cannot), approve, and use **Transfer** to export.
4. **Overview** shows requested against approved by billing period, open
   work, retainage held and turnaround. Every figure is computed from the
   records; none is illustrative.
5. **Activity** is the audit trail, with a check that the chain is intact.

### Try it from an empty organisation

```bash
pnpm samples
```

This writes four PDFs and a schedule of values to `samples/out/` and prints
the subcontract to create for them (project, subcontractor, contract number,
amount, retainage). Create those in the app, paste the schedule into the
schedule editor, upload `1-…`, approve it, then upload `2b-…`.

## How it works

```
upload / email ─▶ store originals ─▶ read each document ─▶ merge into one application
                                                                    │
     export / Procore ◀─ approve ◀─ review workspace ◀─ reconcile ◀─ match to a subcontract
```

**Reading documents** (`src/server/documents`). Two engines produce the same
structure, with a page and position for every value:

- *Claude* (when `ANTHROPIC_API_KEY` is set). The model transcribes amounts as
  text exactly as printed and is told not to compute or correct. Our code turns
  text into cents, then looks every amount up in the PDF's own text layer. A
  value that is not on the page, or that disagrees with the deterministic
  reader, has its confidence cut and is called out. Reads scans and photos.
- *Text-layer reader* (always available, no network). Finds labels and the
  amounts beside them, and reads the schedule of values column by column. Works
  on digitally produced PDFs. It cannot read scans or see an ink signature, and
  reports "unclear" instead of guessing.

A file may contain several documents; pages are classified and split.

**Reconciliation** (`src/server/recon/engine.ts`) is a pure function. It
computes its own G702 from the contract, approved change orders, the last
approved application and this period's line items, then compares it with what
was submitted. It never relies on a total printed on the submission. Each check
returns a pass or a finding that says what is wrong, why it matters and what to
do. Money is integer cents and rates are basis points throughout.

**Lien waivers** (`src/server/compliance`). Classification, completeness
(present, signed, amount, date) and consistency with the application, plus
recognition of Texas, California and Florida statutory form wording. Anything
that would be a legal judgement (non-statutory wording, listed exceptions, an
undeterminable type) is marked "needs qualified review" and can only be signed
off by a controller or admin. The statutory facts were checked against official
statute text on 2026-11-15; see `src/server/compliance/jurisdictions.ts`.

**Review and approval** (`src/server/services/review.ts`). Blocking findings
must be fixed or overridden with a written reason before approval. An accepted
finding reopens automatically if the figures behind it change. Fixing a misread
and adjusting what will be paid are recorded as different things. Approval
writes an immutable record; exports are rendered from that record, never from
live data. A decision is made on what the person saw: approving, rejecting,
submitting and overriding carry the version (and, for approval, the amount)
that was on screen, and are refused if the application has changed since.
A corrected resubmission replaces the earlier one instead of sitting beside it.

**Retainage** (`computeRetainage` in the engine). A flat rate, or a rate that
steps down once the work reaches a percentage of the contract sum (on further
work only, or on all work). Releases are recorded on the contract by an
approver before they are billed, so the application that bills one is checked
against it instead of being flagged for withholding too little.

**Reliability** (`src/db/tx.ts`, `src/server/jobs.ts`). Every change to an
organisation's records is one transaction under that organisation's advisory
lock: it happens completely or not at all, and two people's changes are applied
one after the other. Document reading runs on a database-backed queue with
leases, retries and a visible failure state, so a restart mid-read resumes the
work and a package that cannot be read is reported rather than lost. A re-read
keeps the reviewer's corrections that still apply and says which ones it
dropped.

**Audit trail** (`src/server/audit.ts`). Append-only and hash-chained per
organisation, so an edited or deleted event is detectable.

More detail for contributors is in [docs/conventions.md](docs/conventions.md).

### Stack

Next.js 16 (App Router) and React 19, TypeScript, Tailwind 4, Drizzle ORM.
PostgreSQL in production; for development and tests the same schema and SQL run
on PGlite (Postgres compiled to WASM, in-process), which is why there is no
database to install. Documents are content-addressed by SHA-256 and checked
against their hash on every read; with PostgreSQL they are stored in the
database (one backup covers everything), with the embedded database on disk.
Document processing runs on a database-backed queue inside the server process.

Two versions are pinned for Node 20: `pdfjs-dist` 4.x and `vitest` 3.x. Their
newer majors need Node 22.

## Configuration

Copy `.env.example` to `.env.local`. Everything is optional in development.

| Variable | Effect when set | When not set |
|---|---|---|
| `DATABASE_URL` | Uses PostgreSQL | Embedded database under `RCM_DATA_DIR` (`./.data`) |
| `RCM_SECRET_KEY` | Encrypts stored integration tokens | Required in production; a local key file is generated in development |
| `APP_URL` | Base URL for invite links and OAuth redirects | `http://localhost:3000` |
| `ANTHROPIC_API_KEY` | AI document reading (`RCM_EXTRACTION_MODEL`, default `claude-opus-5-5`) | Text-layer reader only; scans are keyed by hand |
| `PROCORE_CLIENT_ID`, `PROCORE_CLIENT_SECRET`, `PROCORE_ENV` | Procore can be connected | Shown as "Not configured"; file export only |
| `RESEND_API_KEY`, `EMAIL_FROM` | Invitations and messages to subcontractors are emailed | They are saved as drafts and labelled "not sent" |
| `INBOUND_EMAIL_SECRET` | Opens the email-intake webhook | The webhook rejects every request |
| `DATABASE_POOL_MAX` | Connections per process (default 10) | |
| `RCM_STORAGE` | `database` or `disk` for documents | `database` with `DATABASE_URL`, otherwise `disk` |

Settings → Organisation shows which of these are active on a running
deployment, and Settings → System status shows database, storage and queue
health, failed background work and the email-intake log (also at
`/api/health` for monitoring, without sign-in or organisation data). Extraction requests opt in to the API's server-side refusal
fallback; set `RCM_EXTRACTION_FALLBACKS=off` to disable that.

## What is and is not verified

**Verified by automated tests** (`pnpm test`, 208 tests, against in-memory
Postgres):

- Money parsing and rounding; every reconciliation check; waiver pre-screening
  and statutory form recognition.
- Reading generated Texas, California and Florida packages from real PDF bytes,
  including multi-page schedules and combined files.
- The full service workflow: upload → read → match → reconcile → correct or
  override → approve → export, plus sequencing, duplicates, opening balances,
  change orders, reopening, role enforcement and tenant isolation.
- The audit chain, including detection of an edited event.
- The demo workspace build (about forty packages through the real pipeline).
- Team invitations, roles and policy; exports (CSV, JSON, PDF); email intake.
- The AI engine's parsing, grounding, cross-checking and failure handling,
  with a **stubbed** client.
- The Procore client, OAuth with token rotation, import and push, against a
  **local emulator** of the documented API.

**Verified by hand in a browser** on 2026-11-15: sign-up; creating and deleting
the demo workspace; the dashboard; the queue; upload, processing and automatic
matching; the review workspace (evidence highlighting, all tabs, inline edit);
overriding findings; approval with acknowledged warnings; the correction
request; the unmatched-package screen; creating a project, subcontractor and
subcontract with a pasted schedule and running two packages through them in a
non-demo organisation; transfers; activity; settings. The production build
(`pnpm build`) and `pnpm start` were smoke-tested.

**Not verified, because it needs credentials or infrastructure that was not
available:**

| Area | State |
|---|---|
| Claude reading real documents | Never called live. Accuracy on real pay applications is unmeasured. |
| Procore | Never run against a Procore account. Built from the public API documentation (`docs/procore-api-notes.md`). |
| Outbound email (Resend) | Never sent. |
| Inbound email | The webhook logic is tested; no provider has been pointed at it. |
| PostgreSQL via `DATABASE_URL` | Not run. The same migrations and queries run on PGlite, which is Postgres, but the `pg` driver path is untested. |
| Docker image | `Dockerfile` and `docker-compose.yml` are provided and have not been built. |
| Real subcontractor documents | Only generated documents have been read. The text-layer reader's tolerance for other layouts is unmeasured. How to measure it, the synthetic results, and a pilot protocol: [docs/extraction-evaluation.md](docs/extraction-evaluation.md). |

## Limitations and risks

- **Retainage is a flat rate** on completed work and on stored material. Stepped
  retainage and scheduled releases are not modelled; a reduction is flagged for
  a person to confirm.
- **No password reset and no SSO or MFA.** A user who forgets their password
  cannot recover the account without database access. This must be fixed before
  real users are onboarded.
- **Tenant isolation is enforced in application code**, with tests, and not by
  database row-level security.
- **Single node.** The embedded database opens in one process, the job runner is
  in-process, and documents are on local disk. Fine for evaluation and a first
  customer; it needs Postgres, object storage and a separate worker to scale.
- **The sign-in throttle is in memory** and there is no general rate limiting.
- **Procore push** covers contract line items on subcontracts imported from
  Procore. It does not push change-order billing or unit-price contracts, and
  needs an existing Procore billing period.
- **Payments are not tracked**, so "unconditional waiver for the previous
  payment" is a policy check, not a check against a payment.
- **CSV export is generic.** It is not an import file for a specific accounting
  system.
- **Lien waiver knowledge covers three states**, and only form recognition.
  Other states get completeness and consistency checks only.
- Times are shown in the viewer's locale; billing dates are calendar dates
  without a time zone.

## After first customer feedback

1. Run real pay applications from two or three customers through both engines
   and measure reading accuracy field by field. This decides how much of the
   deterministic reader to keep.
2. Connect a Procore sandbox and correct whatever the emulator got wrong.
3. Account recovery, SSO and MFA.
4. Retainage schedules and releases, and final payment applications.
5. A named accounting export (Sage 300 CRE, Vista or CMiC, whichever the first
   customers use) in place of the generic CSV.
6. Subcontractor-facing resubmission, so corrections do not go through email.
7. Postgres row-level security, object storage and a separate worker.

## Repository

```
src/app            pages, server actions, route handlers
src/components     UI kit, shell, charts
src/server
  recon/           reconciliation engine (pure)
  compliance/      lien waiver pre-screen and jurisdiction data (pure)
  documents/       PDF text, the two extraction engines
  services/        business logic: intake, review, records, team, exports, dashboard, demo
  integrations/    Procore
  samples/         generates billing PDFs for the demo and the tests
src/db             schema and database access
drizzle/           SQL migrations (`pnpm db:generate` after a schema change)
tests/             Vitest
docs/              conventions, Procore API notes
```
