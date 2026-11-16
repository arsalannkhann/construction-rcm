import * as Haptics from 'expo-haptics';
import { router, Stack, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { ActivityIndicator, Alert, Linking, View } from 'react-native';
import CircleCheck from 'lucide-react-native/icons/circle-check';
import FileText from 'lucide-react-native/icons/file-text';
import Image from 'lucide-react-native/icons/image';
import Laptop from 'lucide-react-native/icons/laptop';
import Loader from 'lucide-react-native/icons/loader';
import MessageSquare from 'lucide-react-native/icons/message-square';
import OctagonAlert from 'lucide-react-native/icons/octagon-alert';
import Send from 'lucide-react-native/icons/send';
import ShieldCheck from 'lucide-react-native/icons/shield-check';
import TriangleAlert from 'lucide-react-native/icons/triangle-alert';
import { api, ApiError, currentServer, messageOf, type Detail } from '@/lib/api';
import { openDocument } from '@/lib/documents';
import { ago, bytes, date, dateTime, money, plural } from '@/lib/format';
import { useApplication, useInvalidate } from '@/lib/queries';
import { usePalette } from '@/theme';
import { Banner, Button, Card, Divider, Field, LoadingCard, Pill, Row, Screen, Section, statusTone, T } from '@/ui/kit';
import { ErrorState, OfflineBanner, useOnline } from '@/ui/parts';

export default function ApplicationScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const q = useApplication(id);
  const d = q.data;
  return (
    <>
      <Stack.Screen options={{ title: d ? (d.number !== null ? `Application #${d.number}` : 'Application') : '' }} />
      <Screen refreshing={q.isRefetching} onRefresh={() => void q.refetch()}>
        <OfflineBanner />
        {q.error ? <ErrorState error={q.error} onRetry={() => void q.refetch()} /> : null}
        {q.isLoading ? (
          <>
            <LoadingCard rows={2} />
            <LoadingCard rows={4} />
          </>
        ) : null}
        {d ? <Body d={d} onChanged={() => void q.refetch()} /> : null}
      </Screen>
    </>
  );
}

