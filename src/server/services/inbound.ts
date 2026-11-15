/**
 * Email intake.
 *
 * An inbound-email provider (Postmark's inbound webhook format is accepted
 * as-is, as is a small generic JSON shape and a raw RFC 822 message) posts
 * incoming mail to /api/inbound/email/<organisation intake token>. Attachments
 * become a new billing package, exactly as if they had been uploaded.
 *
 * The endpoint is closed unless INBOUND_EMAIL_SECRET is set, and every request
 * must present it. Beyond that:
 *
 *   - A message is processed once. Providers retry webhooks, and people
 *     forward the same email twice; the Message-ID (or, without one, a hash of
 *     the content) is recorded and a repeat is acknowledged without creating
 *     a second application.
 *   - The sender is checked against what is on file. Under the default policy
 *     a package from an unknown address is accepted but cannot be approved
 *     until an approver has dealt with a blocking finding about it; under the
 *     stricter policy it is turned away and the team is told.
 *   - Every message that arrives, accepted or not, is written to the intake
 *     log so nothing disappears without a trace.
 *
 * A sender address can be forged. Verifying SPF/DKIM is the inbound
 * provider's job; configure it to drop mail that fails. Not exercised against
 * a live provider from this repository.
 */
import { timingSafeEqual } from 'node:crypto';
import { and, desc, eq, gte } from 'drizzle-orm';
import type { DB } from '@/db';
import { inboundMessages, memberships, organizations, subcontractors, users } from '@/db/schema';
import { withOrgLock } from '@/db/tx';
import { UserError, type Ctx } from '@/server/auth/permissions';
import { inboundEmailSecret } from '@/server/config';
import { newId, sha256Hex } from '@/server/ids';
import { resolveSettings } from '@/server/types';
import { createApplication, sniffMime, type IncomingFile } from './intake';
import { notifyPermission } from './notify';
import { classifySender } from './reconcile';

export class InboundRejected extends Error {
  constructor(
    public status: 401 | 404 | 422 | 503,
    message: string,
  ) {
    super(message);
    this.name = 'InboundRejected';
  }
}

export type InboundMessage = { from: string | null; subject: string | null; messageId: string | null; attachments: IncomingFile[] };

const READABLE = new Set(['application/pdf', 'image/png', 'image/jpeg', 'image/webp']);
/** Signature logos and tracking pixels arrive as attachments too; they are not billing documents. */
const MIN_BYTES = 4 * 1024;

function addressOf(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const m = /<([^>]+)>/.exec(value) ?? /([^\s<>"]+@[^\s<>"]+)/.exec(value);
  return m ? m[1]!.trim().toLowerCase() : null;
}

function fromBase64(value: unknown): Uint8Array | null {
  if (typeof value !== 'string' || !value) return null;
  try {
    return new Uint8Array(Buffer.from(value, 'base64'));
  } catch {
    return null;
  }
}

const cleanId = (value: unknown): string | null => (typeof value === 'string' && value.trim() ? value.trim().replace(/^<|>$/g, '').slice(0, 500) : null);

