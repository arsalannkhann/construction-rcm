import { redirect } from 'next/navigation';
import { Brand } from '@/components/brand';
import { getSession } from '@/server/auth/session';
import { WelcomeForm } from './welcome-form';

export const metadata = { title: 'Welcome' };

/** Shown to a signed-in user who is not an active member of any organisation. */
export default async function WelcomePage() {
  const session = await getSession();
  if (!session) redirect('/login');
  if (session.ctx) redirect('/overview');
  return (
    <div className="flex min-h-screen flex-col">
      <header className="px-8 py-6">
        <Brand />
      </header>
      <main className="flex flex-1 items-start justify-center px-6 pt-[8vh]">
        <div className="w-full max-w-[380px]">
          <h1 className="text-2xl font-semibold tracking-tight">You are not part of an organisation</h1>
          <p className="mt-1.5 text-[13px] text-ink-2">
            Signed in as {session.user.email}. Your access to a previous organisation may have been removed. Create a new organisation, or ask an admin to invite you again.
          </p>
          <div className="mt-7">
            <WelcomeForm />
          </div>
        </div>
      </main>
    </div>
  );
}
