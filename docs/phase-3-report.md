# Phase 3 report: pilot readiness and reliability

Written on 2026-11-16. Covers the work from the Phase 2 report (`main` at
`c37d1da`) to `main` at `7b94b58`, plus pull request 18 (onboarding) and this
report: 11 pull requests, 27 commits, about 15,900 lines added across 145 files.
Times are UTC. The product is now called **Zephric**; the repository, Vercel and
Supabase projects keep their old names.

## Where it stands

Zephric runs at https://zephric.vercel.app (Vercel, with a Supabase PostgreSQL
database over verified TLS). The public website is served at `/` to visitors
who are not signed in; members go straight to the app.

**It is ready for a supervised pilot with one customer, on the conditions in
section 6. It is not ready for unsupervised production use.** What stands
between the two:

1. **Reading accuracy on real subcontractor documents is still unmeasured.** No
   real package has been read, and there is no Anthropic key, so the AI reader
   has never run. Every claim about reading in this report is about behaviour
   (time limits, fallbacks, warnings), not accuracy.
2. **No production backup exists yet, and no uptime check is running.** Both
   are built and their restore and check logic was run on this machine, but
   GitHub Actions is locked on the owner's account for a billing issue, and the
   backup needs the owner's encryption key and database secrets.
3. **Email, AI reading and Procore have never been used with the real
   services.** The code was checked against each provider's official
   documentation this phase, and corrected where it differed, but nothing has
   been sent to or received from them.
4. **The hosting plans are not for commercial use.** Vercel Hobby is
   non-commercial and runs the scheduler once a day; Supabase Free has no
   downloadable backups and no point-in-time recovery.

## 1. What was checked first

The Phase 2 report and repository were re-checked before any change. The
report's claims held, with two exceptions it had already flagged:

- **Procore duplicate invoices.** A lost answer from Procore was recorded as
  "failed, nothing was created", so pressing Send again could create a second
  invoice. The duplicate check the notes described did not exist.
- **Transfers page "refreshing".** The repeated requests seen on `/transfers`
  were Next.js prefetching every link on the page: 18 server renders in the
  first 4 seconds of opening it, each with a session check and database
  queries.

## 2. What changed

### Procore: one invoice per application (PRs 8, 11)

A push now claims the application in the database (so no other server can push
it at the same time), lists the subcontract's existing invoices, refuses if one
already has the application's number, creates the invoice once, and records
what happened literally: `completed` with Procore's id, `failed` when nothing
was created, or **`unknown`** when the request went out and no usable answer
came back. A retry after an `unknown` adopts the invoice Procore already has
instead of creating another, and only when the earlier request was byte-for-byte
the same. Tested against the Procore emulator, including two simultaneous sends;
with the check disabled, the tests fail.

### Operational safeguards (PR 13)

- **Nightly backup** (`.github/workflows/backup.yml`): dumps production,
  restores it into a scratch database on the runner, checks the copy, encrypts
  it to the owner's public key and keeps it 30 days. A **restore drill** that
  needs no secrets runs before each backup and on every change to migrations.
- **`pnpm backup:check`** checks a restored database: migrations recorded,
  audit chains intact, every stored file matching its SHA-256 and size, no
  dangling references, row counts matching the source. It prints counts only.
- **Uptime check** (`.github/workflows/uptime.yml`): `/api/health` every 15
  minutes.
- **Scheduler heartbeat** (migration 0006): every scheduled call to
  `/api/jobs/run` is recorded. `/api/health` and System status show the last
  run and report a problem after 26 hours. Vercel Hobby keeps logs for an hour,
  so this is the only way to tell that the daily run happened.
- **Incident, 2026-11-15:** the Supabase GitHub integration did not apply
  migration 0005 when it reached `main`, and the site returned 503 for about 7
  minutes until it was applied by hand. Migrations are now applied by hand
  before merging; `operations.md` says how. Migration 0006 was done that way.

### Sign-in and team workflows (PR 15)

An end-to-end walkthrough on a local production build covered sign-up,
two-step verification (setup, sign-in, recovery codes), invitation and
acceptance, two-step required for a new member, rejecting an application, and
signing out other sessions. What it found was fixed:

- After signing in, people return to the page they asked for. Only a path on
  this site is accepted, so the sign-in link cannot be used to send someone
  elsewhere (tested against the usual open-redirect tricks).
- Rejected and voided applications show who decided, when and why.
- The difference between requested and verified amounts has one sign
  everywhere.
- "Require two-step verification for everyone" moved to Settings → Team →
  Security.