/** Accept Postmark's inbound JSON, or `{ from, subject, messageId, attachments: [{ filename, contentBase64, contentType }] }`. */
export function parseInboundJson(body: unknown): InboundMessage {
  if (!body || typeof body !== 'object') throw new InboundRejected(422, 'The request body is not a JSON object.');
  const b = body as Record<string, unknown>;
  const list = (Array.isArray(b.Attachments) ? b.Attachments : Array.isArray(b.attachments) ? b.attachments : []) as Array<Record<string, unknown>>;
  const attachments: IncomingFile[] = [];
  for (const a of list) {
    const bytes = fromBase64(a.Content ?? a.contentBase64 ?? a.content);
    const filename = String(a.Name ?? a.filename ?? a.name ?? 'attachment');
    if (bytes) attachments.push({ filename, mimeType: typeof (a.ContentType ?? a.contentType) === 'string' ? String(a.ContentType ?? a.contentType) : null, bytes });
  }
  // Prefer the sender's own Message-ID header (stable across provider retries AND re-deliveries) over the provider's id.
  const headers = Array.isArray(b.Headers) ? (b.Headers as Array<Record<string, unknown>>) : [];
  const header = headers.find((h) => typeof h.Name === 'string' && h.Name.toLowerCase() === 'message-id')?.Value;
  return {
    from: addressOf(b.From ?? b.from ?? (b.FromFull as Record<string, unknown> | undefined)?.Email),
    subject: typeof (b.Subject ?? b.subject) === 'string' ? String(b.Subject ?? b.subject) : null,
    messageId: cleanId(header) ?? cleanId(b.messageId) ?? cleanId(b.MessageID),
    attachments,
  };
}

/** Parse a raw message (the .eml your mail server or a forwarding rule hands over). */
export async function parseInboundMime(raw: Uint8Array): Promise<InboundMessage> {
  const { default: PostalMime } = await import('postal-mime');
  const mail = await PostalMime.parse(raw);
  return {
    from: mail.from?.address?.toLowerCase() ?? null,
    subject: mail.subject ?? null,
    messageId: cleanId(mail.messageId),
    attachments: mail.attachments.map((a) => ({
      filename: a.filename ?? 'attachment',
      mimeType: a.mimeType,
      bytes: typeof a.content === 'string' ? new TextEncoder().encode(a.content) : new Uint8Array(a.content),
    })),
  };
}

