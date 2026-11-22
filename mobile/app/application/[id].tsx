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
import { rowStatus, type UploadItem } from '@/lib/uploads';
import { BillSlip } from '@/ui/bill-slip';
import { Banner, Button, Card, Divider, Field, LoadingCard, Row, Screen, Section, T } from '@/ui/kit';
import { ErrorState, OfflineBanner, useOnline } from '@/ui/parts';

export default function ApplicationScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const q = useApplication(id);
  const d = q.data;
  return (
    <>
      <Stack.Screen options={{ title: d ? (d.number !== null ? `Bill #${d.number}` : 'Bill') : '' }} />
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

/** The bill as the paper slip: the sender's name for it, their words and tags, the amount, and the stamp. */
function slipFor(d: Detail): UploadItem {
  const said = rowStatus({ ...d, title: d.title ?? null, project: d.project?.name ?? null, contractNumber: d.contract?.number ?? null, claimed: d.amounts.claimed, verified: d.amounts.verified, approved: d.amounts.approved, openBlocking: d.findings.open.filter((f) => f.severity === 'blocking').length, failed: !!d.processingError });
  const typed = d.stated ?? null;
  const cents = typed ?? d.amounts.approved ?? d.amounts.verified ?? d.amounts.claimed;
  const named = d.title?.trim() || null;
  return {
    key: d.id,
    target: { kind: 'application', id: d.id },
    title: named ?? d.subcontractor ?? 'Not matched yet',
    detail: [named ? d.subcontractor : null, d.project?.name, d.number !== null ? `#${d.number}` : null].filter(Boolean).join(' · ') || null,
    at: d.receivedAt,
    ...said,
    amount: cents !== null ? money(cents) : null,
    amountTyped: typed !== null,
    description: d.description?.trim() || null,
    tags: d.tags ?? [],
    haystack: '',
  };
}

function Body({ d, onChanged }: { d: Detail; onChanged: () => void }) {
  const differs = d.amounts.claimed !== null && d.amounts.verified !== null && d.amounts.claimed !== d.amounts.verified;
  const slip = slipFor(d);
  const checked = d.amounts.approved ?? d.amounts.verified;

  return (
    <>
      <BillSlip item={slip} caption={`Sent ${ago(d.receivedAt)}${d.receivedVia === 'email' ? ' by email' : ''}`} />

      {d.status === 'processing' ? (
        <Banner tone="neutral" icon={Loader} title="Zephric is reading it">
          Amounts and checks show up when it finishes. Pull down to refresh
        </Banner>
      ) : null}
      {d.processingError ? (
        <Banner tone="block" icon={TriangleAlert} title="Zephric could not read it">
          Someone in the office will look at it by hand
        </Banner>
      ) : null}

      {d.status !== 'processing' && (checked !== null || d.amounts.claimed !== null) ? (
        <Section title="Zephric’s check">
          <Card style={{ gap: 16 }}>
            <View style={{ flexDirection: 'row', gap: 12 }}>
              <Figure label="Asked for" value={money(d.amounts.claimed)} />
              <Figure label={d.amounts.approved !== null ? 'Approved' : 'Checked amount'} value={money(checked)} />
            </View>
            {differs && d.amounts.approved === null ? (
              <T v="body" tone="warn">
                The checked amount is different from what was asked for
              </T>
            ) : null}
            <Divider />
            <View style={{ flexDirection: 'row', gap: 12 }}>
              <Figure label="Contract so far" value={money(d.amounts.contractSumToDate)} small />
              <Figure label="Held back" value={money(d.amounts.retainage)} small />
              <Figure label="Left to bill" value={money(d.amounts.balanceToFinish)} small />
            </View>
          </Card>
        </Section>
      ) : null}

      <Decision d={d} onChanged={onChanged} />

      <Findings d={d} />

      {d.documents.length > 0 ? (
        <Section title={d.documents.length === 1 ? 'The file' : `Files · ${d.documents.length}`}>
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
        <Button label="Ask the subcontractor for something" kind="secondary" icon={Send} onPress={() => router.push(`/request-info/${d.id}`)} />
      ) : null}

      {d.messages.length > 0 ? (
        <Section title="Messages sent to the subcontractor">
          <Card padded={false}>
            {d.messages.map((m, i) => (
              <View key={m.id}>
                {i > 0 ? <Divider inset={16} /> : null}
                <Row title={m.subject} subtitle={`${m.to ?? ''} · ${ago(m.at)}`} chevron={false} right={<T v="caption" tone={m.status === 'sent' ? 'pass' : m.status === 'failed' ? 'block' : 'ink3'}>{messageStatus(m.status)}</T>} />
              </View>
            ))}
          </Card>
        </Section>
      ) : null}

      <Comments d={d} onChanged={onChanged} />

      {d.timeline.length > 0 ? <Timeline d={d} /> : null}

      <Button label="Open on the website" kind="ghost" icon={Laptop} onPress={() => void Linking.openURL(`${currentServer()}/applications/${d.id}`)} />
    </>
  );
}

function messageStatus(status: string): string {
  switch (status) {
    case 'sent':
      return 'Sent';
    case 'not_sent':
      return 'Saved, not emailed';
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

function Figure({ label, value, small = false }: { label: string; value: string; small?: boolean }) {
  return (
    <View style={{ flex: 1, gap: 2 }}>
      <T v="caption" tone="ink3" numberOfLines={2}>
        {label}
      </T>
      <T v="amount" style={small ? { fontSize: 15 } : { fontSize: 20, lineHeight: 26 }}>
        {value}
      </T>
    </View>
  );
}

/** The decision area: approve here when the server allows it, otherwise the reason and a way to the desktop. */
function Decision({ d, onChanged }: { d: Detail; onChanged: () => void }) {
  const p = usePalette();
  const online = useOnline();
  const invalidate = useInvalidate();
  const [busy, setBusy] = useState(false);

  if (d.decision && (d.status === 'approved' || d.status === 'rejected')) {
    return (
      <Banner tone={d.status === 'approved' ? 'pass' : 'block'} icon={d.status === 'approved' ? CircleCheck : OctagonAlert} title={`${d.status === 'approved' ? 'Approved' : 'Turned down'}${d.decision.by ? ` by ${d.decision.by}` : ''}`}>
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
        `${d.subcontractor ?? 'This bill'}${d.number !== null ? `, bill #${d.number}` : ''}. Zephric checks the amount once more before saving your approval.`,
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
                  Alert.alert('Approve this on the website', err.message, [
                    { text: 'Close', style: 'cancel' },
                    { text: 'Open the website', onPress: () => void Linking.openURL(`${currentServer()}/applications/${d.id}`) },
                  ]);
                } else {
                  Alert.alert(err instanceof ApiError && err.code === 'conflict' ? 'This bill changed' : 'Not approved', messageOf(err));
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
          <ShieldCheck size={20} color={p.pass} strokeWidth={1.75} />
          <T v="heading">Ready for you to approve</T>
        </View>
        <T v="body" tone="ink2">
          Every check is done. You are approving the checked amount, nothing else
        </T>
        <Button label={`Approve ${money(amount)}`} kind="approve" onPress={approve} loading={busy} disabled={!online} size="lg" />
        {!online ? (
          <T v="caption" tone="ink3">
            Approving needs internet
          </T>
        ) : null}
      </Card>
    );
  }

  if (d.desktopReason) {
    return (
      <Banner tone="neutral" icon={Laptop} title="Approve this on the website" action={<Button label="Open the website" kind="secondary" size="sm" onPress={() => void Linking.openURL(`${currentServer()}/applications/${d.id}`)} />}>
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
    <Section title="What Zephric checked">
      <Card style={{ gap: 16 }}>
        <T v="body" tone="ink2">
          {[
            blocking.length ? (blocking.length === 1 ? '1 problem' : `${blocking.length} problems`) : null,
            warnings.length ? `${warnings.length} worth a look` : null,
            d.findings.accepted.length ? `${d.findings.accepted.length} settled` : null,
            `${d.findings.passed} fine`,
          ]
            .filter(Boolean)
            .join(' · ')}
        </T>
        {[...blocking, ...warnings, ...info].map((f) => (
          <View key={f.id} style={{ flexDirection: 'row', gap: 10 }}>
            {f.severity === 'blocking' ? <OctagonAlert size={20} color={p.block} strokeWidth={1.75} /> : f.severity === 'warning' ? <TriangleAlert size={20} color={p.warn} strokeWidth={1.75} /> : <CircleCheck size={20} color={p.ink3} strokeWidth={1.75} />}
            <View style={{ flex: 1, gap: 2 }}>
              <T v="label">{f.title}</T>
              <T v="caption" tone="ink2">
                {f.detail}
              </T>
              {f.needsQualifiedReview ? (
                <T v="caption" tone="warn">
                  A person has to decide this, not Zephric
                </T>
              ) : null}
            </View>
          </View>
        ))}
        {open.length === 0 ? (
          <T v="caption" tone="ink2">
            Nothing wrong found{d.findings.passed > 0 ? ` in ${plural(d.findings.passed, 'check')}` : ''}
          </T>
        ) : null}
        {d.findings.accepted.map((f) => (
          <View key={f.id} style={{ flexDirection: 'row', gap: 10, opacity: 0.85 }}>
            <CircleCheck size={20} color={p.ink3} strokeWidth={1.75} />
            <View style={{ flex: 1, gap: 2 }}>
              <T v="label" tone="ink2">
                {f.title}
              </T>
              <T v="caption" tone="ink3">
                Settled{f.by ? ` by ${f.by}` : ''}
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
      left={<Icon size={20} color={p.ink3} strokeWidth={1.75} />}
      title={doc.filename}
      subtitle={[doc.pageCount ? plural(doc.pageCount, 'page') : null, bytes(doc.size), doc.status === 'unreadable' ? 'Zephric could not read it' : null].filter(Boolean).join(' · ')}
      right={busy ? <ActivityIndicator color={p.ink3} /> : null}
      onPress={async () => {
        setBusy(true);
        try {
          await openDocument(doc);
        } catch (err) {
          Alert.alert('Could not open the file', messageOf(err));
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
      Alert.alert('Note not added', messageOf(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Section title={`Team notes${d.comments.length ? ` · ${d.comments.length}` : ''}`}>
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
            <Field label="Add a note for your team" value={text} onChangeText={setText} multiline maxLength={4000} placeholder="Only your team sees this" />
            <Button label="Add note" kind="secondary" icon={MessageSquare} onPress={post} loading={busy} disabled={!text.trim() || !online} />
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
