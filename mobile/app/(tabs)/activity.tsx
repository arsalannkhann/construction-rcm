import { router } from 'expo-router';
import { View } from 'react-native';
import Bell from 'lucide-react-native/icons/bell';
import { ago } from '@/lib/format';
import { useMarkRead, useNotifications } from '@/lib/queries';
import { usePalette } from '@/theme';
import { Button, Card, Empty, LoadingCard, Row, T } from '@/ui/kit';
import { ErrorState, RowList } from '@/ui/parts';
import { TabScreen } from '@/ui/tab-screen';

export default function Activity() {
  const p = usePalette();
  const list = useNotifications();
  const markRead = useMarkRead();
  const unread = list.data?.unread ?? 0;
  return (
    <TabScreen
      title="Activity"
      subtitle={unread > 0 ? `${unread} unread` : null}
      refreshing={list.isRefetching}
      onRefresh={() => void list.refetch()}
      action={unread > 0 ? <Button label="Mark all read" kind="secondary" size="sm" loading={markRead.isPending} onPress={() => markRead.mutate(undefined)} /> : null}
    >
      {list.error ? <ErrorState error={list.error} onRetry={() => void list.refetch()} /> : null}
      {list.isLoading ? <LoadingCard rows={5} /> : null}
      {list.data ? (
        <Card padded={false}>
          {list.data.items.length === 0 ? (
            <Empty icon={Bell} title="No activity yet">
              Approvals, comments and requests that involve you appear here.
            </Empty>
          ) : (
            <RowList
              items={list.data.items}
              keyOf={(n) => n.id}
              render={(n) => (
                <Row
                  onPress={
                    n.applicationId
                      ? () => {
                          if (!n.read) markRead.mutate([n.id]);
                          router.push(`/application/${n.applicationId}`);
                        }
                      : undefined
                  }
                  left={<View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: n.read ? 'transparent' : p.accent, marginTop: 2 }} />}
                  title={
                    <T v="label" numberOfLines={2} style={{ fontWeight: n.read ? '400' : '600' }}>
                      {n.title}
                    </T>
                  }
                  subtitle={
                    <T v="caption" tone="ink3" numberOfLines={2}>
                      {[n.body, ago(n.at)].filter(Boolean).join(' · ')}
                    </T>
                  }
                />
              )}
            />
          )}
        </Card>
      ) : null}
      <T v="caption" tone="ink3" style={{ textAlign: 'center', paddingHorizontal: 16 }}>
        Activity updates when you open the app. Push notifications are not turned on in this version.
      </T>
    </TabScreen>
  );
}
