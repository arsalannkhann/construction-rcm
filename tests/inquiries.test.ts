/**
 * The public website's "design partner" form: what is stored, what is refused,
 * and how often it can be sent.
 */
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { POST } from '@/app/api/inquiries/route';
import { getDb } from '@/db';
import { inquiries } from '@/db/schema';
import { INQUIRY_CONSENT_VERSION, OVERALL, PER_SENDER, receiveInquiry, sameSite, senderHash } from '@/server/services/inquiries';

const valid = {
  name: '  Alex Morgan ',
  email: 'alex@northline.example',
  company: 'Northline Constructors',
  country: 'United States',
  role: 'Controller',
  challenge: 'Retainage on subcontractor billing is checked by hand every month.',
  website: '',
  consent: true,
};

const post = (body: unknown, headers: Record<string, string> = {}) =>
  POST(
    new Request('https://zephric.example/api/inquiries', {
      method: 'POST',
      headers: { host: 'zephric.example', origin: 'https://zephric.example', 'content-type': 'application/json', 'x-forwarded-for': '203.0.113.7', ...headers },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    }),
  );

describe('the inquiry endpoint', () => {
  it('stores a valid inquiry and answers with a short reference, keeping no network address', async () => {
    const db = await getDb();
    const res = await post(valid);
    expect(res.status).toBe(201);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const { reference } = (await res.json()) as { reference: string };
    expect(reference).toMatch(/^[0-9A-Z]{8}$/);

    const rows = await db.select().from(inquiries).where(eq(inquiries.email, valid.email));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: expect.stringMatching(new RegExp(`^inq_${reference.toLowerCase()}`)),
      name: 'Alex Morgan',
      company: 'Northline Constructors',
      country: 'United States',
      role: 'Controller',
      challenge: valid.challenge,
      consentVersion: INQUIRY_CONSENT_VERSION,
      senderHash: senderHash('203.0.113.7'),
    });
    expect(rows[0]!.senderHash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(rows[0])).not.toContain('203.0.113.7');
  });

  it('refuses a form sent from another site, a body that is not JSON, and one that is too large', async () => {
    const db = await getDb();
    const before = (await db.select().from(inquiries)).length;
    expect((await post(valid, { origin: 'https://elsewhere.example' })).status).toBe(403);
    expect((await post(valid, { origin: 'not a url' })).status).toBe(403);
    expect((await post(valid, { 'content-type': 'text/plain' })).status).toBe(415);
    expect((await post({ ...valid, challenge: 'x'.repeat(20_000) })).status).toBe(413);
    const bad = await post('{"name":');
    expect(bad.status).toBe(400);
    expect(await bad.json()).toEqual({ error: 'Invalid JSON request.' });
    expect(await db.select().from(inquiries)).toHaveLength(before);
  });

  it('explains what is wrong with an incomplete form and stores nothing', async () => {
    const db = await getDb();
    const before = (await db.select().from(inquiries)).length;
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ ...valid, name: '   ' }, 'Please provide a valid name.'],
      [{ ...valid, email: 'alex at northline' }, 'Please provide a valid email address.'],
      [{ ...valid, company: 'x'.repeat(161) }, 'Please provide a valid company.'],
      [{ ...valid, role: 'Controller\u0007' }, 'Please provide a valid role.'],
      [{ ...valid, challenge: 'Too short' }, 'Please describe your challenge in at least 10 characters.'],
      [{ ...valid, consent: 'yes' }, 'Please agree to be contacted about your inquiry.'],
      [{ ...valid, website: 'https://spam.example' }, 'Unable to accept this inquiry.'],
      [{ ...valid, country: undefined }, 'Please provide a valid country.'],
    ];
    for (const [body, error] of cases) {
      const res = await post(body);
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error });
    }
    expect((await post([valid])).status).toBe(400);
    expect(await db.select().from(inquiries)).toHaveLength(before);
  });
});

describe('how often the form can be sent', () => {
  const minutes = (n: number) => n * 60_000;

  it('lets one address send five in ten minutes, without holding up anyone else', async () => {
    const db = await getDb();
    const start = new Date('2030-01-01T10:00:00Z');
    const at = (ms: number) => new Date(start.getTime() + ms);
    for (let i = 0; i < PER_SENDER.limit; i++) {
      expect(await receiveInquiry(db, valid, { address: '198.51.100.1' }, at(minutes(i)))).toMatchObject({ ok: true });
    }
    expect(await receiveInquiry(db, valid, { address: '198.51.100.1' }, at(minutes(6)))).toEqual({ ok: false, status: 429, error: 'Too many attempts. Please try again in a few minutes.' });
    expect(await receiveInquiry(db, valid, { address: '198.51.100.2' }, at(minutes(6)))).toMatchObject({ ok: true });
    // Ten minutes after the first, there is room again.
    expect(await receiveInquiry(db, valid, { address: '198.51.100.1' }, at(minutes(10) + 1000))).toMatchObject({ ok: true });
  });

  it('stops everyone once a hundred have arrived in an hour', async () => {
    const db = await getDb();
    const start = new Date('2030-02-01T10:00:00Z');
    await db.insert(inquiries).values(
      Array.from({ length: OVERALL.limit }, (_, i) => ({
        id: `inq_flood${String(i).padStart(4, '0')}`,
        name: 'Flood',
        email: `flood${i}@example.test`,
        company: 'Flood',
        country: 'Other',
        role: 'Other',
        challenge: 'Ten characters or more.',
        consentVersion: INQUIRY_CONSENT_VERSION,
        senderHash: senderHash(`192.0.2.${i % 250}`),
        createdAt: new Date(start.getTime() + i * 1000),
      })),
    );
    const later = new Date(start.getTime() + minutes(30));
    expect(await receiveInquiry(db, valid, { address: '198.51.100.99' }, later)).toEqual({ ok: false, status: 429, error: 'We are receiving a lot of inquiries right now. Please try again in an hour.' });
    expect(await receiveInquiry(db, valid, { address: null }, later)).toMatchObject({ ok: false, status: 429 });
    expect(await receiveInquiry(db, valid, { address: '198.51.100.99' }, new Date(start.getTime() + minutes(61) + OVERALL.limit * 1000))).toMatchObject({ ok: true });
  });
});

describe('where a form came from', () => {
  it('accepts its own site, or no Origin at all, and nothing else', () => {
    expect(sameSite(null, 'zephric.example')).toBe(true);
    expect(sameSite('https://zephric.example', 'zephric.example')).toBe(true);
    expect(sameSite('http://localhost:3000', 'localhost:3000')).toBe(true);
    expect(sameSite('https://zephric.example.evil.test', 'zephric.example')).toBe(false);
    expect(sameSite('https://zephric.example', null)).toBe(false);
    expect(sameSite('null', 'zephric.example')).toBe(false);
  });
});
