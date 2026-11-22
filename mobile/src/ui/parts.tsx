/** Pieces shared by several screens: bill rows, the offline banner, error states. */
import { useNetworkState } from 'expo-network';
import { router } from 'expo-router';
import { View } from 'react-native';
import CloudOff from 'lucide-react-native/icons/cloud-off';
import TriangleAlert from 'lucide-react-native/icons/triangle-alert';
import { ago, date, money } from '@/lib/format';
import { messageOf, type Row as AppRowData } from '@/lib/api';
import { isOnlineState } from '@/lib/queries';
import { rowStatus } from '@/lib/uploads';
import { Stamp } from './bill-slip';
import { Banner, Button, Divider, Row, T } from './kit';

export function useOnline(): boolean {
  return isOnlineState(useNetworkState());
}

export function OfflineBanner() {
  const online = useOnline();
  if (online) return null;
  return (
    <Banner tone="neutral" icon={CloudOff} title="No internet right now">
      Bills you send are kept on this phone and go out by themselves when you are back online. Approving needs internet.
    </Banner>
  );
}

export function ErrorState({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  return <Banner tone="block" icon={TriangleAlert} title="This did not load" action={onRetry ? <Button label="Try again" kind="secondary" size="sm" onPress={onRetry} /> : undefined}>{messageOf(error)}</Banner>;
}

/** One bill in a list: whose, which number, where it stands (as a stamp), how much. */
export function AppRow({ a, showProject = true }: { a: AppRowData; showProject?: boolean }) {
  // The name the person gave it comes first, so an upload is recognisable before Zephric has matched it.
  const named = a.title?.trim() || null;
  const who = named ?? a.subcontractor ?? 'Not matched yet';
  const typed = a.stated ?? null;
  const amount = typed ?? a.approved ?? a.verified ?? a.claimed;
  const label = typed !== null ? 'As typed' : a.approved !== null ? 'Approved' : a.verified !== null ? 'Checked' : a.claimed !== null ? 'Asked for' : null;
  const said = rowStatus(a);
  return (
    <Row
      onPress={() => router.push(`/application/${a.id}`)}
      accessibilityLabel={`${who}${a.number !== null ? `, bill ${a.number}` : ''}, ${said.status}`}
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
      subtitle={[named ? a.subcontractor : null, showProject ? a.project : null, a.periodTo ? `for ${date(a.periodTo)}` : `sent ${ago(a.receivedAt)}`].filter(Boolean).join(' · ')}
      meta={
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12, marginTop: 8, flexWrap: 'wrap' }}>
          <Stamp label={said.stamp} tone={said.tone} size="sm" />
          {a.openBlocking > 0 ? (
            <T v="caption" tone="block">
              {a.openBlocking === 1 ? '1 problem' : `${a.openBlocking} problems`}
            </T>
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
