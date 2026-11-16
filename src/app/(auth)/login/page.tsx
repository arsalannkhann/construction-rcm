import { CircleCheck, Clock, LogOut } from 'lucide-react';
import Link from '@/components/ui/link';
import { redirect } from 'next/navigation';
import { AuthHeading } from '@/components/auth/auth-frame';
import { Notice } from '@/components/settings/notice';
import { safeReturnPath } from '@/lib/return-path';
import { getSession } from '@/server/auth/session';
import { ForgetSignedInHint } from './forget-hint';
import { LoginForm } from './login-form';

export const metadata = { title: 'Sign in' };

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ reset?: string; next?: string; expired?: string; signed_out?: string }> }) {
  const { reset, next: asked, expired, signed_out: signedOut } = await searchParams;
  const next = safeReturnPath(asked);
  // Already signed in: straight on, to the page that was asked for or the dashboard (never back to the website).
  if (await getSession()) redirect(next ?? '/overview');
  return (
    <>
      {/* Nobody is signed in on this browser any more: the website should stop offering the dashboard. */}
      <ForgetSignedInHint />
      <AuthHeading title="Sign in">Welcome back. Pick up where your team left off.</AuthHeading>
      {reset === 'done' ? (
        <Notice tone="pass" icon={<CircleCheck strokeWidth={1.9} />} className="mt-6">
          Your new password is set, and the account was signed out everywhere. Sign in with it below.
        </Notice>
      ) : expired ? (
        <Notice tone="warn" icon={<Clock strokeWidth={1.9} />} className="mt-6">
          Your session has ended, so you have been signed out. This happens after a period away, or when the account signs out elsewhere or its password changes.
          {next ? ' Sign in to go back to the page you were on.' : ' Sign in to continue.'}
        </Notice>
      ) : signedOut ? (
        <Notice tone="neutral" icon={<LogOut strokeWidth={1.9} />} className="mt-6">
          You have signed out. Nothing from your organisation stays open on this browser.
        </Notice>
      ) : null}
      <div className="mt-7">
        <LoginForm next={next} />
      </div>
      <p className="mt-7 text-[13.5px] text-ink-2">
        New here?{' '}
        <Link href="/signup" className="font-medium text-accent hover:underline">
          Set up your company
        </Link>
      </p>
    </>
  );
}
