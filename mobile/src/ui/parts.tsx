/** Pieces shared by several screens: application rows, the offline banner, error states. */
import { useNetworkState } from 'expo-network';
import { router } from 'expo-router';
import { View } from 'react-native';
import CloudOff from 'lucide-react-native/icons/cloud-off';
import TriangleAlert from 'lucide-react-native/icons/triangle-alert';
import OctagonAlert from 'lucide-react-native/icons/octagon-alert';
import { ago, date, money } from '@/lib/format';
import { messageOf, type Row as AppRowData } from '@/lib/api';
import { isOnlineState } from '@/lib/queries';
import { usePalette } from '@/theme';
import { Banner, Button, Divider, Pill, Row, statusTone, T } from './kit';

export function useOnline(): boolean {
  return isOnlineState(useNetworkState());
}

export function OfflineBanner() {
  const online = useOnline();
  if (online) return null;
  return (
    <Banner tone="neutral" icon={CloudOff} title="You are offline">
      Drafts and captures are saved on this phone and send when you are back online. Approvals and figures need a connection.
    </Banner>
  );
}

export function ErrorState({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  return <Banner tone="block" icon={TriangleAlert} title="Could not load this" action={onRetry ? <Button label="Try again" kind="secondary" size="sm" onPress={onRetry} /> : undefined}>{messageOf(error)}</Banner>;
}

/** One application in a list: who, which number, what state, how much. */
export function AppRow({ a, showProject = true }: { a: AppRowData; showProject?: boolean }) {
  const p = usePalette();
  const who = a.subcontractor ?? 'Unmatched submission';
  const amount = a.approved ?? a.verified ?? a.claimed;
  const label = a.approved !== null ? 'Approved' : a.verified !== null ? 'Verified' : a.claimed !== null ? 'Requested' : null;
  return (
    <Row
      onPress={() => router.push(`/application/${a.id}`)}
      accessibilityLabel={`${who}, application ${a.number ?? 'without a number'}, ${a.statusLabel}`}
      title={
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <T v="label" numberOfLines={1} style={{ flexShrink: 1 }}>
            {who}
          </T>
          {a.number !== null ? (
            <T v="caption" tone="ink3">
              #{a.number}
            </T>
          ) : null}
        </View>
      }
      subtitle={[showProject ? a.project : null, a.periodTo ? `to ${date(a.periodTo)}` : `received ${ago(a.receivedAt)}`].filter(Boolean).join(' · ')}
      meta={
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 6, flexWrap: 'wrap' }}>
          <Pill label={a.failed ? 'Could not be read' : a.statusLabel} tone={a.failed ? 'block' : statusTone(a.status)} />
          {a.openBlocking > 0 ? (
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 3 }}>
              <OctagonAlert size={13} color={p.block} />
              <T v="caption" tone="block">
                {a.openBlocking}
              </T>
            </View>
          ) : null}
          {a.openWarnings > 0 ? (
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 3 }}>
              <TriangleAlert size={13} color={p.warn} />
              <T v="caption" tone="warn">
                {a.openWarnings}
              </T>
            </View>
          ) : null}
        </View>
      }
      right={
        amount !== null ? (
          <View style={{ alignItems: 'flex-end' }}>
            <T v="amount">{money(amount)}</T>
            {label ? (
              <T v="caption" tone="ink3">
                {label}
              </T>
            ) : null}
          </View>
        ) : null
      }
    />
  );
}

export function RowList<T>({ items, render, keyOf }: { items: T[]; render: (item: T) => React.ReactNode; keyOf: (item: T) => string }) {
  return (
    <View>
      {items.map((item, i) => (
        <View key={keyOf(item)}>
          {i > 0 ? <Divider inset={16} /> : null}
          {render(item)}
        </View>
      ))}
    </View>
  );
}
