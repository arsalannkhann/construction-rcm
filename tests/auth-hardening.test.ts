/**
 * Regression tests for the problems a security review of authentication found
 * (2026-11-15), each written as the attack it describes:
 *
 *  1. An owner of one organisation (anyone can become one by signing up) took
 *     over a member of another organisation: by accepting an invitation for
 *     them with only their password, or after they accepted one, then
 *     resetting their two-step verification or password from that organisation.
 *  2. Wrong passwords from anywhere kept an account locked, even against its owner.
 *  3. The client address came from the left of X-Forwarded-For, which the client
 *     writes (covered in tests/auth.test.ts, "sessions").
 *  4. Sign-up answered "already exists" with no limit.
 *  5. Two-step verification could be turned on without the password.
 *  6. Recovery codes were stored as unkeyed sha256.
 */
import { and, eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { memberships, notifications } from '@/db/schema';
import { deviceToken, isRememberedDevice, parseDeviceCookie, rememberDevice } from '@/server/auth/device';
import { startMfaSetup } from '@/server/auth/mfa';
import { completePasswordReset } from '@/server/auth/password-reset';
import type { Ctx } from '@/server/auth/permissions';
import { signIn } from '@/server/auth/sign-in';
import { PASSWORD_ATTEMPTS_PER_EMAIL, PASSWORD_ATTEMPTS_PER_IP, SIGNUPS_PER_IP } from '@/server/auth/throttle';
import { hashRecoveryCode, normaliseRecoveryCode } from '@/server/auth/totp';
import { newId, sha256Hex } from '@/server/ids';
import {
  acceptInvitation,
  authenticate,
  changePassword,
  createOrganization,
  inviteMember,
  issueMemberPasswordReset,
  resetMemberMfa,
  signUp,
  TOO_MANY_SIGN_INS,
  TOO_MANY_SIGN_UPS,
  updatePolicy,
} from '@/server/services/team';
import { createWorld } from './helpers/world';
import { enableMfa, PASSWORD, userRow, verifiedSession } from './helpers/auth';

let n = 0;
/** Someone who signs up on their own and is therefore the owner of a new organisation. */
async function strangerOwner(db: Parameters<typeof signUp>[0]): Promise<Ctx> {
  const i = ++n;
  const email = `mallory${i}@evil.example`;
  const { userId, orgId } = await signUp(db, { name: 'Mallory Stranger', email, password: 'a long attacker password', orgName: `Evil Co ${i}` });
  return { orgId, orgName: `Evil Co ${i}`, isDemo: false, userId, userName: 'Mallory Stranger', userEmail: email, role: 'owner' };
}

const memberOf = async (db: Parameters<typeof signUp>[0], orgId: string, userId: string) =>
  db.select().from(memberships).where(and(eq(memberships.orgId, orgId), eq(memberships.userId, userId)));

describe('1. taking over another organisation’s member', () => {
  it('cannot be done with the victim’s password: accepting needs their second step, and nothing is joined without it', async () => {
    const w = await createWorld();
    await enableMfa(w.db, w.owner.userId);
    await updatePolicy(w.db, w.owner, { requireMfa: true });
    await enableMfa(w.db, w.controller.userId);
    const evil = await strangerOwner(w.db);
    const { token } = await inviteMember(w.db, evil, { email: w.controller.userEmail, role: 'viewer' });

    const outcome = await acceptInvitation(w.db, token, { password: PASSWORD });
    expect(outcome.status).toBe('second_factor');
    expect(await memberOf(w.db, evil.orgId, w.controller.userId)).toEqual([]);
    // Not a member, so nothing to recover from there.
    await expect(resetMemberMfa(w.db, evil, w.controller.userId)).rejects.toThrow('Member not found.');
    await expect(issueMemberPasswordReset(w.db, evil, w.controller.userId)).rejects.toThrow('Member not found.');
    expect((await signIn(w.db, w.controller.userEmail, PASSWORD))?.step).toBe('second_factor');
  });

  it('cannot be done after the victim joined: an organisation cannot recover an account that also belongs elsewhere', async () => {
    const w = await createWorld();
    await enableMfa(w.db, w.accountant.userId);
    const evil = await strangerOwner(w.db);
    // The victim really joins the stranger's organisation (password and second step).
    await w.db.insert(memberships).values({ id: newId('mem'), orgId: evil.orgId, userId: w.accountant.userId, role: 'viewer' });

    await expect(resetMemberMfa(w.db, evil, w.accountant.userId)).rejects.toThrow(/also belongs to another organisation/);
    await expect(issueMemberPasswordReset(w.db, evil, w.accountant.userId)).rejects.toThrow(/also belongs to another organisation/);
    // The message does not name the other organisation.
    await expect(resetMemberMfa(w.db, evil, w.accountant.userId)).rejects.not.toThrow(w.owner.orgName);
    // Their own organisation is held to the same rule: recovering them would hand over the other membership too.
    await expect(resetMemberMfa(w.db, w.owner, w.accountant.userId)).rejects.toThrow(/also belongs to another organisation/);
    expect((await userRow(w.db, w.accountant.userId)).mfaEnabledAt).toBeInstanceOf(Date);
    expect(await w.db.select().from(notifications).where(eq(notifications.userId, w.accountant.userId))).toEqual([]);
  });

  it('still works for a member who belongs only to this organisation, or also to a demo workspace', async () => {
    const w = await createWorld();
    await enableMfa(w.db, w.pm.userId);
    await createOrganization(w.db, w.pm.userId, 'Sample workspace', { isDemo: true });
    await resetMemberMfa(w.db, w.owner, w.pm.userId);
    expect((await userRow(w.db, w.pm.userId)).mfaEnabledAt).toBeNull();
    const { link } = await issueMemberPasswordReset(w.db, w.owner, w.pm.userId);
    await completePasswordReset(w.db, link.split('/reset-password/')[1]!, 'a brand new password');
    expect(await authenticate(w.db, w.pm.userEmail, 'a brand new password')).toMatchObject({ id: w.pm.userId });
  });
});

describe('2. wrong passwords from strangers', () => {
  it('lock the address for new browsers, but not for a browser that signed in to the account before', async () => {
    const w = await createWorld();
    const first = await authenticate(w.db, w.controller.userEmail, PASSWORD, { ipAddress: '203.0.113.7' });
    const remembered = first!.deviceToken!;
    expect(remembered).toMatch(/^[0-9a-f]{16}\.[A-Za-z0-9_-]{32}$/);

    for (let i = 0; i < PASSWORD_ATTEMPTS_PER_EMAIL; i++) expect(await authenticate(w.db, w.controller.userEmail, 'wrong guess', { ipAddress: `198.51.100.${i + 1}` })).toBeNull();
    // A new browser is refused even with the right password, from any address.
    await expect(authenticate(w.db, w.controller.userEmail, PASSWORD, { ipAddress: '203.0.113.7' })).rejects.toThrow(TOO_MANY_SIGN_INS);
    // The owner's browser still gets in, and a stranger's browser with someone else's token does not.
    expect(await authenticate(w.db, w.controller.userEmail, PASSWORD, { ipAddress: '203.0.113.7', deviceTokens: [remembered] })).toMatchObject({ id: w.controller.userId });
    const other = (await authenticate(w.db, w.pm.userEmail, PASSWORD))!.deviceToken!;
    for (let i = 0; i < PASSWORD_ATTEMPTS_PER_EMAIL; i++) await authenticate(w.db, w.controller.userEmail, 'wrong again', { ipAddress: `198.51.100.${i + 50}` });
    await expect(authenticate(w.db, w.controller.userEmail, PASSWORD, { deviceTokens: [other] })).rejects.toThrow(TOO_MANY_SIGN_INS);
  });

  it('from one address lock that address for the account, remembered browser or not', async () => {
    const w = await createWorld();
    const remembered = (await authenticate(w.db, w.viewer.userEmail, PASSWORD))!.deviceToken!;
    for (let i = 0; i < PASSWORD_ATTEMPTS_PER_EMAIL; i++) {
      expect(await authenticate(w.db, w.viewer.userEmail, 'wrong guess', { ipAddress: '192.0.2.44', deviceTokens: [remembered] })).toBeNull();
    }
    await expect(authenticate(w.db, w.viewer.userEmail, PASSWORD, { ipAddress: '192.0.2.44', deviceTokens: [remembered] })).rejects.toThrow(TOO_MANY_SIGN_INS);
    expect(await authenticate(w.db, w.viewer.userEmail, PASSWORD, { ipAddress: '192.0.2.45', deviceTokens: [remembered] })).toMatchObject({ id: w.viewer.userId });
  });

  it('sent in an office’s name do not lock out the people who work there', async () => {
    const w = await createWorld();
    const office = '203.0.113.200';
    const remembered = (await authenticate(w.db, w.accountant.userEmail, PASSWORD, { ipAddress: office }))!.deviceToken!;
    for (let i = 0; i < PASSWORD_ATTEMPTS_PER_IP; i++) await authenticate(w.db, `spray${i}.${n}@example.test`, 'Spring2026!!', { ipAddress: office });
    await expect(authenticate(w.db, w.pm.userEmail, PASSWORD, { ipAddress: office })).rejects.toThrow(TOO_MANY_SIGN_INS);
    expect(await authenticate(w.db, w.accountant.userEmail, PASSWORD, { ipAddress: office, deviceTokens: [remembered] })).toMatchObject({ id: w.accountant.userId });
  });

  it('a remembered browser stops counting once the password changes', async () => {
    const w = await createWorld();
    const before = await userRow(w.db, w.owner.userId);
    const token = deviceToken(before)!;
    expect(isRememberedDevice(before, [token])).toBe(true);
    const here = await verifiedSession(w.db, w.owner.userId, w.orgId);
    await changePassword(w.db, w.owner.userId, PASSWORD, 'another long password', here.token);
    expect(isRememberedDevice(await userRow(w.db, w.owner.userId), [token])).toBe(false);
  });

  it('keeps a few accounts per browser and ignores anything malformed', () => {
    const a = deviceToken({ id: 'usr_a', passwordHash: 'h1' })!;
    const a2 = deviceToken({ id: 'usr_a', passwordHash: 'h2' })!;
    const b = deviceToken({ id: 'usr_b', passwordHash: 'h1' })!;
    const value = rememberDevice(parseDeviceCookie(rememberDevice([], a)), b);
    expect(parseDeviceCookie(value)).toEqual([b, a]);
    expect(parseDeviceCookie(rememberDevice(parseDeviceCookie(value), a2))).toEqual([a2, b]);
    expect(parseDeviceCookie(`junk~${a}~<script>`)).toEqual([a]);
  });
});

describe('4. sign-up', () => {
  it('is limited per address, so it cannot be used to test many emails for an account', async () => {
    const w = await createWorld();
    const ip = '198.18.0.9';
    await expect(signUp(w.db, { name: 'Carl Again', email: w.controller.userEmail, password: 'a long enough password', orgName: 'Again Co' }, { ipAddress: ip })).rejects.toThrow(/already exists/);
    for (let i = 1; i < SIGNUPS_PER_IP; i++) {
      await signUp(w.db, { name: 'New Person', email: `new${i}.${n}.${Date.now()}@example.test`, password: 'a long enough password', orgName: 'New Co' }, { ipAddress: ip });
    }
    await expect(signUp(w.db, { name: 'Carl Again', email: w.controller.userEmail, password: 'a long enough password', orgName: 'Again Co' }, { ipAddress: ip })).rejects.toThrow(TOO_MANY_SIGN_UPS);
    await expect(signUp(w.db, { name: 'Carl Again', email: w.controller.userEmail, password: 'a long enough password', orgName: 'Again Co' }, { ipAddress: '198.18.0.10' })).rejects.toThrow(/already exists/);
  });
});

describe('5. turning on two-step verification', () => {
  it('needs the current password', async () => {
    const w = await createWorld();
    await expect(startMfaSetup(w.db, w.viewer.userId, 'not my password')).rejects.toThrow(/current password is not correct/);
    expect((await userRow(w.db, w.viewer.userId)).mfaSecret).toBeNull();
    expect((await startMfaSetup(w.db, w.viewer.userId, PASSWORD)).secret).toMatch(/^[A-Z2-7]+$/);
  });
});

describe('6. recovery codes at rest', () => {
  it('are stored as a keyed hash, not a plain sha256 that a copy of the database could be checked against', () => {
    const code = 'k7m2p-9xw4c';
    expect(hashRecoveryCode(code)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashRecoveryCode(code)).toBe(hashRecoveryCode('K7M2P 9XW4C'));
    expect(hashRecoveryCode(code)).not.toBe(sha256Hex(`recovery:${normaliseRecoveryCode(code)}`));
    expect(hashRecoveryCode(code)).not.toBe(sha256Hex(normaliseRecoveryCode(code)));
  });
});
