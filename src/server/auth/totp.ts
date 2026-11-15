/**
 * Time-based one-time passwords (RFC 6238 over RFC 4226), as authenticator
 * apps implement them: HMAC-SHA1, six digits, a 30-second step.
 *
 * Pure functions. What is stored, and when a code counts as used, is in
 * mfa.ts.
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { sha256Hex } from '@/server/ids';

export const TOTP_DIGITS = 6;
export const TOTP_STEP_SECONDS = 30;
/** Steps either side of the current one that are accepted, to allow for a phone clock that is a little off. */
export const TOTP_WINDOW = 1;
const SECRET_BYTES = 20; // 160 bits, the length RFC 4226 recommends

// ── Base32 (RFC 4648, no padding) ───────────────────────────────────────────

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(bytes: Uint8Array): string {
  let out = '';
  let buffer = 0;
  let bits = 0;
  for (const byte of bytes) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(buffer >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32[(buffer << (5 - bits)) & 31];
  return out;
}

/** Accepts lower case, spaces, dashes and padding, which is how people retype a key. Null if it is not base32. */
export function base32Decode(text: string): Buffer | null {
  const clean = text.toUpperCase().replace(/[\s-]/g, '').replace(/=+$/, '');
  if (clean.length === 0) return null;
  const bytes: number[] = [];
  let buffer = 0;
  let bits = 0;
  for (const char of clean) {
    const value = BASE32.indexOf(char);
    if (value < 0) return null;
    buffer = (buffer << 5) | value;
    bits += 5;
    if (bits >= 8) {
      bytes.push((buffer >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

// ── Codes ───────────────────────────────────────────────────────────────────

export function generateTotpSecret(): string {
  return base32Encode(randomBytes(SECRET_BYTES));
}

/** The key in groups of four, which is easier to type into an authenticator app. */
export function formatTotpSecret(secret: string): string {
  return secret.replace(/(.{4})(?=.)/g, '$1 ');
}

/** RFC 4226: the code for one counter value. */
export function hotp(key: Uint8Array, counter: number, digits = TOTP_DIGITS): string {
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));
  const mac = createHmac('sha1', key).update(message).digest();
  const offset = mac[mac.length - 1]! & 0x0f;
  const binary = ((mac[offset]! & 0x7f) << 24) | (mac[offset + 1]! << 16) | (mac[offset + 2]! << 8) | mac[offset + 3]!;
  return String(binary % 10 ** digits).padStart(digits, '0');
}

/** The 30-second step a moment falls in. */
export function totpCounter(at: Date | number = Date.now()): number {
  return Math.floor((typeof at === 'number' ? at : at.getTime()) / 1000 / TOTP_STEP_SECONDS);
}

/** The code an authenticator app shows for this key at this moment. */
export function totpCode(secret: string, at: Date | number = Date.now()): string {
  const key = base32Decode(secret);
  if (!key) throw new Error('The two-step verification key is not valid base32.');
  return hotp(key, totpCounter(at));
}

function sameCode(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

/**
 * Check a six-digit code against the key. Returns the step it matched, so the
 * caller can record it, or null.
 *
 * `after` is the last step that was accepted for this account. A code for
 * that step or an earlier one is refused, which is what stops a code that was
 * seen once (over a shoulder, in a proxy log) from being used again.
 */
export function verifyTotp(secret: string, code: string, opts: { at?: Date | number; after?: number | null } = {}): number | null {
  const key = base32Decode(secret);
  if (!key || !/^\d{6}$/.test(code)) return null;
  const current = totpCounter(opts.at);
  let matched: number | null = null;
  // Every step in the window is checked, so the time taken does not show which one matched.
  for (let step = current - TOTP_WINDOW; step <= current + TOTP_WINDOW; step++) {
    if (step < 0) continue;
    if (sameCode(hotp(key, step), code) && matched === null) matched = step;
  }
  if (matched === null) return null;
  if (opts.after != null && matched <= opts.after) return null;
  return matched;
}

/** What the QR code encodes. Authenticator apps show `issuer` and `account` next to the code. */
export function otpauthUri(input: { secret: string; account: string; issuer: string }): string {
  const label = `${encodeURIComponent(input.issuer)}:${encodeURIComponent(input.account)}`;
  const query = new URLSearchParams({ secret: input.secret, issuer: input.issuer, algorithm: 'SHA1', digits: String(TOTP_DIGITS), period: String(TOTP_STEP_SECONDS) });
  return `otpauth://totp/${label}?${query.toString()}`;
}

// ── Recovery codes ──────────────────────────────────────────────────────────

export const RECOVERY_CODE_COUNT = 10;
// No 0/o, 1/i/l or u: characters that are misread when a code is copied from paper.
const RECOVERY_ALPHABET = '23456789abcdefghjkmnpqrstvwxyz';

/** Ten codes of the form `k7m2p-9xw4c`: ten characters, about 49 bits each. */
export function generateRecoveryCodes(): string[] {
  const codes: string[] = [];
  while (codes.length < RECOVERY_CODE_COUNT) {
    let code = '';
    while (code.length < 10) {
      // Rejection sampling, so every character is equally likely.
      for (const byte of randomBytes(16)) {
        if (byte < 240 && code.length < 10) code += RECOVERY_ALPHABET[byte % RECOVERY_ALPHABET.length];
      }
    }
    const formatted = `${code.slice(0, 5)}-${code.slice(5)}`;
    if (!codes.includes(formatted)) codes.push(formatted);
  }
  return codes;
}

/** How a recovery code is compared: lower case, without the dash or any spaces. */
export function normaliseRecoveryCode(input: string): string {
  return input.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** Only this hash of a recovery code is stored. */
export function hashRecoveryCode(code: string): string {
  return sha256Hex(`recovery:${normaliseRecoveryCode(code)}`);
}

/** Whether what was typed is shaped like an authenticator code or like a recovery code. */
export function secondFactorKind(input: string): 'totp' | 'recovery' | null {
  const compact = input.replace(/[\s-]/g, '');
  if (/^\d{6}$/.test(compact)) return 'totp';
  if (normaliseRecoveryCode(input).length === 10) return 'recovery';
  return null;
}
