/**
 * Symmetric encryption for secrets at rest (integration tokens).
 * AES-256-GCM with a key derived from RCM_SECRET_KEY.
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { dataDir, isInMemory, isProduction } from './config';

let cachedKey: Buffer | null = null;

function key(): Buffer {
  if (cachedKey) return cachedKey;
  const configured = process.env.RCM_SECRET_KEY;
  if (configured) {
    cachedKey = createHash('sha256').update(configured).digest();
    return cachedKey;
  }
  if (isProduction()) {
    throw new Error('RCM_SECRET_KEY must be set in production to store integration credentials.');
  }
  if (isInMemory()) {
    cachedKey = createHash('sha256').update('rcm-test-key').digest();
    return cachedKey;
  }
  // Development convenience: a random key persisted next to the local database.
  const file = path.join(dataDir(), 'dev-secret.key');
  if (!fs.existsSync(file)) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, randomBytes(32).toString('hex'), { mode: 0o600 });
  }
  cachedKey = createHash('sha256').update(fs.readFileSync(file, 'utf8').trim()).digest();
  return cachedKey;
}

export function encryptJson(value: unknown): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key(), iv);
  const body = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
  return ['v1', iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), body.toString('base64url')].join('.');
}

export function decryptJson<T>(payload: string): T {
  const [version, iv, tag, body] = payload.split('.');
  if (version !== 'v1' || !iv || !tag || !body) throw new Error('Unrecognised ciphertext format');
  const decipher = createDecipheriv('aes-256-gcm', key(), Buffer.from(iv, 'base64url'));
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  const plain = Buffer.concat([decipher.update(Buffer.from(body, 'base64url')), decipher.final()]);
  return JSON.parse(plain.toString('utf8')) as T;
}
