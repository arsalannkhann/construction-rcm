import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getDb } from '@/db';
import { getSession, loginChallengeToken } from '@/server/auth/session';
import { findLoginChallenge } from '@/server/auth/sign-in';
import { VerifyForm } from './verify-form';

export const metadata = { title: 'Two-step verification' };

/** The second step of signing in, for an account with two-step verification. */
export default async function VerifyPage() {
  if (await getSession()) redirect('/overview');
  const challenge = await findLoginChallenge(await getDb(), await loginChallengeToken());

  if (!challenge) {
    return (
      <>
        <h1 className="text-2xl font-semibold tracking-tight">Sign in again</h1>
        <p className="mt-2 text-[13px] text-ink-2">This sign-in has expired or had too many wrong codes. Enter your email and password again to get a new one.</p>
        <p className="mt-6 text-[13px]">
          <Link href="/login" className="font-medium text-accent hover:underline">
            Go to sign in
          </Link>
        </p>
      </>
    );
  }

  return (
    <>
      <h1 className="text-2xl font-semibold tracking-tight">Two-step verification</h1>
      <p className="mt-1.5 text-[13px] text-ink-2">Enter the 6-digit code your authenticator app shows for Construction RCM.</p>
      <div className="mt-7">
        <VerifyForm attemptsLeft={challenge.attemptsLeft} />
      </div>
      <p className="mt-6 text-xs text-ink-3">
        Lost your phone? Enter one of the recovery codes you saved when you turned on two-step verification. If you have none left, ask an owner or admin of your organisation to reset your two-step verification (Settings → Team).
      </p>
    </>
  );
}
