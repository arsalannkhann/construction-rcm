import { router } from 'expo-router';
import { useState } from 'react';
import { KeyboardAvoidingView, Linking, Modal, Platform, Pressable, ScrollView, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import FileUp from 'lucide-react-native/icons/file-up';
import Info from 'lucide-react-native/icons/info';
import Server from 'lucide-react-native/icons/server';
import { messageOf, ping } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { defaultServer, normalizeServer } from '@/lib/prefs';
import { usePendingShare } from '@/lib/shared';
import { waitingTitle } from '@/lib/shared-rules';
import { usePalette } from '@/theme';
import { Banner, BrandMark, Button, Field, T } from '@/ui/kit';

export default function SignIn() {
  const p = usePalette();
  const insets = useSafeAreaInsets();
  const { signIn, state, server } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [serverOpen, setServerOpen] = useState(false);
  const notice = state.status === 'signed_out' ? state.notice : null;
  const shared = usePendingShare();

  const submit = async () => {
    if (!email.trim() || !password) {
      setError('Enter your email and password.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const next = await signIn(email.trim(), password);
      setPassword('');
      if (next === 'verify') router.push('/verify');
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <KeyboardAvoidingView style={{ flex: 1, backgroundColor: p.canvas }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <ScrollView contentContainerStyle={{ flexGrow: 1, paddingHorizontal: 24, paddingTop: insets.top + 48, paddingBottom: insets.bottom + 24, gap: 20 }} keyboardShouldPersistTaps="handled">
        <View style={{ gap: 18 }}>
          <BrandMark size={44} />
          <View style={{ gap: 6 }}>
            <T v="display">Sign in to Zephric</T>
            <T tone="ink3">Capture billing documents, follow every application, and act on what needs you.</T>
          </View>
        </View>

        {notice ? <Banner tone="neutral" icon={Info}>{notice}</Banner> : null}
        {shared ? (
          <Banner tone="neutral" icon={FileUp} title={waitingTitle(shared.files.length)}>
            Sign in and {shared.files.length === 1 ? 'it opens' : 'they open'} as a new capture. Nothing is sent until you choose to send it.
          </Banner>
        ) : null}
        {error ? <Banner tone="block">{error}</Banner> : null}

        <View style={{ gap: 14 }}>
          <Field label="Work email" value={email} onChangeText={setEmail} autoCapitalize="none" autoCorrect={false} autoComplete="email" keyboardType="email-address" textContentType="username" returnKeyType="next" />
          <Field label="Password" value={password} onChangeText={setPassword} secureTextEntry autoComplete="current-password" textContentType="password" returnKeyType="go" onSubmitEditing={submit} />
          <Button label="Sign in" onPress={submit} loading={busy} size="lg" style={{ marginTop: 4 }} />
          <Button label="Forgot your password?" kind="ghost" onPress={() => void Linking.openURL(`${server}/forgot-password`)} />
        </View>

        <View style={{ flex: 1 }} />
        <View style={{ gap: 10, alignItems: 'center' }}>
          <T v="caption" tone="ink3" style={{ textAlign: 'center' }}>
            New to Zephric? Create your organisation on the web, then sign in here.
          </T>
          <Pressable onPress={() => setServerOpen(true)} accessibilityRole="button" style={{ flexDirection: 'row', alignItems: 'center', gap: 6, padding: 6 }}>
            <Server size={13} color={p.ink3} />
            <T v="caption" tone="ink3">
              {server.replace(/^https?:\/\//, '')}
            </T>
          </Pressable>
        </View>
      </ScrollView>
      <ServerSheet open={serverOpen} onClose={() => setServerOpen(false)} />
    </KeyboardAvoidingView>
  );
}

/** Which Zephric to sign in to: the hosted service, or a test environment. */
function ServerSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const p = usePalette();
  const { server, setServer } = useAuth();
  const [value, setValue] = useState(server);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const save = async () => {
    const next = normalizeServer(value);
    if (!next) {
      setError('Enter an https address, such as zephric.vercel.app.');
      return;
    }
    setBusy(true);
    const ok = await ping(next);
    setBusy(false);
    if (!ok) {
      setError('No Zephric server answered at that address.');
      return;
    }
    setServer(next);
    onClose();
  };
  return (
    <Modal visible={open} animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      <View style={{ flex: 1, backgroundColor: p.canvas, padding: 24, gap: 16 }}>
        <T v="title">Server</T>
        <T tone="ink3">Most people never change this. Use it only if your team gave you another address, such as a test environment.</T>
        <Field label="Address" value={value} onChangeText={(t) => { setValue(t); setError(null); }} autoCapitalize="none" autoCorrect={false} keyboardType="url" error={error} />
        <Button label="Use this server" onPress={save} loading={busy} />
        <Button label={`Reset to ${defaultServer.replace(/^https?:\/\//, '')}`} kind="secondary" onPress={() => { setValue(defaultServer); setError(null); }} />
        <Button label="Cancel" kind="ghost" onPress={onClose} />
      </View>
    </Modal>
  );
}
