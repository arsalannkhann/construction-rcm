# Procore API notes

The reference used to build `src/server/integrations/procore`. Every fact below
was re-checked on **2026-11-15** against Procore's public documentation. Each
fact says what it rests on:

- **Verified** — read on the official page linked in that row, on 2026-11-15.
- **Could not verify** — no official page says it. The code treats it as an
  assumption, and `docs/procore-validation.md` says how to settle it in a sandbox.

Nothing here has been exercised against a live Procore account from this
codebase. No Procore credentials exist in this environment. All automated tests
run against the local emulator in `tests/procore.test.ts`. That emulator is
built from these notes, so it shows the code matches the notes. It does not show
the notes match Procore.

How the pages were read: developers.procore.com renders its guides and
reference in the browser. The text was fetched without authentication from
`https://developers.procore.com/documentation/content/<page>` (guides) and
`https://developers.procore.com/api/v1/resource_groups/resource/<resource>?version=rest_vX.Y`
(the OpenAPI reference behind each `https://developers.procore.com/reference/rest/<resource>?version=X.Y`
page). Those reference pages are the URLs cited below.

## Sources

| Key | Page |
|---|---|
| ENDPOINTS | https://developers.procore.com/documentation/oauth-endpoints |
| AUTHFLOW | https://developers.procore.com/documentation/oauth-auth-grant-flow |
| AUTHREF | https://developers.procore.com/reference/rest/authentication?version=1.0 |
| FAQ | https://developers.procore.com/documentation/faq |
| ERRORS | https://developers.procore.com/documentation/error-reference |
| SECURITY | https://developers.procore.com/documentation/api-security-overview |
| HEALTH | https://developers.procore.com/documentation/integration-health |
| SANDBOXES | https://developers.procore.com/documentation/development-environments |
| KEYS | https://developers.procore.com/documentation/oauth-keys |
| TROUBLE | https://developers.procore.com/documentation/troubleshooting |
| MPR | https://developers.procore.com/documentation/tutorial-mpz |
| OVERVIEW | https://developers.procore.com/documentation/rest-api-overview |
| LIFECYCLE | https://developers.procore.com/documentation/rest-api-lifecycle |
| PAGING | https://developers.procore.com/documentation/pagination |
| RATE | https://developers.procore.com/documentation/rate-limiting |
| RATEHANDLING | https://developers.procore.com/documentation/rate-limit-handling |
| CREATEAPP | https://developers.procore.com/documentation/building-apps-create-new |
| CONNECTOR | https://developers.procore.com/documentation/building-data-connection-apps |
| INSTALL | https://developers.procore.com/documentation/install-version-sandbox |
| REQTUT | https://developers.procore.com/documentation/tutorial-requisitions |
| FINTOOLS | https://developers.procore.com/documentation/tutorial-financial-tools |
| R-COMPANIES | https://developers.procore.com/reference/rest/companies?version=1.0 |
| R-ME | https://developers.procore.com/reference/rest/me?version=1.0 |
| R-PROJECTS11 | https://developers.procore.com/reference/rest/projects?version=1.1 |
| R-PROJECTS10 | https://developers.procore.com/reference/rest/projects?version=1.0 |
| R-VENDORS | https://developers.procore.com/reference/rest/project-vendors?version=1.1 |
| R-WOC | https://developers.procore.com/reference/rest/work-order-contracts?version=1.0 |
| R-WOCLINES | https://developers.procore.com/reference/rest/work-order-contract-line-items?version=1.0 |
| R-CCO | https://developers.procore.com/reference/rest/commitment-change-orders?version=1.0 |
| R-PERIODS | https://developers.procore.com/reference/rest/billing-periods?version=1.0 |
| R-REQ | https://developers.procore.com/reference/rest/requisitions-subcontractor-invoices?version=1.1 |
| R-COMMITMENTS | https://developers.procore.com/reference/rest/commitments?version=1.0 |
| R-CC2 | https://developers.procore.com/reference/rest/commitment-contracts?version=2.0 |
| S-ADMIN | https://support.procore.com/faq/what-is-an-invoice-administrator |
| S-ONBEHALF | https://support.procore.com/products/online/user-guide/project-level/invoicing/tutorials/create-an-invoice-on-behalf-of-an-invoice-contact |

All rows marked Verified were read on 2026-11-15.

## Environments and base URLs