- Two-step page wording, a branded "page not found", `/dashboard` redirects,
  and layout at 730 px.

### AI document reading (PR 16)

- **Time limits.** Each read stops before the hosting limit (functions stop at
  300 s on Vercel): the job runner passes the time it must finish by, and each
  read is also capped by `RCM_EXTRACTION_TIMEOUT_SECONDS` (default 240). Before,
  a long package could be cut off three times and fail as "the server was
  probably restarted".
- **Fallback with a reason.** A failed or stopped AI read falls back to the
  text-layer reader, or marks a scan as not read, and says why. The application
  still reaches review.
- **Evidence for the reviewer.** A warning finding and a notice in the document
  viewer when the backup reader stood in ("check its figures against the
  page"). **Read again** asks for a re-read; corrections are kept and the request
  is audited.
- **Measurement.** System status shows, per reader, what reviewers had to change
  on applications decided in the last 90 days (misread and missed summary
  figures, corrected and hand-keyed lines and waivers, documents not read). It is
  labelled as reviewer effort, not accuracy: a misread value nobody noticed
  counts as read correctly. Measured accuracy still needs the double-keyed
  protocol in `extraction-evaluation.md`.
- Clearer failure reasons from the AI service (timeouts, overload, too large).

### Email providers (PR 17)

Checked against Postmark's and Resend's documentation; details in
[email-provider-notes.md](email-provider-notes.md).

- **Inbound:** the shared secret is checked before the request body is read; a
  secret in the query string is no longer accepted. Status codes follow
  Postmark's retry rules (403 stops retries for what cannot be fixed, 401/503
  keep them going while the owner fixes the setting). Mail marked as spam, or
  failing SPF, is turned away; SPF failures notify the team once a day per
  sender.
- **Outbound:** sends Resend's required User-Agent and an idempotency key on
  every message, so a single retry after a lost answer cannot send it twice. A
  message the provider never answered for is recorded as **Not confirmed**, not
  failed: the application is not put on hold and the same text cannot be sent
  again by accident.
- **Hosting limit found:** on Vercel, an emailed package over 4.5 MB (about 3 MB
  of attachments) is refused by the platform before it reaches Zephric, and the
  app never sees it. The Organisation page and the docs say so.

### Transfers page (PR 10)

Links prefetch when someone points at them, not when they appear. On a local
production build, opening `/transfers` went from 18 prefetch requests to 0.

### Onboarding (PR 18)

A fresh organisation was signed up and set up from scratch, as a finance team
would. Fixed:

- A subcontract could not be set up until the subcontractor had been added on
  another page, with no way back. It can now be added from the subcontract form.
- **Pasting a schedule of values that ends with a TOTAL row doubled the
  schedule** ($480,000 became $960,000). Total and subtotal rows are left out,
  and a total that disagrees with the rows above it is reported.
- A package uploaded before its subcontract existed only said "create the
  subcontract first, then come back". **Set up its subcontract** now fills in
  the subcontractor, project and contract number the package states, and
  matches the application once the subcontract is created. Amounts and retainage
  are deliberately not copied: the application must be checked against the
  subcontract's own terms, not its own figures.
- The setup list explains opening balances for subcontracts already being
  billed, includes requiring two-step verification, and keeps unfinished steps
  on the overview for a new organisation.

### Brand, website and layout (PRs 9, 11, 12, 14, 16)

Zephric name and logo throughout (authenticator entries made before the rename
keep working). The public website, redesigned, with a design-partner inquiry
form that stores inquiries in the database (sender address kept only as a keyed
hash, rate-limited). The signed-in app works at phone and tablet widths: no
sideways scroll at 375 px on the main pages.

### Controls that did not change

Zephric still makes no payment and no legal decision. Arithmetic is done by
code, never by the AI. Every blocking finding needs a person, approval needs an
approver, lien waiver checks are a pre-screen, and every change to a financial
record is in the audit trail. Organisations cannot see each other's records:
each new query this phase is scoped to the organisation and tested with a second
organisation, and for the setup-from-package query the test was shown to fail
when the scoping is removed.

## 3. What was actually verified

