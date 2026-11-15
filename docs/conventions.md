# Code conventions

Short and binding. Read `src/app/(app)/subcontractors/` first: it is the
reference implementation of a screen (page, actions, client dialog).

## Layers

```
src/app/…                 Pages (server components), server actions, route handlers. Thin.
src/components/ui/        The UI kit. Shared; change with care.
src/components/<feature>/ Feature components used by more than one page.
src/server/services/      Business logic. Framework-free: (db, ctx, input) → result.
src/server/recon/         Pure reconciliation engine. No I/O.
src/server/compliance/    Pure lien-waiver pre-screen and jurisdiction data.
src/server/documents/     Reading documents (text layer, Claude) → ExtractionResult.
src/server/integrations/  External systems.
src/db/schema.ts          Tables. Generate migrations with `pnpm db:generate`.
tests/                    Vitest. Services run against in-memory Postgres (PGlite).
```

Pages and actions never contain business rules. If you are writing an `if`
about money, permissions or status in `src/app`, it belongs in a service.

## Rules that protect the product

1. **Tenant isolation.** Every query filters on `ctx.orgId`. Loading a row by
   id is always `and(eq(table.orgId, ctx.orgId), eq(table.id, id))`. A service
   that receives an id from the client must verify it belongs to the org before
   using it. There is a test for this; add to it when you add a service.
2. **Money is integer cents.** Parse with `parseMoney`, display with
   `formatMoney` / `<Money>`. Rates are basis points. No floats, ever.
3. **Permissions are checked in services** with `assertCan(ctx, permission)`.
   The UI hides what a role cannot do (`can(ctx.role, …)`), but hiding is not
   the control.
4. **Everything that changes a financial record writes an audit event**
   (`recordAudit`) with a human-readable `summary` saying what changed, from
   what, to what. The audit trail is shown to customers verbatim.
5. **Expected failures throw `UserError`** with a message a finance user can
   act on. Anything else is a bug and is logged, not shown.
6. **Never report success that did not happen.** If an email was not sent or an
   integration is not connected, the stored status and the UI say exactly that.
7. **Changing anything that feeds verification re-runs reconciliation** for the
   affected open applications (`rereconcileContract` / `runReconciliation`).

## Server actions

```ts
'use server';
export async function doThingAction(input: Input): Promise<ActionResult<Output>> {
  return run(async () => {
    const ctx = await requireCtx();
    return doThing(await getDb(), ctx, input);
  });
}
```

`run` (src/lib/action.ts) turns `UserError` / `PermissionError` into
`{ ok: false, error }`. Client components call actions through `useAction()`
(src/lib/use-action.ts), which shows the error as a toast and refreshes the
page's server data on success.

## Next.js specifics (v16)

- `params` and `searchParams` are Promises: `const { id } = await params`.
- `cookies()` is async. Use `requireCtx()` from `src/server/auth/session.ts`.
- Server components are the default. Add `'use client'` only where there is
  state or an event handler, and keep those components small.
- Server-only packages (`pg`, PGlite, `pdfjs-dist`, `pdf-lib`,
  `@anthropic-ai/sdk`) are listed in `serverExternalPackages`; never import
  them, or anything under `src/server`, into a client component. Types and the
  constants in `src/server/types.ts` and `src/server/auth/permissions.ts` are
  safe to import anywhere.

## UI

- Compose from `src/components/ui`: `Page`, `PageHeader`, `Panel`,
  `PanelHeader`, `Table/Th/Td`, `EmptyState`, `Badge`, `StatusBadge`, `Money`,
  `Button`, `buttonClass` (for links), `Field`, `Input`, `Select`, `Textarea`,
  `Checkbox`, `MoneyInput`, `FormError`, `Dialog`, `Menu`, `Popover`, `Tooltip`.
- Colour carries meaning: `pass` (verified), `warn` (needs attention), `block`
  (blocking), `accent` (interactive / in progress). Everything else is ink on
  paper. No gradients, no decorative icons, no shadows beyond the kit's.
- Base text is 13px. Figures use the `num` class (tabular numerals) and are
  right-aligned in tables.
- Every list has an empty state that says what the thing is and how to add the
  first one. Every control on screen works; do not ship a button that does
  nothing.
- Icons: `lucide-react`, 14–16px, `strokeWidth` ~1.9.
- Copy: plain and specific. Say what happened and what to do. Sentence case.

## Charts

`src/components/charts.tsx`. Pick the form from the data's job before picking
colour. Colour does one job per chart: two validated hues for series identity
(requested vs approved), or the status tokens with a label. Text is always
ink. Thin marks, a 2px surface gap between touching marks, hairline grid, one
axis. Every mark has a hover and focus tooltip, and every chart has a
screen-reader table, so no value is reachable only by hovering. A chart of
invented numbers is a bug: charts read from `src/server/services/dashboard.ts`.

## Tests

`pnpm test` runs everything. `tests/helpers/world.ts` builds an organisation
with a team, project, subcontractor and subcontract, and `submit()` pushes a
generated PDF through the real pipeline. Prefer a service-level test that
exercises real behaviour over a unit test of a helper.
