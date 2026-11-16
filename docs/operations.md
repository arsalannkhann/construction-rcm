# Operating Zephric

How to deploy it, keep it healthy, back it up, recover it, and onboard the
first customer. Written for whoever runs the pilot deployment.

## What you are running

One Node.js process serves the web app and runs the document-processing queue.
Everything it keeps lives in one PostgreSQL database: the records, the audit
trail, the queue, and (by default) the original documents and exports
themselves. Back up the database and you have backed up everything except the
encryption key (see [Secrets](#secrets)).

```
browser ──HTTPS──▶ reverse proxy / load balancer ──▶ app (Next.js, port 3000) ──▶ PostgreSQL
                                                     └─ queue runner (same process)
```

Without `DATABASE_URL` the app uses an embedded database under `RCM_DATA_DIR`
and keeps documents on disk. That mode is for evaluation on one machine. Do not
run a pilot on it.

## Requirements

- PostgreSQL 14 or later. The full test suite runs against PostgreSQL 18.6
  (`pnpm test:pg`); `docker-compose.yml` uses PostgreSQL 16.
- Either Docker, or Node.js 20.9+ with pnpm 9.
- A hostname with HTTPS in front of port 3000. The app does not terminate TLS.
- Database size: roughly the size of the uploaded PDFs plus a few percent. A
  billing package is typically 1–5 MB.

## Configuration

| Variable | Required | Purpose |
|---|---|---|
| `DATABASE_URL` | Yes | `postgres://user:pass@host:5432/db`. For a managed database, see `DATABASE_CA_CERT`. |
| `RCM_SECRET_KEY` | Yes | 32+ random bytes (e.g. `openssl rand -base64 48`). Encrypts stored integration tokens and authenticator keys, and keys the hashes of recovery codes and remembered browsers. Without it in production, credentials cannot be stored and two-step verification cannot be turned on. Treat it as permanent: a new key breaks everyone's second step. |
| `RCM_CLIENT_IP_HEADER` / `RCM_TRUSTED_PROXY_HOPS` | Yes, one of them, unless the default fits | How the client's address is found, for the sign-in limits. Name a header the platform sets itself (`cf-connecting-ip`, `fly-client-ip`, `x-real-ip` on Vercel), or give the number of proxies that append to `X-Forwarded-For` (default 1). Never expose the app without a proxy in front. See `docs/authentication.md`, "Client addresses". |
| `APP_URL` | Yes | The public `https://` URL. Used in invitation and password links and OAuth redirects. Session cookies are marked `Secure` only when this starts with `https://`. |
| `DATABASE_CA_CERT` | For Supabase | The database provider's CA certificate (PEM text, or a path to the file). Connections are then encrypted and the server's certificate and host name are checked. Needed because node-postgres treats `sslmode=require` as full verification against Node's built-in authorities, which do not include Supabase's, so `?sslmode=require` alone fails to connect. Do not switch verification off instead. |
| `RCM_MIGRATIONS` | For Supabase | `external` when the database's schema is managed outside the app (on Supabase, `supabase/migrations`, applied as described under [Schema](#schema)). The app then only checks the schema at start and refuses to run on an older one. Unset, the app applies `drizzle/` itself. |
| `DATABASE_POOL_MAX` | No | Connections per app process (default 10; 3 on Vercel, per instance). |
| `CRON_SECRET` | On Vercel | Secret the scheduler sends to `/api/jobs/run` as `Authorization: Bearer …` (Vercel's cron does this by itself). Without it that endpoint refuses to run. `openssl rand -hex 32`. |
| `RCM_JOB_RUNNER` | No | `poll` (a long-lived process runs the queue) or `request` (serverless: work runs after the request that queued it). Default: `request` on Vercel, `poll` elsewhere. Leave it unset. |
| `RCM_STORAGE` | No | `database` (default with `DATABASE_URL`) or `disk`. Leave it unset. |
| `ANTHROPIC_API_KEY`, `RCM_EXTRACTION_MODEL` | No | AI document reading. Without it, only PDFs with a text layer are read; scans are keyed by hand. |
| `RCM_EXTRACTION_TIMEOUT_SECONDS` | No | Longest one AI read may take (default 240). A read that runs over is stopped; the document is read by the text-layer reader instead, or marked not read, and reviewers are told which. |
| `RESEND_API_KEY`, `EMAIL_FROM` | No | Outbound email. Without them, messages are saved as drafts and clearly marked "not sent". |
| `INBOUND_EMAIL_SECRET` | No | Opens the email-intake webhook. Without it every intake request is refused. |
| `PROCORE_CLIENT_ID`, `PROCORE_CLIENT_SECRET`, `PROCORE_ENV` | No | Procore connection. See `docs/procore-api-notes.md`. |

Settings → Organisation shows which optional services are active. Nothing
optional fails silently: an unconfigured service is shown as not configured,
and work that would have used it is saved and labelled instead.

## Deploy with Docker Compose

On a host with Docker:

```bash
git clone <this repository> construction-rcm
```

```bash
cd construction-rcm
```

Create `.env` next to `docker-compose.yml`:

```
APP_URL=https://billing.example.com
RCM_SECRET_KEY=<output of: openssl rand -base64 48>
```

Change the database password in `docker-compose.yml` (`POSTGRES_PASSWORD` and
the password in `DATABASE_URL`) before the first start, then:

```bash
docker compose up -d --build
```

```bash
curl -s http://localhost:3000/api/health
```

Point your reverse proxy (Caddy, nginx, a cloud load balancer) at port 3000
with HTTPS. Use `/api/health` as its health check.

## Deploy on a container platform with managed PostgreSQL

1. Create a PostgreSQL database and a user that owns it.
2. Build the image from `Dockerfile` (or let the platform build it).
3. Set `DATABASE_URL`, `RCM_SECRET_KEY` and `APP_URL`. Do not mount a volume;
   with `DATABASE_URL` set, documents are stored in the database.
4. Health check: `GET /api/health`, expecting HTTP 200.
5. Run **one instance** for the pilot. Writes are serialised with PostgreSQL
   advisory locks, the queue claims jobs with `FOR UPDATE SKIP LOCKED`, and
   migrations take a lock, so several instances are designed to be safe, but a
   multi-instance deployment has not been tested.

## Use Supabase as the database

Supabase is plain PostgreSQL to this app: it connects as the `postgres` role,
owns its tables, and does not use Supabase Auth, Storage or the Data API.

### Schema

`supabase/migrations/` holds the same migrations as `drizzle/`, under the
version names Supabase expects. `pnpm db:supabase` regenerates it after
`pnpm db:generate`, and a test fails if the two ever differ.

**Apply each new migration by hand, before its change is merged.** Supabase's
GitHub integration can apply these files when they reach `main` (its **Deploy
to production** option, Project settings → Integrations), but on the
`construction-rcm` project it does not: on 2026-11-16 migration 0005 reached
`main`, no Supabase check ran on the commit, the new deployment refused to
start for about seven minutes (`/api/health` named the missing migration), and
the migration had to be applied by hand. Until someone with access to the
Supabase organisation turns that option on and watches it apply one migration,
treat it as off.

To apply one, open the SQL editor and run the file and its history row in one
transaction. With `<version>` and `<name>` taken from the file name
(`supabase/migrations/<version>_<name>.sql`):

```sql
begin;
-- paste the contents of supabase/migrations/<version>_<name>.sql here
insert into supabase_migrations.schema_migrations (version, name, statements)
values ('<version>', '<name>', array[$mig$ paste the same contents here $mig$]);
commit;
```

Then check that it is recorded, and only then merge:

```sql
select version, name from supabase_migrations.schema_migrations order by version;
```

Migrations 0000–0005 are applied to `construction-rcm` and recorded under the
same versions as the files.

Never let the app apply its own migrations to a database Supabase manages: set
`RCM_MIGRATIONS=external`. If you forget, the app refuses to start and says so.

### Connection

1. **Connection string.** Dashboard → **Connect** → **Session pooler** (port
   5432, user `postgres.<project-ref>`). The direct host `db.<ref>.supabase.co`
   only has an IPv6 address unless the paid IPv4 add-on is on. Do not use the
   transaction pooler (port 6543): the app relies on session behaviour.
2. **TLS.** Database settings → **SSL configuration** → **Download
   certificate**. Set `DATABASE_CA_CERT` to the file's path, or to its contents
   (on a container platform, paste it into a secret). Then turn on **Enforce SSL
   on incoming connections** there too.
3. **Pool size.** Keep `DATABASE_POOL_MAX` below the pooler's pool size
   (Database settings → Connection pooling). `5` is plenty for a pilot.
4. **Environment:**

   ```
   DATABASE_URL=postgres://postgres.<ref>:<password>@<pooler-host>:5432/postgres
   DATABASE_CA_CERT=/run/secrets/supabase-ca.crt
   RCM_MIGRATIONS=external
   DATABASE_POOL_MAX=5
   RCM_SECRET_KEY=...
   APP_URL=https://...
   ```

5. Start the app and open Settings → System status. **Database** should read
   *Supabase*, "encrypted and the server's certificate is checked", and
   **Supabase Data API** should read *Locked*.

### The Data API

Supabase publishes every table in `public` through its Data API, and the anon
key that opens it is public by design. Migration 0002 shuts that door twice:
row level security on every table with no policies, and no privileges for the
`anon`, `authenticated` and `service_role` roles. The project's own
automatic-RLS event trigger (`ensure_rls`) also turns RLS on for new tables.
On 2026-11-15 every table answered `401 permission denied` through the Data
API with both public keys, for reading and for inserting. The health check
reports the deployment as degraded if any table becomes reachable again.

Because the app never uses the Data API, you can also switch it off
altogether: Project settings → **Data API**. Supabase's security advisor will
list "RLS enabled, no policy" for every table. That is intended.

### Plan limits that matter for a pilot

- **Database size.** Documents are stored in the database (`stored_objects`),
  so it grows by roughly the size of every uploaded PDF. The Free plan's 500 MB
  holds roughly a hundred or two billing packages. Watch Reports → Database.
- **Pausing.** Free-plan projects are paused after a week of low activity.
- **Backups.** Free-plan backups cannot be downloaded. The nightly backup
  workflow ([Backups](#backups)) takes its own `pg_dump` through the session
  pooler, restores and checks it; it needs three settings in GitHub before it
  does anything. Point-in-time recovery needs a paid plan.

A pilot with a customer's real billing should run on a paid plan. That is a
purchasing decision for whoever owns the Supabase organisation.

### Upgrading on Supabase

The new app version must start only after its migrations are in the database,
so apply them (above) before merging. If it starts first, it refuses to run
(`/api/health` returns 503 naming the missing migration) until they are
applied, and then starts normally on the next request. Migrations so
far only add tables and columns, so the previous app version keeps working
while they are applied.

## Deploy on Vercel

The web app and API run as Vercel Functions; the database and the documents
stay in Supabase. Nothing else is needed.

```
browser ──HTTPS──▶ Vercel (Next.js functions, region sin1) ──TLS──▶ Supabase PostgreSQL (ap-southeast-1)
                     └─ scheduled GET /api/jobs/run (vercel.json)
```

`vercel.json` pins the functions to `sin1` (Singapore), next to the Supabase
project, because every page makes several database round trips.

### What is different from a long-lived server

- **Document processing.** Nothing runs between requests, so there is no queue
  runner. A package is read right after the upload's response is sent (Next.js
  `after()`), within the function's 300-second limit; a function stops taking
  new jobs after 150 seconds so none is cut off half-way. Up to four documents
  of a package are read at once. Whatever is left (a retry whose delay has
  passed, a job abandoned when an instance was stopped) is picked up by the
  next signed-in page view, by the processing screen's status checks, and by
  the scheduled call to `/api/jobs/run`. System status shows the mode as
  "On request".
- **The schedule.** `vercel.json` calls `/api/jobs/run` daily at 03:00 UTC,
  the most often the Hobby plan allows. On Pro, change the schedule to
  `*/5 * * * *` so retries never wait for someone to open the app. The call
  only runs with `CRON_SECRET` set.
- **Uploads.** Vercel refuses a request body over 4.5 MB. The browser sends a
  package of more than 4 MB as 4 MB parts first (`/api/uploads/<id>/parts/<n>`,
  kept in `upload_parts` by migration 0004) and the upload then names them.
  The limit of 25 MB per file is unchanged. Unclaimed parts are deleted after
  six hours.
- **Email intake.** Your email provider posts each message as one request, so
  a message over 4.5 MB is refused by Vercel before it reaches the app. Ask
  senders to split large packages, or upload them by hand.
- **Database connections.** Each instance keeps at most 3 connections and
  closes idle ones before Vercel suspends it.
- **Client address.** Use `RCM_CLIENT_IP_HEADER=x-real-ip`. Vercel sets that
  header itself and overwrites whatever a client sends.

### Plan

Vercel's Hobby plan is for non-commercial use. A pilot with a customer's real
billing belongs on Pro (paid; that is a purchasing decision for whoever owns
the Vercel team), which also allows the five-minute schedule above.

### Environment variables

Project Settings → Environment Variables, for Production. Variables take
effect on the next deployment, so redeploy after changing them.

| Variable | Value |
|---|---|
| `DATABASE_URL` | Supabase → **Connect** → **Session pooler** string, with the database password filled in |
| `DATABASE_CA_CERT` | The text of the certificate from Supabase → Database settings → **SSL configuration** → **Download certificate** (paste the whole PEM) |
| `RCM_SECRET_KEY` | `openssl rand -base64 48`. Permanent: a new key breaks everyone's second step |
| `CRON_SECRET` | `openssl rand -hex 32` |
| `APP_URL` | The production URL, `https://<project>.vercel.app` or your domain |
| `RCM_MIGRATIONS` | `external` |
| `RCM_CLIENT_IP_HEADER` | `x-real-ip` |

Optional, as anywhere else: `ANTHROPIC_API_KEY`, `RESEND_API_KEY` and
`EMAIL_FROM`, `INBOUND_EMAIL_SECRET`, `PROCORE_*`.

The first four are secrets. Paste them into the Vercel dashboard yourself;
nobody else needs to see them. You can paste several `KEY=value` lines into
the first field at once.

### Migrations and branches

The Vercel project deploys `main` to production on every push. Migrations are
applied by hand before the merge ([Schema](#schema)), so the schema is ready
when the code arrives. A deployment from another
branch needs that branch's migrations applied to the database first; otherwise
`/api/health` names the missing migration and the app refuses to serve. Do not
push `main` to production while it is behind the branch running there: it
would replace the running version with the older one.

### Check it

1. `https://<production URL>/api/health` returns `"status":"ok"`, with
   `"tls":"verified"`, `"runner":{"mode":"request",…}` and
   `"pdfReader":{"ok":true}`. Without
   `DATABASE_URL` it returns 503 and says that `DATABASE_URL` is not set.
2. Sign up, then open Settings → System status: Database *Supabase*,
   encrypted and verified; Supabase Data API *Locked*; Document processing
   *On request*.
3. Upload a package over 4 MB and watch it being read.
4. Vercel → the project → Settings → Cron Jobs lists `/api/jobs/run`.
5. The day after deploying, `/api/health` shows `"scheduler":{"lastRunAt":…}`
   within the last day. Vercel's Hobby plan keeps logs for an hour, so this is
   how you know the 03:00 UTC run happened.

## Without Docker

```bash
pnpm install --frozen-lockfile
```

```bash
pnpm build
```

```bash
DATABASE_URL=... RCM_SECRET_KEY=... APP_URL=... NODE_ENV=production pnpm start
```

Run it under a process supervisor (systemd, pm2) that restarts it if it exits.

## First start

Migrations in `drizzle/` run automatically when the process starts, unless
`RCM_MIGRATIONS=external` (Supabase, above). Then:

1. `GET /api/health` returns `{"status":"ok", ...}`. A `degraded` status lists
   its problems; `down` (HTTP 503) means the database is not answering.
2. Open `APP_URL` and choose **Set up your company**. The first person becomes
   the owner of a new organisation.
3. Settings → System status shows the database, document storage and the
   processing queue. All three should be green.
4. Settings → Profile → Signed-in devices shows the address of your own
   session. It must be your public address. If it shows the proxy's internal
   address, or nothing, set `RCM_TRUSTED_PROXY_HOPS` or `RCM_CLIENT_IP_HEADER`
   (see Configuration): the sign-in limits per address depend on it.

Anyone who can reach the sign-up page can create a separate organisation of
their own. Organisations cannot see each other's records, but if that is not
acceptable for the pilot, restrict access to the hostname at the proxy (for
example to the customer's office IP range or behind an SSO proxy).

## Onboarding the first customer (no demo workspace)

Do this with the customer's controller on a call. Use their real contracts and
real billing, one project first.

1. **Organisation.** The controller signs up and names the organisation after
   the company. Settings → Organisation.
   **Two-step verification.** The controller turns it on (Settings → Profile),
   saves the recovery codes, then requires it for everyone (Settings → Team →
   Security). Each member is asked to set it up at their first
   sign-in. A member who loses their phone and their codes is reset by an
   owner or admin (Settings → Team), or by you with `pnpm reset-password` if
   they also belong to another organisation (`docs/authentication.md`).
2. **Team.** Settings → Team → invite people by email with the right role:
   owner/admin (manage everything), controller (approve, override blocking
   findings, sign off waivers), project accountant (review, correct, submit
   for approval), project manager and viewer. If outbound email is not
   configured, the invitation link is shown to copy and send yourself.
3. **Review policy.** Settings → Review policy: rounding tolerance, which
   waivers are required, signature and notarisation, the low-confidence
   threshold, and what happens to packages emailed from unknown addresses.
4. **Project.** Projects → New project, with the state (it decides which lien
   waiver statutes apply: Texas, California and Florida forms are recognised;
   other states get completeness and consistency checks only).
5. **Subcontractors.** Subcontractors → Add, with the billing contact's email
   address. Packages emailed from that address (or its domain) are trusted;
   others are flagged or turned away according to the policy.
6. **Subcontracts.** For each one: number, original amount, retainage on work
   and on stored materials. If retainage steps down (e.g. 10% until 50%
   complete, then 5%), set it under **Edit terms** on the contract. Paste the
   schedule of values from the subcontract's spreadsheet into the schedule
   editor (header, total and subtotal rows are left out; a total that does not
   match the rows is reported). Add change orders, approved and pending. A
   subcontractor that is not on file yet can be added from the subcontract
   form itself.
   **Package first?** A package uploaded before its subcontract exists waits
   under "Needs matching". **Set up its subcontract** on that application
   fills in the subcontractor, project and contract number it states (never
   amounts or retainage, which must come from the subcontract), and matches
   the application as soon as the subcontract is created.
7. **Contracts already being billed.** Upload the most recent approved pay
   application first. It will report that there is no billing history; an
   approver chooses **Set opening balances…** on that finding, which records the
   previous certificates and retainage from it. The next application is then
   checked against that baseline.
8. **First live package.** Upload it (Pay applications → Upload package), go
   through the findings with the controller, and compare each one with what
   they would have caught by hand. Record every disagreement: these are the
   first real measure of the product's accuracy.
9. **Email intake (optional).** Set `INBOUND_EMAIL_SECRET`, create an inbound
   stream with an email provider (for example Postmark), and point its webhook
   at the address shown under Settings → Organisation, sending the secret as
   the HTTP basic-auth password (`https://zephric:<secret>@<address>`). Leave
   Postmark's spam filtering on: messages it marks as spam are turned away.
   Send one test package and check it under Settings → System status → Email
   intake. Details: [email-provider-notes.md](email-provider-notes.md).
10. **Retainage releases.** When retainage is to be paid out, an approver
    records the release on the contract before the application that bills it.

## The public website

Everyone who opens `/` sees the Zephric website, a statically rendered Next.js
page (`src/app/(marketing)/page.tsx`, components in `src/components/marketing/`)
that shares its design tokens with the app (`src/app/globals.css`). Nothing is
loaded from other sites. Being signed in never redirects anyone away from it:
the header and hero offer "Continue to dashboard" instead of "Sign in", and,
when this browser recently had an app page open, a link to resume it. Both are
read from a plain marker cookie (`zephric_signed_in`, set and cleared beside
the HttpOnly session cookie, carrying no secret) and from the last page's path
in `localStorage`; neither grants access, so a stale marker only means the
dashboard link asks the person to sign in. Old `/landing/...` links redirect
to `/`.

The product previews on the page use illustrative, internally consistent
figures and are labelled as such. Keep its claims in line with what is
verified: anything built but unverified is listed under "Built, in
verification", never as available.

### Website inquiries

The "design partner" form posts to `/api/inquiries`, which stores each inquiry
in the `inquiries` table. It belongs to no organisation and no page in the app
shows it. To read new inquiries, open the Supabase dashboard → Table Editor →
`inquiries`, or run:

```sql
select created_at, name, email, company, country, role, challenge
from inquiries order by created_at desc limit 50;
```

Nothing notifies anyone when one arrives; look at least daily during the pilot.
The form accepts six short fields and an explicit agreement to be contacted,
16 KB at most, only from this site, at most 5 per address in ten minutes and
100 in an hour from everyone. The sender's address is not stored, only a keyed
hash of it (so `RCM_SECRET_KEY` must be set). What was sent is never logged.
Delete inquiries you no longer need, and any the sender asks you to delete; the
privacy notice on the page promises that.

## Backups

Everything is in PostgreSQL, including the documents, so a database backup is
a complete backup.

### Nightly, from GitHub Actions

`.github/workflows/backup.yml` runs at 02:30 UTC and on demand (Actions →
Database backup → Run workflow). It has two jobs:

- **Restore drill** runs on every pull request that touches migrations, and
  before every backup. It needs no secrets: it fills a PostgreSQL 17 database
  through the app (all migrations and the demo workspace), dumps it, restores
  the dump into an empty database and runs `pnpm backup:check` on the copy.
  That proves the dump-and-restore procedure works with the current schema.
- **Back up production** dumps the production database through the session
  pooler, restores it into an empty PostgreSQL 17 database on the runner, runs
  the same check, encrypts the dump to your key with
  [age](https://github.com/FiloSottile/age) and keeps it as a workflow artifact
  for 30 days. The repository is public: nothing unencrypted is uploaded, and
  the log shows counts only.

`pnpm backup:check` (scripts/check-restore.ts) checks a restored database:
every migration is recorded, every organisation's audit trail verifies hash by
hash, every stored file matches its SHA-256 and size, no document or exported
file points at a missing file, and (in the drill) every table has as many rows
as the source.

Verified 2026-11-16 on this machine, not yet in GitHub Actions (below): the
drill's exact `pg_dump` and `pg_restore` commands (client 18.7, server 18.6)
on a seeded database restored all 32 tables, 1,978 rows, 210 audit events and
65 files, and the check passed; the same with the production job's flags on a
database shaped like Supabase's (its migration history, no `drizzle` schema).
With planted damage (a deleted file, an edited audit event, altered file
bytes, a missing migration record) each was reported and the check failed.

**GitHub Actions is locked on the repository owner's account** ("The job was
not started because your account is locked due to a billing issue", 2026-11-16),
so neither this workflow nor the uptime check can run until the owner clears it
under GitHub → Settings → Billing and plans. Until then, take backups by hand
([Elsewhere](#elsewhere)) and restore-check them with `pnpm backup:check`.

**Turning on the production backup (owner, about 15 minutes).** Until these are
set, the production job logs a warning and backs up nothing.

1. On your own computer, make a key pair. Keep the key file somewhere safe and
   offline, such as your password manager: without it the backups cannot be
   decrypted, and nobody else can make you a new one.

   ```bash
   age-keygen -o zephric-backup.key
   ```

   It prints the public key (`age1…`).
2. GitHub → the repository → Settings → Secrets and variables → Actions:
   - Variables → `BACKUP_AGE_RECIPIENT` = the `age1…` public key.
   - Secrets → `BACKUP_DATABASE_URL` = the Supabase **session pooler**
     connection string (Connect → Session pooler, port 5432), with the
     database password. GitHub's runners need IPv4, which the direct
     connection does not offer on the Free plan.
   - Secrets → `BACKUP_DATABASE_CA_CERT` = the contents of the Supabase CA
     certificate (Database settings → SSL configuration → Download
     certificate), so the runner verifies it is talking to Supabase. Without
     it the connection is still encrypted, and the log warns that the server
     was not verified.
3. Actions → Database backup → Run workflow. Both jobs should pass, and the run
   should list an artifact named `zephric-<date>.dump.age`.

Whoever can change Actions secrets in this repository can read the database.
Secrets are not given to workflows run from forks.

**To use a backup:** download the artifact from the run (it arrives zipped),
unzip it, then:

```bash
age --decrypt -i zephric-backup.key -o zephric.dump zephric-YYYY-MM-DDTHHMMZ.dump.age
```

Thirty days of artifacts are kept. GitHub pauses scheduled workflows in a public
repository after 60 days without a commit; if that happens, re-enable it under
Actions. A paid Supabase plan adds daily backups you can restore from the
dashboard, and point-in-time recovery as an add-on; both are a good addition to
this, not a replacement.

### Elsewhere

From any machine that can reach the database (`pg_dump` 17 or later for
Supabase):

```bash
pg_dump --format=custom --no-owner --no-privileges --file="zephric-$(date +%F).dump" "$DATABASE_URL"
```

With Docker Compose:

```bash
docker compose exec -T db pg_dump --format=custom --no-owner -U rcm rcm > "zephric-$(date +%F).dump"
```

Keep at least 30 days, off the database host. If you chose
`RCM_STORAGE=disk`, documents are under `RCM_DATA_DIR/storage` instead and
must be backed up together with the dump, taken at the same time
(`pnpm backup:check` then reports no stored files, and does not check them).

### Secrets

`RCM_SECRET_KEY` is not in the database. Store it in your secrets manager. If
it is lost, records and documents are unaffected, but stored integration
tokens (Procore) and authenticator keys cannot be decrypted: the integration
must be reconnected and everyone must set up two-step verification again.

## Restoring

1. Stop the app (on Vercel: pause the project, or point `DATABASE_URL` at the
   restored database only once step 3 passes).
2. Restore the dump into an empty database:

   ```bash
   createdb zephric_restored
   ```

   ```bash
   pg_restore --no-owner --no-privileges --clean --if-exists --exit-on-error --dbname=zephric_restored zephric.dump
   ```

3. Check it before anyone uses it:

   ```bash
   DATABASE_URL=postgres://…/zephric_restored pnpm backup:check
   ```

4. Start the app with the same `RCM_SECRET_KEY`. On a database Supabase
   manages, keep `RCM_MIGRATIONS=external` and apply any migration newer than
   the dump by hand ([Schema](#schema)); elsewhere the app applies them at
   start.
5. Work done after the dump was taken is gone. Settings → System status and
   Activity show the last recorded events; tell the team which billing
   packages to upload again.

Restoring into plain PostgreSQL 17 is what the drill tests every night.
Restoring into a new Supabase project follows the same steps but has not been
rehearsed; do it once, into a scratch project, before you need it.

## What happens when things fail

| Failure | What the app does | What you do |
|---|---|---|
| The process dies or is restarted mid-read | The job's lease lapses after 2 minutes and it is picked up again. Uploaded files and queued work are in the database. | Nothing. |
| A package cannot be read (corrupt file, AI service down) | Retried 3 times with increasing delay, then marked failed. The application shows the error, reviewers are notified, and it is listed under System status → Failed background work. | Fix the cause, then **Retry** there or on the application. |
| This deployment cannot read PDFs (for example a file the reader loads at run time was not deployed) | `/api/health` reports `degraded` with `pdfReader.ok: false`; System status shows Document reading *Not working*. Uploads are stored, but their documents are marked as not readable. The cause is logged on a line starting `[health]`. | Fix and redeploy. A package read while it was broken has to be read again: remove a file from it (the package is re-read), or void it and upload it again. |
| The database is unreachable | Requests fail with an error page; `/api/health` returns 503. Nothing is half-written: each change is one transaction. | Restore the database; the app reconnects on its own. |
| Two people change the same application at once | The changes are applied one after the other. A decision made on figures that changed in the meantime is refused and the page refreshes. | Nothing. |
| An email provider retries a delivery | The message is recognised by its Message-ID (or its content) and not processed twice. | Nothing. |
| Outbound email fails | The message is saved as failed, the sender is notified, and the application is not put on hold. | Fix the provider settings and send it again. |

## Monitoring

`GET /api/health` answers 200 with `"status":"ok"` when everything is working,
and otherwise lists the problems: the database unreachable, a stalled queue,
the queue not running, PDFs that cannot be read, or the scheduled run missed
for more than a day. It shows counts only, never an organisation's data.

- **GitHub Actions** (`.github/workflows/uptime.yml`; it cannot run while the
  account's Actions are locked for billing, see [Backups](#backups)) checks it every 15
  minutes, three attempts 20 seconds apart, and fails if it is not ok. GitHub
  emails a failed scheduled run to whoever last changed the workflow's
  schedule, so check that person's notification settings. Scheduled runs can
  start late when GitHub is busy, and pause after 60 days without a commit. Set
  the repository variable `HEALTH_URL` to check another address.
- **A dedicated uptime service** (an owner decision; several have free tiers)
  alerts faster and by text message. Point it at the same URL, every minute,
  alerting on anything but HTTP 200 and on `"status":"degraded"` lasting more
  than 10 minutes.
- **Scheduled background work.** On Vercel, the queue runs when someone uses
  the app and once a day from Vercel Cron (`/api/jobs/run`). Each scheduled run
  is recorded; `/api/health` shows `"scheduler":{"lastRunAt":…}` and reports a
  problem (`degraded`) once the last run is more than 26 hours old, which means
  the cron job or `CRON_SECRET` is wrong. Where a process polls the queue
  (`RCM_JOB_RUNNER` unset), the scheduled run is not needed and its age is not
  a problem.
- `queue.failed` greater than zero means someone should look at System status.
- Logs go to standard output. Useful prefixes: `[jobs]` (queue), `[intake]`
  (document reading), `[db]` (connections, after-commit hooks), `[health]`.
- The audit trail (Activity) records every change to financial records, with a
  chain check that detects edited or deleted events.

## Upgrading

1. Take a backup (above).
2. Deploy the new version. Migrations run at start, under a lock, and only move
   forward.
3. Check `/api/health` and System status.

To roll back the code after a migration, restore the backup taken in step 1.

## Known operational limits

- Sign-in attempts are throttled per address; there is no general rate limit
  on the API. Put the app behind a proxy or WAF with basic rate limiting.
- The queue runner lives in the web process. At pilot volumes (tens of
  packages a day) that is enough; a separate worker is the change to make if
  reading packages ever slows the web app down. On Vercel there is no runner:
  see [Deploy on Vercel](#deploy-on-vercel).
- On Vercel, one package has to be read within about five minutes (the
  function limit), and email-intake messages over 4.5 MB are refused.
- Tenant isolation is enforced in application code (every query is scoped to
  the signed-in organisation, with tests), not by database row-level security.
  The row-level security that migration 0002 turns on only keeps roles other
  than the app's out entirely; the app's own role is not subject to it.
