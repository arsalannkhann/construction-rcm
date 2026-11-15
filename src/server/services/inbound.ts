/**
 * Email intake.
 *
 * An inbound-email provider (Postmark's inbound webhook format is accepted
 * as-is, as is a small generic JSON shape and a raw RFC 822 message) posts
 * incoming mail to /api/inbound/email/<organisation intake token>. Attachments
 * become a new billing package, exactly as if they had been uploaded.
 *
 * The endpoint is closed unless INBOUND_EMAIL_SECRET is set, and every request
 * must present it. Not exercised against a live provider from this repository.
 */
import { timingSafeEqual } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { DB } from '@/db';
import { organizations } from '@/db/schema';
import { UserError } from '@/server/auth/permissions';
import { inboundEmailSecret } from '@/server/config';
import { createApplication, sniffMime, type IncomingFile } from './intake';

export class InboundRejected extends Error {
  constructor(
    public status: 401 | 404 | 422 | 503,
    message: string,
  ) {
    super(message);
    this.name = 'InboundRejected';
  }
}

export type InboundMessage = { from: string | null; subject: string | null; attachments: IncomingFile[] };

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

/** Accept Postmark's inbound JSON, or `{ from, subject, attachments: [{ filename, contentBase64, contentType }] }`. */
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
  return {
    from: addressOf(b.From ?? b.from ?? (b.FromFull as Record<string, unknown> | undefined)?.Email),
    subject: typeof (b.Subject ?? b.subject) === 'string' ? String(b.Subject ?? b.subject) : null,
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

/** Turn an inbound message into a billing package for the organisation that owns the token. */
export async function receiveInboundEmail(db: DB, token: string, presentedSecret: string | null, message: InboundMessage): Promise<{ id: string; files: string[]; ignored: string[] }> {
  if (!inboundSecretMatches(presentedSecret)) throw new InboundRejected(401, 'The shared secret is missing or wrong.');
  const [org] = await db.select().from(organizations).where(eq(organizations.intakeToken, token));
  if (!org) throw new InboundRejected(404, 'Unknown intake address.');

  const usable: IncomingFile[] = [];
  const ignored: string[] = [];
  for (const file of message.attachments) {
    if (READABLE.has(sniffMime(file)) && file.bytes.byteLength >= MIN_BYTES) usable.push(file);
    else ignored.push(file.filename);
  }
  if (usable.length === 0) throw new InboundRejected(422, 'The message has no PDF or image attachments to process.');

  try {
    const { id } = await createApplication(db, { system: true, orgId: org.id, name: 'Email intake' }, { files: usable, receivedVia: 'email', senderEmail: message.from });
    return { id, files: usable.map((f) => f.filename), ignored };
  } catch (err) {
    if (err instanceof UserError) throw new InboundRejected(422, err.message);
    throw err;
  }
}
