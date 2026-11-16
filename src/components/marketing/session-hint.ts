'use client';

import { useSyncExternalStore } from 'react';
import { LAST_PAGE_KEY, SIGNED_IN_HINT_COOKIE } from '@/lib/session-markers';

/**
 * Whether this browser has a Zephric session, for the public website's
 * "Continue to dashboard" action. Read from a plain marker cookie set beside
 * the real (HttpOnly) session cookie: it carries no secret and grants nothing.
 * A stale marker only means the dashboard link asks the person to sign in.
 */
const noop = () => () => {};

function readHint(): boolean {
  return document.cookie.split('; ').some((c) => c === `${SIGNED_IN_HINT_COOKIE}=1`);
}

/** False while rendering on the server and during hydration, so the first paint is the same for everyone. */
export function useSignedIn(): boolean {
  return useSyncExternalStore(noop, readHint, () => false);
}

export type LastPage = { path: string; label: string };

function readLastPage(): string | null {
  try {
    return window.localStorage.getItem(LAST_PAGE_KEY);
  } catch {
    return null;
  }
}

/** The app page to offer to resume, when there is one worth offering. */
export function useLastPage(): LastPage | null {
  const raw = useSyncExternalStore(noop, readLastPage, () => null);
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as LastPage;
    if (typeof value?.path !== 'string' || !value.path.startsWith('/') || value.path.startsWith('//') || value.path === '/overview') return null;
    return { path: value.path, label: String(value.label ?? '').slice(0, 60) || 'your last page' };
  } catch {
    return null;
  }
}
