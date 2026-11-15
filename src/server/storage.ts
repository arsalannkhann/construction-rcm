/**
 * Original-document storage. Content-addressed (sha256) and namespaced by
 * organisation, so an uploaded file is never modified and identical re-uploads
 * are detectable. Local disk today; the two functions below are the whole
 * surface an object-store adapter would need to implement.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { dataDir, isInMemory } from './config';
import { sha256Hex } from './ids';

const memory = new Map<string, Buffer>();
const KEY_PATTERN = /^[a-z0-9_]+\/[a-z0-9_-]+\/[a-f0-9]{64}$/;

function resolve(key: string): string {
  if (!KEY_PATTERN.test(key)) throw new Error('Invalid storage key');
  return path.join(dataDir(), 'storage', key);
}

export type StoredObject = { key: string; sha256: string; size: number };

export async function putObject(orgId: string, namespace: 'documents' | 'exports', bytes: Uint8Array): Promise<StoredObject> {
  const sha256 = sha256Hex(bytes);
  const key = `${orgId}/${namespace}/${sha256}`;
  if (isInMemory()) {
    memory.set(key, Buffer.from(bytes));
  } else {
    const file = resolve(key);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, bytes);
  }
  return { key, sha256, size: bytes.byteLength };
}

export async function getObject(key: string): Promise<Buffer> {
  if (isInMemory()) {
    const hit = memory.get(key);
    if (!hit) throw new Error('Stored object not found');
    return hit;
  }
  return fs.readFile(resolve(key));
}
