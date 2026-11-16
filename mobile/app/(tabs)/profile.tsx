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
import { Button, Card, Divider, Pill, Row, Section, Segmented, T } from '@/ui/kit';
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
      Alert.alert('Could not switch organisation', messageOf(err));
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
      `${plural(unsent.length, 'capture')} not sent`,
      'Unsent captures stay on this phone, visible only to you in this organisation, unless you delete them.',
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
    if (!ok && on) Alert.alert('Biometric unlock is not available', 'Set up Face ID, Touch ID or a fingerprint in your phone’s settings first.');
  };

  return (
    <TabScreen title="Profile">
      <Card style={{ flexDirection: 'row', alignItems: 'center', gap: 14 }}>
        <View style={{ width: 52, height: 52, borderRadius: 26, backgroundColor: p.accentSoft, alignItems: 'center', justifyContent: 'center' }}>
          <T v="heading" tone="accent">
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
            <View style={{ marginTop: 4 }}>
              <Pill label={session.profile.role} tone="accent" />
            </View>
          ) : null}
        </View>
      </Card>

      {orgs.length > 0 ? (
        <Section title="Organisation">
          <Card padded={false}>
            {orgs.map((o, i) => (
              <View key={o.id}>
                {i > 0 ? <Divider inset={16} /> : null}
                <Row
                  title={o.name}
                  subtitle={`${o.roleLabel}${o.isDemo ? ' · Demo workspace' : ''}`}
                  onPress={() => void choose(o.id)}
                  chevron={false}
                  right={switching === o.id ? <ActivityIndicator color={p.ink3} /> : o.id === session.profile.orgId ? <Check size={18} color={p.accentText} /> : null}
                  accessibilityLabel={`${o.name}${o.id === session.profile.orgId ? ', current organisation' : ''}`}
                />
              </View>
            ))}
          </Card>
        </Section>
      ) : null}

      <Section title="Security">
        <Card padded={false}>
          <Row
            title="Biometric unlock"
            subtitle={biometricAvailable === false ? 'Not set up on this phone' : 'Ask for Face ID or fingerprint when opening Zephric'}
            chevron={false}
            right={<Switch value={biometric} onValueChange={(v) => void toggleBiometric(v)} disabled={biometricAvailable === false && !biometric} trackColor={{ true: p.accent, false: p.lineStrong }} />}
          />
          <Divider inset={16} />
          <Row
            title="Two-step verification"
            subtitle={session.me?.user.mfaEnabled ? 'On for your account' : 'Off. Turn it on from Zephric on the web.'}
            chevron={false}
            right={<Pill label={session.me?.user.mfaEnabled ? 'On' : 'Off'} tone={session.me?.user.mfaEnabled ? 'pass' : 'warn'} />}
          />
        </Card>
      </Section>

      <Section title="Appearance">
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

      <Section title="Zephric on the web">
        <Card padded={false}>
          <Row title="Open Zephric" subtitle={server.replace(/^https?:\/\//, '')} onPress={() => void Linking.openURL(`${server}/overview`)} right={<ExternalLink size={16} color={p.ink3} />} chevron={false} />
        </Card>
      </Section>

      <Button label="Sign out" kind="danger" icon={LogOut} onPress={confirmSignOut} />
      <T v="caption" tone="ink3" style={{ textAlign: 'center' }}>
        Zephric {Constants.expoConfig?.version ?? ''} · Signing out ends this session on the server.
      </T>
    </TabScreen>
  );
}
