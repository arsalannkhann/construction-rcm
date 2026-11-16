import { redirect } from 'next/navigation';
import { AuthFrame } from '@/components/auth/auth-frame';
import { getDb } from '@/db';
import { getSession } from '@/server/auth/session';
import { listMyOrganizations } from '@/server/services/team';
import { MfaRequiredSetup } from './mfa-required-setup';

export const metadata = { title: 'Two-step verification required' };

/**
 * Where a member lands when their organisation requires two-step verification
 * and they have not turned it on. `requireCtx()` sends them here from every
 * page, and nothing in that organisation can be read or changed until they set
 * it up (the session resolves without a context).
 */
export default async function MfaRequiredPage() {
  const session = await getSession();
  if (!session) redirect('/login');
  if (!session.mfaRequired) redirect(session.ctx ? '/overview' : '/welcome');

  const organizations = await listMyOrganizations(await getDb(), session.user.id);
  const elsewhere = organizations.filter((o) => !o.requiresMfa && o.id !== session.mfaRequired!.orgId).map((o) => ({ id: o.id, name: o.name }));

  return (
    <AuthFrame wide>
      <div>
          <h1 className="text-[26px] font-semibold leading-tight tracking-[-0.025em]">{session.mfaRequired.orgName} requires two-step verification</h1>
          <p className="mt-2 text-[14px] leading-relaxed text-ink-2">
            Signed in as {session.user.email}. An owner or admin of {session.mfaRequired.orgName} has made two-step verification compulsory for every member. Set it up for your account to continue. It takes about a minute.
          </p>
          <div className="mt-6">
            <MfaRequiredSetup orgName={session.mfaRequired.orgName} elsewhere={elsewhere} />
          </div>
      </div>
    </AuthFrame>
  );
}
