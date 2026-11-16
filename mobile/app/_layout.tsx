import { QueryClientProvider } from '@tanstack/react-query';
import { NavigationBar } from 'expo-navigation-bar';
import { router, Stack, useRootNavigationState } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import * as SystemUI from 'expo-system-ui';
import { useEffect, useRef, useState } from 'react';
import { Alert, AppState, StyleSheet, View } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import Fingerprint from 'lucide-react-native/icons/fingerprint-pattern';
import { AuthProvider, useAuth } from '@/lib/auth';
import { DraftLimitError, tidyReceipts, type Owner } from '@/lib/drafts';
import { readPrefs, writePrefs } from '@/lib/prefs';
import { makeQueryClient, wireQueryLifecycle } from '@/lib/queries';
import { runQueue, startSender } from '@/lib/sender';
import { clearShared, collectAndroidShare, openSharedAsCapture, usePendingShare } from '@/lib/shared';
import { onShare } from '../modules/share-intake';
import { ThemeContext, usePalette, type ThemePref } from '@/theme';
import { BrandMark, Button, T } from '@/ui/kit';
import { useOnline } from '@/ui/parts';

const queryClient = makeQueryClient();

export default function RootLayout() {
  const [pref, setPrefState] = useState<ThemePref>(() => readPrefs().theme);
  const setPref = (next: ThemePref) => {
    writePrefs({ theme: next });
    setPrefState(next);
  };
  useEffect(() => wireQueryLifecycle(), []);
  useEffect(() => tidyReceipts(), []);
  // Files shared from another app (Android). They are kept on the phone at
  // once, signed in or not; SharedIntake opens them once someone can use them.
  useEffect(() => {
    const collect = () =>
      void collectAndroidShare()
        .then((message) => {
          if (message) Alert.alert('Some files were not added', message);
        })
        .catch(() => Alert.alert('Not added', 'The shared files could not be added. Try sharing them again.'));
    collect();
    return onShare(collect);
  }, []);

  return (
    <ThemeContext.Provider value={{ pref, setPref }}>
      <SafeAreaProvider>
        <QueryClientProvider client={queryClient}>
          <AuthProvider>
            <Shell />
          </AuthProvider>
        </QueryClientProvider>
      </SafeAreaProvider>
    </ThemeContext.Provider>
  );
}

function Shell() {
  const p = usePalette();
  const { state, locked } = useAuth();
  const signedIn = state.status === 'signed_in';

  useEffect(() => {
    void SystemUI.setBackgroundColorAsync(p.canvas);
  }, [p.canvas]);

  if (state.status === 'booting') return <Splash />;

  return (
    <View style={{ flex: 1, backgroundColor: p.canvas }}>
      <StatusBar style={p.scheme === 'dark' ? 'light' : 'dark'} />
      <NavigationBar style={p.scheme === 'dark' ? 'light' : 'dark'} />
      <Stack
        screenOptions={{
          headerShown: false,
          contentStyle: { backgroundColor: p.canvas },
          headerStyle: { backgroundColor: p.canvas },
          headerTintColor: p.ink,
          headerTitleStyle: { color: p.ink, fontWeight: '600' },
          headerShadowVisible: false,
          headerBackButtonDisplayMode: 'minimal',
        }}
      >
        <Stack.Protected guard={signedIn}>
          <Stack.Screen name="(tabs)" />
          <Stack.Screen name="application/[id]" options={{ headerShown: true, title: 'Application' }} />
          <Stack.Screen name="project/[id]" options={{ headerShown: true, title: 'Project' }} />
          <Stack.Screen name="capture/index" options={{ headerShown: true, title: 'Capture' }} />
          <Stack.Screen name="capture/[id]" options={{ headerShown: true, title: 'Draft' }} />
          <Stack.Screen name="request-info/[id]" options={{ headerShown: true, title: 'Request information', presentation: 'modal' }} />
          <Stack.Screen name="pick-contract/[draftId]" options={{ headerShown: true, title: 'Choose a subcontract', presentation: 'modal' }} />
        </Stack.Protected>
        <Stack.Protected guard={!signedIn}>
          <Stack.Screen name="sign-in" />
          <Stack.Protected guard={state.status === 'verify'}>
            <Stack.Screen name="verify" />
          </Stack.Protected>
        </Stack.Protected>
      </Stack>
      {signedIn ? <Sender owner={state.profile.orgId ? { userId: state.profile.userId, orgId: state.profile.orgId } : null} /> : null}
      {signedIn && !locked ? <SharedIntake owner={state.profile.orgId ? { userId: state.profile.userId, orgId: state.profile.orgId } : null} canUpload={state.profile.canUpload} /> : null}
      {locked ? <LockScreen /> : null}
      <PrivacyCover />
    </View>
  );
}