function Body({ d, onChanged }: { d: Detail; onChanged: () => void }) {
  const differs = d.amounts.claimed !== null && d.amounts.verified !== null && d.amounts.claimed !== d.amounts.verified;
  const headline = d.amounts.approved ?? d.amounts.verified ?? d.amounts.claimed;
  const headlineLabel = d.amounts.approved !== null ? 'Approved payment' : d.amounts.verified !== null ? 'Verified payment due' : 'Payment requested';

  return (
    <>
      <Card style={{ gap: 14 }}>
        <View style={{ gap: 4 }}>
          <T v="title" numberOfLines={2}>
            {d.subcontractor ?? 'Unmatched submission'}
          </T>
          <T v="caption" tone="ink3">
            {[d.project?.name, d.contract ? `${d.contract.number} ${d.contract.title}` : null].filter(Boolean).join(' · ') || 'Not yet matched to a subcontract'}
          </T>
        </View>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
          <Pill label={d.statusLabel} tone={statusTone(d.status)} />
          {d.periodTo ? <Pill label={`Period to ${date(d.periodTo)}`} /> : null}
          <Pill label={`Received ${ago(d.receivedAt)}${d.receivedVia === 'email' ? ' by email' : ''}`} />
        </View>
        <Divider />
        <View style={{ gap: 2 }}>
          <T v="caption" tone="ink3">
            {headlineLabel}
          </T>
          <T v="amountLarge">{money(headline)}</T>
          {differs && d.amounts.approved === null ? (
            <T v="caption" tone="warn">
              The subcontractor requested {money(d.amounts.claimed)}. Zephric’s verified figure differs.
            </T>
          ) : null}
        </View>
        <View style={{ flexDirection: 'row', gap: 12 }}>
          <Figure label="Contract sum to date" value={money(d.amounts.contractSumToDate)} />
          <Figure label="Retainage" value={money(d.amounts.retainage)} />
          <Figure label="Balance to finish" value={money(d.amounts.balanceToFinish)} />
        </View>
        <T v="caption" tone="ink3">
          Figures are computed by Zephric’s reconciliation on the server, not on this phone.
        </T>
      </Card>

      {d.status === 'processing' ? (
        <Banner tone="accent" icon={Loader} title="Zephric is reading this package">
          Figures and checks appear when it finishes. Pull down to refresh.
        </Banner>
      ) : null}
      {d.processingError ? (
        <Banner tone="block" icon={TriangleAlert} title="This package could not be read automatically">
          {d.processingError}
        </Banner>
      ) : null}

      <Decision d={d} onChanged={onChanged} />

      <Findings d={d} />

      {d.documents.length > 0 ? (
        <Section title={`Documents · ${d.documents.length}`}>
          <Card padded={false}>
            {d.documents.map((doc, i) => (
              <View key={doc.id}>
                {i > 0 ? <Divider inset={52} /> : null}
                <DocumentRow doc={doc} />
              </View>
            ))}
          </Card>
        </Section>
      ) : null}

      {d.can.requestInfo ? (
        <Button label="Request information from the subcontractor" kind="secondary" icon={Send} onPress={() => router.push(`/request-info/${d.id}`)} />
      ) : null}

      {d.messages.length > 0 ? (
        <Section title="Messages to the subcontractor">
          <Card padded={false}>
            {d.messages.map((m, i) => (
              <View key={m.id}>
                {i > 0 ? <Divider inset={16} /> : null}
                <Row title={m.subject} subtitle={`${m.to ?? ''} · ${ago(m.at)}`} chevron={false} right={<Pill label={messageStatus(m.status)} tone={m.status === 'sent' ? 'pass' : m.status === 'failed' ? 'block' : 'warn'} />} />
              </View>
            ))}
          </Card>
        </Section>
      ) : null}

      <Comments d={d} onChanged={onChanged} />

      {d.timeline.length > 0 ? <Timeline d={d} /> : null}

      <Button label="Open on the web" kind="ghost" icon={Laptop} onPress={() => void Linking.openURL(`${currentServer()}/applications/${d.id}`)} />
    </>
  );
}

function messageStatus(status: string): string {
  switch (status) {
    case 'sent':
      return 'Sent';
    case 'not_sent':
      return 'Recorded, not sent';
    case 'failed':
      return 'Failed';
    case 'unconfirmed':
      return 'Not confirmed';
    case 'sending':
      return 'Sending';
    default:
      return status;
  }
}

function Figure({ label, value }: { label: string; value: string }) {
  return (
    <View style={{ flex: 1, gap: 2 }}>
      <T v="caption" tone="ink3" numberOfLines={2}>
        {label}
      </T>
      <T v="caption" style={{ fontWeight: '600', fontVariant: ['tabular-nums'] }}>
        {value}
      </T>
    </View>
  );
}

