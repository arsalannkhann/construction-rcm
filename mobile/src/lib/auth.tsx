/**
 * Who is signed in, and the transitions between signed out, second step,
 * signed in and locked.
 *
 * A session here is a website session (same lifetime, idle limit and
 * revocation), held in secure storage. Signing out ends it on the server too.
 * Switching organisation or signing out drops every cached response, so
 * nothing from one organisation is ever shown in another.
 */
import { onlineManager, useQueryClient } from '@tanstack/react-query';
import * as LocalAuthentication from 'expo-local-authentication';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { AppState } from 'react-native';
import { api, ApiError, configureApi, NetworkError, type Me, type SignInResult } from './api';
import { clearDocumentCache } from './documents';
import { readPrefs, writePrefs } from './prefs';
import { clearSession, readDeviceToken, readSession, writeDeviceToken, writeSession, type StoredProfile, type StoredSession } from './secure';

export type AuthState =
  | { status: 'booting' }
  | { status: 'signed_out'; notice: string | null }
  | { status: 'verify'; challenge: string; email: string }
  | { status: 'signed_in'; me: Me | null; profile: StoredProfile; offline: boolean };

type AuthApi = {
  state: AuthState;
  locked: boolean;
  server: string;
  setServer: (server: string) => void;
  signIn: (email: string, password: string) => Promise<'signed_in' | 'verify'>;
  verify: (code: string) => Promise<{ status: 'signed_in' } | { status: 'wrong_code'; attemptsLeft: number }>;
  cancelVerify: () => void;
  signOut: (notice?: string | null) => Promise<void>;
  refreshMe: () => Promise<void>;
  switchOrganization: (orgId: string) => Promise<void>;
  unlock: () => Promise<boolean>;
  biometric: boolean;
  setBiometric: (on: boolean) => Promise<boolean>;
};

const AuthContext = createContext<AuthApi | null>(null);

/** How long the app may sit in the background before biometric unlock is asked for again. */
const LOCK_AFTER_MS = 60_000;

