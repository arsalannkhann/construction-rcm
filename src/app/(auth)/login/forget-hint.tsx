'use client';

import { useEffect } from 'react';
import { SIGNED_IN_HINT_COOKIE } from '@/lib/session-markers';

/** Clears the website's "signed in" marker, for pages only someone without a session sees. */
export function ForgetSignedInHint() {
  useEffect(() => {
    document.cookie = `${SIGNED_IN_HINT_COOKIE}=; Max-Age=0; path=/; SameSite=Lax`;
  }, []);
  return null;
}