| Environment | Login (OAuth) base | API base | OAuth credentials | Status |
|---|---|---|---|---|
| Production | `https://login.procore.com` | `https://api.procore.com` | Production | Verified (SANDBOXES, ENDPOINTS) |
| Developer Sandbox | `https://login-sandbox.procore.com` | `https://sandbox.procore.com` | Sandbox pair from the app's Credentials tab | Verified (SANDBOXES) |
| Monthly Sandbox | `https://login-sandbox-monthly.procore.com` | `https://api-monthly.procore.com` | **Production** pair | Verified (SANDBOXES) |
| On-Demand Sandbox | `https://login.procore.com` | `https://api.procore.com` | **Production** pair; each sandbox is its own `company_id` | Verified (SANDBOXES) |

- Production and sandbox tokens are not interchangeable, and each environment
  has its own Client ID and Client Secret. Verified (ENDPOINTS, SANDBOXES).
- A Developer Sandbox is created automatically when an app is registered, with a
  starter project "1234 – Sandbox Test Project". It cannot be refreshed or
  deleted. Verified (SANDBOXES).
- Sandbox OAuth credentials exist only once a version carries a Data Connector
  component. Production credentials exist only after such a version is promoted.
  Verified (KEYS, CONNECTOR).
- The app must be installed in the company: Company Tools → Admin → App
  Management → Install App → Install Custom App, using the Sandbox Installation
  Key. Verified (INSTALL). A 403 can mean "the app is not installed in the target
  company". Verified (ERRORS).
- This codebase knows two values of `PROCORE_ENV`: `sandbox`, which means the
  Developer Sandbox, and `production`. The Monthly Sandbox works by setting
  `PROCORE_ENV=production` with `PROCORE_LOGIN_BASE` / `PROCORE_API_BASE`
  overrides (see `src/server/config.ts`). The On-Demand Sandbox works like
  production. Code fact, not a Procore fact.

## OAuth 2.0 (authorization code grant)

| Fact | Status |
|---|---|
| Authorize: `GET {login}/oauth/authorize` with `response_type=code`, `client_id`, `redirect_uri`, `state` | Verified (ENDPOINTS, AUTHFLOW) |
| The code works once and expires in 10 minutes | Verified (ENDPOINTS, AUTHFLOW) |
| `state` is echoed back on the redirect, and is how the client prevents CSRF | Verified (ENDPOINTS, AUTHFLOW) |
| Token: `POST {login}/oauth/token` with `grant_type=authorization_code`, `client_id`, `client_secret`, `code`, `redirect_uri` | Verified (ENDPOINTS, AUTHFLOW) |
| Refresh: `POST {login}/oauth/token` with `grant_type=refresh_token`, `client_id`, `client_secret`, `refresh_token`, `redirect_uri` | Verified (AUTHFLOW) |
| Request encoding: the guides send **form-data** (`curl -F`). The OpenAPI reference lists `application/json`. Neither mentions `application/x-www-form-urlencoded` | Verified (ENDPOINTS, AUTHFLOW, AUTHREF). The code now sends multipart form-data, as the guides do. Whether the other encodings are also accepted: could not verify |
| Response: `access_token`, `token_type`, `expires_in`, `refresh_token`, `created_at` (and `scope` in the reference) | Verified (AUTHFLOW, AUTHREF) |
| Access tokens last 90 minutes (`expires_in` 5400). The reference's example is 5378, so the code uses `expires_in` from each response | Verified (FAQ, AUTHFLOW, ERRORS, AUTHREF) |
| A refresh token lasts until it is used | Verified (FAQ, SECURITY) |
| **Refresh tokens rotate and are single-use.** Each refresh returns a new pair. *Any* refresh call, successful or not, permanently invalidates the presented refresh token, **including one whose response was lost to a network error** | Verified (FAQ, ERRORS, AUTHFLOW, HEALTH) |
| Persist the new refresh token before using the new access token | Verified (HEALTH) |
| Revoke: `POST {login}/oauth/revoke` with `token` (the **access** token), `client_id`, `client_secret`, as form-data. Revoking the access token also revokes its refresh token. The answer is 200 even for an invalid token | Verified (ENDPOINTS, FAQ) |
| Token info: `GET {login}/oauth/token/info` with the bearer token returns `resource_owner_id`, `expires_in`, `application.uid`, `created_at` | Verified (ENDPOINTS, AUTHREF) |
| Redirect URI must match a registered one exactly, including trailing slashes. Dynamic URIs are not supported. `http://localhost` is registered by default. Guides ask for `https://` in production | Verified (KEYS, TROUBLE, ENDPOINTS) |
| Whether Procore accepts `http://localhost:3000/api/integrations/procore/callback` (a port and a path on plain http) as a registered redirect URI | Could not verify. See validation step 2 |
| Whether revoking an access token that has already **expired** also revokes its refresh token | Could not verify. The code renews first if the stored access token has expired, then revokes the fresh one |

