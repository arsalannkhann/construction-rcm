import { CircleCheck } from 'lucide-react';
import Link from '@/components/ui/link';
import { redirect } from 'next/navigation';
import { Notice } from '@/components/settings/notice';
import { safeReturnPath } from '@/lib/return-path';
import { getSession } from '@/server/auth/session';
import { LoginForm } from './login-form';

export const metadata = { title: 'Sign in' };

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ reset?: string; next?: string }> }) {
  const { reset, next: asked } = await searchParams;
  const next = safeReturnPath(asked);
  if (await getSession()) redirect(next ?? '/');
  return (
    <>
      <h1 className="text-2xl font-semibold tracking-tight">Sign in</h1>
      <p className="mt-1.5 text-[13px] text-ink-2">Welcome back. Pick up where your team left off.</p>
      {reset === 'done' ? (
        <Notice tone="pass" icon={<CircleCheck strokeWidth={1.9} />} className="mt-5">
          Your new password is set, and the account was signed out everywhere. Sign in with it below.
        </Notice>
      ) : null}
      <div className="mt-7">
        <LoginForm next={next} />
      </div>
      <p className="mt-6 text-[13px] text-ink-2">
        New here?{' '}
        <Link href="/signup" className="font-medium text-accent hover:underline">
          Set up your company
        </Link>
      </p>
    </>
  );
}
