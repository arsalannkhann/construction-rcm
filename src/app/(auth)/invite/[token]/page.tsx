import Link from 'next/link';
import { getDb } from '@/db';
import { ROLE_LABEL } from '@/server/auth/permissions';
import { findInvitation } from '@/server/services/team';
import { InviteForm } from './invite-form';

export const metadata = { title: 'Join your team' };

export default async function InvitePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const invitation = await findInvitation(await getDb(), token);

  if (!invitation) {
    return (
      <>
        <h1 className="text-2xl font-semibold tracking-tight">This invitation is no longer valid</h1>
        <p className="mt-2 text-[13px] text-ink-2">It may have expired, been withdrawn, or already been used. Ask the person who invited you to send a new one.</p>
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
      <h1 className="text-2xl font-semibold tracking-tight">Join {invitation.orgName}</h1>
      <p className="mt-1.5 text-[13px] text-ink-2">
        You have been invited as <span className="font-medium text-ink">{ROLE_LABEL[invitation.role]}</span> using {invitation.email}.
      </p>
      <div className="mt-7">
        <InviteForm token={token} email={invitation.email} hasAccount={invitation.hasAccount} />
      </div>
    </>
  );
}
