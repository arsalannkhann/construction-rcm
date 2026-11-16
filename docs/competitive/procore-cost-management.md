# Procore cost management: notes and gap analysis

Read on 2026-11-17 from Procore's public marketing pages for its cost-management
product (overview, and the pages for main contractors, subcontractors and
owners, plus Payment Application Management and Project Financials). These are
marketing pages: they describe what Procore says the product does, not what we
have tested. Notes are paraphrased; nothing here is copied from Procore.

## What Procore sells

One place for a job's money, replacing spreadsheets. Its pitch, in our words:

- **Budget, commitments and changes together.** Budgets with revisions,
  subcontracts and purchase orders ("commitments"), change events and
  variations, direct costs, and a cost-to-complete figure, so a project team can
  see an overrun coming before month-end close.
- **Forecasting.** Time-phased forecasts per project and rolled up across a
  portfolio; historical data ("Insights") used to make forecasts better.
- **Payment application (invoice) management.** Subcontractors submit their own
  pay applications; each billing period shows the status of every one; routing
  and approval with an audit trail; approve or reject invoiced amounts; checks
  against overbilling and against work not yet done; make sure no application is
  missed; the owner invoice is pre-filled from the approved subcontractor ones;
  results sync to accounting. They claim a two-week billing cycle drops to
  minutes.
- **AI.** Reads budgets, commitments and change events to flag cost risk and
  overruns, and surfaces scope buried in unreviewed changes, RFIs and drawings.
  A person approves each recommendation.
- **Platform.** Unlimited users, documents and data on every account; hundreds
  of integrations (BI tools, e-signature, ERP and accounting such as Sage, Xero,
  MYOB); mobile; security and data-ownership assurances.

Each audience gets the same tools with a different message: main contractors
are sold control of margin and faster billing, subcontractors are sold getting
paid faster and capturing every variation, owners are sold cost certainty,
audit-ready approvals and portfolio dashboards (including a planning sandbox for
projects not yet funded).

## Where we stand

Our product is narrower and deeper: a main contractor's team receives
subcontractor pay applications (upload, email, phone), we read them, check
every figure against the subcontract, its change orders, its schedule of values
and prior approvals, check the lien waivers the project's state requires, route
the result for approval, and hand the approved record to accounting or Procore.

| Procore capability | Us before this round | Now |
| --- | --- | --- |
| Commitments (subcontracts) with change orders | Yes: subcontracts, schedule of values, change orders, retainage terms | Same |
| Overbilling prevention | Yes, and stricter: every line and the contract total are checked before approval, with the evidence on the page | Same |
| Verify work billed against prior billing | Yes: previous-period figures must match what we approved last time | Same |
| Approval routing, audit trail | Yes: roles, two-person rule, immutable approved record, full activity log | Same |
| Status of every pay application in a billing period | Partly: an application list and a billing-by-month chart | **Billing periods page and project billing grid** |
| Make sure no pay application is missed | Partly: application numbers out of sequence are flagged, but a subcontractor who sends nothing goes unnoticed | **Missing applications flagged per period, counted on the overview** |
| Owner invoice pre-filled from approved sub applications | No | **Partly: a per-project, per-period roll-up of approved subcontractor billing (CSV) to build the owner invoice from** |
| Budget and budget-vs-committed | No | **A budget per project, with committed, pending changes, projected cost and the variance** |
| Change exposure (change events) | Pending change orders were stored but not counted anywhere | **Pending changes counted as exposure and in projected cost** |
| Cost-risk flags ("AI flags overruns") | No | **Rule-based cost and billing risks on the overview, each with its reason** |
| Cost-to-complete, time-phased forecasts | No | No (see gaps) |
| Subcontractors submit their own applications | Email to a project address; no portal | Same |
| Accounting sync | File exports (CSV, JSON, PDF) and Procore push | Same |
| Direct costs, labour from timesheets | No | No (out of scope for now) |
| Unlimited users and documents | Yes | Same |
| Mobile | Yes: review, approve, comment, share a package into the app | Same |

## Where we can win

1. **Verification depth.** Procore routes and approves; we check the
   arithmetic, the schedule of values line by line, prior billing, retainage
   (including stepped terms and releases), change orders and statutory lien
   waivers, and show where on which page each figure was read. A reviewer sees
   what is wrong instead of re-adding columns.
2. **No re-keying.** Packages arrive as PDFs by email or phone and are read
   automatically, with measured accuracy and every doubtful value sent to a
   person (docs/extraction-evaluation.md). Procore expects the subcontractor to
   key their application into Procore.
3. **Works beside Procore.** Teams already on Procore keep it; we push approved
   figures into it. A team without Procore gets the cost picture here.
4. **Explainable flags.** Our risk flags are rules with their reasons and
   numbers, not a model's opinion; each one links to the record it is about.

## Gaps, in the order we would close them

1. **Prime contract and the owner's pay application.** Model the head contract
   and its schedule, and generate the main contractor's own G702/G703 from the
   approved subcontractor billing plus self-performed work and markup. The
   roll-up added in this round is the first half.
2. **Subcontractor portal.** A no-account link per subcontract where the
   subcontractor uploads their package, sees its status and the reason for a
   hold, and gets reminded when a period is due. Pairs with the missing-
   application flags.
3. **Budget by cost code and cost-to-complete.** Today the budget is one figure
   per project for subcontracted work. Next: budget lines by cost code mapped to
   subcontracts, with forecast-to-complete per line.
4. **Forecasting.** Project the remaining billing per subcontract from its
   billing pace and the remaining balance, rolled up into a cash-flow view.
   Must be labelled as a projection; every figure on the overview today is
   computed from records, and that should stay visible.
5. **Accounting integrations.** QuickBooks, Sage and Xero, beyond file exports.
6. **Change events.** Potential changes before they become change orders, with
   rough costs, so exposure appears earlier than a pending change order.

## Built in this round

- **Project budget and cost position.** Optional budget on each project (for
  its subcontracted work). The project page shows the budget, what is committed
  (subcontracts and approved change orders), pending changes, the projected
  cost (committed plus pending) and what is left or over. Projects and the
  overview show the variance.
- **Billing periods** (`/billing`). For any month: every subcontract expected to
  bill, whether its application arrived, where it is in review, what was
  requested and approved, and which are missing. Months that have closed flag a
  subcontract that had been billing, still has a balance, and sent nothing.
- **Billing grid on each project.** Six months by subcontract, one cell per
  period, linking to the application.
- **Approved billing roll-up.** Per project and period, a CSV of the approved
  subcontractor figures (work this period, stored materials, retainage, payment
  due), the basis of the owner invoice.
- **Cost and billing risks on the overview.** Projects over or near their
  budget, large pending changes against a subcontract, and subcontracts that
  missed the last closed billing period.
