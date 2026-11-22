/**
 * Home: the first thing everyone sees, from the worker on site to the CEO.
 *
 * One bright thing (the "Send a bill" button, the only accent on the screen),
 * one physical moment (the latest bill as a stamped paper slip), a way to find
 * any bill, and, for people who check or approve, what is waiting for them.
 * Everything is said in plain words; the office terms stay on the website.
 */
import { router } from 'expo-router';
import { useMemo } from 'react';
import { Alert, Pressable, View } from 'react-native';
import Camera from 'lucide-react-native/icons/camera';
import ChevronRight from 'lucide-react-native/icons/chevron-right';
import Inbox from 'lucide-react-native/icons/inbox';
import Search from 'lucide-react-native/icons/search';
import { useSignedIn } from '@/lib/auth';
import { createDraft, useDrafts } from '@/lib/drafts';
import { plural } from '@/lib/format';
import { useHome } from '@/lib/queries';
import { buildUploads } from '@/lib/uploads';
import { radius, usePalette } from '@/theme';
import { BillSlip } from '@/ui/bill-slip';
import { Banner, Button, Card, Empty, LoadingCard, Section, T } from '@/ui/kit';
import { AppRow, ErrorState, RowList } from '@/ui/parts';
import { TabScreen } from '@/ui/tab-screen';

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

function today(): string {
  const d = new Date();
  return `${DAYS[d.getDay()]}, ${d.getDate()} ${MONTHS[d.getMonth()]}`;
}