| What | How | Result |
|---|---|---|
| Automated tests, embedded database | `pnpm test` on the final branch | 466 passed, 3 skipped (PostgreSQL-only) |
| Automated tests, real PostgreSQL | `pnpm test:pg` on the final branch | 469 passed |
| Types and build | `pnpm typecheck`, `pnpm build` | Pass |
| Tests catch the faults they are for | Faults planted on purpose (Procore check removed, email retry rule broken, organisation filter removed, inbound route reordered) | Each made its tests fail |
| Production health | `GET https://zephric.vercel.app/api/health`, 2026-11-16 01:41 | `ok`; database TLS verified; no table exposed through Supabase's Data API; PDF reader ok; queue empty |
| Scheduler | Same check | **Not yet observed.** No scheduled run recorded; the first daily run is due at 03:00 UTC on 2026-11-16 |
| Restore | The drill's dump and restore commands and `backup:check`, run on this machine against a seeded database | 32 tables, 1,978 rows, 210 audit events and 65 files restored and checked; planted damage was detected |
| Sign-in and team flows | Walkthrough on a local production build | Passed after the PR 15 fixes |
| Onboarding | Walkthrough in the browser on a fresh local workspace | Passed after the PR 18 fixes |
| Reading behaviour | Tests with an AI stub that only stops when cancelled; browser check of the warning and Read again | Pass |
| Phone layout | Browser at 375 px, 730 px and desktop | No sideways scroll on the main pages |

**Not verified:**

- Any real subcontractor document, and any call to the AI service.
- Any email sent through Resend or received from Postmark.
- Any call to Procore (emulator only).
- A backup or restore of the **production** database.
- The GitHub Actions workflows (backup, restore drill, uptime): none has run.
- Two-step verification, invitations and rejection **on the live site**. They
  were walked through locally. Passwords are not typed on the production site
  from here, so the owner has to do this (section 7, step B5).
- The daily scheduled run on Vercel (see above).

## 4. Remaining blockers

| Blocker | Effect | Who |
|---|---|---|
| GitHub Actions locked for billing | No backups, no restore drill in CI, no uptime check | Owner: clear the billing issue |
| Backup secrets not set | The backup job cannot run even once Actions works | Owner (section 5) |
| Supabase Free plan | Its own backups cannot be downloaded; no point-in-time recovery | Owner: paid plan, consider point-in-time recovery |
| Vercel Hobby plan | Non-commercial use only; scheduler once a day, so failed background work waits up to a day unless someone opens the app | Owner: Pro, then a 5-minute schedule |
| No dedicated uptime service | Outages are noticed only when someone visits | Owner |
| Real-document accuracy unmeasured | Reading must be double-checked during the pilot | Pilot protocol (section 6) |
| Email intake over 4.5 MB refused on Vercel | Large emailed packages never arrive; senders must split them or upload by hand | Accept for the pilot, or host elsewhere later |
| Supabase GitHub integration does not apply migrations | Each schema change needs a manual step before merging | Engineering practice, documented |
| Procore not validated in a sandbox | Leave Procore off for the first pilot | Owner's Procore developer account |

## 5. External services the owner must configure

None of these has been purchased or changed from here.

| Service | What to do | Then check |
|---|---|---|
| **GitHub** | Clear the Actions billing lock (account Settings → Billing and plans). | Actions → "Database backup" → "Restore drill (sample data)" runs green. |
| **Backups** | `age-keygen -o zephric-backup.key` and keep the private key offline. In the repository's Actions settings: variable `BACKUP_AGE_RECIPIENT` (the `age1…` public key); secrets `BACKUP_DATABASE_URL` (Supabase session pooler URL) and `BACKUP_DATABASE_CA_CERT` (Supabase CA certificate). See `operations.md`, "Backups". | Run "Database backup" by hand; "Back up production" ends with the restored copy checked. Decrypt one backup with the key and restore it once yourself. |
| **Uptime service** | Any service with a free tier: `https://zephric.vercel.app/api/health` every minute, alert on anything but HTTP 200 and on `"status":"degraded"` for 10 minutes. | Pause the check once to see an alert arrive. |
| **Vercel Pro** | Upgrade; change `vercel.json` to `*/5 * * * *` and deploy. | `/api/health` → `scheduler.lastRunAt` moves every 5 minutes. |
| **Supabase paid plan** | Upgrade; consider point-in-time recovery. | Backups listed in Supabase. |
| **Anthropic** | Set `ANTHROPIC_API_KEY` in Vercel and redeploy. Without it, scans and photos must be keyed by hand. | Settings → Organisation shows AI reading configured; upload one scanned package. |
| **Resend** | Verify a sending domain (DNS), create an API key, set `RESEND_API_KEY` and `EMAIL_FROM`. | Invite a colleague; the email arrives. |
| **Postmark inbound** (optional) | Set `INBOUND_EMAIL_SECRET`; point an inbound stream at `https://zephric:<secret>@<address under Settings → Organisation>`; keep spam filtering on. | Send a small package; it appears under System status → Email intake. |
| **Procore** (not for the first pilot) | A Procore developer account and sandbox; run `procore-validation.md`. | All its steps pass. |
| **Custom domain** (optional) | Add it in Vercel, set `APP_URL`, redeploy. | Invitation links use it. |

