/**
 * Authentication at the service layer, against a real Postgres (PGlite under
 * `pnpm test`, PostgreSQL under `pnpm test:pg`): the password rule, password
 * reset, two-step verification and recovery codes, the login challenge,
 * sessions, the database-backed throttle, the organisation's requireMfa
 * policy, administrator recovery actions, tenant isolation and the audit trail.
 */
import { and, eq, inArray } from 'drizzle-orm';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { DB } from '@/db';
import { auditEvents, authAttempts, loginChallenges, memberships, notifications, passwordResets, sessions, users } from '@/db/schema';
import { verifyAuditChain } from '@/server/audit';
import { hashPassword } from '@/server/auth/password';
import { PASSWORD_MIN_LENGTH, passwordProblem } from '@/server/auth/password-rules';
import { completePasswordReset, createOperatorResetLink, findPasswordReset, requestPasswordReset, RESET_LINK_MINUTES } from '@/server/auth/password-reset';
import { disableMfa, getMfaStatus, regenerateRecoveryCodes, resetMfaByOperator, startMfaSetup, confirmMfaSetup } from '@/server/auth/mfa';
import { PermissionError } from '@/server/auth/permissions';
import { qrSvgDataUri } from '@/server/auth/qr';
import { clientIp } from '@/server/auth/request-meta';
import { CHALLENGE_MAX_ATTEMPTS, completeSecondStep, createLoginChallenge, findLoginChallenge, signIn } from '@/server/auth/sign-in';
import { MFA_ATTEMPTS_PER_USER, PASSWORD_ATTEMPTS_PER_EMAIL, PASSWORD_ATTEMPTS_PER_IP, passwordLimits, pruneAuthRecords, reserveAttempt } from '@/server/auth/throttle';
import {
  base32Decode,
  base32Encode,
  generateRecoveryCodes,
  generateTotpSecret,
  hashRecoveryCode,
  hotp,
  otpauthUri,
  totpCode,
  totpCounter,
  verifyTotp,
} from '@/server/auth/totp';
import { describeUserAgent } from '@/server/auth/user-agent';
import { appUrl } from '@/server/config';
import { newId, sha256Hex } from '@/server/ids';
import {
  acceptInvitation,
  authenticate,
  findInvitation,
  changePassword,
  createSession,
  destroySession,
  inviteMember,
  issueMemberPasswordReset,
  listMembers,
  listSessions,
  resetMemberMfa,
  resolveSession,
  revokeInvitation,
  revokeOtherSessions,
  revokeSession,
  SESSION_IDLE_DAYS,
  signUp,
  switchOrganization,
  TOO_MANY_SIGN_INS,
  updatePolicy,
} from '@/server/services/team';
import { addMember, createWorld, type World } from './helpers/world';
import { at, enableMfa, minutes, PASSWORD, sessionRows, userRow, verifiedSession } from './helpers/auth';

const DAY = 86_400_000;
const tokenOf = (link: string) => link.split('/reset-password/')[1]!;
const eventsFor = (db: DB, orgId: string, action: string) =>
  db.select().from(auditEvents).where(and(eq(auditEvents.orgId, orgId), eq(auditEvents.action, action))).orderBy(auditEvents.seq);
const withEmail = () => {
  process.env.RESEND_API_KEY = 're_test_key';
  process.env.EMAIL_FROM = 'security@northline.example';
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  delete process.env.RESEND_API_KEY;
  delete process.env.EMAIL_FROM;
});

// ── TOTP ────────────────────────────────────────────────────────────────────

