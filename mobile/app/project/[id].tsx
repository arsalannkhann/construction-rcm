import { router, Stack, useLocalSearchParams } from 'expo-router';
import { View } from 'react-native';
import { date, money } from '@/lib/format';
import { useProject } from '@/lib/queries';
import { statusStamp } from '@/lib/uploads';
import { Stamp } from '@/ui/bill-slip';
import { Card, Divider, LoadingCard, Row, Screen, Section, T } from '@/ui/kit';
import { ErrorState, OfflineBanner } from '@/ui/parts';

export default function ProjectScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const q = useProject(id);
  const d = q.data;
  return (
    <>
      <Stack.Screen options={{ title: d?.project.name ?? '' }} />
      <Screen refreshing={q.isRefetching} onRefresh={() => void q.refetch()}>
        <OfflineBanner />
        {q.error ? <ErrorState error={q.error} onRetry={() => void q.refetch()} /> : null}
        {q.isLoading ? <LoadingCard rows={4} /> : null}
        {d ? (
          <>
            <Card style={{ gap: 14 }}>
              <View style={{ gap: 2 }}>
                <T v="title">{d.project.name}</T>
                <T v="caption" tone="ink3">
                  {[d.project.number ? `#${d.project.number}` : null, [d.project.city, d.project.state].filter(Boolean).join(', ') || null].filter(Boolean).join(' · ')}
                </T>
              </View>
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', rowGap: 14 }}>
                <Figure label="Total of contracts" value={money(d.totals.committed)} />
                <Figure label="Approved so far" value={money(d.totals.approvedToDate)} />
                <Figure label="Held back" value={money(d.totals.retainageHeld)} />
                <Figure label="Left to bill" value={money(d.totals.balanceToFinish)} />
              </View>
            </Card>

            <Section title={`Subcontractors · ${d.contracts.length}`}>
              <Card padded={false}>
                {d.contracts.length === 0 ? (
                  <View style={{ padding: 16 }}>
                    <T v="caption" tone="ink3">
                      No subcontractors on this project yet
                    </T>
                  </View>
                ) : (
                  d.contracts.map((c, i) => (
                    <View key={c.id}>
                      {i > 0 ? <Divider inset={16} /> : null}
                      <Row
                        title={c.subcontractor}
                        subtitle={`${c.number} · ${c.title}`}
                        onPress={c.latestApplication ? () => router.push(`/application/${c.latestApplication!.id}`) : undefined}
                        meta={
                          c.latestApplication ? (
                            <View style={{ marginTop: 8, flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                              <Stamp size="sm" label={statusStamp(c.latestApplication.status, c.latestApplication.statusLabel).stamp} tone={statusStamp(c.latestApplication.status, c.latestApplication.statusLabel).tone} />
                              <T v="caption" tone="ink3">
                                Latest bill{c.latestApplication.applicationNumber !== null ? ` #${c.latestApplication.applicationNumber}` : ''}
                              </T>
                            </View>
                          ) : null
                        }
                        right={
                          <View style={{ alignItems: 'flex-end' }}>
                            <T v="amount">{money(c.approvedToDate)}</T>
                            <T v="caption" tone="ink3">
                              of {money(c.contractSum)}
                            </T>
                          </View>
                        }
                      />
                    </View>
                  ))
                )}
              </Card>
            </Section>

            {d.applications.length > 0 ? (
              <Section title="Latest bills">
                <Card padded={false}>
                  {d.applications.map((a, i) => (
                    <View key={a.id}>
                      {i > 0 ? <Divider inset={16} /> : null}
                      <Row
                        title={`${a.subcontractor ?? 'Not matched yet'}${a.number !== null ? ` #${a.number}` : ''}`}
                        subtitle={a.periodTo ? `For ${date(a.periodTo)}` : `Sent ${date(a.receivedAt)}`}
                        meta={
                          <View style={{ marginTop: 8 }}>
                            <Stamp size="sm" label={statusStamp(a.status, a.statusLabel).stamp} tone={statusStamp(a.status, a.statusLabel).tone} />
                          </View>
                        }
                        right={<T v="amount">{money(a.approved ?? a.claimed)}</T>}
                        onPress={() => router.push(`/application/${a.id}`)}
                      />
                    </View>
                  ))}
                </Card>
              </Section>
            ) : null}
          </>
        ) : null}
      </Screen>
    </>
  );
}

function Figure({ label, value }: { label: string; value: string }) {
  return (
    <View style={{ width: '50%', gap: 2 }}>
      <T v="caption" tone="ink3">
        {label}
      </T>
      <T v="amount">{value}</T>
    </View>
  );
}
