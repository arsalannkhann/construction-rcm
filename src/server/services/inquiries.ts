/**
 * The "design partner" form on the public website (src/components/marketing/partner-form.tsx).
 *
 * Anyone can send it, without signing in, so it is kept narrow: six short text
 * fields and an explicit agreement, a size limit, a check that the form was
 * sent from this site, and limits on how often one address, and everyone
 * together, can send. The sender's address is not stored, only a keyed hash
 * of it, which is all the per-address limit needs.
 *
 * What was sent is never logged. Nothing in the app shows inquiries; whoever
 * runs Zephric reads them in the database (docs/operations.md, "Website
 * inquiries").
 */
import { createHmac } from 'node:crypto';
import { and, count, eq, gt } from 'drizzle-orm';
import type { DB } from '@/db';
import { inquiries } from '@/db/schema';
import { purposeKey } from '../crypto';
import { newId } from '../ids';

/** The date of the privacy notice the form links to; stored with each inquiry. */
export const INQUIRY_CONSENT_VERSION = '2026-11-16';
export const MAX_INQUIRY_BYTES = 16_384;
/** One address may send this many inquiries in ten minutes. */
export const PER_SENDER = { limit: 5, windowMs: 10 * 60_000 };
/** Everyone together may send this many in an hour; a flood stops here, whatever addresses it comes from. */
export const OVERALL = { limit: 100, windowMs: 60 * 60_000 };

const FIELDS = { name: 120, email: 254, company: 160, country: 80, role: 100, challenge: 3000 } as const;
type Field = keyof typeof FIELDS;
const LABEL: Record<Field, string> = { name: 'name', email: 'work email', company: 'company', country: 'country', role: 'role', challenge: 'description of your challenge' };

export type InquiryInput = Record<Field, string>;
export type InquiryResult = { ok: true; reference: string } | { ok: false; status: 400 | 429; error: string };

/** The error to show for this submission, or null when it can be stored. */
export function validateInquiry(value: unknown): string | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return 'Invalid inquiry.';
  const v = value as Record<string, unknown>;
  for (const [key, max] of Object.entries(FIELDS) as Array<[Field, number]>) {
    const field = v[key];
    // eslint-disable-next-line no-control-regex
    if (typeof field !== 'string' || !field.trim() || field.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(field)) {
      return `Please provide a valid ${LABEL[key]}.`;
    }
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test((v.email as string).trim())) return 'Please provide a valid email address.';
  if ((v.challenge as string).trim().length < 10) return 'Please describe your challenge in at least 10 characters.';
  if (v.consent !== true) return 'Please agree to be contacted about your inquiry.';
  // A field people cannot see; only scripts fill it in.
  if (v.website) return 'Unable to accept this inquiry.';
  return null;
}

/** True when a browser says the form was sent from a page on this same site (or says nothing, as non-browser clients do). */
export function sameSite(origin: string | null, host: string | null): boolean {
  if (!origin) return true;
  if (!host) return false;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

export function senderHash(address: string | null): string | null {
  return address ? createHmac('sha256', purposeKey('inquiry-sender')).update(address).digest('hex') : null;
}

export async function receiveInquiry(db: DB, input: unknown, sender: { address: string | null }, now = new Date()): Promise<InquiryResult> {
  const error = validateInquiry(input);
  if (error) return { ok: false, status: 400, error };
  const v = input as InquiryInput;

  const hash = senderHash(sender.address);
  const since = (ms: number) => new Date(now.getTime() - ms);
  const [overall] = await db.select({ n: count() }).from(inquiries).where(gt(inquiries.createdAt, since(OVERALL.windowMs)));
  if ((overall?.n ?? 0) >= OVERALL.limit) return { ok: false, status: 429, error: 'We are receiving a lot of inquiries right now. Please try again in an hour.' };
  if (hash) {
    const [mine] = await db
      .select({ n: count() })
      .from(inquiries)
      .where(and(eq(inquiries.senderHash, hash), gt(inquiries.createdAt, since(PER_SENDER.windowMs))));
    if ((mine?.n ?? 0) >= PER_SENDER.limit) return { ok: false, status: 429, error: 'Too many attempts. Please try again in a few minutes.' };
  }

  const id = newId('inq');
  await db.insert(inquiries).values({
    id,
    name: v.name.trim(),
    email: v.email.trim(),
    company: v.company.trim(),
    country: v.country.trim(),
    role: v.role.trim(),
    challenge: v.challenge.trim(),
    consentVersion: INQUIRY_CONSENT_VERSION,
    senderHash: hash,
    createdAt: now,
  });
  return { ok: true, reference: id.slice(4, 12).toUpperCase() };
}
