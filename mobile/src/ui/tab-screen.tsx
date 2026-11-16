import { type ReactNode } from 'react';
import { View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Screen, T } from './kit';
import { OfflineBanner } from './parts';

/** A top-level tab: a large title, an optional action, the offline notice, then the content. */
export function TabScreen({ title, subtitle, action, children, refreshing, onRefresh }: { title: string; subtitle?: string | null; action?: ReactNode; children: ReactNode; refreshing?: boolean; onRefresh?: () => void }) {
  const insets = useSafeAreaInsets();
  return (
    <Screen refreshing={refreshing} onRefresh={onRefresh} contentStyle={{ paddingTop: insets.top + 12 }}>
      <View style={{ flexDirection: 'row', alignItems: 'flex-end', justifyContent: 'space-between', gap: 12, paddingHorizontal: 4 }}>
        <View style={{ flex: 1, gap: 2 }}>
          {subtitle ? (
            <T v="caption" tone="ink3" numberOfLines={1}>
              {subtitle}
            </T>
          ) : null}
          <T v="display" accessibilityRole="header">
            {title}
          </T>
        </View>
        {action}
      </View>
      <OfflineBanner />
      {children}
    </Screen>
  );
}
