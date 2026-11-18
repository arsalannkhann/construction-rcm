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
| Owner invoice pre-filled from approved sub applications | No | **Yes: the main contractor's own application to the owner (G702 summary and G703 continuation sheet), worked out each period from approved subcontractor billing, with markup and hand-entered lines, frozen on submission, certification recorded, PDF** |
| Budget and budget-vs-committed | No | **A budget per project, with committed, pending changes, projected cost and the variance; split by cost code, each line with its subcontracts, budget changes between lines and a lock on the original budget** |
| Change exposure (change events) | Pending change orders were stored but not counted anywhere | **Pending changes counted as exposure and in projected cost** |
| Cost-risk flags ("AI flags overruns") | No | **Rule-based cost and billing risks on the overview, each with its reason** |
| Cost-to-complete, time-phased forecasts | No | **Cost to complete per budget line: billed to date, a forecast of what is still to be committed (by a method chosen per line), the estimate at completion and the projected over or under. Not time-phased yet (see gaps)** |
| Subcontractors submit their own applications | Email to a project address; no portal | **A no-account link per subcontract: upload, see each application's status and the messages sent to them, reminders before and after the due day** |
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

1. ~~**Prime contract and the owner's pay application.**~~ Done in the second
   round (below). Still open: emailing the application to the owner from here,
   the owner or architect certifying inside the product rather than the
   certification being recorded, and self-performed work tracked from costs
   rather than entered each period.
2. ~~**Subcontractor portal.**~~ Done in the third round (below). Still open:
   subcontractor accounts that cover every subcontract they hold with one
   sign-in, compliance documents (insurance certificates, W-9s) with expiry
   reminders, a per-subcontract due day, and reminders by text message.
   Reminders need an email provider on the deployment.
3. ~~**Budget by cost code and cost-to-complete.**~~ Done in the fourth round
   (below). Still open: splitting one subcontract across several cost codes
   (today a subcontract counts against one line), a cost code list kept for the
   whole organisation rather than suggested from other projects, linking a
   budget change to the owner change order that funds it, and direct costs
   (self-performed work, purchases) on the lines.
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

## Built in the second round: owner billing

- **Contract with the owner.** Per project: contract number, architect,
  original sum, retainage on work and on stored materials, date. Owner change
  orders, pending or approved; approving one adds it to the contract sum with a
  line of its own on the owner schedule.
- **Owner schedule of values.** Each line says how it is billed every period:
  it follows one or more subcontracts (the line's value times their approved
  percent complete, weighted by contract sum, so a marked-up line bills in
  step), it follows the rest of the contract (fee, insurance and bonds, at the
  percent complete of the other lines), or it is entered each period (general
  conditions, self-performed work). "Start from subcontracts" builds a first
  schedule in one click. Subcontracts not on the schedule are flagged.
- **Applications to the owner.** One per period. A draft is worked out from the
  latest subcontractor application approved up to the end of its period, every
  time it is opened, so it is always current; only approved billing counts.
  Columns E and F can be typed over on any line, with a note, and the worked-out
  figure stays visible. Checks before submitting: the schedule adds up to the
  contract sum, no line billed beyond its value (both blocking), lines typed
  above the approved progress, subcontracts not on the schedule, and
  subcontractor applications for the period still in review.
- **Submit, certify, reopen.** Submitting freezes the figures with a
  fingerprint (an approver submits on the figures they saw, or is asked to look
  again). The owner's certified amount is recorded, with a reason when it is
  short, and counts as the previous certificate on the next application.
  Reopening is allowed on the latest submitted application, with a reason.
- **PDF.** A summary page laid out like a G702 (lines 1 to 9, change order
  summary, signature and certification boxes) and landscape continuation sheets
  (columns A to I, repeated headings, grand total), marked DRAFT until
  submitted. Every download is in the activity log.
- **Risk on the overview.** Approved subcontractor billing for a month that no
  submitted application to the owner covers yet.

## Built in the third round: subcontractor portal

- **A link per subcontract.** A reviewer makes it on the subcontract page, with
  the address reminders go to. The link is the only credential: 256 random
  bits, looked up by its SHA-256 and stored encrypted, one live link per
  subcontract. Replacing it or turning it off stops the old one at once; what
  was sent through it stays on record. Wrong links are counted per address and
  refused for a while after 20 in 15 minutes.
- **What the subcontractor sees.** The subcontract, what is due this month and
  whether last month's application is missing, the same way the billing board
  works it out, and every application received on the subcontract however it
  was sent: its status (received, in review, waiting on you, approved,
  rejected), the amount requested, the amount approved once it is approved, the
  file names and the messages the team sent them. No internal comment,
  finding, decision note or other subcontract.
- **Uploading.** PDF, PNG, JPEG or WebP only, large files in parts, ten packages
  a day per subcontract, refused on a closed subcontract. A package arrives
  already matched to its subcontract, is read like any other and shows in the
  activity log as received through the portal.
- **Reminders.** The organisation sets the due day (1 to 28) on the review
  policy. A subcontract that has nothing in for the month gets one email in the
  five days before the due day and one after it, with the link; never twice,
  never when the month's application is in or still being read, and never
  without an email provider. A failed send is recorded and its link's creator
  told. Each email shows on the subcontract page.

## Built in the fourth round: budget by cost code

- **Budget lines.** Each project's budget for subcontracted work can be split
  into lines by cost code, each with its original budget. Subcontracts are
  assigned to a line; any that are not are shown apart, so the lines and that
  row always add up to the project. The first lines take over a project's
  single budget figure, with whatever they do not use going to a contingency
  line, so the total does not change underneath anyone. "Start from the
  subcontracts" makes one line per trade from the subcontracts already there.
- **Budget changes and the lock.** Money moves between lines (from contingency,
  say), or is added to or taken from the budget, by a budget change with a
  reason; a change is voided, never deleted, and no line can go below zero.
  Locking the budget freezes each line's original amount; unlocking takes an
  approver.
- **Cost to complete.** Per line: committed, pending change orders and billed
  to date (completed and stored, from approved applications), all from records;
  then, as a forecast, what is still to be committed by the method chosen for
  the line (the rest of the budget, an amount entered with a note, or nothing
  more), the estimate at completion, the cost to complete and the projected
  over or under. The page keeps the two kinds of figure in separate columns.
- **Overview risks.** Lines projected over their own budget, subcontracts on
  no line, and a project forecast to finish over budget when the project-level
  figure does not already show it.
- **Export.** The budget as CSV, one row per line with every figure.