## Request headers and ids

| Fact | Status |
|---|---|
| `Authorization: Bearer <access token>` on every API call | Verified (ENDPOINTS, ERRORS) |
| `Procore-Company-Id: <company id>` on every API call, even when `company_id` is also a path or query parameter | Verified (MPR) |
| Exempt from that header: `GET /rest/v1.0/me` and `GET /rest/v1.0/companies` (unless `/me` is given a `company_id` or `project_id`) | Verified (MPR, R-ME) |
| Without the header Procore answers "Missing Procore-Company-Id header!" | Verified (MPR). The HTTP status of that answer: could not verify (the emulator uses 403) |
| Ids may exceed 32 bits. Store them as 64-bit or larger | Verified (MPR) |
| Whether any id exceeds 2^53, the largest integer a JavaScript number holds exactly | Could not verify. The client parses responses so that integers beyond 2^53 arrive as exact strings, and the code carries every id as a string |

## Versioning and lifecycle

| Fact | Status |
|---|---|
| Resources are versioned independently: `/rest/v{api}.{resource}` (e.g. `/rest/v1.1/projects`) | Verified (OVERVIEW) |
| Lifecycle stages Pilot → Beta → GA → Deprecated → Sunset. Minimum notice before sunset: Beta 6 months, GA 1 year. New apps are denied access to deprecated endpoints | Verified (LIFECYCLE) |
| `/rest/v1.0/commitments` and `/rest/v1.0/commitments/{id}` are deprecated (since 2021-04-20) | Verified (R-COMMITMENTS) |
| v2.0 `commitment_contracts` is **beta** | Verified (R-CC2) |
| The work-order-contract line-items reference recommends the v2.0 commitment-contract line items "for new integrations" | Verified (R-WOCLINES). That endpoint sits on the beta v2.0 resource, so v1.0 (GA) stays in use |
| Every endpoint used below is GA and not deprecated | Verified (each reference row below, `stage: ga`, `deprecated` unset) |

## Pagination

| Fact | Status |
|---|---|
| `page` (1-based) and `per_page` query parameters | Verified (PAGING) |
| Response headers `Link` (`first`, `prev`, `next`, `last`), `Total`, `Per-Page`. On the last page `next` is omitted | Verified (PAGING) |
| Keep `per_page` at or below 2,000. Not every endpoint paginates; per-endpoint limits are in the reference | Verified (PAGING) |
| The example `Link` URLs drop the request's other query parameters (`project_id`) | Verified that the example shows this (PAGING). Whether real responses do: could not verify. So the client never follows `Link` URLs. It builds each page URL itself, and uses `Link`'s `next`, then `Total`, then a short page only to decide whether another page exists |
| Per-endpoint limits: projects v1.1 default 100, max 300. Requisitions v1.1 default 30, max 100. Commitment change orders default 100 | Verified (R-PROJECTS11, R-REQ, R-CCO) |

## Rate limits

| Fact | Status |
|---|---|
| Two limits per app: a 10-second spike window and a 60-minute hourly window, counted per user (per company for service accounts) | Verified (RATE) |
| Every request counts, including 400/403/404 failures | Verified (RATE) |
| Headers `X-Rate-Limit-Limit`, `X-Rate-Limit-Remaining`, `X-Rate-Limit-Reset` (Unix **seconds**). One set per response, usually the spike limit, the hourly one only once it is spent | Verified (RATE) |
| Exceeding either limit: **429**. **Procore does not send `Retry-After` on a 429**. Wait until `X-Rate-Limit-Reset`, with backoff and jitter | Verified (ERRORS, RATE, RATEHANDLING) |
| A reset 10 s away or less is the spike window; anything further is the hourly one. Measure from the response's `Date` header, not the local clock. Procore's sample assumes the spike window when a 429 has no headers, and adds up to 1 s of random delay | Verified (RATEHANDLING) |
| Heavy load: **503** with `Retry-After` in seconds | Verified (RATE) |
| 500 and 502 are transient: retry after a short delay. 503: retry with exponential backoff | Verified (ERRORS) |
| No numeric limit is published, and limits can change at any time | Verified (RATE). "3,600 per hour" appears nowhere official; it is not used |