Keep `RCM_SECRET_KEY` and `CRON_SECRET` in a secrets manager. `RCM_SECRET_KEY`
cannot be changed without breaking everyone's two-step verification.

## 6. Readiness for a supervised pilot

**Ready, on these conditions:**

1. One customer, one project first, with Zephric's operator on hand.
2. **Before customer data goes in:** GitHub unlocked, backup secrets set, one
   backup taken and restored, and an uptime alert configured. Without these, a
   database loss would be unrecoverable from anything this project controls.
3. The plans upgraded, or the owner's explicit acceptance that a paying pilot on
   Hobby and Free plans breaks Vercel's terms and has no point-in-time recovery.
4. **Nothing is paid on the reader's output alone.** The first three packages
   from each subcontractor, and every new form, are double-keyed by two people,
   and the differences are recorded (`extraction-evaluation.md`, "Pilot
   protocol"). Any confidently wrong value stops the pilot until it is fixed and
   measured again.
5. Without an Anthropic key, only digitally produced PDFs are read; scans are
   keyed by hand. That is workable for a pilot, but should be expected.
6. Email is optional. Without Resend, invitation links are copied and sent by
   hand, and messages to subcontractors are saved as drafts marked "not sent".

## 7. Exact steps for onboarding the first customer

### A. Owner, before anything else

1. Clear the GitHub billing lock; set the backup variable and secrets; run the
   backup once by hand and restore one copy (section 5).
2. Set up the uptime alert.
3. Decide on the Vercel and Supabase plans (section 6, condition 3).
4. Decide on the Anthropic key and Resend.

### B. Operator, on the live site

1. `https://zephric.vercel.app/api/health`: `ok`, `tls: verified`,
   `exposedTables: 0`, `pdfReader.ok: true`, and `scheduler.lastRunAt` set
   (after 03:00 UTC; if it is still empty a day later, check `CRON_SECRET` and
   Vercel → Settings → Cron Jobs).
2. With Vercel Pro: the 5-minute schedule deployed and `lastRunAt` moving.
3. With a custom domain: `APP_URL` set to it.
4. Settings → Organisation, "Deployment status": confirm what is and is not
   configured, and tell the customer.
5. **Live checks of sign-in and team flows** in the owner's own organisation:
   turn on two-step verification and save the recovery codes; invite a second
   address and accept it in a private window; reject a test application; sign
   out other sessions from Profile. Record the results.

### C. With the customer's controller, on a call

1. **Sign up.** The controller creates the organisation at `/signup`.
2. **Two-step.** Settings → Profile: turn it on, save the recovery codes. Then
   Settings → Team → Security: require it for everyone.
3. **Team.** Settings → Team: invite by role. Controllers approve and override
   blocking findings; project accountants review and submit for approval.
   Without Resend, copy each invitation link and send it.
4. **Review policy.** Settings → Review policy: rounding tolerance, required
   waivers, signature and notarisation, low-confidence threshold, and what
   happens to email from unknown senders.
5. **One project.** Projects → New project, with its state (Texas, California
   and Florida lien waiver forms are recognised; other states get completeness
   checks only).
6. **Subcontracts.** From the project, Add subcontract. Add the subcontractor
   from the form if it is new, with the billing contact's email. Enter the
   number, amount and retainage **from the signed subcontract**. Paste the
   schedule of values from the spreadsheet (a total row is left out and
   checked). Add change orders, approved and pending. Stepped retainage goes
   under Edit terms.
7. **Subcontracts already being billed.** Upload the latest approved pay
   application first. On its "no billing history" finding, an approver chooses
   **Set opening balances…**; the next application is checked against them.
8. **First live package.** Pay applications → Upload package. If it arrives
   before its subcontract exists, it waits in "Needs matching": choose **Set up
   its subcontract** there.
9. **Review together.** Go through every finding with the controller and record
   each disagreement with what they would have caught by hand. Those records are
   the pilot's first real measure of accuracy.
10. **Week one.** Double-key the first packages (section 6, condition 4). Check
    System status weekly: failed background work, the email intake log, and
    "What reviewers changed after the reader".

The full operator version is `operations.md`, "Onboarding the first customer".