/** Sends queued drafts in the background while the app is open. */
function Sender({ owner }: { owner: Owner | null }) {
  const online = useOnline();
  const ownerRef = useRef(owner);
  const onlineRef = useRef(online);
  ownerRef.current = owner;
  onlineRef.current = online;
  useEffect(
    () =>
      startSender(
        () => ownerRef.current,
        () => onlineRef.current,
      ),
    [],
  );
  // Coming back online sends what was waiting.
  useEffect(() => {
    if (online) void runQueue(ownerRef.current, true);
  }, [online]);
  return null;
}

/**
 * Shared files waiting on the phone become a new capture for the person signed
 * in, in their current organisation, and the capture opens. Nothing is sent
 * until they press Send there.
 */
function SharedIntake({ owner, canUpload }: { owner: Owner | null; canUpload: boolean }) {
  const pending = usePendingShare();
  const nav = useRootNavigationState();
  const busy = useRef(false);
  useEffect(() => {
    if (!pending || !owner || !nav?.key || busy.current) return;
    if (!canUpload) {
      clearShared();
      Alert.alert('Your role cannot submit documents', 'The shared files were not added. Ask an admin in your organisation for upload access.');
      return;
    }
    busy.current = true;
    openSharedAsCapture(owner)
      .then((id) => {
        if (id) router.push({ pathname: '/capture/[id]', params: { id, shared: '1' } });
      })
      .catch((err) => Alert.alert('Not added', err instanceof DraftLimitError ? err.message : 'The shared files could not be added. Try sharing them again.'))
      .finally(() => {
        busy.current = false;
      });
  }, [pending, owner?.userId, owner?.orgId, canUpload, nav?.key]);
  return null;
}

function Splash() {
  const p = usePalette();
  return (
    <View style={{ flex: 1, backgroundColor: p.canvas, alignItems: 'center', justifyContent: 'center' }}>
      <BrandMark size={56} />
    </View>
  );
}

/** Biometric unlock. Opaque, so nothing behind it can be read. */
function LockScreen() {
  const p = usePalette();
  const { unlock, signOut, state } = useAuth();
  const [busy, setBusy] = useState(false);
  const tried = useRef(false);
  const attempt = async () => {
    setBusy(true);
    try {
      await unlock();
    } finally {
      setBusy(false);
    }
  };
  useEffect(() => {
    if (!tried.current) {
      tried.current = true;
      void attempt();
    }
  });
  return (
    <View style={[StyleSheet.absoluteFill, { backgroundColor: p.canvas, alignItems: 'center', justifyContent: 'center', padding: 32, gap: 16 }]} accessibilityViewIsModal>
      <BrandMark size={52} />
      <T v="title" style={{ textAlign: 'center' }}>
        Zephric is locked
      </T>
      <T tone="ink3" style={{ textAlign: 'center' }}>
        {state.status === 'signed_in' ? `Signed in as ${state.profile.name}${state.profile.orgName ? ` · ${state.profile.orgName}` : ''}` : ''}
      </T>
      <Button label="Unlock" icon={Fingerprint} onPress={attempt} loading={busy} size="lg" style={{ alignSelf: 'stretch', marginTop: 8 }} />
      <Button label="Sign out" kind="ghost" onPress={() => void signOut()} />
    </View>
  );
}

/** While the app is in the background (and in the app switcher), show the mark instead of the screen. */
function PrivacyCover() {
  const p = usePalette();
  const [hidden, setHidden] = useState(AppState.currentState !== 'active');
  useEffect(() => {
    const sub = AppState.addEventListener('change', (s) => setHidden(s !== 'active'));
    return () => sub.remove();
  }, []);
  if (!hidden) return null;
  return (
    <View pointerEvents="none" style={[StyleSheet.absoluteFill, { backgroundColor: p.canvas, alignItems: 'center', justifyContent: 'center' }]}>
      <BrandMark size={56} />
    </View>
  );
}
