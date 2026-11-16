/**
 * The session token and the remembered-device token, in the iOS keychain /
 * Android keystore-backed storage. Readable only by this app, only while the
 * device is unlocked, and never backed up to another device.
 */
import * as SecureStore from 'expo-secure-store';

const SESSION = 'zephric.session';
const DEVICE = 'zephric.device';

const options: SecureStore.SecureStoreOptions = { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY };

/** What is kept about the signed-in person so drafts still open offline. Nothing financial. */
export type StoredProfile = {
  userId: string;
  name: string;
  email: string;
  orgId: string | null;
  orgName: string | null;
  role: string | null;
  canUpload: boolean;
};

export type StoredSession = { token: string; expiresAt: string; server: string; profile: StoredProfile | null };

export async function readSession(): Promise<StoredSession | null> {
  try {
    const raw = await SecureStore.getItemAsync(SESSION, options);
    if (!raw) return null;
    const value = JSON.parse(raw) as StoredSession;
    if (!value.token || new Date(value.expiresAt).getTime() <= Date.now()) {
      await clearSession();
      return null;
    }
    return value;
  } catch {
    return null;
  }
}

export async function writeSession(session: StoredSession): Promise<void> {
  await SecureStore.setItemAsync(SESSION, JSON.stringify(session), options);
}

export async function clearSession(): Promise<void> {
  await SecureStore.deleteItemAsync(SESSION, options).catch(() => undefined);
}

export async function readDeviceToken(): Promise<string | null> {
  return SecureStore.getItemAsync(DEVICE, options).catch(() => null);
}

export async function writeDeviceToken(token: string | null): Promise<void> {
  if (token) await SecureStore.setItemAsync(DEVICE, token, options).catch(() => undefined);
}
