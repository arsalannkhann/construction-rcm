import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useState } from 'react';
import Camera from 'lucide-react-native/icons/camera';
import Inbox from 'lucide-react-native/icons/inbox';
import { useSignedIn } from '@/lib/auth';
import { useApplications, useHome, type BillingView } from '@/lib/queries';
import { Button, Card, Empty, LoadingCard, Segmented } from '@/ui/kit';
import { AppRow, ErrorState, RowList } from '@/ui/parts';
import { TabScreen } from '@/ui/tab-screen';

const EMPTY: Record<BillingView, { title: string; body: string }> = {
  attention: { title: 'Nothing needs you', body: 'Applications waiting on your review or approval appear here.' },
  open: { title: 'No open applications', body: 'Everything received has been decided.' },
  decided: { title: 'Nothing decided yet', body: 'Approved and rejected applications appear here.' },
  mine: { title: 'You have not submitted anything', body: 'Captures you send from this phone or upload on the web appear here.' },
};

export default function Billing() {
  const session = useSignedIn();
  const home = useHome();
  const params = useLocalSearchParams<{ view?: string }>();
  const perms = home.data?.permissions;
  const canDecide = perms ? perms.review || perms.approve : true;
  const [view, setView] = useState<BillingView>(canDecide ? 'attention' : 'mine');
  useEffect(() => {
    if (params.view === 'attention' || params.view === 'open' || params.view === 'decided' || params.view === 'mine') setView(params.view);
  }, [params.view]);
  const list = useApplications(view);
  const canUpload = perms?.upload ?? session.profile.canUpload;

  const options: Array<{ value: BillingView; label: string }> = [
    ...(canDecide ? [{ value: 'attention' as const, label: 'Needs you' }] : []),
    { value: 'open', label: 'Open' },
    { value: 'decided', label: 'Decided' },
    ...(canUpload ? [{ value: 'mine' as const, label: 'Submitted by me' }] : []),
  ];

  return (
    <TabScreen
      title="Billing"
      subtitle={session.profile.orgName}
      refreshing={list.isRefetching}
      onRefresh={() => void list.refetch()}
      action={canUpload ? <Button label="Capture" icon={Camera} size="sm" onPress={() => router.push('/capture')} /> : null}
    >
      <Segmented value={view} options={options} onChange={setView} />
      {list.error ? <ErrorState error={list.error} onRetry={() => void list.refetch()} /> : null}
      {list.isLoading ? <LoadingCard rows={5} /> : null}
      {list.data ? (
        <Card padded={false}>
          {list.data.length === 0 ? (
            <Empty icon={Inbox} title={EMPTY[view].title}>
              {EMPTY[view].body}
            </Empty>
          ) : (
            <RowList items={list.data} keyOf={(a) => a.id} render={(a) => <AppRow a={a} />} />
          )}
        </Card>
      ) : null}
    </TabScreen>
  );
}
