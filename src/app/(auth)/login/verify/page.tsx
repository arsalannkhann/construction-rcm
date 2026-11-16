import Link from '@/components/ui/link';
import { redirect } from 'next/navigation';
import { getDb } from '@/db';
import { safeReturnPath } from '@/lib/return-path';
import { MFA_ISSUER, MFA_ISSUER_RENAMED_AT, PREVIOUS_MFA_ISSUER } from '@/server/auth/mfa';
import { getSession, loginChallengeToken } from '@/server/auth/session';
import { findLoginChallenge } from '@/server/auth/sign-in';
import { VerifyForm } from './verify-form';

export const metadata = { title: 'Two-step verification' };

/** The second step of signing in, for an account with two-step verification. */
export default async function VerifyPage({ searchParams }: { searchParams: Promise<{ next?: string }> }) {
  const next = safeReturnPath((await searchParams).next);
  if (await getSession()) redirect(next ?? '/overview');
  const challenge = await findLoginChallenge(await getDb(), await loginChallengeToken());

  if (!challenge) {
    return (
      <>
        <h1 className="text-[26px] font-semibold leading-tight tracking-[-0.025em]">Sign in again</h1>
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
      <h1 className="text-[26px] font-semibold leading-tight tracking-[-0.025em]">Two-step verification</h1>
      <p className="mt-2 text-[14px] leading-relaxed text-ink-2">
        Enter the 6-digit code your authenticator app shows for {challenge.mfaEnabledAt && challenge.mfaEnabledAt < MFA_ISSUER_RENAMED_AT ? `${PREVIOUS_MFA_ISSUER}, the name your app was given when you set it up` : MFA_ISSUER}.
      </p>
      <div className="mt-7">
        <VerifyForm attemptsLeft={challenge.attemptsLeft} next={next} />
      </div>
      <p className="mt-6 text-xs text-ink-3">
        Lost your phone? Enter one of the recovery codes you saved when you turned on two-step verification. If you have none left, ask an owner or admin of your organisation to reset your two-step verification (Settings → Team).
      </p>
    </>
  );
}
