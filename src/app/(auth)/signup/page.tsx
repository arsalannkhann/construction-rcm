import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getSession } from '@/server/auth/session';
import { SignupForm } from './signup-form';

export const metadata = { title: 'Set up your company' };

export default async function SignupPage() {
  if (await getSession()) redirect('/');
  return (
    <>
      <h1 className="text-2xl font-semibold tracking-tight">Set up your company</h1>
      <p className="mt-1.5 text-[13px] text-ink-2">Create your organisation, then add a project and upload your first billing package. No integrations needed to start.</p>
      <div className="mt-7">
        <SignupForm />
      </div>
      <p className="mt-6 text-[13px] text-ink-2">
        Already have an account?{' '}
        <Link href="/login" className="font-medium text-accent hover:underline">
          Sign in
        </Link>
      </p>
    </>
  );
}
