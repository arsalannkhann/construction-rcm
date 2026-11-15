/**
 * Outbound email. One provider (Resend's REST API) behind one function.
 *
 * The return value is the literal delivery outcome. With no provider
 * configured the message is NOT sent and the caller records it as a draft;
 * nothing in the product ever reports a message as sent unless the provider
 * accepted it.
 *
 * Not exercised against the live Resend API from this repository.
 */
import { emailConfig } from './config';

export type EmailResult =
  | { status: 'sent'; provider: 'resend'; providerRef: string | null }
  | { status: 'not_sent'; provider: null; reason: string }
  | { status: 'failed'; provider: 'resend'; error: string };

export async function sendEmail(message: { to: string; subject: string; text: string; replyTo?: string }): Promise<EmailResult> {
  const config = emailConfig();
  if (!config.configured) {
    return { status: 'not_sent', provider: null, reason: 'Email delivery is not configured on this deployment (RESEND_API_KEY and EMAIL_FROM).' };
  }
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${config.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: config.from, to: [message.to], subject: message.subject, text: message.text, reply_to: message.replyTo }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      return { status: 'failed', provider: 'resend', error: `Email provider returned HTTP ${res.status}${body ? `: ${body.slice(0, 200)}` : ''}` };
    }
    const json = (await res.json().catch(() => ({}))) as { id?: string };
    return { status: 'sent', provider: 'resend', providerRef: json.id ?? null };
  } catch (err) {
    return { status: 'failed', provider: 'resend', error: err instanceof Error ? err.message : 'The email provider could not be reached.' };
  }
}

export function emailDeliveryConfigured(): boolean {
  return emailConfig().configured;
}
