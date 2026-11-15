/**
 * Inviting a teammate: create the invitation, then try to email the link.
 * The outcome is the literal delivery result; an invitation is only ever
 * reported as emailed when the provider accepted the message.
 */
import { and, eq } from 'drizzle-orm';
import type { DB } from '@/db';
import { invitations } from '@/db/schema';
import { formatDate } from '@/lib/utils';
import { ROLE_LABEL, type Ctx } from '@/server/auth/permissions';
import { appUrl } from '@/server/config';
import { sendEmail } from '@/server/email';
import type { Role } from '@/server/types';
import { inviteMember } from './team';

export type InviteOutcome = {
  /** The one-time link. Only a hash of its token is stored, so it cannot be shown again. */
  link: string;
  email: 'sent' | 'not_sent' | 'failed';
  /** Why the email did not go out; null when it was sent. */
  detail: string | null;
};

export async function inviteAndNotify(db: DB, ctx: Ctx, input: { email: string; role: string }): Promise<InviteOutcome> {
  const { id, token } = await inviteMember(db, ctx, input);
  const link = `${appUrl()}/invite/${token}`;

  // Read back what was stored: the address as normalised, and when the link stops working.
  const [invitation] = await db
    .select({ email: invitations.email, role: invitations.role, expiresAt: invitations.expiresAt })
    .from(invitations)
    .where(and(eq(invitations.orgId, ctx.orgId), eq(invitations.id, id)));
  const to = invitation?.email ?? input.email.trim().toLowerCase();
  const role = ROLE_LABEL[(invitation?.role ?? input.role) as Role];
  const expiry = invitation ? ` and expires on ${formatDate(invitation.expiresAt.toISOString().slice(0, 10))}` : '';

  const result = await sendEmail({
    to,
    subject: `${ctx.userName} invited you to ${ctx.orgName} on Construction RCM`,
    text: [
      `${ctx.userName} (${ctx.userEmail}) has invited you to join ${ctx.orgName} on Construction RCM as ${role}.`,
      '',
      'Accept the invitation:',
      link,
      '',
      `The link can be used once${expiry}. If you were not expecting this invitation, you can ignore this email.`,
    ].join('\n'),
    replyTo: ctx.userEmail,
  });

  if (result.status === 'sent') return { link, email: 'sent', detail: null };
  if (result.status === 'failed') return { link, email: 'failed', detail: result.error };
  return { link, email: 'not_sent', detail: result.reason };
}