function profileOf(me: Me): StoredProfile {
  return {
    userId: me.user.id,
    name: me.user.name,
    email: me.user.email,
    orgId: me.organization?.id ?? null,
    orgName: me.organization?.name ?? null,
    role: me.organization?.roleLabel ?? null,
    canUpload: me.permissions.upload,
  };
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const [state, setState] = useState<AuthState>({ status: 'booting' });
  const [server, setServerState] = useState(() => readPrefs().server);
  const [biometric, setBiometricState] = useState(() => readPrefs().biometric);
  const [locked, setLocked] = useState(() => readPrefs().biometric);
  const session = useRef<StoredSession | null>(null);
  const backgroundedAt = useRef<number | null>(null);

  const forget = useCallback(
    async (notice: string | null) => {
      session.current = null;
      configureApi({ token: null });
      await clearSession();
      queryClient.clear();
      clearDocumentCache();
      setLocked(false);
      setState({ status: 'signed_out', notice });
    },
    [queryClient],
  );

  // A response saying the session is over (expired, revoked elsewhere, password changed) signs the app out.
  useEffect(() => {
    configureApi({ server, onSignedOut: (reason) => void forget(reason) });
  }, [server, forget]);

  const adopt = useCallback(
    async (token: string, expiresAt: string) => {
      configureApi({ token, server });
      const me = await api<Me>('/api/mobile/me', { token });
      const stored: StoredSession = { token, expiresAt, server, profile: profileOf(me) };
      session.current = stored;
      await writeSession(stored);
      queryClient.clear();
      setState({ status: 'signed_in', me, profile: profileOf(me), offline: false });
    },
    [queryClient, server],
  );

  const refreshMe = useCallback(async () => {
    const s = session.current;
    if (!s) return;
    try {
      const me = await api<Me>('/api/mobile/me');
      s.profile = profileOf(me);
      await writeSession(s);
      setState({ status: 'signed_in', me, profile: s.profile, offline: false });
    } catch (err) {
      if (err instanceof NetworkError && s.profile) setState((prev) => (prev.status === 'signed_in' ? { ...prev, offline: true } : prev));
    }
  }, []);

  // Opened offline, the app knows only the stored profile. Coming back online
  // loads the rest (organisations, two-step status) without waiting for the
  // app to be reopened.
  useEffect(() => onlineManager.subscribe((online) => {
    if (online && session.current) void refreshMe();
  }), [refreshMe]);

  // Start: an existing session opens straight into the app; offline, it still opens the drafts.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const stored = await readSession();
      if (cancelled) return;
      if (!stored || stored.server !== readPrefs().server) {
        if (stored) await clearSession();
        setLocked(false);
        setState({ status: 'signed_out', notice: null });
        return;
      }
      session.current = stored;
      configureApi({ token: stored.token, server: stored.server });
      try {
        const me = await api<Me>('/api/mobile/me');
        if (cancelled) return;
        stored.profile = profileOf(me);
        await writeSession(stored);
        setState({ status: 'signed_in', me, profile: stored.profile, offline: false });
      } catch (err) {
        if (cancelled) return;
        if (err instanceof NetworkError && stored.profile) setState({ status: 'signed_in', me: null, profile: stored.profile, offline: true });
        else if (err instanceof ApiError && err.status === 401) await forget('Your session has ended. Sign in again.');
        else if (err instanceof ApiError && err.status === 403 && stored.profile) setState({ status: 'signed_in', me: null, profile: stored.profile, offline: false });
        else await forget(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [forget]);

  // Lock again after a while in the background, when biometric unlock is on.
  useEffect(() => {
    const sub = AppState.addEventListener('change', (next) => {
      if (next === 'background' || next === 'inactive') {
        if (backgroundedAt.current === null) backgroundedAt.current = Date.now();
      } else if (next === 'active') {
        const away = backgroundedAt.current === null ? 0 : Date.now() - backgroundedAt.current;
        backgroundedAt.current = null;
        if (biometric && session.current && away > LOCK_AFTER_MS) setLocked(true);
        if (session.current) void refreshMe();
      }
    });
    return () => sub.remove();
  }, [biometric, refreshMe]);

  const signIn = useCallback(
    async (email: string, password: string) => {
      const deviceToken = await readDeviceToken();
      const result = await api<SignInResult>('/api/mobile/session', { method: 'POST', token: null, body: { email, password, ...(deviceToken ? { deviceToken } : {}) } });
      if (result.status === 'verify') {
        setState({ status: 'verify', challenge: result.challenge, email });
        return 'verify' as const;
      }
      await writeDeviceToken(result.deviceToken);
      await adopt(result.token, result.expiresAt);
      return 'signed_in' as const;
    },
    [adopt],
  );

  const verify = useCallback(
    async (code: string) => {
      if (state.status !== 'verify') throw new Error('No sign-in is waiting for a code.');
      try {
        const result = await api<SignInResult>('/api/mobile/session/verify', { method: 'POST', token: null, body: { challenge: state.challenge, code } });
        if (result.status !== 'signed_in') throw new Error('Unexpected answer.');
        await writeDeviceToken(result.deviceToken);
        await adopt(result.token, result.expiresAt);
        return { status: 'signed_in' as const };
      } catch (err) {
        if (err instanceof ApiError && err.body?.status === 'wrong_code') return { status: 'wrong_code' as const, attemptsLeft: Number(err.body.attemptsLeft ?? 0) };
        if (err instanceof ApiError && err.body?.status === 'restart') setState({ status: 'signed_out', notice: err.message });
        throw err;
      }
    },
    [adopt, state],
  );

  const signOut = useCallback(
    async (notice: string | null = 'You have signed out. Nothing from your company stays open in the app.') => {
      const token = session.current?.token;
      if (token) await api('/api/mobile/session', { method: 'DELETE', token, timeoutMs: 8_000 }).catch(() => undefined);
      await forget(notice);
    },
    [forget],
  );

  const switchOrganization = useCallback(
    async (orgId: string) => {
      await api('/api/mobile/org', { method: 'POST', body: { orgId } });
      // Nothing cached from the previous organisation may be shown in the next one.
      queryClient.clear();
      clearDocumentCache();
      const s = session.current;
      if (s) await adopt(s.token, s.expiresAt);
    },
    [adopt, queryClient],
  );

  const unlock = useCallback(async () => {
    const result = await LocalAuthentication.authenticateAsync({ promptMessage: 'Unlock Zephric', cancelLabel: 'Cancel', disableDeviceFallback: false });
    if (result.success) setLocked(false);
    return result.success;
  }, []);

  const setBiometric = useCallback(async (on: boolean) => {
    if (on) {
      const [hardware, enrolled] = await Promise.all([LocalAuthentication.hasHardwareAsync(), LocalAuthentication.isEnrolledAsync()]);
      if (!hardware || !enrolled) return false;
      const result = await LocalAuthentication.authenticateAsync({ promptMessage: 'Turn on biometric unlock', disableDeviceFallback: false });
      if (!result.success) return false;
    }
    writePrefs({ biometric: on });
    setBiometricState(on);
    return true;
  }, []);

  const setServer = useCallback((next: string) => {
    writePrefs({ server: next });
    setServerState(next);
    configureApi({ server: next });
  }, []);

  const cancelVerify = useCallback(() => setState({ status: 'signed_out', notice: null }), []);

  const value = useMemo<AuthApi>(
    () => ({ state, locked: locked && state.status === 'signed_in', server, setServer, signIn, verify, cancelVerify, signOut, refreshMe, switchOrganization, unlock, biometric, setBiometric }),
    [state, locked, server, setServer, signIn, verify, cancelVerify, signOut, refreshMe, switchOrganization, unlock, biometric, setBiometric],
  );
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthApi {
  const value = useContext(AuthContext);
  if (!value) throw new Error('useAuth outside AuthProvider');
  return value;
}

/** The signed-in state, for screens that only render when signed in. */
export function useSignedIn() {
  const { state } = useAuth();
  if (state.status !== 'signed_in') throw new Error('Not signed in');
  return state;
}
