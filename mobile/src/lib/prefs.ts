/**
 * Small, non-secret preferences kept in the app's own files: theme, server,
 * whether biometric unlock is on. Secrets (the session token) live in the
 * keychain / keystore instead (src/lib/secure.ts).
 */
import { File, Paths } from 'expo-file-system';
import Constants from 'expo-constants';
import type { ThemePref } from '@/theme';

export type Prefs = {
  theme: ThemePref;
  server: string;
  biometric: boolean;
};

const extra = (Constants.expoConfig?.extra ?? {}) as { apiUrl?: string; localTestBuild?: boolean };
const DEFAULT_SERVER = String(extra.apiUrl ?? 'https://zephric.vercel.app');
/** The local test variant (mobile/app.config.js), never a distributed build. */
const LOCAL_TEST_BUILD = extra.localTestBuild === true;

const defaults: Prefs = { theme: 'system', server: DEFAULT_SERVER, biometric: false };

function file(): File {
  return new File(Paths.document, 'prefs.json');
}

let cache: Prefs | null = null;

export function readPrefs(): Prefs {
  if (cache) return cache;
  try {
    const f = file();
    cache = f.exists ? { ...defaults, ...(JSON.parse(f.textSync()) as Partial<Prefs>) } : { ...defaults };
  } catch {
    cache = { ...defaults };
  }
  return cache;
}

export function writePrefs(patch: Partial<Prefs>): Prefs {
  const next = { ...readPrefs(), ...patch };
  cache = next;
  try {
    const f = file();
    if (!f.exists) f.create();
    f.writeSync(JSON.stringify(next));
  } catch {
    /* A preference that is not saved is not worth interrupting anyone for. */
  }
  return next;
}

export const defaultServer = DEFAULT_SERVER;

/**
 * A server address someone typed. Release builds talk only to https; a
 * development build may also use a computer on the local network, and the
 * local test variant the phone's own localhost (forwarded by adb reverse).
 */
export function normalizeServer(input: string): string | null {
  let value = input.trim().replace(/\/+$/, '');
  if (!value) return null;
  if (!/^https?:\/\//i.test(value)) value = `https://${value}`;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  const local = /^(localhost|127\.0\.0\.1|10\.0\.2\.2|192\.168\.\d+\.\d+|10\.\d+\.\d+\.\d+)$/.test(url.hostname);
  const loopback = /^(localhost|127\.0\.0\.1)$/.test(url.hostname);
  if (url.protocol === 'http:' && !((__DEV__ && local) || (LOCAL_TEST_BUILD && loopback))) return null;
  if (url.pathname !== '/' && url.pathname !== '') return null;
  return `${url.protocol}//${url.host}`;
}
