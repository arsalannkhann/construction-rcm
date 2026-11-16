import { useState } from 'react';
import { KeyboardAvoidingView, Platform, ScrollView, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import ShieldCheck from 'lucide-react-native/icons/shield-check';
import { messageOf } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { usePalette } from '@/theme';
import { Banner, Button, Field, T } from '@/ui/kit';

/** The second step: a code from the authenticator app, or one of the recovery codes. */
export default function Verify() {
  const p = usePalette();
  const insets = useSafeAreaInsets();
  const { verify, cancelVerify, state } = useAuth();
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [recovery, setRecovery] = useState(false);

  const submit = async () => {
    const value = code.trim();
    if (!value) return;
    setBusy(true);
    setError(null);
    try {
      const result = await verify(value);
      if (result.status === 'wrong_code') {
        setCode('');
        setError(`That code did not work. ${result.attemptsLeft} ${result.attemptsLeft === 1 ? 'try' : 'tries'} left.`);
      }
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <KeyboardAvoidingView style={{ flex: 1, backgroundColor: p.canvas }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <ScrollView contentContainerStyle={{ paddingHorizontal: 24, paddingTop: insets.top + 48, paddingBottom: insets.bottom + 24, gap: 20 }} keyboardShouldPersistTaps="handled">
        <View style={{ width: 48, height: 48, borderRadius: 24, backgroundColor: p.accentSoft, alignItems: 'center', justifyContent: 'center' }}>
          <ShieldCheck size={24} color={p.accentText} />
        </View>
        <View style={{ gap: 6 }}>
          <T v="display">Two-step verification</T>
          <T tone="ink3">
            {recovery ? 'Enter one of the recovery codes you saved when you turned on two-step verification. Each works once.' : `Enter the 6-digit code from your authenticator app${state.status === 'verify' ? ` for ${state.email}` : ''}.`}
          </T>
        </View>
        {error ? <Banner tone="block">{error}</Banner> : null}
        <Field
          label={recovery ? 'Recovery code' : 'Code'}
          value={code}
          onChangeText={setCode}
          autoFocus
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType={recovery ? 'default' : 'number-pad'}
          textContentType="oneTimeCode"
          autoComplete="one-time-code"
          maxLength={recovery ? 32 : 6}
          onSubmitEditing={submit}
          style={recovery ? undefined : { fontSize: 24, letterSpacing: 8, textAlign: 'center', fontVariant: ['tabular-nums'] }}
        />
        <Button label="Verify" onPress={submit} loading={busy} size="lg" />
        <Button label={recovery ? 'Use an authenticator code' : 'Use a recovery code'} kind="ghost" onPress={() => { setRecovery(!recovery); setCode(''); setError(null); }} />
        <Button label="Start again" kind="ghost" onPress={cancelVerify} />
      </ScrollView>
    </KeyboardAvoidingView>
  );
}
