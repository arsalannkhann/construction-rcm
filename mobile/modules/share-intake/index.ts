/**
 * Android's Share sheet into Zephric (android/…/ShareIntakeModule.kt).
 * Absent on iOS, where shared files arrive as file:// links instead
 * (app/+native-intent.tsx).
 */
import { requireOptionalNativeModule, type EventSubscription } from 'expo-modules-core';

export type SharedFileStatus = 'ok' | 'too_large' | 'unreadable' | 'unsupported';

export type SharedFile = {
  /** A file:// copy in the app's cache; null unless status is 'ok'. */
  uri: string | null;
  name: string | null;
  mimeType: string | null;
  size: number | null;
  status: SharedFileStatus;
};

export type TakenShare = { files: SharedFile[]; overLimit: number };

type NativeShareIntake = {
  take(maxFiles: number, maxBytes: number): Promise<TakenShare>;
  addListener(event: 'onShare', listener: () => void): EventSubscription;
};

const native = requireOptionalNativeModule<NativeShareIntake>('ZephricShareIntake');

export const shareIntakeAvailable = native !== null;

/** Copies the share that opened the app, or arrived since, at most `maxFiles` of them. Each file is taken once. */
export async function takeShare(maxFiles: number, maxBytes: number): Promise<TakenShare> {
  if (!native) return { files: [], overLimit: 0 };
  return native.take(maxFiles, maxBytes);
}

/** Called when something is shared to the app while it is open. */
export function onShare(listener: () => void): () => void {
  if (!native) return () => {};
  const sub = native.addListener('onShare', listener);
  return () => sub.remove();
}
