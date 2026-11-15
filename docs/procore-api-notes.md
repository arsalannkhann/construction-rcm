# Procore API notes

Reference used to build `src/server/integrations/procore`. Researched from
developers.procore.com and support.procore.com on 2026-11-15. Items marked
**unverified** were not confirmed on an official page. Nothing here has been
exercised against a live Procore account from this codebase.

## OAuth 2.0 (authorization code)

| Environment | Login host | API host |
|---|---|---|
| Production | `login.procore.com` | `api.procore.com` |
| Developer sandbox | `login-sandbox.procore.com` | `sandbox.procore.com` |
| Monthly sandbox | `login-sandbox-monthly.procore.com` | `api-monthly.procore.com` |

- Authorize: `GET {login}/oauth/authorize?client_id=&response_type=code&redirect_uri=&state=`
  The code is single-use and expires in 10 minutes.
- Token: `POST {login}/oauth/token`, form fields `grant_type=authorization_code`,
  `client_id`, `client_secret`, `code`, `redirect_uri`. Response: `access_token`,
  `token_type`, `expires_in` (5400 s), `refresh_token`, `created_at`.
- Refresh: same URL with `grant_type=refresh_token`, `client_id`, `client_secret`,
  `refresh_token`, `redirect_uri`. **Refresh tokens rotate**: each response
  returns a new one and the old one stops working.
- Revoke: `POST {login}/oauth/revoke` with `token`, `client_id`, `client_secret`.

## Headers, pagination, limits

- `Authorization: Bearer <token>` and `Procore-Company-Id: <company_id>` on every
  call except `GET /rest/v1.0/me` and `GET /rest/v1.0/companies`.
- Pagination: `page` (1-based) and `per_page`; response headers `Link`, `Total`, `Per-Page`.
- Rate limits: headers `X-Rate-Limit-Limit`, `X-Rate-Limit-Remaining`,
  `X-Rate-Limit-Reset` (Unix seconds). 429 when exceeded; 503 with `Retry-After`
  under load. The numeric limit is not published (3,600/hour is **unverified**).
- IDs can exceed 32 bits; treat them as strings.

## Endpoints used

| Purpose | Request |
|---|---|
| Companies | `GET /rest/v1.0/companies` → `id`, `name`, `is_active` |
| Projects | `GET /rest/v1.1/projects?company_id=` → `id`, `name`, `project_number`, `active` (default 100/page, max 300) |
| Project vendors | `GET /rest/v1.1/projects/{project_id}/vendors` → `id`, `name`, `email_address`, `is_active` |
| Subcontracts | `GET /rest/v1.0/work_order_contracts?project_id=` (`filters[status]`) |
| Subcontract detail | `GET /rest/v1.0/work_order_contracts/{id}?project_id=` → `status`, `vendor`, `grand_total`, `retainage_percent`, `accounting_method`, `number`, `title` |
| Schedule of values | `GET /rest/v1.0/work_order_contracts/{id}/line_items?project_id=` → `id`, `amount`, `description`, `position` |
| Change orders | `GET /rest/v1.0/projects/{project_id}/commitment_change_orders` (`filters[contract_id]`) → `id`, `contract_id`, `number`, `title`, `status`, `grand_total` |
| Billing periods | `GET` / `POST /rest/v1.0/projects/{project_id}/billing_periods` — POST body `{"billing_period":{start_date,end_date,due_date,status}}` |
| Invoices (list) | `GET /rest/v1.1/requisitions?project_id=` (`filters[commitment_id]`, `filters[period_id]`) |
| Invoice (create) | `POST /rest/v1.1/requisitions` → 201 |

`/rest/v1.0/commitments` is deprecated; new apps are denied access. The v2.0
`commitment_contracts` resource is still beta, so v1.0 `work_order_contracts` is used.

### Creating a subcontractor invoice ("requisition")

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
        "work_completed_this_period": "1000.00", "materials_presently_stored": "0" }
    ]
  }
}
```

- `item_type`: `contract_item`, `contract_detail_item`, `change_order_item`, `change_order_detail_item`.
- `status`: `draft`, `under_review`, `revise_and_resubmit`, `approved`,
  `approved_as_noted`, `pending_owner_approval`. Only users with Admin on the
  Commitments tool can set anything beyond `draft` / `under_review`.
- Attachments: `requisition.upload_ids` (from `POST /rest/v1.1/projects/{project_id}/uploads`).

Preconditions, documented for the UI (API enforcement is **unverified**): the
commitment is Approved or Complete; a contract company and an invoice contact are
assigned; subcontractor SOV lines are approved; a billing period exists.

## Things the API will not let us do

- **Do not set `origin_id`** on an invoice we may need to change: once set, the
  whole object is immutable, and only one integration may use it.
- An invoice sent to ERP Integrations can no longer be edited (attachments excepted).
- The SOV and contract company cannot be changed on Approved/Complete commitments.
- Retainage-retained amounts require Admin on Commitments.
- Whether approval-workflow steps or Procore Pay actions are available by API was
  not investigated.

## What that means for this product

- We push the **approved line items** (work this period, materials stored) as a
  requisition in `draft` status and let Procore compute its own totals. We do
  not push retainage amounts or force a status the connected user may not be
  allowed to set.
- A push needs the application's contract and its SOV lines to be mapped to
  Procore ids. That mapping exists only for contracts imported from Procore, so
  for contracts created by hand the push is unavailable and the file export is
  the path. The UI says so rather than attempting a partial push.