export default function Home() {
  const p = usePalette();
  const session = useSignedIn();
  const home = useHome();
  const owner = session.profile.orgId ? { userId: session.profile.userId, orgId: session.profile.orgId } : null;
  const drafts = useDrafts(owner);
  const failed = drafts.filter((d) => d.status === 'failed');
  const canUpload = home.data?.permissions.upload ?? session.profile.canUpload;
  const decides = !!home.data && (home.data.permissions.review || home.data.permissions.approve);
  const last = useMemo(() => buildUploads(drafts, home.data?.recentSubmissions ?? [])[0] ?? null, [drafts, home.data?.recentSubmissions]);

  if (!session.profile.orgId) {
    return (
      <TabScreen title="Zephric" subtitle={today()}>
        <Card>
          <Empty icon={Inbox} title="You are not in a company yet">
            {session.me?.mfaRequired ? `${session.me.mfaRequired.orgName} asks for a second sign-in step. Turn it on in Zephric on the website, then sign in again.` : 'Ask your company to invite you, or finish setting up your company on the website, then come back here.'}
          </Empty>
        </Card>
      </TabScreen>
    );
  }

  const sendBill = () => {
    if (!owner) return;
    if (!canUpload) {
      Alert.alert('You cannot send bills yet', 'Ask an admin in your company to let you send bills.');
      return;
    }
    const d = createDraft(owner);
    router.push(`/capture/${d.id}`);
  };

  return (
    <TabScreen title={session.profile.orgName ?? 'Zephric'} subtitle={today()} refreshing={home.isRefetching} onRefresh={() => void home.refetch()}>
      {canUpload ? (
        <Pressable
          onPress={sendBill}
          accessibilityRole="button"
          accessibilityLabel="Send a bill. Take a photo of it or attach a PDF"
          style={({ pressed }) => ({
            backgroundColor: p.accent,
            borderRadius: radius.lg,
            minHeight: 72,
            paddingHorizontal: 20,
            flexDirection: 'row',
            alignItems: 'center',
            gap: 16,
            transform: [{ scale: pressed ? 0.98 : 1 }],
          })}
        >
          <Camera size={24} color="#ffffff" strokeWidth={1.75} />
          <View style={{ flex: 1, gap: 2 }}>
            <T v="heading" style={{ color: '#ffffff', fontSize: 19, lineHeight: 24 }}>
              Send a bill
            </T>
            <T v="caption" style={{ color: 'rgba(255,255,255,0.85)' }}>
              Take a photo of it, or attach a PDF
            </T>
          </View>
        </Pressable>
      ) : null}

      {failed.length > 0 ? (
        <Banner tone="block" title={`${plural(failed.length, 'bill')} not sent`} action={<Button label="Open" size="sm" kind="secondary" onPress={() => router.push('/uploads')} />}>
          They are safe on this phone. Open them to send again.
        </Banner>
      ) : null}

      {home.error ? <ErrorState error={home.error} onRetry={() => void home.refetch()} /> : null}

      {canUpload ? (
        last ? (
          <BillSlip item={last} onPress={() => (last.target.kind === 'draft' ? router.push(`/capture/${last.target.id}`) : router.push(`/application/${last.target.id}`))} />
        ) : home.isLoading ? (
          <LoadingCard rows={3} />
        ) : (
          <Card>
            <Empty icon={Inbox} title="No bills sent yet">
              When you send a bill, it shows up here with where it stands.
            </Empty>
          </Card>
        )
      ) : null}

      {canUpload ? (
        <Pressable
          onPress={() => router.push('/uploads')}
          accessibilityRole="button"
          accessibilityLabel="Find a bill you sent"
          style={({ pressed }) => ({
            minHeight: 56,
            borderRadius: radius.lg,
            borderWidth: 1,
            borderColor: p.lineStrong,
            backgroundColor: pressed ? p.sunken : p.surface,
            paddingHorizontal: 16,
            flexDirection: 'row',
            alignItems: 'center',
            gap: 12,
          })}
        >
          <Search size={20} color={p.ink3} strokeWidth={1.75} />
          <T v="body" tone="ink3" style={{ flex: 1, fontSize: 17 }}>
            Find a bill
          </T>
          <ChevronRight size={20} color={p.ink4} strokeWidth={1.75} />
        </Pressable>
      ) : null}

      {decides ? (
        <Section
          title={home.data!.attentionTotal > 0 ? `Waiting for you · ${home.data!.attentionTotal}` : 'Waiting for you'}
          action={home.data!.attentionTotal > home.data!.attention.length ? <Button label="See all" kind="ghost" size="sm" onPress={() => router.push({ pathname: '/billing', params: { view: 'attention' } })} /> : null}
        >
          <Card padded={false}>
            {home.data!.attention.length === 0 ? (
              <Empty title="Nothing to check">Bills that need you to check or approve them show up here.</Empty>
            ) : (
              <RowList items={home.data!.attention} keyOf={(a) => a.id} render={(a) => <AppRow a={a} />} />
            )}
          </Card>
        </Section>
      ) : null}

      {home.data ? <InProgress counts={home.data.counts} /> : null}

      {!home.data && home.isLoading && !canUpload ? <LoadingCard rows={4} /> : null}
    </TabScreen>
  );
}

/** What the company's bills are doing right now, as one quiet line of plain words. */
function InProgress({ counts }: { counts: { pendingApproval: number; needsReview: number; onHold: number; processing: number } }) {
  const parts = [
    counts.processing > 0 ? `${counts.processing} being read` : null,
    counts.needsReview > 0 ? `${counts.needsReview} being checked` : null,
    counts.pendingApproval > 0 ? `${counts.pendingApproval} waiting for approval` : null,
    counts.onHold > 0 ? `${counts.onHold} on hold` : null,
  ].filter(Boolean);
  return (
    <Pressable onPress={() => router.push({ pathname: '/billing', params: { view: 'open' } })} accessibilityRole="button" style={{ gap: 4, paddingHorizontal: 4 }}>
      <T v="eyebrow" tone="ink3">
        Company bills right now
      </T>
      <T v="body" tone="ink2">
        {parts.length > 0 ? parts.join(' · ') : 'Nothing in progress'}
      </T>
    </Pressable>
  );
}
