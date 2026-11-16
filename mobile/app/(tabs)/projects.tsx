import { router } from 'expo-router';
import { View } from 'react-native';
import Building2 from 'lucide-react-native/icons/building-complex';
import { useSignedIn } from '@/lib/auth';
import { money, plural } from '@/lib/format';
import { useProjects } from '@/lib/queries';
import { Card, Empty, LoadingCard, Pill, PressableCard, T } from '@/ui/kit';
import { ErrorState } from '@/ui/parts';
import { TabScreen } from '@/ui/tab-screen';

export default function Projects() {
  const session = useSignedIn();
  const projects = useProjects();
  return (
    <TabScreen title="Projects" subtitle={session.profile.orgName} refreshing={projects.isRefetching} onRefresh={() => void projects.refetch()}>
      {projects.error ? <ErrorState error={projects.error} onRetry={() => void projects.refetch()} /> : null}
      {projects.isLoading ? <LoadingCard rows={4} /> : null}
      {projects.data?.length === 0 ? (
        <Card>
          <Empty icon={Building2} title="No projects yet">
            Projects and their subcontracts are set up on the web.
          </Empty>
        </Card>
      ) : null}
      {projects.data?.map((p) => (
        <PressableCard key={p.id} onPress={() => router.push(`/project/${p.id}`)} style={{ gap: 14 }} accessibilityLabel={`${p.name}, ${plural(p.contracts, 'subcontract')}`}>
          <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 10 }}>
            <View style={{ flex: 1, gap: 2 }}>
              <T v="heading" numberOfLines={2}>
                {p.name}
              </T>
              <T v="caption" tone="ink3" numberOfLines={1}>
                {[p.number ? `#${p.number}` : null, [p.city, p.state].filter(Boolean).join(', ') || null, plural(p.contracts, 'subcontract')].filter(Boolean).join(' · ')}
              </T>
            </View>
            {p.inReview > 0 ? <Pill label={`${p.inReview} open`} tone="accent" /> : p.status !== 'active' ? <Pill label={p.status === 'closed' ? 'Closed' : p.status} /> : null}
          </View>
          <View style={{ flexDirection: 'row', gap: 16 }}>
            <Figure label="Committed" value={money(p.committed)} />
            <Figure label="Approved to date" value={money(p.approvedToDate)} />
          </View>
        </PressableCard>
      ))}
    </TabScreen>
  );
}

function Figure({ label, value }: { label: string; value: string }) {
  return (
    <View style={{ flex: 1, gap: 2 }}>
      <T v="caption" tone="ink3">
        {label}
      </T>
      <T v="amount">{value}</T>
    </View>
  );
}
