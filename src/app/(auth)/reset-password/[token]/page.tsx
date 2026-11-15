import Link from '@/components/ui/link';
import { getDb } from '@/db';
import { findPasswordReset } from '@/server/auth/password-reset';
import { ResetForm } from './reset-form';

export const metadata = { title: 'Set a new password' };

export default async function ResetPasswordPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const reset = await findPasswordReset(await getDb(), token);

  if (!reset) {
    return (
      <>
        <h1 className="text-2xl font-semibold tracking-tight">This reset link is no longer valid</h1>
        <p className="mt-2 text-[13px] text-ink-2">Reset links work once and for 60 minutes, and a newer link replaces an older one. Ask for a new link, or ask an owner or admin of your organisation to create one for you.</p>
        <p className="mt-6 flex gap-5 text-[13px]">
          <Link href="/forgot-password" className="font-medium text-accent hover:underline">
            Get a new link
          </Link>
          <Link href="/login" className="font-medium text-accent hover:underline">
            Go to sign in
          </Link>
        </p>
      </>
    );
  }

  return (
    <>
      <h1 className="text-2xl font-semibold tracking-tight">Set a new password</h1>
      <p className="mt-1.5 text-[13px] text-ink-2">For {reset.email}. Setting it signs this account out on every device; then you sign in with the new password.</p>
      <div className="mt-7">
        <ResetForm token={token} email={reset.email} />
      </div>
    </>
  );
}
