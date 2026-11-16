import { router } from 'expo-router';
import { View } from 'react-native';
import Camera from 'lucide-react-native/icons/camera';
import CircleCheck from 'lucide-react-native/icons/circle-check';
import Clock from 'lucide-react-native/icons/clock';
import FileStack from 'lucide-react-native/icons/file-stack';
import Hourglass from 'lucide-react-native/icons/hourglass';
import Inbox from 'lucide-react-native/icons/inbox';
import ScanSearch from 'lucide-react-native/icons/scan-search';
import UploadCloud from 'lucide-react-native/icons/cloud-upload';
import { useSignedIn } from '@/lib/auth';
import { useDrafts } from '@/lib/drafts';
import { plural } from '@/lib/format';
import { useHome } from '@/lib/queries';
import { radius, usePalette } from '@/theme';
import { Banner, Button, Card, Empty, LoadingCard, PressableCard, Section, T, type IconType } from '@/ui/kit';
import { AppRow, ErrorState, RowList } from '@/ui/parts';
import { TabScreen } from '@/ui/tab-screen';

function greeting(): string {
  const h = new Date().getHours();
  return h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
}

export default function Overview() {
  const p = usePalette();
  const session = useSignedIn();
  const home = useHome();
  const owner = session.profile.orgId ? { userId: session.profile.userId, orgId: session.profile.orgId } : null;
  const drafts = useDrafts(owner);
  const waiting = drafts.filter((d) => d.status === 'queued' || d.status === 'sending');
  const failed = drafts.filter((d) => d.status === 'failed');
  const first = session.profile.name.split(' ')[0];
  const canUpload = home.data?.permissions.upload ?? session.profile.canUpload;

  if (!session.profile.orgId) {
    return (
      <TabScreen title={`${greeting()}, ${first}`}>
        <Card>
          <Empty icon={Inbox} title="No organisation yet">
            {session.me?.mfaRequired ? `${session.me.mfaRequired.orgName} requires two-step verification. Turn it on in Zephric on the web, then sign in again.` : 'Finish setting up your organisation on the web, or accept an invitation, then come back here.'}
          </Empty>
        </Card>
      </TabScreen>
    );
  }

  return (
    <TabScreen title={`${greeting()}, ${first}`} subtitle={session.profile.orgName} refreshing={home.isRefetching} onRefresh={() => void home.refetch()}>
      {canUpload ? (
        <PressableCard onPress={() => router.push('/capture')} style={{ backgroundColor: p.navy, borderColor: p.navy, flexDirection: 'row', alignItems: 'center', gap: 14, paddingVertical: 18 }} accessibilityLabel="Capture a billing document">
          <View style={{ width: 46, height: 46, borderRadius: radius.md, backgroundColor: 'rgba(18,194,180,0.16)', alignItems: 'center', justifyContent: 'center' }}>
            <Camera size={22} color="#4fd8cb" />
          </View>
          <View style={{ flex: 1, gap: 2 }}>
            <T v="heading" style={{ color: '#ffffff' }}>
              Capture a billing document
            </T>
            <T v="caption" style={{ color: '#a9b4c8' }}>
              Photograph a pay application or attach a PDF
            </T>
          </View>
        </PressableCard>
      ) : null}

      {failed.length > 0 ? (
        <Banner tone="block" title={`${plural(failed.length, 'capture')} could not be sent`} action={<Button label="Review" size="sm" kind="secondary" onPress={() => router.push('/capture')} />}>
          They are safe on this phone. Open them to see what went wrong and send again.
        </Banner>
      ) : waiting.length > 0 ? (
        <Banner tone="accent" icon={UploadCloud} title={`Sending ${plural(waiting.length, 'capture')}`}>
          Kept on this phone until Zephric confirms it has them.
        </Banner>
      ) : null}

      {home.error ? <ErrorState error={home.error} onRetry={() => void home.refetch()} /> : null}

      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10 }}>
        <Tile icon={CircleCheck} label="Pending approval" value={home.data?.counts.pendingApproval} tone={p.aquaText} onPress={() => router.push({ pathname: '/billing', params: { view: 'attention' } })} />
        <Tile icon={ScanSearch} label="Needs review" value={home.data?.counts.needsReview} tone={p.accentText} onPress={() => router.push({ pathname: '/billing', params: { view: 'open' } })} />
        <Tile icon={Hourglass} label="Awaiting subcontractor" value={home.data?.counts.onHold} tone={p.warn} onPress={() => router.push({ pathname: '/billing', params: { view: 'open' } })} />
        <Tile icon={Clock} label="Being read" value={home.data?.counts.processing} tone={p.ink2} onPress={() => router.push({ pathname: '/billing', params: { view: 'open' } })} />
      </View>

      {home.data && (home.data.permissions.review || home.data.permissions.approve) ? (
        <Section title="Needs you" action={home.data.attentionTotal > home.data.attention.length ? <Button label="See all" kind="ghost" size="sm" onPress={() => router.push({ pathname: '/billing', params: { view: 'attention' } })} /> : null}>
          <Card padded={false}>
            {home.data.attention.length === 0 ? (
              <Empty icon={CircleCheck} title="You are all caught up">
                Nothing is waiting on your review or approval.
              </Empty>
            ) : (
              <RowList items={home.data.attention} keyOf={(a) => a.id} render={(a) => <AppRow a={a} />} />
            )}
          </Card>
        </Section>
      ) : null}

      {home.data && home.data.recentSubmissions.length > 0 ? (
        <Section title="Your recent submissions">
          <Card padded={false}>
            <RowList items={home.data.recentSubmissions} keyOf={(a) => a.id} render={(a) => <AppRow a={a} />} />
          </Card>
        </Section>
      ) : null}

      {!home.data && home.isLoading ? <LoadingCard rows={4} /> : null}

      {home.data && !home.data.permissions.review && !home.data.permissions.approve && home.data.recentSubmissions.length === 0 ? (
        <Card>
          <Empty icon={FileStack} title="Nothing submitted yet">
            {canUpload ? 'Capture a pay application, lien waiver or supporting document and it will appear here as Zephric reads it.' : 'Your role can view billing in this organisation.'}
          </Empty>
        </Card>
      ) : null}
    </TabScreen>
  );
}

function Tile({ icon: Icon, label, value, tone, onPress }: { icon: IconType; label: string; value: number | undefined; tone: string; onPress: () => void }) {
  return (
    <PressableCard onPress={onPress} style={{ flexBasis: '47%', flexGrow: 1, gap: 10, paddingVertical: 14 }} accessibilityLabel={`${label}: ${value ?? 'loading'}`}>
      <Icon size={18} color={tone} />
      <View style={{ gap: 1 }}>
        <T v="amountLarge">{value === undefined ? '–' : String(value)}</T>
        <T v="caption" tone="ink3" numberOfLines={1}>
          {label}
        </T>
      </View>
    </PressableCard>
  );
}
