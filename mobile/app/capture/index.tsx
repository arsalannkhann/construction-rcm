import { router } from 'expo-router';
import { Alert, View } from 'react-native';
import Camera from 'lucide-react-native/icons/camera';
import CircleCheck from 'lucide-react-native/icons/circle-check';
import FilePen from 'lucide-react-native/icons/file-pen';
import Plus from 'lucide-react-native/icons/plus';
import TriangleAlert from 'lucide-react-native/icons/triangle-alert';
import UploadCloud from 'lucide-react-native/icons/cloud-upload';
import { useSignedIn } from '@/lib/auth';
import { createDraft, useDrafts, type Draft } from '@/lib/drafts';
import { ago, plural } from '@/lib/format';
import { usePalette } from '@/theme';
import { Button, Card, Divider, Empty, Row, Screen, Section, T } from '@/ui/kit';
import { Stamp } from '@/ui/bill-slip';
import { OfflineBanner } from '@/ui/parts';

export default function CaptureHome() {
  const p = usePalette();
  const session = useSignedIn();
  const owner = session.profile.orgId ? { userId: session.profile.userId, orgId: session.profile.orgId } : null;
  const drafts = useDrafts(owner);
  const open = drafts.filter((d) => d.status !== 'submitted');
  const sent = drafts.filter((d) => d.status === 'submitted');

  const start = () => {
    if (!owner) return;
    if (!session.profile.canUpload) {
      Alert.alert('You cannot send bills yet', 'Ask an admin in your company to let you send bills.');
      return;
    }
    const d = createDraft(owner);
    router.push(`/capture/${d.id}`);
  };

  return (
    <Screen>
      <OfflineBanner />
      <Card style={{ gap: 12 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
          <Camera size={20} color={p.ink2} strokeWidth={1.75} />
          <T v="heading">Send a bill or receipt</T>
        </View>
        <T v="caption" tone="ink2">
          Take a photo of each page, or attach a PDF. It stays safe on this phone until Zephric has it.
        </T>
        <Button label="Send a bill" icon={Plus} onPress={start} size="lg" disabled={!owner} />
      </Card>

      {open.length > 0 ? (
        <Section title="Not sent yet">
          <Card padded={false}>
            {open.map((d, i) => (
              <View key={d.id}>
                {i > 0 ? <Divider inset={52} /> : null}
                <DraftRow d={d} />
              </View>
            ))}
          </Card>
        </Section>
      ) : null}

      {sent.length > 0 ? (
        <Section title="Sent from this phone">
          <Card padded={false}>
            {sent.map((d, i) => (
              <View key={d.id}>
                {i > 0 ? <Divider inset={52} /> : null}
                <DraftRow d={d} />
              </View>
            ))}
          </Card>
        </Section>
      ) : null}

      {drafts.length === 0 ? (
        <Card>
          <Empty icon={FilePen} title="Nothing here yet">
            Bills you start show up here, even without internet
          </Empty>
        </Card>
      ) : null}
    </Screen>
  );
}

function DraftRow({ d }: { d: Draft }) {
  const p = usePalette();
  const name = d.title.trim() || d.contract?.label || 'Untitled bill';
  const icon =
    d.status === 'submitted' ? <CircleCheck size={20} color={p.ink3} strokeWidth={1.75} /> : d.status === 'failed' ? <TriangleAlert size={20} color={p.ink3} strokeWidth={1.75} /> : d.status === 'queued' || d.status === 'sending' ? <UploadCloud size={20} color={p.ink3} strokeWidth={1.75} /> : <FilePen size={20} color={p.ink3} strokeWidth={1.75} />;
  const stamp =
    d.status === 'submitted' ? <Stamp size="sm" label="Received" tone="progress" /> : d.status === 'failed' ? <Stamp size="sm" label="Not sent" tone="problem" /> : d.status === 'sending' ? <Stamp size="sm" label="Sending" tone="progress" /> : d.status === 'queued' ? <Stamp size="sm" label="Waiting" tone="progress" /> : <Stamp size="sm" label="Not sent" tone="neutral" />;
  return (
    <Row
      left={icon}
      title={name}
      subtitle={`${plural(d.files.length, 'file')} · ${d.status === 'submitted' ? `sent ${ago(d.submittedAt)}` : `edited ${ago(d.updatedAt)}`}`}
      meta={<View style={{ marginTop: 8 }}>{stamp}</View>}
      onPress={() => (d.status === 'submitted' && d.applicationId ? router.push(`/application/${d.applicationId}`) : router.push(`/capture/${d.id}`))}
    />
  );
}