## Error statuses

| Status | Meaning | Status |
|---|---|---|
| 400 | malformed or missing fields | Verified (ERRORS) |
| 401 | missing, expired or invalid access token ("The access token is invalid") | Verified (ERRORS) |
| 403 | the user lacks permission, the app is not installed in the company, the tool is disabled, or "App is not connected to this company" | Verified (ERRORS) |
| 404 | does not exist, or the user cannot see it | Verified (ERRORS) |
| 409 | conflicts, such as a duplicate `origin_id` | Verified (ERRORS) |
| 422 | business-rule failure (status transitions, missing dependent records) | Verified (ERRORS) |
| Body | 4xx bodies often carry `message` or `errors` | Verified (ERRORS) |
| Token endpoint | Error names (`invalid_grant`, `invalid_client`) and their HTTP status (400/401) | Could not verify. The code treats any 400 or 401 from `/oauth/token` as "this grant is no longer good" |

## Endpoints used

All rows: verified against the cited reference page on 2026-11-15, unless the
row says otherwise.

| Purpose | Request | What we read | Source |
|---|---|---|---|
| Current user (smoke check only) | `GET /rest/v1.0/me` (no company header) | `id`, `login`, `name` | R-ME |
| Companies | `GET /rest/v1.0/companies` (no company header) | `id`, `name`, `is_active` | R-COMPANIES |
| List projects | `GET /rest/v1.1/projects?company_id=&filters[by_status]=All&per_page=300` | `id`, `name`, `project_number`, `active` | R-PROJECTS11 (v1.1 returns active projects by default; `filters[by_status]` takes `All`/`Active`/`Inactive`) |
| One project | `GET /rest/v1.0/projects/{id}?company_id=` | `id`, `name`, `project_number`, `active` | R-PROJECTS10 |
| Project vendors | `GET /rest/v1.1/projects/{project_id}/vendors` | `id`, `name`, `email_address`, `is_active` | R-VENDORS. Users without Directory read permission get the `minimal` view; whether that view has `email_address`/`is_active`: could not verify (the import treats both as optional) |
| Subcontracts | `GET /rest/v1.0/work_order_contracts?project_id=` | `id`, `number`, `title`, `status` | R-WOC. `project_id` is required |
| Subcontract | `GET /rest/v1.0/work_order_contracts/{id}?project_id=` | `status` (`Draft`, `Out For Bid`, `Out For Signature`, `Approved`, `Complete`, `Terminated`, `Void`), `accounting_method` (`amount`/`unit`), `retainage_percent` (decimal string), `grand_total` (decimal string), `number`, `title`, `vendor` = **`{ id, company }`** | R-WOC |
| Schedule of values | `GET /rest/v1.0/work_order_contracts/{id}/line_items?project_id=` | `id`, `amount` (decimal string), `description`, `position` (1-based) | R-WOCLINES |
| Change orders | `GET /rest/v1.0/projects/{project_id}/commitment_change_orders?filters[contract_id]=` | `id`, `contract_id`, `number`, `title`, `grand_total` (decimal string), `status` ∈ `draft`, `pricing`, `not_pricing`, `pending`, `revised`, `proceeding`, `not_proceeding`, `pending_billable`, `no_charge`, `approved`, `rejected`, `void` | R-CCO |
| Billing periods | `GET /rest/v1.0/projects/{project_id}/billing_periods` | `id`, `start_date`, `end_date`, `due_date`, `status` (`open`/`closed`; only one open per project) | R-PERIODS |
| Invoices (list) | `GET /rest/v1.1/requisitions?project_id=&filters[commitment_id]=&per_page=100` | `id`, `invoice_number`, `commitment_id`, `period_id`, `status` | R-REQ. `project_id` is required; `per_page` max 100 |
| Invoice (create) | `POST /rest/v1.1/requisitions` → 201 | `id` | R-REQ |

### Creating a subcontractor invoice ("requisition")

The body as sent (verified field by field against R-REQ):

