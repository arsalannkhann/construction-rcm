# Operating Construction RCM

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
| `DATABASE_URL` | Yes | `postgres://user:pass@host:5432/db`. Add `?sslmode=require` for a managed database that needs TLS. |
| `RCM_SECRET_KEY` | Yes | 32+ random bytes (e.g. `openssl rand -base64 48`). Encrypts stored integration tokens. The app refuses to store credentials in production without it. |
| `APP_URL` | Yes | The public `https://` URL. Used in invitation and password links and OAuth redirects. Session cookies are marked `Secure` only when this starts with `https://`. |
| `DATABASE_POOL_MAX` | No | Connections per app process (default 10). |
| `RCM_STORAGE` | No | `database` (default with `DATABASE_URL`) or `disk`. Leave it unset. |
| `ANTHROPIC_API_KEY`, `RCM_EXTRACTION_MODEL` | No | AI document reading. Without it, only PDFs with a text layer are read; scans are keyed by hand. |
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

Migrations in `drizzle/` run automatically when the process starts. Then:

1. `GET /api/health` returns `{"status":"ok", ...}`. A `degraded` status lists
   its problems; `down` (HTTP 503) means the database is not answering.
2. Open `APP_URL` and choose **Set up your company**. The first person becomes
   the owner of a new organisation.
3. Settings → System status shows the database, document storage and the
   processing queue. All three should be green.

Anyone who can reach the sign-up page can create a separate organisation of
their own. Organisations cannot see each other's records, but if that is not
acceptable for the pilot, restrict access to the hostname at the proxy (for
example to the customer's office IP range or behind an SSO proxy).

## Onboarding the first customer (no demo workspace)

Do this with the customer's controller on a call. Use their real contracts and
real billing, one project first.

1. **Organisation.** The controller signs up and names the organisation after
   the company. Settings → Organisation.
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
   editor. Add change orders, approved and pending.
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
   the HTTP basic-auth password. Send one test package and check it under
   Settings → System status → Email intake.
10. **Retainage releases.** When retainage is to be paid out, an approver
    records the release on the contract before the application that bills it.

## Backups

Everything is in PostgreSQL, including the documents, so a database backup is
a complete backup.

Nightly, from a machine that can reach the database:

```bash
pg_dump --format=custom --no-owner --file="rcm-$(date +%F).dump" "$DATABASE_URL"
```

With Docker Compose:

```bash
docker compose exec -T db pg_dump --format=custom --no-owner -U rcm rcm > "rcm-$(date +%F).dump"
```

Keep at least 30 days, off the database host. A managed database's automatic
snapshots and point-in-time recovery are a good addition, not a replacement for
a dump you have restored at least once.

**Test a restore before the pilot starts** (into a scratch database):

```bash
createdb rcm_restore_test
```

```bash
pg_restore --no-owner --dbname=rcm_restore_test rcm-YYYY-MM-DD.dump
```

Start an app instance against `rcm_restore_test`, sign in, open an approved
application and download its approval PDF, then go to Activity and run the
audit-chain check. All three must work.

If you chose `RCM_STORAGE=disk`, documents are under `RCM_DATA_DIR/storage`
instead and must be backed up together with the database dump, taken at the
same time.

### Secrets

`RCM_SECRET_KEY` is not in the database. Store it in your secrets manager. If
it is lost, records and documents are unaffected, but stored integration
tokens (Procore) cannot be decrypted and the integration must be reconnected.

## Restoring

1. Stop the app.
2. Restore the dump into an empty database (`pg_restore --clean --if-exists` to
   replace an existing one).
3. Start the app with the same `RCM_SECRET_KEY`. Migrations newer than the dump
   are applied automatically.
4. Work done after the dump was taken is gone. Settings → System status and
   Activity show the last recorded events; tell the team which billing
   packages to upload again.

## What happens when things fail

| Failure | What the app does | What you do |
|---|---|---|
| The process dies or is restarted mid-read | The job's lease lapses after 2 minutes and it is picked up again. Uploaded files and queued work are in the database. | Nothing. |
| A package cannot be read (corrupt file, AI service down) | Retried 3 times with increasing delay, then marked failed. The application shows the error, reviewers are notified, and it is listed under System status → Failed background work. | Fix the cause, then **Retry** there or on the application. |
| The database is unreachable | Requests fail with an error page; `/api/health` returns 503. Nothing is half-written: each change is one transaction. | Restore the database; the app reconnects on its own. |
| Two people change the same application at once | The changes are applied one after the other. A decision made on figures that changed in the meantime is refused and the page refreshes. | Nothing. |
| An email provider retries a delivery | The message is recognised by its Message-ID (or its content) and not processed twice. | Nothing. |
| Outbound email fails | The message is saved as failed, the sender is notified, and the application is not put on hold. | Fix the provider settings and send it again. |

## Monitoring

- Poll `GET /api/health` every minute. Alert on HTTP 503, and on
  `"status":"degraded"` lasting more than 10 minutes (the problems are listed
  in the response: a stalled queue, or the queue not running).
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
  reading packages ever slows the web app down.
- Tenant isolation is enforced in application code (every query is scoped to
  the signed-in organisation, with tests), not by database row-level security.
