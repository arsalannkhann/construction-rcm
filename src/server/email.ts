/**
 * Outbound email. One provider (Resend's REST API) behind one function.
 *
 * The return value is the literal delivery outcome. With no provider
 * configured the message is NOT sent and the caller records it as a draft;
 * nothing in the product ever reports a message as sent unless the provider
 * accepted it.
 *
 * Checked against Resend's API documentation (2026-11-16):
 *   - Every request must carry a User-Agent header (403 without one).
 *   - `Idempotency-Key`: the same key with the same body within 24 hours gets
 *     the original answer and sends nothing new; a different body is 409
 *     `invalid_idempotent_request`; the same key still in progress is 409
 *     `concurrent_idempotent_requests`.
 *   - 429 is a rate limit (`rate_limit_exceeded`, 10 requests a second per
 *     team by default) or a spent quota (`daily_quota_exceeded`,
 *     `monthly_quota_exceeded`).
 *
 * So a message with a key is retried once after a lost answer, a 5xx or a rate
 * limit, and the key makes the retry safe. When no answer ever arrives the
 * outcome is `unconfirmed`, not `failed`: the provider may have sent it, and
 * sending it again could reach the recipient twice.
 *
 * Not exercised against the live Resend API from this repository.
 */
import { emailConfig } from './config';

export type EmailResult =
  | { status: 'sent'; provider: 'resend'; providerRef: string | null }
  | { status: 'not_sent'; provider: null; reason: string }
  | { status: 'failed'; provider: 'resend'; error: string }
  /** No answer from the provider: it may or may not have sent the message. */
  | { status: 'unconfirmed'; provider: 'resend'; error: string };

export type OutgoingEmail = {
  to: string;
  subject: string;
  text: string;
  replyTo?: string;
  /**
   * Identifies this one message (for example the id of its record), so a retry
   * cannot send it twice. Without one, nothing is retried.
   */
  idempotencyKey?: string;
};

const ENDPOINT = 'https://api.resend.com/emails';
const USER_AGENT = 'Zephric/1.0';
const TIMEOUT_MS = 15_000;
const RETRY_DELAY_MS = 1_000;

type Attempt =
  | { kind: 'answer'; status: number; body: string; retryable: boolean }
  /** The request may have reached the provider; no answer came back. */
  | { kind: 'lost'; error: string };

export async function sendEmail(message: OutgoingEmail, opts: { fetchImpl?: typeof fetch; retryDelayMs?: number } = {}): Promise<EmailResult> {
  const config = emailConfig();
  if (!config.configured) {
    return { status: 'not_sent', provider: null, reason: 'Email delivery is not configured on this deployment (RESEND_API_KEY and EMAIL_FROM).' };
  }
  const doFetch = opts.fetchImpl ?? fetch;
  const headers: Record<string, string> = { Authorization: `Bearer ${config.apiKey}`, 'Content-Type': 'application/json', 'User-Agent': USER_AGENT };
  if (message.idempotencyKey) headers['Idempotency-Key'] = message.idempotencyKey.slice(0, 256);
  const body = JSON.stringify({ from: config.from, to: [message.to], subject: message.subject, text: message.text, ...(message.replyTo ? { reply_to: message.replyTo } : {}) });

  const attempt = async (): Promise<Attempt> => {
    try {
      const res = await doFetch(ENDPOINT, { method: 'POST', headers, body, signal: AbortSignal.timeout(TIMEOUT_MS) });
      const text = await res.text().catch(() => '');
      const name = errorName(text);
      const retryable = res.status >= 500 || (res.status === 429 && name === 'rate_limit_exceeded') || (res.status === 409 && name === 'concurrent_idempotent_requests');
      return { kind: 'answer', status: res.status, body: text, retryable };
    } catch (err) {
      const timedOut = err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError');
      return { kind: 'lost', error: timedOut ? `no answer within ${TIMEOUT_MS / 1000} seconds` : err instanceof Error ? err.message : 'the provider could not be reached' };
    }
  };

  let result = await attempt();
  // Only with a key: then the provider recognises a repeat and does not send it again.
  if (message.idempotencyKey && (result.kind === 'lost' || result.retryable)) {
    await new Promise((r) => setTimeout(r, opts.retryDelayMs ?? RETRY_DELAY_MS));
    result = await attempt();
  }

  if (result.kind === 'lost') {
    return {
      status: 'unconfirmed',
      provider: 'resend',
      error: `The email provider did not confirm the message (${result.error}). It may have been sent. Check with the recipient before sending it again.`,
    };
  }
  if (result.status >= 200 && result.status < 300) {
    let id: string | null = null;
    try {
      id = (JSON.parse(result.body) as { id?: string }).id ?? null;
    } catch {
      /* accepted, without an id we can read */
    }
    return { status: 'sent', provider: 'resend', providerRef: id };
  }
  if (result.status === 409 && errorName(result.body) === 'concurrent_idempotent_requests') {
    return { status: 'unconfirmed', provider: 'resend', error: 'The email provider was still sending this message when asked again. It may have been sent. Check with the recipient before sending it again.' };
  }
  return { status: 'failed', provider: 'resend', error: describeRefusal(result.status, result.body) };
}

function errorName(body: string): string | null {
  try {
    const name = (JSON.parse(body) as { name?: unknown }).name;
    return typeof name === 'string' ? name : null;
  } catch {
    return null;
  }
}

/** The provider's refusal in a sentence, with its own error name and message (never the API key). */
function describeRefusal(status: number, body: string): string {
  let name: string | null = null;
  let detail: string | null = null;
  try {
    const json = JSON.parse(body) as { name?: unknown; message?: unknown };
    name = typeof json.name === 'string' ? json.name : null;
    detail = typeof json.message === 'string' ? json.message.slice(0, 200) : null;
  } catch {
    detail = body ? body.slice(0, 200) : null;
  }
  const why =
    name === 'daily_quota_exceeded' || name === 'monthly_quota_exceeded'
      ? 'The email account has used up its sending quota.'
      : name === 'rate_limit_exceeded'
        ? 'The email provider is limiting how fast messages can be sent; try again in a minute.'
        : status === 401 || status === 403
          ? 'The email provider refused the API key or the sending address.'
          : null;
  return `${why ? `${why} ` : ''}Email provider returned HTTP ${status}${name ? ` ${name}` : ''}${detail ? `: ${detail}` : ''}`;
}

export function emailDeliveryConfigured(): boolean {
  return emailConfig().configured;
}
