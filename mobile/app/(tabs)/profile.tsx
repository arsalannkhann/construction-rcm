import Constants from 'expo-constants';
import * as LocalAuthentication from 'expo-local-authentication';
import { router } from 'expo-router';
import { useContext, useEffect, useState } from 'react';
import { ActivityIndicator, Alert, Linking, Switch, View } from 'react-native';
import Check from 'lucide-react-native/icons/check';
import ExternalLink from 'lucide-react-native/icons/external-link';
import LogOut from 'lucide-react-native/icons/log-out';
import { messageOf } from '@/lib/api';
import { useAuth, useSignedIn } from '@/lib/auth';
import { deleteDraft, useDrafts } from '@/lib/drafts';
import { initials, plural } from '@/lib/format';
import { ThemeContext, usePalette, type ThemePref } from '@/theme';
import { Button, Card, Divider, Row, Section, Segmented, T } from '@/ui/kit';
import { TabScreen } from '@/ui/tab-screen';

export default function Profile() {
  const p = usePalette();
  const session = useSignedIn();
  const { switchOrganization, signOut, biometric, setBiometric, server } = useAuth();
  const { pref, setPref } = useContext(ThemeContext);
  const [switching, setSwitching] = useState<string | null>(null);
  const [biometricAvailable, setBiometricAvailable] = useState<boolean | null>(null);
  const owner = session.profile.orgId ? { userId: session.profile.userId, orgId: session.profile.orgId } : null;
  const unsent = useDrafts(owner).filter((d) => d.status !== 'submitted' && d.files.length > 0);

  useEffect(() => {
    void Promise.all([LocalAuthentication.hasHardwareAsync(), LocalAuthentication.isEnrolledAsync()]).then(([h, e]) => setBiometricAvailable(h && e));
  }, []);

  const orgs = session.me?.organizations ?? [];

  const choose = async (orgId: string) => {
    if (orgId === session.profile.orgId || switching) return;
    setSwitching(orgId);
    try {
      await switchOrganization(orgId);
      router.replace('/');
    } catch (err) {
      Alert.alert('Could not switch company', messageOf(err));
    } finally {
      setSwitching(null);
    }
  };

  const confirmSignOut = () => {
    if (unsent.length === 0) {
      void signOut();
      return;
    }
    Alert.alert(
      `${plural(unsent.length, 'bill')} not sent`,
      'Bills you have not sent yet stay on this phone, and only you can see them, unless you delete them.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete and sign out',
          style: 'destructive',
          onPress: () => {
            for (const d of unsent) deleteDraft(d.id);
            void signOut();
          },
        },
        { text: 'Keep and sign out', onPress: () => void signOut() },
      ],
    );
  };

  const toggleBiometric = async (on: boolean) => {
    const ok = await setBiometric(on);
    if (!ok && on) Alert.alert('Fingerprint or face unlock is not set up', 'Set it up in your phone’s settings first, then turn it on here.');
  };

  return (
    <TabScreen title="Me">
      <Card style={{ flexDirection: 'row', alignItems: 'center', gap: 14 }}>
        <View style={{ width: 52, height: 52, borderRadius: 26, backgroundColor: p.sunken, alignItems: 'center', justifyContent: 'center' }}>
          <T v="heading" tone="ink2">
            {initials(session.profile.name)}
          </T>
        </View>
        <View style={{ flex: 1, gap: 2 }}>
          <T v="heading" numberOfLines={1}>
            {session.profile.name}
          </T>
          <T v="caption" tone="ink3" numberOfLines={1}>
            {session.profile.email}
          </T>
          {session.profile.role ? (
            <T v="caption" tone="ink2" style={{ marginTop: 4 }}>
              {session.profile.role}
            </T>
          ) : null}
        </View>
      </Card>

      {orgs.length > 0 ? (
        <Section title="Company">
          <Card padded={false}>
            {orgs.map((o, i) => (
              <View key={o.id}>
                {i > 0 ? <Divider inset={16} /> : null}
                <Row
                  title={o.name}
                  subtitle={`${o.roleLabel}${o.isDemo ? ' · Practice company' : ''}`}
                  onPress={() => void choose(o.id)}
                  chevron={false}
                  right={switching === o.id ? <ActivityIndicator color={p.ink3} /> : o.id === session.profile.orgId ? <Check size={18} color={p.accentText} /> : null}
                  accessibilityLabel={`${o.name}${o.id === session.profile.orgId ? ', current company' : ''}`}
                />
              </View>
            ))}
          </Card>
        </Section>
      ) : null}

      <Section title="Signing in">
        <Card padded={false}>
          <Row
            title="Unlock with fingerprint or face"
            subtitle={biometricAvailable === false ? 'Not set up on this phone' : 'Asks for it each time you open Zephric'}
            chevron={false}
            right={<Switch value={biometric} onValueChange={(v) => void toggleBiometric(v)} disabled={biometricAvailable === false && !biometric} trackColor={{ true: p.accent, false: p.lineStrong }} />}
          />
          <Divider inset={16} />
          <Row
            title="Extra sign-in code"
            subtitle={!session.me ? 'Shown when you are online' : session.me.user.mfaEnabled ? 'A code from your phone each time you sign in' : 'Turn it on from the Zephric website'}
            chevron={false}
            right={session.me ? <T v="label" tone={session.me.user.mfaEnabled ? 'pass' : 'ink3'}>{session.me.user.mfaEnabled ? 'On' : 'Off'}</T> : undefined}
          />
        </Card>
      </Section>

      <Section title="Light or dark">
        <Segmented<ThemePref>
          value={pref}
          onChange={setPref}
          options={[
            { value: 'system', label: 'Match phone' },
            { value: 'light', label: 'Light' },
            { value: 'dark', label: 'Dark' },
          ]}
        />
      </Section>

      <Section title="Zephric website">
        <Card padded={false}>
          <Row title="Open the website" subtitle={server.replace(/^https?:\/\//, '')} onPress={() => void Linking.openURL(`${server}/overview`)} right={<ExternalLink size={16} color={p.ink3} />} chevron={false} />
        </Card>
      </Section>

      <Button label="Sign out" kind="danger" icon={LogOut} onPress={confirmSignOut} />
      <T v="caption" tone="ink3" style={{ textAlign: 'center' }}>
        Zephric {Constants.expoConfig?.version ?? ''} · Signing out ends this session on the server.
      </T>
    </TabScreen>
  );
}
