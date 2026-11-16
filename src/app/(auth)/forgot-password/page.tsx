import Link from '@/components/ui/link';
import { Notice } from '@/components/settings/notice';
import { emailDeliveryConfigured } from '@/server/email';
import { RESET_LINK_MINUTES } from '@/server/auth/password-reset';
import { ForgotForm } from './forgot-form';

export const metadata = { title: 'Reset your password' };
// Whether email can be sent is read from the running deployment, not frozen at build time.
export const dynamic = 'force-dynamic';

export default function ForgotPasswordPage() {
  const canEmail = emailDeliveryConfigured();
  return (
    <>
      <h1 className="text-[26px] font-semibold leading-tight tracking-[-0.025em]">Reset your password</h1>
      {canEmail ? (
        <>
          <p className="mt-2 text-[14px] leading-relaxed text-ink-2">Enter the email address you sign in with. If it has an account, we email it a link to set a new password. The link works once, for {RESET_LINK_MINUTES} minutes.</p>
          <div className="mt-7">
            <ForgotForm />
          </div>
        </>
      ) : (
        <div className="mt-5 space-y-4 text-[13px] text-ink-2">
          {/* Said plainly, because it is true for every address: nothing is emailed from here. */}
          <Notice tone="warn">Reset emails cannot be sent from this deployment, because email delivery is not set up.</Notice>
          <p>To get a link to set a new password:</p>
          <ul className="list-disc space-y-1.5 pl-5">
            <li>
              Ask an owner or admin of your organisation. They can create a one-time reset link for you under <span className="font-medium text-ink">Settings → Team</span>.
            </li>
            <li>
              If you are the only owner, ask whoever runs this deployment to run <code className="rounded bg-sunken px-1 font-mono text-xs text-ink">pnpm reset-password &lt;your email&gt;</code>, which prints a one-time link.
            </li>
          </ul>
        </div>
      )}
      <p className="mt-6 text-[13px]">
        <Link href="/login" className="font-medium text-accent hover:underline">
          Back to sign in
        </Link>
      </p>
    </>
  );
}
