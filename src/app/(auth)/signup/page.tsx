import Link from '@/components/ui/link';
import { redirect } from 'next/navigation';
import { getSession } from '@/server/auth/session';
import { SignupForm } from './signup-form';

export const metadata = { title: 'Set up your company' };

export default async function SignupPage() {
  if (await getSession()) redirect('/overview');
  return (
    <>
      <h1 className="text-[26px] font-semibold leading-tight tracking-[-0.025em]">Set up your company</h1>
      <p className="mt-2 text-[14px] leading-relaxed text-ink-2">Create your organisation, then add a project and upload your first billing package. No integrations needed to start.</p>
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
