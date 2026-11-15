import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getSession } from '@/server/auth/session';
import { LoginForm } from './login-form';

export const metadata = { title: 'Sign in' };

export default async function LoginPage() {
  if (await getSession()) redirect('/');
  return (
    <>
      <h1 className="text-2xl font-semibold tracking-tight">Sign in</h1>
      <p className="mt-1.5 text-[13px] text-ink-2">Welcome back. Pick up where your team left off.</p>
      <div className="mt-7">
        <LoginForm />
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
