/**
 * Links the system hands the app. On iOS, choosing Zephric under "Open in" or
 * "Copy to" (the document types in app.json) arrives here as a file:// address
 * in the app's Inbox folder: it is kept as a shared file (src/lib/shared.ts)
 * and the app opens at its start. Everything else passes through unchanged.
 */
import { Alert } from 'react-native';
import { receiveOpenedFile } from '@/lib/shared';

export async function redirectSystemPath({ path }: { path: string; initial: boolean }): Promise<string | null> {
  if (!path.startsWith('file://')) return path;
  try {
    const message = await receiveOpenedFile(path);
    if (message) Alert.alert('Some files were not added', message);
  } catch {
    Alert.alert('Not added', 'That file could not be added. Try again.');
  }
  return '/';
}