```json
{
  "project_id": 1,
  "commitment_id": 2,
  "requisition": {
    "period_id": 3,
    "requisition_start": "2026-11-01",
    "requisition_end": "2026-11-30",
    "billing_date": "2026-11-30",
    "invoice_number": "5",
    "status": "draft",
    "final": false,
    "items": [
      { "item_type": "contract_item", "line_item_id": 10,
        "work_completed_this_period": "1000.00", "materials_presently_stored": "0.00" }
    ]
  }
}
```

| Fact | Status |
|---|---|
| `project_id` and `commitment_id` are required integers. `requisition` fields are optional in the schema | Verified (R-REQ) |
| `item_type` (required on each item): `contract_item`, `contract_detail_item`, `change_order_item`, `change_order_detail_item` | Verified (R-REQ) |
| Amounts are strings. `materials_presently_stored` is used only when neither `new_materials` nor `stored_materials` is sent; a 2025 fix made it stop being ignored | Verified (R-REQ, including its changelog) |
| `status` values: `draft`, `under_review`, `revise_and_resubmit`, `approved`, `approved_as_noted`, `pending_owner_approval`. "Admin can set any status, standard and billing recipient can set to under_review (submit) or draft (save)" | Verified (R-REQ) |
| `invoice_number` is a string | Verified (R-REQ; REQTUT shows it returned as `"123"`) |
| Commitments are invoiced `progressive` or `simplified`. On `simplified`, a new invoice keeps only the lines billed in the request, and a save that fails the cross-invoice totals returns 400 with per-line `errors.line_items` | Verified (R-REQ) |
| Several invoices can exist for one commitment in one billing period | Verified (S-ONBEHALF) |
| Whether Procore refuses a second invoice with the same `invoice_number` on one commitment | Could not verify. The push looks for an existing invoice with our number before creating one (see below) |
| Whether Procore accepts an invoice in a **closed** billing period | Could not verify |
| Update and delete work only on the latest, open invoice | Verified (REQTUT) |
| Retainage fields (`work_completed_retainage_retained_this_period` and others) are for Admin users | Verified (R-REQ) |

Preconditions in the Procore UI (verified against S-ONBEHALF; whether the API
enforces each one: could not verify):

- the commitment has a Contract Company and an Invoice Contact from that company;
- its status is Approved or Complete;
- all Subcontractor SOV lines are Approved, where the SSOV tab is enabled;
- a billing period exists (only invoice administrators can create them).

Permissions: an invoice administrator is a user with **Admin on the
project-level Commitments tool**. That user can manage billing periods,
commitments and subcontractor invoices (S-ADMIN). The projects list returns
every project only to full company admins, and otherwise only projects the user
has been added to (R-PROJECTS11). Line items can be read with "lowered
permissions" by invoice contacts and contract accessors through a view
parameter (R-WOCLINES changelog). The full matrix of which permission each
endpoint needs is not on the reference pages: could not verify. The validation
procedure asks for a user with Admin on Commitments and Read-only (or better) on
the Directory.

## Things the API will not let us do

- **Never set `origin_id` on an invoice.** Once set, the whole invoice is
  immutable ("The invoice is not editable because it has been synced with ERP"),
  and only one integration may use `origin_id` per object. Verified (FINTOOLS).
  That is also why `origin_id` cannot be the idempotency key for the push.
- Retainage amounts need Admin on Commitments. Verified (R-REQ).
- Whether approval workflow steps or Procore Pay actions are available through the
  API was not investigated.

## What that means for this product

- Import reads one project, its vendors, its Approved/Complete amount-based
  subcontracts, their schedules of values and their change orders. It writes
  nothing to Procore.
- The push sends the **approved line items** (work this period, materials
  presently stored) as a `draft` invoice. Procore computes its own totals and
  retainage. We send no retainage amounts and no status other than `draft`.
- **No duplicate invoices.** Before creating, the push lists the commitment's
  invoices (`filters[commitment_id]`) and looks for one whose `invoice_number`
  equals the application number:
  - Found, after an earlier attempt from this app whose outcome was unknown: that
    invoice is adopted and recorded.
  - Found with no such earlier attempt: nothing is created, and the user is told
    which invoice already exists.
  - A create that times out, fails at the network, or gets a 5xx is never
    resent automatically. It is checked by listing instead.
- A push is possible only for contracts imported from Procore, because only those
  carry Procore line ids. Billing on change-order lines is not pushed yet.
