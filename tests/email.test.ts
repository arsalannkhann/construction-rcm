/**
 * Outbound email through Resend's API, with the provider stubbed. Covers what
 * Resend's documentation requires of a client (a User-Agent; an
 * Idempotency-Key for safe retries) and how each answer, or the lack of one,
 * is reported. Nothing here talks to the real API.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sendEmail } from '@/server/email';

type Call = { url: string; headers: Record<string, string>; body: Record<string, unknown> };

/** A provider that gives the answers in order (a Response, or an error to throw), recording each request. */
function provider(...answers: Array<Response | Error>) {
  const calls: Call[] = [];
  const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), headers: init?.headers as Record<string, string>, body: JSON.parse(String(init?.body)) });
    const next = answers.shift();
    if (!next) throw new Error('no more answers');
    if (next instanceof Error) throw next;
    return next;
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const timeout = () => Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });
const message = { to: 'maria@lonestarelectric.example', subject: 'Pay application #2', text: 'Please send the waiver.', replyTo: 'ap@northline.example' };
const fast = { retryDelayMs: 0 };

beforeEach(() => {
  process.env.RESEND_API_KEY = 're_test_key';
  process.env.EMAIL_FROM = 'Northline AP <ap@northline.example>';
});
afterEach(() => {
  delete process.env.RESEND_API_KEY;
  delete process.env.EMAIL_FROM;
});

describe('sending email through the provider', () => {
  it('sends what Resend requires: a User-Agent, the key, and reply_to', async () => {
    const p = provider(json(200, { id: 'em_1' }));
    expect(await sendEmail({ ...message, idempotencyKey: 'msg_1' }, { ...fast, fetchImpl: p.fetchImpl })).toEqual({ status: 'sent', provider: 'resend', providerRef: 'em_1' });
    const [call] = p.calls;
    expect(call!.url).toBe('https://api.resend.com/emails');
    expect(call!.headers).toMatchObject({ Authorization: 'Bearer re_test_key', 'User-Agent': 'Zephric/1.0', 'Idempotency-Key': 'msg_1' });
    expect(call!.body).toEqual({ from: 'Northline AP <ap@northline.example>', to: ['maria@lonestarelectric.example'], subject: 'Pay application #2', text: 'Please send the waiver.', reply_to: 'ap@northline.example' });

    const bare = provider(json(200, { id: 'em_2' }));
    await sendEmail({ to: message.to, subject: 's', text: 't' }, { ...fast, fetchImpl: bare.fetchImpl });
    expect(bare.calls[0]!.body).not.toHaveProperty('reply_to');
    expect(bare.calls[0]!.headers).not.toHaveProperty('Idempotency-Key');
  });

  it('retries a lost answer once with the same key, so the message is sent once', async () => {
    const p = provider(new TypeError('fetch failed'), json(200, { id: 'em_3' }));
    expect(await sendEmail({ ...message, idempotencyKey: 'msg_3' }, { ...fast, fetchImpl: p.fetchImpl })).toMatchObject({ status: 'sent', providerRef: 'em_3' });
    expect(p.calls.map((c) => c.headers['Idempotency-Key'])).toEqual(['msg_3', 'msg_3']);
    expect(p.calls[0]!.body).toEqual(p.calls[1]!.body);
  });

  it('says "not confirmed", not "failed", when no answer ever comes', async () => {
    const twice = provider(timeout(), timeout());
    const r = await sendEmail({ ...message, idempotencyKey: 'msg_4' }, { ...fast, fetchImpl: twice.fetchImpl });
    expect(r).toMatchObject({ status: 'unconfirmed' });
    expect(r.status === 'unconfirmed' && r.error).toMatch(/no answer within 15 seconds\). It may have been sent/);

    // Without a key a retry could send it twice, so there is none.
    const once = provider(new TypeError('fetch failed'));
    expect(await sendEmail(message, { ...fast, fetchImpl: once.fetchImpl })).toMatchObject({ status: 'unconfirmed' });
    expect(once.calls).toHaveLength(1);
  });

  it('retries a server error or a rate limit once, but not a spent quota or a refusal', async () => {
    expect(await sendEmail({ ...message, idempotencyKey: 'k1' }, { ...fast, fetchImpl: provider(json(500, { name: 'internal_server_error' }), json(200, { id: 'em_5' })).fetchImpl })).toMatchObject({ status: 'sent' });
    expect(await sendEmail({ ...message, idempotencyKey: 'k2' }, { ...fast, fetchImpl: provider(json(429, { name: 'rate_limit_exceeded', message: 'Too many requests' }), json(200, { id: 'em_6' })).fetchImpl })).toMatchObject({ status: 'sent' });

    const quota = provider(json(429, { name: 'daily_quota_exceeded', message: 'You have reached your daily email sending quota.' }));
    const q = await sendEmail({ ...message, idempotencyKey: 'k3' }, { ...fast, fetchImpl: quota.fetchImpl });
    expect(quota.calls).toHaveLength(1);
    expect(q.status === 'failed' && q.error).toMatch(/^The email account has used up its sending quota\. Email provider returned HTTP 429 daily_quota_exceeded/);

    const refused = provider(json(422, { name: 'invalid_parameter', message: 'Invalid `to` field.' }));
    const f = await sendEmail({ ...message, idempotencyKey: 'k4' }, { ...fast, fetchImpl: refused.fetchImpl });
    expect(refused.calls).toHaveLength(1);
    expect(f.status === 'failed' && f.error).toBe('Email provider returned HTTP 422 invalid_parameter: Invalid `to` field.');

    const down = provider(json(503, {}), json(503, {}));
    expect(await sendEmail({ ...message, idempotencyKey: 'k5' }, { ...fast, fetchImpl: down.fetchImpl })).toMatchObject({ status: 'failed', error: expect.stringContaining('HTTP 503') });
  });

  it('treats "the same key is still in progress" as not confirmed', async () => {
    const busy = () => json(409, { name: 'concurrent_idempotent_requests', message: 'Same idempotency key used while original request is still in progress.' });
    expect(await sendEmail({ ...message, idempotencyKey: 'k6' }, { ...fast, fetchImpl: provider(busy(), busy()).fetchImpl })).toMatchObject({ status: 'unconfirmed' });
    expect(await sendEmail({ ...message, idempotencyKey: 'k7' }, { ...fast, fetchImpl: provider(busy(), json(200, { id: 'em_8' })).fetchImpl })).toMatchObject({ status: 'sent', providerRef: 'em_8' });
  });

  it('sends nothing and says so when no provider is configured', async () => {
    delete process.env.RESEND_API_KEY;
    const p = provider();
    expect(await sendEmail(message, { fetchImpl: p.fetchImpl })).toMatchObject({ status: 'not_sent' });
    expect(p.calls).toHaveLength(0);
  });
});
