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
import { Button, Card, Divider, Empty, Pill, Row, Screen, Section, T } from '@/ui/kit';
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
      Alert.alert('Your role cannot submit documents', 'Ask an admin in your organisation for upload access.');
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
          <Camera size={20} color={p.accentText} />
          <T v="heading">Submit billing documents</T>
        </View>
        <T v="caption" tone="ink2">
          Photograph each page of a pay application or lien waiver, or attach PDFs from your phone. Everything is kept on this phone until Zephric confirms it has it.
        </T>
        <Button label="New capture" icon={Plus} onPress={start} size="lg" disabled={!owner} />
      </Card>

      {open.length > 0 ? (
        <Section title="Drafts and sending">
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
          <Empty icon={FilePen} title="No captures yet">
            Drafts you start appear here, even without a connection.
          </Empty>
        </Card>
      ) : null}
    </Screen>
  );
}

function DraftRow({ d }: { d: Draft }) {
  const p = usePalette();
  const name = d.title.trim() || d.contract?.label || 'Untitled capture';
  const icon =
    d.status === 'submitted' ? <CircleCheck size={20} color={p.pass} /> : d.status === 'failed' ? <TriangleAlert size={20} color={p.block} /> : d.status === 'queued' || d.status === 'sending' ? <UploadCloud size={20} color={p.accentText} /> : <FilePen size={20} color={p.ink3} />;
  const pill =
    d.status === 'submitted' ? <Pill label="Received by Zephric" tone="pass" /> : d.status === 'failed' ? <Pill label="Not sent" tone="block" /> : d.status === 'sending' ? <Pill label={`Sending ${Math.round(d.progress * 100)}%`} tone="accent" /> : d.status === 'queued' ? <Pill label="Waiting to send" tone="accent" /> : <Pill label="Draft" />;
  return (
    <Row
      left={icon}
      title={name}
      subtitle={`${plural(d.files.length, 'file')} · ${d.status === 'submitted' ? `sent ${ago(d.submittedAt)}` : `edited ${ago(d.updatedAt)}`}`}
      meta={<View style={{ marginTop: 6 }}>{pill}</View>}
      onPress={() => (d.status === 'submitted' && d.applicationId ? router.push(`/application/${d.applicationId}`) : router.push(`/capture/${d.id}`))}
    />
  );
}
