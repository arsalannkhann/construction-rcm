/**
 * Remembered devices: a browser that has signed in to an account before.
 *
 * After a complete sign-in the browser gets a long-lived HttpOnly cookie
 * holding a token for that account. The token is a keyed hash of the account
 * id and its current password hash, so it stops working when the password
 * changes and nobody can make one without RCM_SECRET_KEY. Nothing is stored
 * in the database.
 *
 * Its only use is the sign-in limit (src/server/auth/throttle.ts). Wrong
 * passwords for an address from anywhere lock that address for new browsers,
 * but a browser that has signed in to the account before can still try, so a
 * stranger guessing at someone's address cannot keep them out of their own
 * account. It grants nothing else: the password and the second step are
 * still required.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { purposeKey } from '@/server/crypto';
import { sha256Hex } from '@/server/ids';

export const DEVICE_COOKIE = 'rcm_device';
export const DEVICE_COOKIE_DAYS = 180;
/** A browser shared by a few people remembers each of them; older entries drop off. */
const MAX_ACCOUNTS_PER_BROWSER = 5;

type Account = { id: string; passwordHash: string };

const tagOf = (userId: string) => sha256Hex(`device-tag:${userId}`).slice(0, 16);

/**
 * The token for an account on a remembered browser, or null when no key is
 * available (production without RCM_SECRET_KEY): then no device is
 * remembered and every browser is treated as new.
 */
export function deviceToken(account: Account): string | null {
  let key: Buffer;
  try {
    key = purposeKey('remembered-device');
  } catch {
    return null;
  }
  const mac = createHmac('sha256', key).update(`${account.id}:${account.passwordHash}`).digest('base64url').slice(0, 32);
  return `${tagOf(account.id)}.${mac}`;
}

/** The tokens in the cookie's value. Anything malformed is ignored. */
export function parseDeviceCookie(value: string | null | undefined): string[] {
  if (!value) return [];
  return value
    .split('~')
    .filter((t) => /^[0-9a-f]{16}\.[A-Za-z0-9_-]{32}$/.test(t))
    .slice(0, MAX_ACCOUNTS_PER_BROWSER);
}

/** Whether one of the presented tokens is this account's current one. */
export function isRememberedDevice(account: Account, presented: string[]): boolean {
  const expected = deviceToken(account);
  if (!expected) return false;
  const want = Buffer.from(expected);
  return presented.some((t) => t.length === expected.length && timingSafeEqual(Buffer.from(t), want));
}

/** The cookie's new value: this account's token first, replacing any older one for the same account. */
export function rememberDevice(existing: string[], token: string): string {
  const tag = token.split('.')[0];
  return [token, ...existing.filter((t) => t.split('.')[0] !== tag)].slice(0, MAX_ACCOUNTS_PER_BROWSER).join('~');
}