describe('TOTP (RFC 6238 / RFC 4226)', () => {
  // The SHA-1 seed from RFC 6238 appendix B: the ASCII string "12345678901234567890".
  const seed = Buffer.from('12345678901234567890', 'ascii');
  const seedBase32 = base32Encode(seed);

  it('matches the RFC 6238 SHA-1 test vectors', () => {
    const vectors: Array<[seconds: number, code: string]> = [
      [59, '94287082'],
      [1111111109, '07081804'],
      [1111111111, '14050471'],
      [1234567890, '89005924'],
      [2000000000, '69279037'],
      [20000000000, '65353130'],
    ];
    for (const [seconds, code] of vectors) {
      expect(hotp(seed, totpCounter(seconds * 1000), 8)).toBe(code);
      // Six digits, as authenticator apps show, are the last six of the eight.
      expect(totpCode(seedBase32, seconds * 1000)).toBe(code.slice(-6));
    }
  });

  it('matches the RFC 4226 HOTP test vectors', () => {
    const expected = ['755224', '287082', '359152', '969429', '338314', '254676', '287922', '162583', '399871', '520489'];
    expected.forEach((code, counter) => expect(hotp(seed, counter)).toBe(code));
  });

  it('encodes keys as base32 the way authenticator apps read them', () => {
    expect(seedBase32).toBe('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
    expect(base32Decode(seedBase32)!.equals(seed)).toBe(true);
    // People retype keys in lower case, in groups, with padding.
    expect(base32Decode('gezd gnbv-gy3t qojq gezd gnbv gy3t qojq==')!.equals(seed)).toBe(true);
    expect(base32Decode('GEZD1')).toBeNull();
    expect(base32Decode('')).toBeNull();
    const secret = generateTotpSecret();
    expect(secret).toMatch(/^[A-Z2-7]{32}$/);
    expect(base32Decode(secret)!.length).toBe(20); // 160 bits
    expect(generateTotpSecret()).not.toBe(secret);
  });

  it('accepts the current step and one either side, and nothing further', () => {
    const now = 1_800_000_015_000;
    const step = totpCounter(now);
    const codeAt = (offsetSteps: number) => totpCode(seedBase32, now + offsetSteps * 30_000);
    expect(verifyTotp(seedBase32, codeAt(0), { at: now })).toBe(step);
    expect(verifyTotp(seedBase32, codeAt(-1), { at: now })).toBe(step - 1);
    expect(verifyTotp(seedBase32, codeAt(1), { at: now })).toBe(step + 1);
    expect(verifyTotp(seedBase32, codeAt(-2), { at: now })).toBeNull();
    expect(verifyTotp(seedBase32, codeAt(2), { at: now })).toBeNull();
    expect(verifyTotp(seedBase32, '12345', { at: now })).toBeNull();
    expect(verifyTotp(seedBase32, 'abcdef', { at: now })).toBeNull();
  });

  it('refuses a step at or before the last one accepted, so a code cannot be replayed', () => {
    const now = 1_800_000_015_000;
    const step = totpCounter(now);
    const code = totpCode(seedBase32, now);
    expect(verifyTotp(seedBase32, code, { at: now, after: step - 1 })).toBe(step);
    expect(verifyTotp(seedBase32, code, { at: now, after: step })).toBeNull();
    expect(verifyTotp(seedBase32, totpCode(seedBase32, now - 30_000), { at: now, after: step })).toBeNull();
    // The next step's code still works.
    expect(verifyTotp(seedBase32, totpCode(seedBase32, now + 30_000), { at: now + 30_000, after: step })).toBe(step + 1);
  });

  it('builds an otpauth URI and a QR code for it', async () => {
    const uri = otpauthUri({ secret: seedBase32, account: 'ana@example.test', issuer: 'Zephric' });
    expect(uri.startsWith('otpauth://totp/Zephric:ana%40example.test?')).toBe(true);
    const query = new URL(uri).searchParams;
    expect(query.get('secret')).toBe(seedBase32);
    expect(query.get('issuer')).toBe('Zephric');
    expect([query.get('algorithm'), query.get('digits'), query.get('period')]).toEqual(['SHA1', '6', '30']);
    const qr = await qrSvgDataUri(uri);
    expect(qr.startsWith('data:image/svg+xml;base64,')).toBe(true);
    expect(Buffer.from(qr.split(',')[1]!, 'base64').toString('utf8')).toMatch(/^<svg[\s\S]*<\/svg>\s*$/);
  });

  it('makes ten distinct recovery codes, compared without regard to case or the dash', () => {
    const codes = generateRecoveryCodes();
    expect(codes).toHaveLength(10);
    expect(new Set(codes).size).toBe(10);
    for (const code of codes) expect(code).toMatch(/^[2-9a-hjkmnp-tv-z]{5}-[2-9a-hjkmnp-tv-z]{5}$/);
    const code = codes[0]!;
    expect(hashRecoveryCode(code.toUpperCase().replace('-', ' '))).toBe(hashRecoveryCode(code));
    expect(hashRecoveryCode(code)).not.toBe(hashRecoveryCode(codes[1]!));
  });
});

// ── The password rule ───────────────────────────────────────────────────────

describe('the password rule', () => {
  it('asks for length, refuses common passwords and the account’s own email or name', () => {
    expect(passwordProblem('short')).toMatch(`at least ${PASSWORD_MIN_LENGTH} characters`);
    expect(passwordProblem('x'.repeat(201))).toMatch(/too long/);
    for (const common of ['password123', 'Password123', '1234567890', 'qwertyuiop', 'aaaaaaaaaaaa', 'Correct Horse Battery Staple']) {
      expect(passwordProblem(common)).toMatch(/most commonly used/);
    }
    expect(passwordProblem('ana.accountant@example.test', { email: 'ana.accountant@example.test' })).toMatch(/email address or your name/);
    expect(passwordProblem('Ana Accountant Smith', { name: 'ana accountantsmith' })).toMatch(/email address or your name/);
    // No character-class rules: a long phrase is fine.
    expect(passwordProblem('plumb line and ledger rule', { email: 'ana@example.test', name: 'Ana' })).toBeNull();
  });

  it('is applied at sign-up, on invitation, on change and on reset, but existing passwords keep working', async () => {
    const w = await createWorld();
    await expect(signUp(w.db, { name: 'Sam Signup', email: 'sam.signup@example.test', password: 'password123', orgName: 'Sam Co' })).rejects.toThrow(/most commonly used/);
    await expect(signUp(w.db, { name: 'Sam Signup', email: 'sam.signup@example.test', password: 'sam.signup@example.test', orgName: 'Sam Co' })).rejects.toThrow(/email address or your name/);
    // A refused sign-up leaves nothing behind.
    expect(await w.db.select().from(users).where(eq(users.email, 'sam.signup@example.test'))).toEqual([]);

    const { token } = await inviteMember(w.db, w.owner, { email: 'ian.invitee@example.test', role: 'viewer' });
    await expect(acceptInvitation(w.db, token, { name: 'Ian Invitee', password: 'qwerty123456' })).rejects.toThrow(/most commonly used/);
    await expect(changePassword(w.db, w.viewer.userId, PASSWORD, '1234567890')).rejects.toThrow(/most commonly used/);

    // An account made before the rule, with a password the rule would now refuse, still signs in.
    const id = newId('usr');
    await w.db.insert(users).values({ id, email: 'legacy@example.test', name: 'Lee Legacy', passwordHash: await hashPassword('password12') });
    expect(await authenticate(w.db, 'legacy@example.test', 'password12')).toMatchObject({ id });
  });
});

// ── Password reset ──────────────────────────────────────────────────────────

describe('password reset by email', () => {
  let w: World;
  beforeAll(async () => {
    w = await createWorld();
  });

  /** Run the deferred email straight away so the test can see it. */
  const collect = () => {
    const pending: Promise<void>[] = [];
    return { defer: (work: () => Promise<void>) => void pending.push(work()), settle: () => Promise.all(pending) };
  };

  it('says honestly that it cannot email anyone when delivery is not configured, for every address', async () => {
    const before = await w.db.select().from(passwordResets);
    expect(await requestPasswordReset(w.db, w.accountant.userEmail)).toBe('unavailable');
    expect(await requestPasswordReset(w.db, 'nobody-here@example.test')).toBe('unavailable');
    expect(await w.db.select().from(passwordResets)).toHaveLength(before.length);
  });

  it('gives the same answer whether or not the account exists, and only emails a real account', async () => {
    withEmail();
    const provider = vi.fn(async (_url: string, _init: RequestInit) => new Response(JSON.stringify({ id: 'em_1' }), { status: 200 }));
    vi.stubGlobal('fetch', provider);
    const run = collect();

    const real = await requestPasswordReset(w.db, ` ${w.pm.userEmail.toUpperCase()} `, { defer: run.defer });
    const fake = await requestPasswordReset(w.db, 'no-such-person@example.test', { defer: run.defer });
    await run.settle();
    expect(real).toBe('requested');
    expect(fake).toBe(real);
    expect(provider).toHaveBeenCalledTimes(1);

    const message = JSON.parse(String(provider.mock.calls[0]![1].body)) as { to: string[]; subject: string; text: string };
    expect(message.to).toEqual([w.pm.userEmail]);
    const link = /https?:\/\/\S+\/reset-password\/\S+/.exec(message.text)![0];
    expect(link.startsWith(`${appUrl()}/reset-password/`)).toBe(true);
    expect(message.text).toContain(`${RESET_LINK_MINUTES} minutes`);

    // Only the hash of the token is stored.
    const token = tokenOf(link);
    const rows = await w.db.select().from(passwordResets).where(eq(passwordResets.userId, w.pm.userId));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.tokenHash).toBe(sha256Hex(token));
    expect(JSON.stringify(rows)).not.toContain(token);
    expect(rows[0]!.issuedBy).toBeNull();
    expect(rows[0]!.expiresAt.getTime() - rows[0]!.createdAt.getTime()).toBe(RESET_LINK_MINUTES * 60_000);
    expect(await findPasswordReset(w.db, token)).toEqual({ email: w.pm.userEmail });
  });

  it('takes three requests per address per hour; after that it answers the same and sends nothing', async () => {
    withEmail();
    const provider = vi.fn(async () => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', provider);
    const run = collect();
    const target = await addMember(w.db, w.orgId, w.owner.orgName, 'viewer', 'Rita Requests');
    const outcomes = [];
    for (let i = 0; i < 5; i++) outcomes.push(await requestPasswordReset(w.db, target.userEmail, { defer: run.defer }));
    await run.settle();
    expect(outcomes).toEqual(['requested', 'requested', 'requested', 'requested', 'requested']);
    expect(provider).toHaveBeenCalledTimes(3);
    // Each new link replaced the one before, so exactly one works.
    expect(await w.db.select().from(passwordResets).where(eq(passwordResets.userId, target.userId))).toHaveLength(1);
    // An hour later it takes requests again.
    expect(await requestPasswordReset(w.db, target.userEmail, { defer: run.defer, now: new Date(Date.now() + 61 * 60_000) })).toBe('requested');
    await run.settle();
    expect(provider).toHaveBeenCalledTimes(4);
  });
});

describe('completing a password reset', () => {
  let w: World;
  beforeAll(async () => {
    w = await createWorld();
  });

  it('sets the password, signs the account out everywhere, and does not sign anyone in', async () => {
    const ana = await addMember(w.db, w.orgId, w.owner.orgName, 'accountant', 'Ana Again');
    const one = await createSession(w.db, ana.userId, w.orgId);
    await createSession(w.db, ana.userId, w.orgId);
    await createLoginChallenge(w.db, ana.userId);
    const { link } = await issueMemberPasswordReset(w.db, w.owner, ana.userId);

    await completePasswordReset(w.db, tokenOf(link), 'a brand new passphrase');
    expect(await sessionRows(w.db, ana.userId)).toEqual([]);
    expect(await resolveSession(w.db, one.token)).toBeNull();
    expect(await w.db.select().from(loginChallenges).where(eq(loginChallenges.userId, ana.userId))).toEqual([]);
    const user = await userRow(w.db, ana.userId);
    expect(user.passwordChangedAt).toBeInstanceOf(Date);
    expect(await authenticate(w.db, ana.userEmail, PASSWORD)).toBeNull();
    expect(await authenticate(w.db, ana.userEmail, 'a brand new passphrase')).toMatchObject({ id: ana.userId });
    // authenticate() is only the password check; still no session was created by the reset.
    expect(await sessionRows(w.db, ana.userId)).toEqual([]);
  });

  it('works once, expires, and is replaced by a newer link', async () => {
    const bo = await addMember(w.db, w.orgId, w.owner.orgName, 'viewer', 'Bo Links');
    const first = tokenOf((await issueMemberPasswordReset(w.db, w.owner, bo.userId)).link);
    const second = tokenOf((await issueMemberPasswordReset(w.db, w.owner, bo.userId)).link);
    expect(await findPasswordReset(w.db, first)).toBeNull();
    await expect(completePasswordReset(w.db, first, 'first link password')).rejects.toThrow(/no longer valid/);

    // A refused password does not use the link up.
    await expect(completePasswordReset(w.db, second, 'password123')).rejects.toThrow(/most commonly used/);
    await completePasswordReset(w.db, second, 'second link password');
    await expect(completePasswordReset(w.db, second, 'second link again!')).rejects.toThrow(/no longer valid/);
    expect(await authenticate(w.db, bo.userEmail, 'second link password')).toMatchObject({ id: bo.userId });

    const third = tokenOf((await issueMemberPasswordReset(w.db, w.owner, bo.userId)).link);
    const later = new Date(Date.now() + (RESET_LINK_MINUTES + 1) * 60_000);
    expect(await findPasswordReset(w.db, third, { now: later })).toBeNull();
    await expect(completePasswordReset(w.db, third, 'too late password', { now: later })).rejects.toThrow(/no longer valid/);
    expect(await findPasswordReset(w.db, third)).not.toBeNull();

    await expect(completePasswordReset(w.db, 'not-a-real-token', 'whatever password')).rejects.toThrow(/no longer valid/);
    await expect(completePasswordReset(w.db, '', 'whatever password')).rejects.toThrow(/no longer valid/);
  });

  it('can be used only once even when two requests race', async () => {
    const cy = await addMember(w.db, w.orgId, w.owner.orgName, 'viewer', 'Cy Race');
    const token = tokenOf((await issueMemberPasswordReset(w.db, w.owner, cy.userId)).link);
    const results = await Promise.allSettled([completePasswordReset(w.db, token, 'racing password one'), completePasswordReset(w.db, token, 'racing password two')]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
    expect(await eventsFor(w.db, w.orgId, 'team.password_reset_completed').then((e) => e.filter((x) => x.entityId === cy.userId))).toHaveLength(1);
  });

  it('leaves two-step verification on', async () => {
    const di = await addMember(w.db, w.orgId, w.owner.orgName, 'viewer', 'Di Twostep');
    const { secret } = await enableMfa(w.db, di.userId);
    await completePasswordReset(w.db, tokenOf((await issueMemberPasswordReset(w.db, w.owner, di.userId)).link), 'reset but still two-step');
    expect((await getMfaStatus(w.db, di.userId)).enabled).toBe(true);
    const result = await signIn(w.db, di.userEmail, 'reset but still two-step');
    expect(result?.step).toBe('second_factor');
    expect(secret).toBeTruthy();
  });

  it('clears the failed sign-ins that were counted against the address', async () => {
    const ed = await addMember(w.db, w.orgId, w.owner.orgName, 'viewer', 'Ed Forgot');
    for (let i = 0; i < PASSWORD_ATTEMPTS_PER_EMAIL; i++) expect(await authenticate(w.db, ed.userEmail, `wrong guess ${i}`)).toBeNull();
    await expect(authenticate(w.db, ed.userEmail, PASSWORD)).rejects.toThrow(TOO_MANY_SIGN_INS);
    await completePasswordReset(w.db, tokenOf((await issueMemberPasswordReset(w.db, w.owner, ed.userId)).link), 'remembered it now');
    expect(await authenticate(w.db, ed.userEmail, 'remembered it now')).toMatchObject({ id: ed.userId });
  });

  it('is on the record of every organisation the person belongs to, without the link', async () => {
    const other = await createWorld();
    const fay = await addMember(w.db, w.orgId, w.owner.orgName, 'viewer', 'Fay Both');
    // Issued while Fay belongs only to this organisation; she joins another before using it.
    const { link } = await issueMemberPasswordReset(w.db, w.owner, fay.userId);
    await w.db.insert(memberships).values({ id: newId('mem'), orgId: other.orgId, userId: fay.userId, role: 'accountant' });
    // Now that she belongs to both, neither organisation's admins can issue another (tests/auth-hardening.test.ts).
    await expect(issueMemberPasswordReset(w.db, w.owner, fay.userId)).rejects.toThrow(/also belongs to another organisation/);
    await completePasswordReset(w.db, tokenOf(link), 'fay has a new one');

    const issued = (await eventsFor(w.db, w.orgId, 'team.password_reset_issued')).filter((e) => e.entityId === fay.userId);
    expect(issued.map((e) => [e.actorName, e.summary])).toEqual([['Olivia Owner', 'Created a one-time password reset link for Fay Both']]);
    for (const orgId of [w.orgId, other.orgId]) {
      const done = (await eventsFor(w.db, orgId, 'team.password_reset_completed')).filter((e) => e.entityId === fay.userId);
      expect(done).toHaveLength(1);
      expect(done[0]!.actorType).toBe('system');
      expect(done[0]!.summary).toBe('A new password was set for Fay Both using the one-time reset link created by Olivia Owner');
      expect(JSON.stringify(done[0])).not.toContain(tokenOf(link));
      expect((await verifyAuditChain(w.db, orgId)).ok).toBe(true);
    }
    // The member is told in the app.
    const told = await w.db.select().from(notifications).where(and(eq(notifications.userId, fay.userId), eq(notifications.orgId, w.orgId)));
    expect(told.map((n) => n.title)).toEqual(['Olivia Owner created a password reset link for your account']);
  });
});

describe('reset links created by an administrator', () => {
  it('only by owners and admins, only for active members of their own organisation, never for themselves', async () => {
    const w = await createWorld();
    const other = await createWorld();
    const admin = await addMember(w.db, w.orgId, w.owner.orgName, 'admin', 'Adam Admin');
    const before = (await w.db.select().from(passwordResets)).length;

    for (const ctx of [w.controller, w.accountant, w.pm, w.viewer]) {
      await expect(issueMemberPasswordReset(w.db, ctx, w.viewer.userId)).rejects.toBeInstanceOf(PermissionError);
    }
    // Tenant isolation: an admin of another organisation cannot reach this one's people.
    await expect(issueMemberPasswordReset(other.db, other.owner, w.accountant.userId)).rejects.toThrow('Member not found.');
    await expect(issueMemberPasswordReset(w.db, w.owner, w.owner.userId)).rejects.toThrow(/cannot create a password reset link for yourself/);
    await expect(issueMemberPasswordReset(w.db, admin, w.owner.userId)).rejects.toThrow(/Only an owner/);
    await expect(issueMemberPasswordReset(w.db, w.owner, 'usr_doesnotexist')).rejects.toThrow('Member not found.');
    expect(await w.db.select().from(passwordResets)).toHaveLength(before);

    // A deactivated member gets nothing until reactivated.
    const gone = await addMember(w.db, w.orgId, w.owner.orgName, 'viewer', 'Gus Gone');
    await w.db.update(memberships).set({ status: 'deactivated' }).where(and(eq(memberships.orgId, w.orgId), eq(memberships.userId, gone.userId)));
    await expect(issueMemberPasswordReset(w.db, w.owner, gone.userId)).rejects.toThrow(/deactivated/);

    // An admin acting on a stale session after being demoted is refused.
    await w.db.update(memberships).set({ role: 'viewer' }).where(and(eq(memberships.orgId, w.orgId), eq(memberships.userId, admin.userId)));
    await expect(issueMemberPasswordReset(w.db, admin, w.viewer.userId)).rejects.toThrow(/no longer have permission/);

    const issued = await issueMemberPasswordReset(w.db, w.owner, w.viewer.userId);
    expect(issued.link.startsWith(`${appUrl()}/reset-password/`)).toBe(true);
    const [row] = await w.db.select().from(passwordResets).where(eq(passwordResets.userId, w.viewer.userId));
    expect(row).toMatchObject({ issuedBy: w.owner.userId, tokenHash: sha256Hex(tokenOf(issued.link)) });
  });

  it('can be printed by the operator for any account, and is on the record as the operator', async () => {
    const w = await createWorld();
    const { link, name } = await createOperatorResetLink(w.db, ` ${w.owner.userEmail.toUpperCase()}`);
    expect(name).toBe('Olivia Owner');
    expect(await findPasswordReset(w.db, tokenOf(link))).toEqual({ email: w.owner.userEmail });
    const [event] = await eventsFor(w.db, w.orgId, 'team.password_reset_issued');
    expect(event).toMatchObject({ actorType: 'system', summary: 'A one-time password reset link for Olivia Owner was created by the system operator from the command line' });
    await expect(createOperatorResetLink(w.db, 'nobody@example.test')).rejects.toThrow(/No account/);
  });
});

// ── Two-step verification ───────────────────────────────────────────────────

describe('turning on two-step verification', () => {
  let w: World;
  beforeAll(async () => {
    w = await createWorld();
  });

  it('stores the key encrypted and does nothing until a code confirms it', async () => {
    const here = await createSession(w.db, w.accountant.userId, w.orgId);
    const elsewhere = await createSession(w.db, w.accountant.userId, w.orgId);
    const { secret, uri } = await startMfaSetup(w.db, w.accountant.userId, PASSWORD);
    expect(uri).toContain(secret);
    const stored = await userRow(w.db, w.accountant.userId);
    expect(stored.mfaSecret).toBeTruthy();
    expect(stored.mfaSecret).not.toContain(secret);
    expect(stored.mfaEnabledAt).toBeNull();
    // Not on yet: sessions keep working and signing in needs only the password.
    expect((await resolveSession(w.db, here.token))?.ctx).toBeTruthy();
    expect((await signIn(w.db, w.accountant.userEmail, PASSWORD))?.step).toBe('done');

    const now = new Date();
    await expect(confirmMfaSetup(w.db, w.accountant.userId, '000000', here.token, { now })).rejects.toThrow(/not right/);
    await expect(confirmMfaSetup(w.db, w.accountant.userId, 'abc', here.token, { now })).rejects.toThrow(/6-digit/);
    const { recoveryCodes } = await confirmMfaSetup(w.db, w.accountant.userId, totpCode(secret, now), here.token, { now });
    expect(recoveryCodes).toHaveLength(10);

    const on = await userRow(w.db, w.accountant.userId);
    expect(on.mfaEnabledAt).toBeInstanceOf(Date);
    expect(on.mfaRecoveryCodes).toEqual(recoveryCodes.map(hashRecoveryCode));
    expect(JSON.stringify(on)).not.toContain(recoveryCodes[0]!);
    expect(on.mfaLastCounter).toBe(totpCounter(now));
    // This session passed the second step just now and stays; the other was password-only and is signed out.
    expect((await resolveSession(w.db, here.token))?.ctx).toMatchObject({ userId: w.accountant.userId });
    expect(await resolveSession(w.db, elsewhere.token)).toBeNull();
    expect(await sessionRows(w.db, w.accountant.userId)).toHaveLength(1);
    expect(await getMfaStatus(w.db, w.accountant.userId)).toMatchObject({ enabled: true, recoveryCodesLeft: 10 });

    await expect(startMfaSetup(w.db, w.accountant.userId, PASSWORD)).rejects.toThrow(/already on/);
    const [event] = await eventsFor(w.db, w.orgId, 'team.mfa_enabled');
    // `elsewhere` and the session the password-only sign-in above created.
    expect(event).toMatchObject({ actorName: 'Ana Accountant', summary: 'Turned on two-step verification. Their other sessions (2) were signed out' });
  });

  it('refuses a key that was replaced by a newer setup', async () => {
    const { secret: first } = await startMfaSetup(w.db, w.viewer.userId, PASSWORD);
    await startMfaSetup(w.db, w.viewer.userId, PASSWORD);
    await expect(confirmMfaSetup(w.db, w.viewer.userId, totpCode(first, new Date()))).rejects.toThrow(/not right/);
    expect((await getMfaStatus(w.db, w.viewer.userId)).enabled).toBe(false);
  });
});

describe('signing in with two-step verification', () => {
  let w: World;
  let secret: string;
  let recoveryCodes: string[];
  const base = new Date(Date.now() + 60 * 60_000); // each test signs in at its own later time, so codes are never replays
  beforeAll(async () => {
    w = await createWorld();
    ({ secret, recoveryCodes } = await enableMfa(w.db, w.controller.userId));
  });

  it('does not create a session for the password alone', async () => {
    const before = await userRow(w.db, w.controller.userId);
    const result = await signIn(w.db, w.controller.userEmail, PASSWORD, { now: base });
    expect(result?.step).toBe('second_factor');
    expect(await sessionRows(w.db, w.controller.userId)).toEqual([]);
    expect((await userRow(w.db, w.controller.userId)).lastLoginAt).toEqual(before.lastLoginAt);
    // A session made for this account some other way, without the second step, gets nothing.
    const bypass = await createSession(w.db, w.controller.userId, w.orgId);
    expect(await resolveSession(w.db, bypass.token)).toBeNull();
    await destroySession(w.db, bypass.token);
  });

  it('creates the session, marked as verified, once the code is right', async () => {
    const now = at(base, minutes(1));
    const result = await signIn(w.db, w.controller.userEmail, PASSWORD, { now, userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/17.0 Safari/605.1.15', ipAddress: '203.0.113.7' });
    if (result?.step !== 'second_factor') throw new Error('expected a challenge');
    const challenge = result.challenge;
    expect(challenge.expiresAt.getTime() - now.getTime()).toBe(minutes(10));
    const [stored] = await w.db.select().from(loginChallenges).where(eq(loginChallenges.id, sha256Hex(challenge.token)));
    expect(stored).toMatchObject({ userId: w.controller.userId, attempts: 0 });
    // The second-step page reads when two-step was set up, to name the app entry it was given then.
    expect(await findLoginChallenge(w.db, challenge.token, now)).toEqual({
      attemptsLeft: CHALLENGE_MAX_ATTEMPTS,
      expiresAt: challenge.expiresAt,
      mfaEnabledAt: (await userRow(w.db, w.controller.userId)).mfaEnabledAt,
    });

    const done = await completeSecondStep(w.db, challenge.token, totpCode(secret, now), { now, userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/17.0 Safari/605.1.15', ipAddress: '203.0.113.7' });
    if (done.status !== 'signed_in') throw new Error(`expected to be signed in, got ${done.status}`);
    expect(done.usedRecoveryCode).toBe(false);
    const [row] = await w.db.select().from(sessions).where(eq(sessions.id, sha256Hex(done.session.token)));
    expect(row).toMatchObject({ userId: w.controller.userId, ipAddress: '203.0.113.7' });
    expect(row!.mfaVerifiedAt).toEqual(now);
    expect(describeUserAgent(row!.userAgent)).toBe('Safari on macOS');
    expect((await resolveSession(w.db, done.session.token))?.ctx).toMatchObject({ userId: w.controller.userId, orgId: w.orgId });
    // The challenge is spent.
    expect(await findLoginChallenge(w.db, challenge.token, now)).toBeNull();
    expect(await completeSecondStep(w.db, challenge.token, totpCode(secret, at(now, 30_000)), { now: at(now, 30_000) })).toEqual({ status: 'restart', reason: 'expired' });

    // The same code cannot be used again for another sign-in.
    const again = await signIn(w.db, w.controller.userEmail, PASSWORD, { now });
    if (again?.step !== 'second_factor') throw new Error('expected a challenge');
    expect(await completeSecondStep(w.db, again.challenge.token, totpCode(secret, now), { now })).toMatchObject({ status: 'wrong_code' });
  });

  it('allows five codes per sign-in, then the sign-in has to start again', async () => {
    const now = at(base, minutes(5));
    const result = await signIn(w.db, w.controller.userEmail, PASSWORD, { now });
    if (result?.step !== 'second_factor') throw new Error('expected a challenge');
    const token = result.challenge.token;
    const seen = [];
    for (let i = 0; i < CHALLENGE_MAX_ATTEMPTS; i++) seen.push(await completeSecondStep(w.db, token, '000000', { now }));
    expect(seen).toEqual([
      { status: 'wrong_code', attemptsLeft: 4 },
      { status: 'wrong_code', attemptsLeft: 3 },
      { status: 'wrong_code', attemptsLeft: 2 },
      { status: 'wrong_code', attemptsLeft: 1 },
      { status: 'restart', reason: 'too_many' },
    ]);
    // Even the right code does not rescue it now.
    expect((await completeSecondStep(w.db, token, totpCode(secret, now), { now })).status).toBe('restart');
    expect(await w.db.select().from(loginChallenges).where(eq(loginChallenges.id, sha256Hex(token)))).toEqual([]);
  });

  it('expires after ten minutes', async () => {
    const now = at(base, minutes(20));
    const result = await signIn(w.db, w.controller.userEmail, PASSWORD, { now });
    if (result?.step !== 'second_factor') throw new Error('expected a challenge');
    const late = at(now, minutes(11));
    expect(await findLoginChallenge(w.db, result.challenge.token, late)).toBeNull();
    expect(await completeSecondStep(w.db, result.challenge.token, totpCode(secret, late), { now: late })).toEqual({ status: 'restart', reason: 'expired' });
    expect(await completeSecondStep(w.db, null, '123456', { now: late })).toEqual({ status: 'restart', reason: 'expired' });
  });

  it('takes each recovery code once, in place of a code from the app', async () => {
    const now = at(base, minutes(30));
    const code = recoveryCodes[3]!;
    const first = await signIn(w.db, w.controller.userEmail, PASSWORD, { now });
    if (first?.step !== 'second_factor') throw new Error('expected a challenge');
    // Typed in capitals with a space instead of the dash, it still matches.
    const done = await completeSecondStep(w.db, first.challenge.token, code.toUpperCase().replace('-', ' '), { now });
    expect(done).toMatchObject({ status: 'signed_in', usedRecoveryCode: true, recoveryCodesLeft: 9 });
    expect((await userRow(w.db, w.controller.userId)).mfaRecoveryCodes).not.toContain(hashRecoveryCode(code));

    const second = await signIn(w.db, w.controller.userEmail, PASSWORD, { now });
    if (second?.step !== 'second_factor') throw new Error('expected a challenge');
    expect(await completeSecondStep(w.db, second.challenge.token, code, { now })).toMatchObject({ status: 'wrong_code' });
    const [event] = await eventsFor(w.db, w.orgId, 'team.mfa_recovery_code_used');
    expect(event).toMatchObject({ actorName: 'Carlos Controller', summary: 'Signed in with a recovery code instead of their authenticator app (9 codes left)' });
    expect(event!.summary).not.toContain(code);
  });

  it('limits wrong codes per account across sign-ins: ten in fifteen minutes', async () => {
    const x = await createWorld();
    const { secret: key } = await enableMfa(x.db, x.viewer.userId);
    const now = at(base, minutes(40));
    let wrong = 0;
    while (wrong < MFA_ATTEMPTS_PER_USER) {
      const r = await signIn(x.db, x.viewer.userEmail, PASSWORD, { now });
      if (r?.step !== 'second_factor') throw new Error('expected a challenge');
      for (let i = 0; i < 4 && wrong < MFA_ATTEMPTS_PER_USER; i++, wrong++) expect((await completeSecondStep(x.db, r.challenge.token, '111111', { now })).status).toBe('wrong_code');
    }
    const r = await signIn(x.db, x.viewer.userEmail, PASSWORD, { now });
    if (r?.step !== 'second_factor') throw new Error('expected a challenge');
    expect(await completeSecondStep(x.db, r.challenge.token, totpCode(key, now), { now })).toEqual({ status: 'locked' });
    // Fifteen minutes later the right code works.
    const later = at(now, minutes(16));
    const r2 = await signIn(x.db, x.viewer.userEmail, PASSWORD, { now: later });
    if (r2?.step !== 'second_factor') throw new Error('expected a challenge');
    expect((await completeSecondStep(x.db, r2.challenge.token, totpCode(key, later), { now: later })).status).toBe('signed_in');
  });

  it('joins an invited person with two-step verification only once their code is right', async () => {
    const x = await createWorld();
    const { token } = await inviteMember(x.db, x.owner, { email: w.controller.userEmail, role: 'viewer' });
    const outcome = await acceptInvitation(x.db, token, { password: PASSWORD });
    if (outcome.status !== 'second_factor') throw new Error('expected the second step');
    expect(outcome.userId).toBe(w.controller.userId);
    // The password alone made no membership and used up nothing.
    const inX = () => x.db.select().from(memberships).where(and(eq(memberships.orgId, x.orgId), eq(memberships.userId, w.controller.userId)));
    expect(await inX()).toEqual([]);
    expect(await findInvitation(x.db, token)).not.toBeNull();

    const challenge = await createLoginChallenge(x.db, outcome.userId, { invitationId: outcome.invitationId, now: at(base, minutes(119)) });
    expect((await completeSecondStep(x.db, challenge.token, '000000', { now: at(base, minutes(119)) })).status).toBe('wrong_code');
    expect(await inX()).toEqual([]);
    const later = at(base, minutes(120));
    const done = await completeSecondStep(x.db, challenge.token, totpCode(secret, later), { now: later });
    if (done.status !== 'signed_in') throw new Error('expected to be signed in');
    expect(done.invitation).toBe('joined');
    expect(await inX()).toMatchObject([{ role: 'viewer', status: 'active' }]);
    expect(await findInvitation(x.db, token)).toBeNull();
    // The session opens in the organisation that was joined.
    expect((await resolveSession(x.db, done.session.token))?.ctx).toMatchObject({ orgId: x.orgId, role: 'viewer' });
  });

  it('signs in without joining when the invitation was revoked before the second step', async () => {
    const x = await createWorld();
    const { id, token } = await inviteMember(x.db, x.owner, { email: w.controller.userEmail, role: 'viewer' });
    const outcome = await acceptInvitation(x.db, token, { password: PASSWORD });
    if (outcome.status !== 'second_factor') throw new Error('expected the second step');
    const challenge = await createLoginChallenge(x.db, outcome.userId, { invitationId: outcome.invitationId, now: at(base, minutes(129)) });
    await revokeInvitation(x.db, x.owner, id);
    const later = at(base, minutes(130));
    const done = await completeSecondStep(x.db, challenge.token, totpCode(secret, later), { now: later });
    if (done.status !== 'signed_in') throw new Error('expected to be signed in');
    expect(done.invitation).toBe('no_longer_valid');
    expect(await x.db.select().from(memberships).where(and(eq(memberships.orgId, x.orgId), eq(memberships.userId, w.controller.userId)))).toEqual([]);
  });
});

describe('turning off two-step verification and replacing recovery codes', () => {
  it('needs the current password and a valid code, and both are on the record', async () => {
    const w = await createWorld();
    const { secret, recoveryCodes } = await enableMfa(w.db, w.pm.userId);
    const now = new Date();

    await expect(regenerateRecoveryCodes(w.db, w.pm.userId, 'not my password', totpCode(secret, now), { now })).rejects.toThrow(/current password is not correct/);
    await expect(regenerateRecoveryCodes(w.db, w.pm.userId, PASSWORD, '000000', { now })).rejects.toThrow(/code is not right/);
    const fresh = await regenerateRecoveryCodes(w.db, w.pm.userId, PASSWORD, totpCode(secret, now), { now });
    expect(fresh).toHaveLength(10);
    expect(fresh.some((c) => recoveryCodes.includes(c))).toBe(false);
    expect((await userRow(w.db, w.pm.userId)).mfaRecoveryCodes).toEqual(fresh.map(hashRecoveryCode));

    const later = at(now, 30_000);
    await expect(disableMfa(w.db, w.pm.userId, PASSWORD, recoveryCodes[0]!, { now: later })).rejects.toThrow(/code is not right/); // an old code
    await expect(disableMfa(w.db, w.pm.userId, 'not my password', fresh[0]!, { now: later })).rejects.toThrow(/current password is not correct/);
    await disableMfa(w.db, w.pm.userId, PASSWORD, fresh[0]!, { now: later });
    const off = await userRow(w.db, w.pm.userId);
    expect([off.mfaSecret, off.mfaEnabledAt, off.mfaRecoveryCodes, off.mfaLastCounter]).toEqual([null, null, null, null]);
    expect((await signIn(w.db, w.pm.userEmail, PASSWORD))?.step).toBe('done');

    expect((await eventsFor(w.db, w.orgId, 'team.mfa_recovery_codes_regenerated')).map((e) => e.summary)).toEqual([
      'Replaced their two-step verification recovery codes. The previous codes no longer work',
    ]);
    expect((await eventsFor(w.db, w.orgId, 'team.mfa_disabled')).map((e) => [e.actorName, e.summary])).toEqual([['Pat Manager', 'Turned off two-step verification']]);
  });
});

describe('resetting a member’s two-step verification', () => {
  it('turns it off, signs them out everywhere, tells them, and is on the record', async () => {
    const w = await createWorld();
    await enableMfa(w.db, w.accountant.userId);
    const session = await verifiedSession(w.db, w.accountant.userId, w.orgId);
    await createLoginChallenge(w.db, w.accountant.userId);

    await resetMemberMfa(w.db, w.owner, w.accountant.userId);
    const user = await userRow(w.db, w.accountant.userId);
    expect([user.mfaSecret, user.mfaEnabledAt, user.mfaRecoveryCodes]).toEqual([null, null, null]);
    expect(await resolveSession(w.db, session.token)).toBeNull();
    expect(await sessionRows(w.db, w.accountant.userId)).toEqual([]);
    expect(await w.db.select().from(loginChallenges).where(eq(loginChallenges.userId, w.accountant.userId))).toEqual([]);
    // Their password still works, without a second step now.
    expect((await signIn(w.db, w.accountant.userEmail, PASSWORD))?.step).toBe('done');

    const [event] = await eventsFor(w.db, w.orgId, 'team.mfa_reset');
    expect(event).toMatchObject({ actorName: 'Olivia Owner', entityId: w.accountant.userId, summary: 'Reset two-step verification for Ana Accountant and signed them out on every device' });
    const told = await w.db.select().from(notifications).where(eq(notifications.userId, w.accountant.userId));
    expect(told.map((n) => n.title)).toContain('Olivia Owner reset your two-step verification');
    await expect(resetMemberMfa(w.db, w.owner, w.accountant.userId)).rejects.toThrow(/does not have two-step verification/);
  });

  it('cannot be done to yourself, across organisations, by a non-admin, or to an owner by an admin', async () => {
    const w = await createWorld();
    const other = await createWorld();
    const admin = await addMember(w.db, w.orgId, w.owner.orgName, 'admin', 'Adam Admin');
    await enableMfa(w.db, w.owner.userId);
    await enableMfa(w.db, admin.userId);
    await enableMfa(w.db, w.viewer.userId);

    await expect(resetMemberMfa(w.db, admin, admin.userId)).rejects.toThrow(/for yourself/);
    await expect(resetMemberMfa(other.db, other.owner, w.viewer.userId)).rejects.toThrow('Member not found.');
    await expect(resetMemberMfa(w.db, w.controller, w.viewer.userId)).rejects.toBeInstanceOf(PermissionError);
    await expect(resetMemberMfa(w.db, admin, w.owner.userId)).rejects.toThrow(/Only an owner/);
    for (const id of [w.owner.userId, admin.userId, w.viewer.userId]) expect((await getMfaStatus(w.db, id)).enabled).toBe(true);
    expect(await eventsFor(w.db, w.orgId, 'team.mfa_reset')).toEqual([]);

    await resetMemberMfa(w.db, admin, w.viewer.userId);
    expect((await getMfaStatus(w.db, w.viewer.userId)).enabled).toBe(false);
  });

  it('can be done by the operator for a locked-out sole owner', async () => {
    const w = await createWorld();
    await enableMfa(w.db, w.owner.userId);
    expect(await resetMfaByOperator(w.db, w.owner.userEmail)).toEqual({ name: 'Olivia Owner', wasOn: true });
    expect((await getMfaStatus(w.db, w.owner.userId)).enabled).toBe(false);
    const [event] = await eventsFor(w.db, w.orgId, 'team.mfa_reset');
    expect(event).toMatchObject({ actorType: 'system' });
    expect(await resetMfaByOperator(w.db, w.owner.userEmail)).toEqual({ name: 'Olivia Owner', wasOn: false });
  });
});

// ── Requiring two-step verification ─────────────────────────────────────────

describe('an organisation that requires two-step verification', () => {
  it('can only be set by an owner or admin who has it on themselves', async () => {
    const w = await createWorld();
    await expect(updatePolicy(w.db, w.controller, { requireMfa: true })).rejects.toBeInstanceOf(PermissionError);
    await expect(updatePolicy(w.db, w.owner, { requireMfa: true })).rejects.toThrow(/Turn on two-step verification for your own account first/);
    await enableMfa(w.db, w.owner.userId);
    await updatePolicy(w.db, w.owner, { requireMfa: true });
    const [event] = await eventsFor(w.db, w.orgId, 'policy.updated');
    expect(event!.summary).toBe('Two-step verification is now required for every member of the organisation');
    // A controller can still change the review policy without touching it.
    await updatePolicy(w.db, w.controller, { toleranceCents: 250 });
    await updatePolicy(w.db, w.owner, { requireMfa: false });
    expect((await eventsFor(w.db, w.orgId, 'policy.updated')).map((e) => e.summary)).toEqual([
      'Two-step verification is now required for every member of the organisation',
      'Changed review policy: toleranceCents 100 → 250',
      'Two-step verification is no longer required for members of the organisation',
    ]);
  });

  it('gives a member without it no context in that organisation until they turn it on, and leaves other organisations alone', async () => {
    const w = await createWorld();
    const other = await createWorld();
    await w.db.insert(memberships).values({ id: newId('mem'), orgId: other.orgId, userId: w.accountant.userId, role: 'viewer' });
    await enableMfa(w.db, w.owner.userId);
    await updatePolicy(w.db, w.owner, { requireMfa: true });

    const session = await createSession(w.db, w.accountant.userId, w.orgId);
    const resolved = await resolveSession(w.db, session.token);
    expect(resolved).toMatchObject({ ctx: null, user: { id: w.accountant.userId, mfaEnabled: false }, mfaRequired: { orgId: w.orgId, orgName: w.owner.orgName } });
    // The owner, who has it on, works normally.
    const owner = await verifiedSession(w.db, w.owner.userId, w.orgId);
    expect((await resolveSession(w.db, owner.token))?.ctx).toMatchObject({ userId: w.owner.userId });
    // The same person in an organisation that does not require it is unaffected.
    await switchOrganization(w.db, session.token, w.accountant.userId, other.orgId);
    expect((await resolveSession(w.db, session.token))?.ctx).toMatchObject({ orgId: other.orgId, role: 'viewer' });
    await switchOrganization(w.db, session.token, w.accountant.userId, w.orgId);
    expect((await resolveSession(w.db, session.token))?.ctx).toBeNull();

    // Setting it up from that session is allowed, and afterwards the organisation opens.
    await enableMfa(w.db, w.accountant.userId, { keepToken: session.token });
    expect((await resolveSession(w.db, session.token))?.ctx).toMatchObject({ orgId: w.orgId, userId: w.accountant.userId, role: 'accountant' });
    expect((await listMembers(w.db, w.owner)).filter((m) => m.mfaEnabled).map((m) => m.userId).sort()).toEqual([w.accountant.userId, w.owner.userId].sort());
  });
});

// ── Sessions ────────────────────────────────────────────────────────────────

describe('sessions', () => {
  let w: World;
  beforeAll(async () => {
    w = await createWorld();
  });

  it('are stored only as a hash of the token, and signing out deletes the row', async () => {
    const { token } = await createSession(w.db, w.viewer.userId, w.orgId);
    const rows = await sessionRows(w.db, w.viewer.userId);
    expect(rows.map((r) => r.id)).toContain(sha256Hex(token));
    expect(JSON.stringify(rows)).not.toContain(token);
    await destroySession(w.db, token);
    expect((await sessionRows(w.db, w.viewer.userId)).map((r) => r.id)).not.toContain(sha256Hex(token));
    expect(await resolveSession(w.db, token)).toBeNull();
  });

  it('end after the idle timeout, and record when they were last used at most every five minutes', async () => {
    const start = new Date();
    const { token } = await createSession(w.db, w.viewer.userId, w.orgId, { now: start });
    const seen = async () => (await w.db.select().from(sessions).where(eq(sessions.id, sha256Hex(token))))[0]?.lastSeenAt;
    expect(await seen()).toEqual(start);
    await resolveSession(w.db, token, { now: at(start, minutes(1)) });
    expect(await seen()).toEqual(start);
    await resolveSession(w.db, token, { now: at(start, minutes(6)) });
    expect(await seen()).toEqual(at(start, minutes(6)));

    // The idle timeout, independently of the absolute lifetime.
    await w.db.update(sessions).set({ lastSeenAt: new Date(Date.now() - (SESSION_IDLE_DAYS + 1) * DAY), expiresAt: new Date(Date.now() + DAY) }).where(eq(sessions.id, sha256Hex(token)));
    expect(await resolveSession(w.db, token)).toBeNull();
    expect(await seen()).toBeUndefined();
    // And the absolute lifetime.
    const old = await createSession(w.db, w.viewer.userId, w.orgId, { now: new Date(Date.now() - 15 * DAY) });
    expect(await resolveSession(w.db, old.token)).toBeNull();
  });

  it('are listed for their owner only, the current one first, and can be signed out one at a time or all at once', async () => {
    const x = await createWorld();
    const me = x.accountant;
    const here = await createSession(x.db, me.userId, x.orgId, { userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0 Safari/537.36', ipAddress: '198.51.100.4' });
    const phone = await createSession(x.db, me.userId, x.orgId, { userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile Safari/604.1' });
    const laptop = await createSession(x.db, me.userId, x.orgId, { userAgent: 'Mozilla/5.0 (X11; Linux x86_64; rv:133.0) Gecko/20100101 Firefox/133.0' });
    const someoneElse = await createSession(x.db, x.viewer.userId, x.orgId);

    const list = await listSessions(x.db, me.userId, here.token);
    expect(list).toHaveLength(3);
    expect(list[0]).toMatchObject({ current: true, device: 'Chrome on Windows', ipAddress: '198.51.100.4', organization: x.owner.orgName });
    expect(list.slice(1).map((s) => s.device).sort()).toEqual(['Firefox on Linux', 'Safari on iPhone']);
    // The ids on screen are not the stored ids.
    const stored = (await sessionRows(x.db, me.userId)).map((r) => r.id);
    for (const s of list) expect(stored).not.toContain(s.id);

    await expect(revokeSession(x.db, me.userId, list[0]!.id, here.token)).rejects.toThrow(/session you are using/);
    // Someone else's session cannot be reached through this account, whatever id is sent.
    const theirs = (await listSessions(x.db, x.viewer.userId, someoneElse.token))[0]!;
    await revokeSession(x.db, me.userId, theirs.id, here.token);
    expect(await resolveSession(x.db, someoneElse.token)).not.toBeNull();

    const phoneId = list.find((s) => s.device === 'Safari on iPhone')!.id;
    await revokeSession(x.db, me.userId, phoneId, here.token);
    expect(await resolveSession(x.db, phone.token)).toBeNull();
    expect(await resolveSession(x.db, laptop.token)).not.toBeNull();

    expect(await revokeOtherSessions(x.db, me.userId, here.token)).toBe(1);
    expect(await resolveSession(x.db, laptop.token)).toBeNull();
    expect(await resolveSession(x.db, here.token)).not.toBeNull();
    expect(await revokeOtherSessions(x.db, me.userId, here.token)).toBe(0);

    expect((await eventsFor(x.db, x.orgId, 'team.session_revoked')).map((e) => [e.actorName, e.summary])).toEqual([
      ['Ana Accountant', 'Signed out one of their own sessions (Safari on iPhone)'],
      ['Ana Accountant', 'Signed out all of their other sessions (1)'],
    ]);
  });

  it('other than the current one are signed out when the password changes', async () => {
    const x = await createWorld();
    const me = x.pm;
    const here = await createSession(x.db, me.userId, x.orgId);
    const there = await createSession(x.db, me.userId, x.orgId);
    await expect(changePassword(x.db, me.userId, 'not the password', 'a new long password', here.token)).rejects.toThrow(/current password is not correct/);
    await expect(changePassword(x.db, me.userId, PASSWORD, PASSWORD, here.token)).rejects.toThrow(/different from your current one/);
    await changePassword(x.db, me.userId, PASSWORD, 'a new long password', here.token);
    expect(await resolveSession(x.db, here.token)).not.toBeNull();
    expect(await resolveSession(x.db, there.token)).toBeNull();
    expect((await userRow(x.db, me.userId)).passwordChangedAt).toBeInstanceOf(Date);
    expect((await eventsFor(x.db, x.orgId, 'team.password_changed')).map((e) => [e.actorName, e.summary])).toEqual([['Pat Manager', 'Changed their password. Their other sessions (1) were signed out']]);
  });

  it('take the client address from the right of X-Forwarded-For, never from what the client put on the left', () => {
    const h = (values: Record<string, string>) => ({ get: (name: string) => values[name] ?? null });
    // One proxy (the default) appends the address it saw; whatever the client sent is to its left.
    expect(clientIp(h({ 'x-forwarded-for': '6.6.6.6, 203.0.113.9' }), {})).toBe('203.0.113.9');
    expect(clientIp(h({ 'x-forwarded-for': '203.0.113.9' }), {})).toBe('203.0.113.9');
    // Two proxies: the second appended the first's address.
    expect(clientIp(h({ 'x-forwarded-for': '6.6.6.6, 203.0.113.9, 10.0.0.2' }), { RCM_TRUSTED_PROXY_HOPS: '2' })).toBe('203.0.113.9');
    expect(clientIp(h({ 'x-forwarded-for': '10.0.0.2' }), { RCM_TRUSTED_PROXY_HOPS: '2' })).toBeNull(); // fewer entries than proxies: not trusted
    // X-Real-IP is read only when named as the platform's header.
    expect(clientIp(h({ 'x-real-ip': '2001:db8::1' }), {})).toBeNull();
    expect(clientIp(h({ 'x-real-ip': '2001:db8::1', 'x-forwarded-for': '6.6.6.6' }), { RCM_CLIENT_IP_HEADER: 'X-Real-IP' })).toBe('2001:db8::1');
    expect(clientIp(h({ 'x-forwarded-for': '<script>' }), {})).toBeNull();
    expect(clientIp(h({}), {})).toBeNull();
    expect(describeUserAgent(null)).toBe('Unknown device');
    expect(describeUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/131.0 Safari/537.36 Edg/131.0')).toBe('Edge on macOS');
    expect(describeUserAgent('Zephric Mobile/1.0.0 (Android 35)')).toBe('Zephric app on Android');
    expect(describeUserAgent('Zephric Mobile/1.0.0 (iOS 18.2)')).toBe('Zephric app on iOS');
    expect(describeUserAgent('Mozilla/5.0 (iPhone; CPU iPhone OS 18_2 like Mac OS X) AppleWebKit/605.1.15 EdgiOS/131.0 Mobile/15E148 Safari/605.1.15')).toBe('Edge on iPhone');
  });

  it('set cookies that are HttpOnly, SameSite=Lax and Secure in production', async () => {
    const { authCookieOptions, cookieSecure } = await import('@/server/auth/session');
    const expires = new Date();
    expect(authCookieOptions(expires)).toMatchObject({ httpOnly: true, sameSite: 'lax', path: '/', expires, secure: false });
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('APP_URL', 'https://rcm.example.com');
    expect(cookieSecure()).toBe(true);
    vi.stubEnv('APP_URL', 'http://rcm.example.com'); // misconfigured: still Secure, so a cookie is never sent in the clear
    expect(cookieSecure()).toBe(true);
    vi.stubEnv('APP_URL', 'http://localhost:3000');
    expect(cookieSecure()).toBe(false);
  });
});

// ── Throttling ──────────────────────────────────────────────────────────────

describe('sign-in throttling', () => {
  it('locks an address after eight wrong passwords, with the same answer whether or not it has an account', async () => {
    const w = await createWorld();
    for (let i = 0; i < PASSWORD_ATTEMPTS_PER_EMAIL; i++) {
      expect(await authenticate(w.db, w.viewer.userEmail, `wrong ${i}`)).toBeNull();
      expect(await authenticate(w.db, 'ghost@example.test', `wrong ${i}`)).toBeNull();
    }
    // Now even the right password is refused, and the refusal reads the same for a real and a made-up address.
    await expect(authenticate(w.db, w.viewer.userEmail, PASSWORD)).rejects.toThrow(TOO_MANY_SIGN_INS);
    await expect(authenticate(w.db, 'ghost@example.test', PASSWORD)).rejects.toThrow(TOO_MANY_SIGN_INS);
    // Other addresses are unaffected.
    expect(await authenticate(w.db, w.pm.userEmail, PASSWORD)).toMatchObject({ id: w.pm.userId });
  });

  it('forgives mistakes once the right password is given', async () => {
    const w = await createWorld();
    for (let round = 0; round < 2; round++) {
      for (let i = 0; i < PASSWORD_ATTEMPTS_PER_EMAIL - 1; i++) expect(await authenticate(w.db, w.viewer.userEmail, `typo ${i}`)).toBeNull();
      expect(await authenticate(w.db, w.viewer.userEmail, PASSWORD)).toMatchObject({ id: w.viewer.userId });
    }
  });

  it('locks an IP address after thirty wrong passwords across any addresses', async () => {
    const w = await createWorld();
    const ip = `198.51.100.${Math.floor(Math.random() * 200) + 20}`;
    for (let i = 0; i < PASSWORD_ATTEMPTS_PER_IP; i++) expect(await authenticate(w.db, `spray${i}@example.test`, 'Spring2026!!', { ipAddress: ip })).toBeNull();
    await expect(authenticate(w.db, w.viewer.userEmail, PASSWORD, { ipAddress: ip })).rejects.toThrow(TOO_MANY_SIGN_INS);
    expect(await authenticate(w.db, w.viewer.userEmail, PASSWORD, { ipAddress: '192.0.2.200' })).toMatchObject({ id: w.viewer.userId });
  });

  it('opens again when the fifteen-minute window has passed', async () => {
    const w = await createWorld();
    const limits = passwordLimits(w.viewer.userEmail);
    const start = new Date();
    for (let i = 0; i < PASSWORD_ATTEMPTS_PER_EMAIL; i++) expect(await reserveAttempt(w.db, 'password', limits, { now: start })).not.toBeNull();
    expect(await reserveAttempt(w.db, 'password', limits, { now: at(start, minutes(1)) })).toBeNull();
    expect(await reserveAttempt(w.db, 'password', limits, { now: at(start, minutes(16)) })).not.toBeNull();
  });

  it('survives a restart: the count is in the database, not in the process', async () => {
    const w = await createWorld();
    for (let i = 0; i < PASSWORD_ATTEMPTS_PER_EMAIL; i++) expect(await authenticate(w.db, w.viewer.userEmail, `wrong ${i}`)).toBeNull();
    // A fresh copy of every module, as after a restart: nothing remembered in memory survives.
    vi.resetModules();
    const fresh = await import('@/server/services/team');
    expect(fresh.authenticate).not.toBe(authenticate);
    await expect(fresh.authenticate(w.db, w.viewer.userEmail, PASSWORD)).rejects.toThrow(fresh.TOO_MANY_SIGN_INS);
  });

  it('holds under concurrent guesses: exactly eight get through', async () => {
    const w = await createWorld();
    const results = await Promise.allSettled(Array.from({ length: 20 }, (_, i) => authenticate(w.db, w.viewer.userEmail, `burst ${i}`)));
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(PASSWORD_ATTEMPTS_PER_EMAIL);
    expect(results.filter((r) => r.status === 'rejected').every((r) => (r as PromiseRejectedResult).reason.message === TOO_MANY_SIGN_INS)).toBe(true);
    const counted = await w.db.select().from(authAttempts).where(and(eq(authAttempts.subject, w.viewer.userEmail), eq(authAttempts.kind, 'password')));
    expect(counted).toHaveLength(PASSWORD_ATTEMPTS_PER_EMAIL);
  });

  // Two app instances are two connection pools on one database. PGlite is one in-process
  // database, so this runs only against a PostgreSQL server (`pnpm test:pg`).
  it.runIf(!!process.env.DATABASE_URL)('holds across two app instances sharing the database', async () => {
    const w = await createWorld();
    const pg = await import('pg');
    const { drizzle } = await import('drizzle-orm/node-postgres');
    const pool = new pg.default.Pool({ connectionString: process.env.DATABASE_URL, max: 5 });
    const second = drizzle(pool) as unknown as DB;
    try {
      const guesses = Array.from({ length: 24 }, (_, i) => authenticate(i % 2 === 0 ? w.db : second, w.viewer.userEmail, `two instances ${i}`, { ipAddress: '203.0.113.50' }));
      const results = await Promise.allSettled(guesses);
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(PASSWORD_ATTEMPTS_PER_EMAIL);
      // Either instance now refuses the right password.
      await expect(authenticate(second, w.viewer.userEmail, PASSWORD)).rejects.toThrow(TOO_MANY_SIGN_INS);
      await expect(authenticate(w.db, w.viewer.userEmail, PASSWORD)).rejects.toThrow(TOO_MANY_SIGN_INS);
    } finally {
      await pool.end();
    }
  });

  it('counts wrong passwords given to confirm a change, like wrong passwords at sign-in', async () => {
    const w = await createWorld();
    for (let i = 0; i < PASSWORD_ATTEMPTS_PER_EMAIL; i++) await expect(changePassword(w.db, w.viewer.userId, `guess ${i}`, 'a new long password')).rejects.toThrow(/not correct/);
    await expect(changePassword(w.db, w.viewer.userId, PASSWORD, 'a new long password')).rejects.toThrow(/Too many/);
  });

  it('deletes attempts older than a day, and nothing newer', async () => {
    const w = await createWorld();
    const subject = `prune-${newId('x')}@example.test`;
    const now = new Date();
    await w.db.insert(authAttempts).values([
      { id: newId('att'), subject, kind: 'password', succeeded: false, createdAt: new Date(now.getTime() - 25 * 3_600_000) },
      { id: newId('att'), subject, kind: 'password', succeeded: false, createdAt: new Date(now.getTime() - 23 * 3_600_000) },
    ]);
    await pruneAuthRecords(w.db, now);
    const left = await w.db.select().from(authAttempts).where(eq(authAttempts.subject, subject));
    expect(left).toHaveLength(1);
    expect(now.getTime() - left[0]!.createdAt.getTime()).toBeLessThan(24 * 3_600_000);
  });
});

// ── Audit summaries ─────────────────────────────────────────────────────────

describe('the audit trail for account security', () => {
  it('never carries a token, a key or a code', async () => {
    const w = await createWorld();
    const { secret, recoveryCodes } = await enableMfa(w.db, w.viewer.userId);
    const { link } = await issueMemberPasswordReset(w.db, w.owner, w.viewer.userId);
    await completePasswordReset(w.db, tokenOf(link), 'audit trail password');
    const events = await w.db.select().from(auditEvents).where(and(eq(auditEvents.orgId, w.orgId), inArray(auditEvents.action, ['team.mfa_enabled', 'team.password_reset_issued', 'team.password_reset_completed'])));
    expect(events).toHaveLength(3);
    const text = JSON.stringify(events);
    for (const secretThing of [secret, tokenOf(link), link, ...recoveryCodes]) expect(text).not.toContain(secretThing);
    expect((await verifyAuditChain(w.db, w.orgId)).ok).toBe(true);
  });
});
