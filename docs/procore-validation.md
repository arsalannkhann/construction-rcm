# Validating the Procore integration against a sandbox

The Procore integration has never been run against a Procore account. It is
built from Procore's public documentation ([procore-api-notes.md](procore-api-notes.md))
and tested against a local emulator built from those same notes. That shows the
code matches the notes. It does not show the notes match Procore. This
procedure is how to find out, with a Procore developer sandbox, before any
customer connects their production Procore company.

Run it on a deployment you control, never on a customer's organisation. It
creates draft invoices in the sandbox company.

Record the result of every step: the date, the commit (`git rev-parse HEAD`),
pass or fail, and what Procore showed. Then update the documents listed in
[After the run](#after-the-run).

## Before you start: one known defect

**A push whose answer is lost can create a second invoice.** If Procore does not
answer the request that creates the invoice (a timeout, a dropped connection or
a 5xx), the app records the push as failed, says "Nothing was created in
Procore", and lets someone send it again. Procore may in fact have created the
invoice, and sending again would create a second one. The duplicate check
described in the brief for this integration (list the subcontract's invoices
and look for one with the application number before creating) is not
implemented. Until it is:

- after any failed push whose error says Procore could not be reached or
  returned a server error, look at the subcontract's invoices in Procore before
  sending again;
- step 12 below measures whether Procore itself refuses a second invoice with
  the same number, which decides how serious this is.

## What you need

- An account on the Procore Developer Portal (developers.procore.com). Creating
  an app there gives you a **Developer Sandbox** company with a starter project,
  "1234 – Sandbox Test Project". The sandbox cannot be refreshed or deleted.
- A running instance of this app whose `APP_URL` is the address you open it at,
  with an organisation you own. A local instance (`pnpm dev`, http://localhost:3000)
  is enough if Procore accepts that redirect URI (step 2).
- About two hours, including the wait for a token to expire (step 13).

## 1. Create the Procore app

1. Developer Portal → **My Apps** → **Create a New App**.
2. Add a version with a **Data Connector** component. Sandbox OAuth credentials
   exist only once a version has one.
3. Open the app's **Credentials** tab and note the **sandbox** Client ID and
   Client Secret. These work only against the Developer Sandbox; production
   uses a different pair, issued only after a version is promoted.

## 2. Register the redirect URI

The redirect URI is `APP_URL` followed by `/api/integrations/procore/callback`.
Settings → Integrations in the app shows it with a copy button. Register it on
the app exactly as shown, including the scheme, port and path, with no trailing
slash.

**Settle this:** whether Procore accepts `http://localhost:3000/api/integrations/procore/callback`
(plain http, with a port and a path). Procore's guides register `http://localhost`
by default and ask for `https://` in production; neither says whether this form
is accepted. If it is refused, run the app at an `https://` address you control
and set `APP_URL` to it.

## 3. Install the app in the sandbox company

In the sandbox company: **Company Tools → Admin → App Management → Install App
→ Install Custom App**, using the app's Sandbox Installation Key. Without this,
API calls answer 403 ("App is not connected to this company").

## 4. Prepare the sandbox data

In "1234 – Sandbox Test Project", as a user with **Admin** on the project-level
**Commitments** tool and at least **Read-only** on the **Directory**:

1. A subcontract (Commitments → Create → Subcontract) with:
   - status **Approved**, accounting method **amount-based**;
   - a **Contract Company** and an **Invoice Contact** from that company;
   - a retainage percentage, for example 10%;
   - three or more schedule-of-values lines, with amounts that include cents.
2. Two commitment change orders on it: one **Approved** and one **Pending**.
3. A second subcontract in **Draft** status, and, if you can, a unit-price one.
   Both should be left out of the import.
4. A **billing period** whose dates cover the period-to date you will bill in
   step 9. Only invoice administrators can create billing periods.

## 5. Configure the app

Set these on the app instance and restart it (redeploy, on Vercel):

| Variable | Value |
|---|---|
| `PROCORE_CLIENT_ID` | The sandbox Client ID |
| `PROCORE_CLIENT_SECRET` | The sandbox Client Secret |
| `PROCORE_ENV` | `sandbox` (the default; it means the Developer Sandbox) |

**Expect:** Settings → Integrations shows Procore as *Not connected*, with the
redirect URI from step 2 and a **Connect Procore** button for owners and admins.

## 6. Connect

1. As an owner or admin, Settings → Integrations → **Connect Procore**.
2. Sign in at `login-sandbox.procore.com` as the user from step 4 and approve
   access.

**Expect:** you are sent back to Settings → Integrations. If the user sees one
company, it is chosen and the page shows *Connected*, with the company, the
environment (sandbox) and who connected. If the user sees several, a company
picker appears; choose the sandbox company.

**Check in the database:** the organisation's `integrations` row for `procore`
holds the tokens encrypted (no readable token in the row), and `last_error` is
empty.

**If it fails:** the page states the reason. "Procore did not accept the
authorization … the redirect URI registered on the Procore app does not match"
means step 2 is wrong.

## 7. Import

Settings → Integrations → **Import from Procore** → choose the sandbox project.

**Expect:**

- a subcontractor for the subcontract's vendor;
- the Approved subcontract, with its number, title and amount to the cent;
- its retainage percentage on completed work and on stored materials (0% with a
  note if Procore has none);
- one schedule line per Procore line item, amounts to the cent;
- both change orders, the Approved one as approved and the Pending one as
  pending (any Procore status other than approved, rejected or void comes in as
  pending);
- the Draft subcontract, and the unit-price one, listed as skipped, each with
  its reason.

Then import the same project again. **Expect:** "Everything in Procore was
already here, so nothing was created or changed."

In Procore, change the subcontract's title, add a schedule line and change a
change order's amount; if Procore has no retainage on the subcontract, set one
here by hand. Import again. **Expect:** the new title, the new line and the new
amount are picked up, and the retainage set here is kept.

**Settle this:** whether a user without Directory read permission sees vendor
`email_address` and `is_active` (the "minimal" vendor view). The import treats
both as optional.

## 8. Check the rate-limit and paging behaviour

Look at the server log for the import. **Expect:** no repeated page and no
`429`. If the sandbox project has more than 100 change orders or 300 projects,
the import still brings in every one (paging).

## 9. Bill against the imported subcontract

1. Upload a pay application for the imported subcontract: a G702 and G703
   whose contractor, contract number and line items match it, with a
   period-to date inside the billing period from step 4. Bill work on the
   original schedule lines only, not on a change-order line (see step 11).
2. If the package is not matched automatically, match it to the imported
   subcontract.
3. Resolve every finding and approve it.

## 10. Push

On the approved application: **Transfer** → **Procore, as a draft subcontractor
invoice**.

**Expect, in the app:** "Created draft invoice <id> in Procore". Transfers lists
a completed Procore row carrying that id, the application's transfer status is
*synced*, and Activity has the push with the line count, work this period and
materials stored.

**Expect, in Procore:** the subcontract's Invoices tab shows a **Draft** invoice
whose number is the application number, in the billing period from step 4. On
each line, work completed this period and materials presently stored equal the
approved record (the PDF approval record from the same Transfer menu lists
them). Retainage is Procore's own calculation; the app sends none.

Open the Transfer menu again. **Expect:** the Procore item is disabled and says
the application was already sent, with the invoice id.

## 11. Pushes the app should refuse

Each of these should leave nothing new in Procore, and the menu item or the
Transfers row should say why:

1. An approved application for a subcontract created by hand here: *not
   imported from Procore … use file export*.
2. An application that bills a change-order line this period: *Pushing
   change-order billing is not supported yet*.
3. An application whose period-to date no billing period covers. Push it.
   **Expect:** a failed Transfers row, "No billing period in Procore covers …",
   and an invoice count in Procore that has not changed.

## 12. Settle what the documentation does not say

Record each answer; each one changes a "could not verify" row in the notes.

1. **Duplicate invoice numbers.** In Procore, create a draft invoice by hand on
   the subcontract with the number of an approved application that has not
   been pushed. Then push that application. Does Procore refuse it, or create
   a second invoice with the same number? (This decides how serious the defect
   at the top of this page is.) Delete the extra invoice afterwards.
2. **Closed billing periods.** Close the billing period from step 4 and push
   another application dated inside it. Is it accepted?
3. **Missing company header.** The HTTP status Procore returns for "Missing
   Procore-Company-Id header!" (the emulator uses 403). Send any API call
   without the header, with curl and a sandbox token.
4. **Token request encoding.** Whether `/oauth/token` also accepts
   `application/x-www-form-urlencoded` (the app sends multipart form-data, as
   Procore's guides do).

## 13. Token renewal

Access tokens last 90 minutes. Wait at least that long after step 6 (or, on a
test instance only, set the stored expiry in the past), then run an import.

**Expect:** the import works without reconnecting, and the `integrations` row
holds a new token pair. Run two imports from two browser tabs at the same
moment. **Expect:** both work, and Procore receives one renewal (refresh tokens
are single-use; a second renewal with the same token would break the
connection).

## 14. Disconnect

Settings → Integrations → **Disconnect**.

**Expect:** the stored authorization is revoked at Procore and deleted here.
Imported projects, subcontracts and change orders stay, still linked to their
Procore records. The draft invoice stays in Procore. CSV, JSON and PDF exports
keep working.

**Settle this:** whether revoking an access token that has already expired also
revokes its refresh token. (The app renews an expired token first and then
revokes the fresh one, so this only matters if that changes.)

## After the run

- `docs/procore-api-notes.md`: change each row this run settled from "Could not
  verify" to what Procore did, with the date and "sandbox".
- `README.md`, "What is and is not verified": move Procore from the not-verified
  table to the real-infrastructure table, saying exactly which steps passed.
- Settings → Integrations says the integration "has been tested against an
  emulator of Procore's API and not yet against a live Procore account". Change
  that sentence (`src/app/(app)/settings/integrations/page.tsx`) only after this
  run passes.
- Fix anything the emulator got wrong in `tests/procore.test.ts` first, so the
  emulator models what Procore did.

Production credentials are a separate step: promote a version of the app, set
`PROCORE_ENV=production` with the production pair, and repeat steps 6, 7 and 14
against the customer's company with their Procore administrator. Do not push
to a production company until the duplicate-invoice defect is fixed.
