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
  attention: { title: 'Nothing for you right now', body: 'Bills you need to check or approve show up here' },
  open: { title: 'No bills in progress', body: 'Everything that came in has been approved or turned down' },
  decided: { title: 'Nothing finished yet', body: 'Approved and turned-down bills show up here' },
  mine: { title: 'You have not sent anything yet', body: 'Bills you send from this phone or the website show up here' },
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
    ...(canDecide ? [{ value: 'attention' as const, label: 'For you' }] : []),
    { value: 'open', label: 'In progress' },
    { value: 'decided', label: 'Finished' },
    ...(canUpload ? [{ value: 'mine' as const, label: 'Sent by me' }] : []),
  ];

  return (
    <TabScreen
      title="Bills"
      subtitle={session.profile.orgName}
      refreshing={list.isRefetching}
      onRefresh={() => void list.refetch()}
      action={canUpload ? <Button label="Send a bill" icon={Camera} size="sm" onPress={() => router.push('/capture')} /> : null}
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