/** The decision area: approve here when the server allows it, otherwise the reason and a way to the desktop. */
function Decision({ d, onChanged }: { d: Detail; onChanged: () => void }) {
  const online = useOnline();
  const invalidate = useInvalidate();
  const [busy, setBusy] = useState(false);

  if (d.decision && (d.status === 'approved' || d.status === 'rejected')) {
    return (
      <Banner tone={d.status === 'approved' ? 'pass' : 'block'} icon={d.status === 'approved' ? CircleCheck : OctagonAlert} title={`${d.status === 'approved' ? 'Approved' : 'Rejected'}${d.decision.by ? ` by ${d.decision.by}` : ''}`}>
        {dateTime(d.decision.at)}
        {d.decision.note ? ` · ${d.decision.note}` : ''}
      </Banner>
    );
  }

  if (d.can.approve && d.amounts.verified !== null) {
    const amount = d.amounts.verified;
    const approve = () => {
      Alert.alert(
        `Approve ${money(amount)}?`,
        `${d.subcontractor ?? 'This subcontractor'}${d.number !== null ? `, application #${d.number}` : ''}. Zephric checks the figures again before recording your approval, and refuses if anything has changed.`,
        [
          { text: 'Cancel', style: 'cancel' },
          {
            text: 'Approve',
            onPress: async () => {
              setBusy(true);
              try {
                await api(`/api/mobile/applications/${d.id}/approve`, { method: 'POST', body: { expectedVersion: d.version, expectedAmount: amount }, timeoutMs: 60_000 });
                void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
                await invalidate();
              } catch (err) {
                void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
                onChanged();
                if (err instanceof ApiError && err.code === 'desktop_required') {
                  Alert.alert('Decide on the desktop', err.message, [
                    { text: 'Close', style: 'cancel' },
                    { text: 'Open on the web', onPress: () => void Linking.openURL(`${currentServer()}/applications/${d.id}`) },
                  ]);
                } else {
                  Alert.alert(err instanceof ApiError && err.code === 'conflict' ? 'The application changed' : 'Not approved', messageOf(err));
                }
              } finally {
                setBusy(false);
              }
            },
          },
        ],
      );
    };
    return (
      <Card style={{ gap: 12 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <ShieldCheck size={18} color="#1b7a4a" />
          <T v="heading">Ready for your approval</T>
        </View>
        <T v="caption" tone="ink2">
          Submitted for approval with every check passed or decided. You approve the verified amount, nothing else.
        </T>
        <Button label={`Approve ${money(amount)}`} kind="approve" onPress={approve} loading={busy} disabled={!online} size="lg" />
        {!online ? (
          <T v="caption" tone="ink3">
            Approvals need a connection.
          </T>
        ) : null}
      </Card>
    );
  }

  if (d.desktopReason) {
    return (
      <Banner tone="neutral" icon={Laptop} title="Decide on the desktop" action={<Button label="Open on the web" kind="secondary" size="sm" onPress={() => void Linking.openURL(`${currentServer()}/applications/${d.id}`)} />}>
        {d.desktopReason}
      </Banner>
    );
  }
  return null;
}

function Findings({ d }: { d: Detail }) {
  const p = usePalette();
  const open = d.findings.open;
  const blocking = open.filter((f) => f.severity === 'blocking');
  const warnings = open.filter((f) => f.severity === 'warning');
  const info = open.filter((f) => f.severity === 'info');
  if (d.status === 'processing') return null;
  return (
    <Section title="Checks">
      <Card style={{ gap: 14 }}>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
          {blocking.length ? <Pill label={plural(blocking.length, 'blocking finding')} tone="block" /> : null}
          {warnings.length ? <Pill label={plural(warnings.length, 'warning')} tone="warn" /> : null}
          {d.findings.accepted.length ? <Pill label={`${d.findings.accepted.length} decided with a reason`} tone="neutral" /> : null}
          <Pill label={`${d.findings.passed} passed`} tone="pass" />
        </View>
        {[...blocking, ...warnings, ...info].map((f) => (
          <View key={f.id} style={{ flexDirection: 'row', gap: 10 }}>
            {f.severity === 'blocking' ? <OctagonAlert size={18} color={p.block} /> : f.severity === 'warning' ? <TriangleAlert size={18} color={p.warn} /> : <CircleCheck size={18} color={p.ink3} />}
            <View style={{ flex: 1, gap: 2 }}>
              <T v="label">{f.title}</T>
              <T v="caption" tone="ink2">
                {f.detail}
              </T>
              {f.needsQualifiedReview ? (
                <T v="caption" tone="warn">
                  Needs a qualified reviewer’s judgement. Zephric does not decide this.
                </T>
              ) : null}
            </View>
          </View>
        ))}
        {open.length === 0 ? (
          <T v="caption" tone="ink2">
            No open findings. {d.findings.passed > 0 ? `${plural(d.findings.passed, 'check')} passed.` : ''}
          </T>
        ) : null}
        {d.findings.accepted.map((f) => (
          <View key={f.id} style={{ flexDirection: 'row', gap: 10, opacity: 0.85 }}>
            <CircleCheck size={18} color={p.ink3} />
            <View style={{ flex: 1, gap: 2 }}>
              <T v="label" tone="ink2">
                {f.title}
              </T>
              <T v="caption" tone="ink3">
                Decided{f.by ? ` by ${f.by}` : ''}
                {f.note ? `: “${f.note}”` : ''}
              </T>
            </View>
          </View>
        ))}
      </Card>
    </Section>
  );
}

function DocumentRow({ doc }: { doc: Detail['documents'][number] }) {
  const p = usePalette();
  const [busy, setBusy] = useState(false);
  const Icon = doc.mimeType.startsWith('image/') ? Image : FileText;
  return (
    <Row
      left={<Icon size={20} color={p.ink3} />}
      title={doc.filename}
      subtitle={[doc.pageCount ? plural(doc.pageCount, 'page') : null, bytes(doc.size), doc.status === 'unreadable' ? 'Not machine-readable' : null].filter(Boolean).join(' · ')}
      right={busy ? <ActivityIndicator color={p.ink3} /> : null}
      onPress={async () => {
        setBusy(true);
        try {
          await openDocument(doc);
        } catch (err) {
          Alert.alert('Could not open the document', messageOf(err));
        } finally {
          setBusy(false);
        }
      }}
    />
  );
}

function Comments({ d, onChanged }: { d: Detail; onChanged: () => void }) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const online = useOnline();
  if (!d.can.comment && d.comments.length === 0) return null;
  const post = async () => {
    if (!text.trim()) return;
    setBusy(true);
    try {
      await api(`/api/mobile/applications/${d.id}/comments`, { method: 'POST', body: { body: text.trim() } });
      setText('');
      onChanged();
    } catch (err) {
      Alert.alert('Comment not added', messageOf(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Section title={`Comments${d.comments.length ? ` · ${d.comments.length}` : ''}`}>
      <Card style={{ gap: 14 }}>
        {d.comments.map((c) => (
          <View key={c.id} style={{ gap: 2 }}>
            <T v="caption" tone="ink3">
              {c.by} · {ago(c.at)}
            </T>
            <T v="body" selectable>
              {c.body}
            </T>
          </View>
        ))}
        {d.can.comment ? (
          <View style={{ gap: 10 }}>
            <Field label="Add a comment for your team" value={text} onChangeText={setText} multiline maxLength={4000} placeholder="Visible to your team, not the subcontractor" />
            <Button label="Post comment" kind="secondary" icon={MessageSquare} onPress={post} loading={busy} disabled={!text.trim() || !online} />
          </View>
        ) : null}
      </Card>
    </Section>
  );
}

function Timeline({ d }: { d: Detail }) {
  const p = usePalette();
  const [all, setAll] = useState(false);
  const items = all ? d.timeline : d.timeline.slice(0, 5);
  return (
    <Section title="History">
      <Card style={{ gap: 14 }}>
        {items.map((e) => (
          <View key={e.id} style={{ flexDirection: 'row', gap: 10 }}>
            <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: p.lineStrong, marginTop: 7 }} />
            <View style={{ flex: 1, gap: 2 }}>
              <T v="caption">{e.summary}</T>
              <T v="caption" tone="ink3">
                {e.by} · {dateTime(e.at)}
              </T>
            </View>
          </View>
        ))}
        {d.timeline.length > 5 ? <Button label={all ? 'Show less' : `Show all ${d.timeline.length}`} kind="ghost" size="sm" onPress={() => setAll(!all)} /> : null}
      </Card>
    </Section>
  );
}
