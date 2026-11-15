/**
 * Every server action returns an ActionResult instead of throwing, so the UI
 * can show a precise message. Expected failures (validation, permissions)
 * carry their own message; anything else is logged and reported generically.
 */
import { unstable_rethrow } from 'next/navigation';
import { PermissionError, UserError } from '@/server/auth/permissions';

export type ActionResult<T = undefined> = { ok: true; data: T } | { ok: false; error: string };

export async function run<T>(fn: () => Promise<T>): Promise<ActionResult<T>> {
  try {
    return { ok: true, data: await fn() };
  } catch (err) {
    // redirect() and notFound() work by throwing; let them through.
    unstable_rethrow(err);
    if (err instanceof UserError || err instanceof PermissionError) return { ok: false, error: err.message };
    console.error('[action] unexpected error:', err);
    return { ok: false, error: 'Something went wrong on our side. Please try again.' };
  }
}
