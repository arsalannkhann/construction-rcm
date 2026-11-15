/**
 * Transactions and write serialisation.
 *
 * Every service that changes an organisation's records runs inside
 * `withOrgLock`: one database transaction that first takes an advisory lock
 * for the organisation. That gives two guarantees the product depends on:
 *
 *   1. Atomicity. An approval, an edit or a re-read either happens completely
 *      (rows, findings, audit event, notifications) or not at all. A crash or
 *      an error half-way leaves nothing behind.
 *   2. No interleaving. Two people acting on the same organisation's records
 *      at the same moment are applied one after the other, each seeing the
 *      other's committed result. Reconciliation reads many rows and writes
 *      many rows; it is only correct if nothing moves underneath it.
 *
 * The lock is per organisation rather than per contract on purpose. Writes
 * are short (milliseconds; document reading and network calls happen outside
 * the transaction), a general contractor's finance team is a handful of
 * people, and one lock cannot deadlock. Narrowing it to a contract is the
 * change to make if write contention ever shows up in practice.
 *
 * Rules for code that runs inside a lock:
 *   - Use the `tx` handle it is given for every query. `locked` services do
 *     this automatically because `tx` is passed as their `db` argument.
 *   - No network calls and no document reading. Do those before or after.
 *   - Anything that must only happen if the transaction commits (waking the
 *     job runner, sending an email) goes through `afterCommit`.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { sql } from 'drizzle-orm';
import type { DB } from './index';

type Scope = { tx: DB; orgs: Set<string>; after: Array<() => void | Promise<void>> };

// One store per process, even when a bundler loads this module twice.
const g = globalThis as unknown as { __rcmTxScope?: AsyncLocalStorage<Scope> };
const scopes = (g.__rcmTxScope ??= new AsyncLocalStorage<Scope>());

async function takeLock(tx: DB, orgId: string): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${'org:' + orgId}))`);
}

/** The transaction the current call is running in, if any. */
export function currentTx(): DB | null {
  return scopes.getStore()?.tx ?? null;
}

/**
 * Run `fn` in a transaction holding the organisation's write lock. Nested
 * calls join the transaction that is already open.
 */
export async function withOrgLock<T>(db: DB, orgId: string, fn: (tx: DB) => Promise<T>): Promise<T> {
  const open = scopes.getStore();
  if (open) {
    if (!open.orgs.has(orgId)) {
      await takeLock(open.tx, orgId);
      open.orgs.add(orgId);
    }
    return fn(open.tx);
  }

  const after: Scope['after'] = [];
  const result = await db.transaction(async (raw) => {
    const tx = raw as unknown as DB;
    await takeLock(tx, orgId);
    return scopes.run({ tx, orgs: new Set([orgId]), after }, () => fn(tx));
  });
  for (const hook of after) {
    try {
      await hook();
    } catch (err) {
      console.error('[db] an after-commit hook failed:', err);
    }
  }
  return result;
}

/** Run `fn` in a transaction without an organisation lock (for records that belong to no organisation, such as a user). */
export async function inTransaction<T>(db: DB, fn: (tx: DB) => Promise<T>): Promise<T> {
  const open = scopes.getStore();
  if (open) return fn(open.tx);
  const after: Scope['after'] = [];
  const result = await db.transaction(async (raw) => {
    const tx = raw as unknown as DB;
    return scopes.run({ tx, orgs: new Set(), after }, () => fn(tx));
  });
  for (const hook of after) {
    try {
      await hook();
    } catch (err) {
      console.error('[db] an after-commit hook failed:', err);
    }
  }
  return result;
}

/** Run `fn` once the surrounding transaction has committed, or straight away if there is none. It does not run if the transaction rolls back. */
export function afterCommit(fn: () => void | Promise<void>): void {
  const open = scopes.getStore();
  if (open) open.after.push(fn);
  else void Promise.resolve().then(fn).catch((err) => console.error('[db] a deferred hook failed:', err));
}

/** Start background work that must not inherit the caller's transaction. */
export function outsideTransaction<T>(fn: () => T): T {
  return scopes.exit(fn);
}

type OrgScope = string | { orgId: string };

/**
 * Wrap a service of the form `(db, ctx | orgId, ...args)` so that it runs
 * inside the organisation's write lock.
 */
export function locked<S extends OrgScope, A extends unknown[], R>(fn: (db: DB, scope: S, ...args: A) => Promise<R>): (db: DB, scope: S, ...args: A) => Promise<R> {
  return (db, scope, ...args) => withOrgLock(db, typeof scope === 'string' ? scope : scope.orgId, (tx) => fn(tx, scope, ...args));
}
