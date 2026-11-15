import { randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';

const N = 16384;
const KEYLEN = 64;

function scrypt(password: string, salt: Buffer, n: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCb(password, salt, KEYLEN, { N: n, r: 8, p: 1 }, (err, key) => (err ? reject(err) : resolve(key)));
  });
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scrypt(password, salt, N);
  return `scrypt$${N}$${salt.toString('base64url')}$${key.toString('base64url')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, n, salt, hash] = stored.split('$');
  if (scheme !== 'scrypt' || !n || !salt || !hash) return false;
  const expected = Buffer.from(hash, 'base64url');
  const actual = await scrypt(password, Buffer.from(salt, 'base64url'), Number(n));
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

/**
 * A well-formed hash of nothing in particular. Checking a password against it
 * takes as long as checking a real one, so a sign-in attempt for an address
 * with no account does not come back faster than one for an address with one.
 */
export const DUMMY_PASSWORD_HASH = `scrypt$${N}$AAAAAAAAAAAAAAAAAAAAAA$${'A'.repeat(86)}`;

export { passwordProblem } from './password-rules';
