import { redirect } from 'next/navigation';
import { AuthFrame } from '@/components/auth/auth-frame';
import { getSession } from '@/server/auth/session';
import { WelcomeForm } from './welcome-form';

export const metadata = { title: 'Welcome' };

/** Shown to a signed-in user who is not an active member of any organisation. */
export default async function WelcomePage() {
  const session = await getSession();
  if (!session) redirect('/login');
  if (session.mfaRequired) redirect('/mfa-required');
  if (session.ctx) redirect('/overview');
  return (
    <AuthFrame>
      <div>
          <h1 className="text-[26px] font-semibold leading-tight tracking-[-0.025em]">You are not part of an organisation</h1>
          <p className="mt-2 text-[14px] leading-relaxed text-ink-2">
            Signed in as {session.user.email}. Your access to a previous organisation may have been removed. Create a new organisation, or ask an admin to invite you again.
          </p>
          <div className="mt-7">
            <WelcomeForm />
          </div>
      </div>
    </AuthFrame>
  );
}
