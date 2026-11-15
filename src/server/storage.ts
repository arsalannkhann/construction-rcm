/**
 * Original-document and export storage. Content-addressed (sha256) and
 * namespaced by organisation, so a stored file is never modified and identical
 * re-uploads are detectable.
 *
 * Three backends behind the same two functions:
 *
 *   database  The bytes live in PostgreSQL (`stored_objects`). This is the
 *             default whenever DATABASE_URL is set, so one database backup
 *             captures the records AND the documents they refer to, the
 *             write is part of the same transaction as the row that points
 *             at it, and any number of app instances see the same files.
 *   disk      Files under RCM_DATA_DIR/storage. The default for the embedded
 *             database (local evaluation). Must be backed up alongside it.
 *   memory    Tests.
 *
 * Override with RCM_STORAGE=database|disk. An S3-compatible backend would
 * implement the same two functions; it is not needed at pilot volumes
 * (a billing package is typically a few megabytes).
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { getDb } from '@/db';
import { storedObjects } from '@/db/schema';
import { currentTx } from '@/db/tx';
import { dataDir, isInMemory } from './config';
import { sha256Hex } from './ids';

const memory = new Map<string, Buffer>();
const KEY_PATTERN = /^[a-z0-9_]+\/[a-z0-9_-]+\/[a-f0-9]{64}$/;

export type StorageMode = 'database' | 'disk' | 'memory';

export function storageMode(): StorageMode {
  const forced = process.env.RCM_STORAGE;
  if (forced === 'database' || forced === 'disk') return forced;
  if (process.env.DATABASE_URL) return 'database';
  return isInMemory() ? 'memory' : 'disk';
}

function assertKey(key: string): void {
  if (!KEY_PATTERN.test(key)) throw new Error('Invalid storage key');
}

function diskPath(key: string): string {
  assertKey(key);
  return path.join(dataDir(), 'storage', key);
}

export type StoredObject = { key: string; sha256: string; size: number };

export async function putObject(orgId: string, namespace: 'documents' | 'exports', bytes: Uint8Array): Promise<StoredObject> {
  const sha256 = sha256Hex(bytes);
  const key = `${orgId}/${namespace}/${sha256}`;
  assertKey(key);
  const mode = storageMode();
  if (mode === 'database') {
    // Inside a transaction this joins it: the bytes and the row that refers to them commit together.
    const db = currentTx() ?? (await getDb());
    await db.insert(storedObjects).values({ key, orgId, sha256, size: bytes.byteLength, bytes }).onConflictDoNothing();
  } else if (mode === 'memory') {
    memory.set(key, Buffer.from(bytes));
  } else {
    const file = diskPath(key);
    await fs.mkdir(path.dirname(file), { recursive: true });
    // Write to a temporary name and rename, so a crash never leaves a truncated file under the real key.
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
    await fs.writeFile(tmp, bytes);
    await fs.rename(tmp, file);
  }
  return { key, sha256, size: bytes.byteLength };
}

export class StoredObjectMissing extends Error {
  constructor(key: string) {
    super(`Stored object ${key} is missing from ${storageMode()} storage`);
    this.name = 'StoredObjectMissing';
  }
}

export async function getObject(key: string): Promise<Buffer> {
  assertKey(key);
  const mode = storageMode();
  let bytes: Buffer | null = null;
  if (mode === 'database') {
    const db = currentTx() ?? (await getDb());
    const [row] = await db.select({ bytes: storedObjects.bytes }).from(storedObjects).where(eq(storedObjects.key, key));
    bytes = row ? Buffer.from(row.bytes) : null;
  } else if (mode === 'memory') {
    bytes = memory.get(key) ?? null;
  } else {
    bytes = await fs.readFile(diskPath(key)).catch((err: NodeJS.ErrnoException) => {
      if (err.code === 'ENOENT') return null;
      throw err;
    });
  }
  if (!bytes) throw new StoredObjectMissing(key);
  // The key ends in the hash of the content, so corruption or tampering is detectable on every read.
  if (sha256Hex(bytes) !== key.slice(-64)) throw new Error(`Stored object ${key} failed its integrity check: the bytes no longer match their hash`);
  return bytes;
}
