'use client';

import { logoutAction } from '@/app/(auth)/actions';
import { LAST_PAGE_KEY } from './session-markers';

/**
 * Signs out: ends the session on the server, forgets what this browser kept
 * about the app, and leaves with a full page load that replaces the current
 * history entry, so the in-memory app (and its cached pages) is gone. Pages
 * restored from the back-forward cache reload themselves (AppShell), and the
 * server then sends them to sign in.
 */
export async function signOut(): Promise<void> {
  try {
    await logoutAction();
  } finally {
    try {
      window.localStorage.removeItem(LAST_PAGE_KEY);
      window.sessionStorage.clear();
    } catch {
      // Storage can be unavailable (private windows); there is then nothing to clear.
    }
    window.location.replace('/login?signed_out=1');
  }
}
