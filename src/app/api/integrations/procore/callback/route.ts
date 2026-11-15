/**
 * Procore sends the browser back here after the user approves (or declines)
 * access. The `state` must match the cookie set when connecting started; only
 * then is the code exchanged. The outcome goes back to the integrations page
 * as `connected=1` or a short error code — never a token or anything Procore said.
 */
import type { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/db';
import { PermissionError } from '@/server/auth/permissions';
import { getSession } from '@/server/auth/session';
import { completeConnect, ProcoreConnectFailure } from '@/server/integrations/procore';
import { backToSettings, clearStateCookie, goTo, readStateCookie, sameState, STATE_COOKIE } from '../oauth-state';

export async function GET(request: NextRequest) {
  // The state is single-use whatever happens next.
  const finish = (res: NextResponse) => {
    clearStateCookie(res);
    return res;
  };

  const session = await getSession();
  if (!session) return finish(goTo('/login'));
  if (!session.ctx) return finish(goTo('/welcome'));

  const params = request.nextUrl.searchParams;
  const expected = readStateCookie(request.cookies.get(STATE_COOKIE)?.value);
  if (!expected || !sameState(params.get('state') ?? '', expected.state)) return finish(backToSettings({ error: 'state' }));
  if (expected.orgId !== session.ctx.orgId) return finish(backToSettings({ error: 'org_changed' }));

  // The user declined, or Procore refused the request (for example a redirect URI that is not registered).
  if (params.get('error')) return finish(backToSettings({ error: 'denied' }));
  const code = params.get('code');
  if (!code) return finish(backToSettings({ error: 'missing_code' }));

  try {
    await completeConnect(await getDb(), session.ctx, code);
  } catch (err) {
    if (err instanceof PermissionError) return finish(backToSettings({ error: 'forbidden' }));
    if (err instanceof ProcoreConnectFailure) return finish(backToSettings({ error: err.code }));
    console.error('[procore] connecting failed:', err instanceof Error ? err.message : 'unknown error');
    return finish(backToSettings({ error: 'failed' }));
  }
  return finish(backToSettings({ connected: true }));
}