export function inboundSecretMatches(presented: string | null): boolean {
  const secret = inboundEmailSecret();
  if (!secret) throw new InboundRejected(503, 'Email intake is not enabled on this deployment (INBOUND_EMAIL_SECRET is not set).');
  if (!presented) return false;
  const a = Buffer.from(presented);
  const b = Buffer.from(secret);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Where a provider may put the shared secret: a header, a bearer token, the password of basic auth, or (last resort) the query string. */
export function presentedSecret(request: Request): string | null {
  const direct = request.headers.get('x-inbound-secret');
  if (direct) return direct;
  const auth = request.headers.get('authorization');
  if (auth) {
    const [scheme, value] = auth.split(/\s+/, 2);
    if (scheme?.toLowerCase() === 'bearer' && value) return value;
    if (scheme?.toLowerCase() === 'basic' && value) {
      const decoded = Buffer.from(value, 'base64').toString('utf8');
      const colon = decoded.indexOf(':');
      return colon >= 0 ? decoded.slice(colon + 1) : decoded;
    }
  }
  return new URL(request.url).searchParams.get('secret');
}

export type InboundResult =
  | { outcome: 'accepted'; id: string; files: string[]; ignored: string[] }
  /** This message was already received; nothing new was created. */
  | { outcome: 'duplicate'; id: string | null }
  /** The message arrived but was not turned into an application. */
  | { outcome: 'rejected'; reason: string };

/**
 * Turn an inbound message into a billing package for the organisation that
 * owns the token. Throws `InboundRejected` only when the caller is not
 * entitled to deliver at all; a message that is simply not usable is logged
 * and reported as `rejected`, so the provider does not keep retrying it.
 */
export async function receiveInboundEmail(db: DB, token: string, presented: string | null, message: InboundMessage): Promise<InboundResult> {
  if (!inboundSecretMatches(presented)) throw new InboundRejected(401, 'The shared secret is missing or wrong.');
  const [org] = await db.select().from(organizations).where(eq(organizations.intakeToken, token));
  if (!org) throw new InboundRejected(404, 'Unknown intake address.');

  const usable: IncomingFile[] = [];
  const ignored: string[] = [];
  for (const file of message.attachments) {
    if (READABLE.has(sniffMime(file)) && file.bytes.byteLength >= MIN_BYTES) usable.push(file);
    else ignored.push(file.filename);
  }
  // Without a Message-ID, identical sender + subject + attachments is the same message.
  const key = message.messageId ?? `content:${sha256Hex([message.from ?? '', message.subject ?? '', ...usable.map((f) => sha256Hex(f.bytes)).sort()].join('\n'))}`;
  const policy = resolveSettings(org.settings).unknownSenderPolicy;

  return withOrgLock(db, org.id, async (tx) => {
    const [seen] = await tx.select().from(inboundMessages).where(and(eq(inboundMessages.orgId, org.id), eq(inboundMessages.messageId, key)));
    if (seen) return { outcome: 'duplicate', id: seen.payApplicationId };

    const log = async (outcome: 'accepted' | 'rejected', reason: string | null, payApplicationId: string | null) => {
      await tx.insert(inboundMessages).values({ id: newId('inb'), orgId: org.id, messageId: key, fromEmail: message.from, subject: message.subject?.slice(0, 300) ?? null, outcome, reason, attachments: message.attachments.length, payApplicationId });
    };

    if (usable.length === 0) {
      const reason = message.attachments.length === 0 ? 'The message had no attachments.' : 'None of the attachments was a PDF or an image of a document.';
      await log('rejected', reason, null);
      return { outcome: 'rejected', reason };
    }

    if (policy === 'reject') {
      const contacts = await tx.select({ email: subcontractors.contactEmail }).from(subcontractors).where(eq(subcontractors.orgId, org.id));
      const team = await tx.select({ email: users.email }).from(memberships).innerJoin(users, eq(users.id, memberships.userId)).where(and(eq(memberships.orgId, org.id), eq(memberships.status, 'active')));
      const known = contacts.some((c) => classifySender(message.from, c.email, []) !== 'unknown') || classifySender(message.from, null, team.map((t) => t.email)) === 'team';
      if (!known) {
        const reason = `The sender ${message.from ?? '(no address)'} is not on file for any subcontractor, and this organisation only accepts email from known senders.`;
        // Tell the team once a day per sender, so a real subcontractor using a new address is noticed and a flood is not.
        const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
        const [recent] = message.from
          ? await tx.select({ id: inboundMessages.id }).from(inboundMessages).where(and(eq(inboundMessages.orgId, org.id), eq(inboundMessages.fromEmail, message.from), eq(inboundMessages.outcome, 'rejected'), gte(inboundMessages.createdAt, since))).limit(1)
          : [];
        await log('rejected', reason, null);
        if (!recent) {
          await notifyPermission(tx, org.id, 'application:review', {
            type: 'intake.sender_rejected',
            title: 'An emailed billing package was turned away',
            body: `From ${message.from ?? 'an unknown address'}${message.subject ? `, “${message.subject.slice(0, 80)}”` : ''}. Add the address to the subcontractor’s record and ask them to send it again.`,
            href: '/settings/system#intake',
          });
        }
        return { outcome: 'rejected', reason };
      }
    }

    try {
      const { id } = await createApplication(tx, { system: true, orgId: org.id, name: 'Email intake' }, { files: usable, receivedVia: 'email', senderEmail: message.from });
      await log('accepted', ignored.length ? `Ignored: ${ignored.join(', ')}` : null, id);
      return { outcome: 'accepted', id, files: usable.map((f) => f.filename), ignored };
    } catch (err) {
      if (!(err instanceof UserError)) throw err;
      // createApplication wrote nothing before it refused (it validates first), so logging here is safe.
      await log('rejected', err.message, null);
      return { outcome: 'rejected', reason: err.message };
    }
  });
}

/** The most recent messages that reached the intake address, for the system status screen. */
export async function listInboundMessages(db: DB, ctx: Ctx, limit = 25) {
  return db.select().from(inboundMessages).where(eq(inboundMessages.orgId, ctx.orgId)).orderBy(desc(inboundMessages.createdAt)).limit(limit);
}
