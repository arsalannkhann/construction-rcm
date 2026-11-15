/**
 * Start connecting Procore: remember a random `state` in a short-lived cookie
 * and send the browser to Procore's authorize page.
 */
import { NextResponse } from 'next/server';
import { PermissionError } from '@/server/auth/permissions';
import { getSession } from '@/server/auth/session';
import { beginConnect, ProcoreConnectFailure } from '@/server/integrations/procore';
import { backToSettings, goTo, setStateCookie } from '../oauth-state';

export async function GET() {
  const session = await getSession();
  if (!session) return goTo('/login');
  if (!session.ctx) return goTo('/welcome');

  let begun: { url: string; state: string };
  try {
    begun = beginConnect(session.ctx);
  } catch (err) {
    if (err instanceof PermissionError) return backToSettings({ error: 'forbidden' });
    if (err instanceof ProcoreConnectFailure) return backToSettings({ error: err.code });
    console.error('[procore] could not start connecting:', err instanceof Error ? err.message : 'unknown error');
    return backToSettings({ error: 'failed' });
  }

  const res = NextResponse.redirect(begun.url);
  res.headers.set('Cache-Control', 'no-store');
  setStateCookie(res, begun.state, session.ctx.orgId);
  return res;
}
