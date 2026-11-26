import { router, useLocalSearchParams } from 'expo-router';
import { useMemo, useState } from 'react';
import { View } from 'react-native';
import Check from 'lucide-react-native/icons/check';
import Wand from 'lucide-react-native/icons/wand';
import { updateDraft, useDraft } from '@/lib/drafts';
import { useContracts } from '@/lib/queries';
import { usePalette } from '@/theme';
import { Card, Divider, Empty, Field, LoadingCard, Row, Screen, Section, T } from '@/ui/kit';
import { ErrorState } from '@/ui/parts';

/** Which subcontract a capture is for. Optional: Zephric can match it from the documents. */
export default function PickContract() {
  const p = usePalette();
  const { draftId } = useLocalSearchParams<{ draftId: string }>();
  const draft = useDraft(draftId);
  const contracts = useContracts();
  const [query, setQuery] = useState('');

  const groups = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = (contracts.data ?? []).filter((c) => !q || `${c.label} ${c.group}`.toLowerCase().includes(q));
    const map = new Map<string, typeof list>();
    for (const c of list) map.set(c.group, [...(map.get(c.group) ?? []), c]);
    return [...map.entries()];
  }, [contracts.data, query]);

  const choose = (contract: { id: string; label: string; group: string } | null) => {
    if (draft) updateDraft(draft.id, { contract });
    router.back();
  };

  return (
    <Screen>
      <Card padded={false}>
        <Row left={<Wand size={20} color={p.ink2} strokeWidth={1.75} />} title="Let Zephric work it out" subtitle="It reads the job and subcontractor from the bill" onPress={() => choose(null)} chevron={false} right={!draft?.contract ? <Check size={18} color={p.accentText} /> : null} />
      </Card>
      <Field label="Search" value={query} onChangeText={setQuery} placeholder="Subcontractor, project or contract number" autoCorrect={false} clearButtonMode="while-editing" />
      {contracts.error ? <ErrorState error={contracts.error} onRetry={() => void contracts.refetch()} /> : null}
      {contracts.isLoading ? <LoadingCard rows={4} /> : null}
      {contracts.data && groups.length === 0 ? (
        <Card>
          <Empty title={query ? 'Nothing matches' : 'No jobs set up yet'}>{query ? 'Try another name or number' : 'Jobs are set up on the Zephric website'}</Empty>
        </Card>
      ) : null}
      {groups.map(([group, items]) => (
        <Section key={group} title={group}>
          <Card padded={false}>
            {items.map((c, i) => {
              const [who, ...rest] = c.label.split(' · ');
              return (
                <View key={c.id}>
                  {i > 0 ? <Divider inset={16} /> : null}
                  <Row title={who ?? c.label} subtitle={rest.join(' · ')} onPress={() => choose(c)} chevron={false} right={draft?.contract?.id === c.id ? <Check size={18} color={p.accentText} /> : null} />
                </View>
              );
            })}
          </Card>
        </Section>
      ))}
      <T v="caption" tone="ink3" style={{ textAlign: 'center' }}>
        Only current jobs in your company are listed
      </T>
    </Screen>
  );
}
