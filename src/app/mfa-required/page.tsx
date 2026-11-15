import { redirect } from 'next/navigation';
import { Brand } from '@/components/brand';
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
    <div className="flex min-h-screen flex-col">
      <header className="px-8 py-6">
        <Brand />
      </header>
      <main className="flex flex-1 items-start justify-center px-6 pb-24 pt-[6vh]">
        <div className="w-full max-w-[520px]">
          <h1 className="text-2xl font-semibold tracking-tight">{session.mfaRequired.orgName} requires two-step verification</h1>
          <p className="mt-1.5 text-[13px] text-ink-2">
            Signed in as {session.user.email}. An owner or admin of {session.mfaRequired.orgName} has made two-step verification compulsory for every member. Set it up for your account to continue. It takes about a minute.
          </p>
          <div className="mt-6">
            <MfaRequiredSetup orgName={session.mfaRequired.orgName} elsewhere={elsewhere} />
          </div>
        </div>
      </main>
    </div>
  );
}
