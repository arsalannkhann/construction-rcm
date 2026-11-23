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
      <p className="mt-2 text-[14px] leading-relaxed text-ink-2">A private workspace for your team. There is nothing to connect or install, and an example workspace to explore before you enter anything of your own.</p>
      <div className="mt-7">
        <SignupForm />
      </div>
      <p className="mt-6 text-[13px] text-ink-2">
        Already have an account?{' '}
        <Link href="/login" className="font-medium text-accent hover:underline">
          Sign in
        </Link>
        <span className="text-ink-4"> · </span>
        <Link href="/sample" className="font-medium text-accent hover:underline">
          See the sample first
        </Link>
      </p>
    </>
  );
}
