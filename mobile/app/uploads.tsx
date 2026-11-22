/**
 * My uploads: one list of everything this person has sent or is sending, with
 * a search box. Built for people who are not comfortable with software: big
 * text, the name they gave each upload, and the state in plain words.
 */
import { router } from 'expo-router';
import { useMemo, useState } from 'react';
import { Pressable, ScrollView, TextInput, View } from 'react-native';
import CircleAlert from 'lucide-react-native/icons/circle-alert';
import CircleCheck from 'lucide-react-native/icons/circle-check';
import CloudUpload from 'lucide-react-native/icons/cloud-upload';
import FileText from 'lucide-react-native/icons/file-text';
import Search from 'lucide-react-native/icons/search';
import X from 'lucide-react-native/icons/x';
import { useSignedIn } from '@/lib/auth';
import { useDrafts } from '@/lib/drafts';
import { ago } from '@/lib/format';
import { useApplications } from '@/lib/queries';
import { buildUploads, filterUploads, tagCounts, type Period, type UploadItem, type UploadTone } from '@/lib/uploads';
import { radius, usePalette } from '@/theme';
import { Card, Empty, LoadingCard, Screen, T } from '@/ui/kit';
import { ErrorState, OfflineBanner } from '@/ui/parts';

export default function MyUploads() {
  const p = usePalette();
  const session = useSignedIn();
  const owner = session.profile.orgId ? { userId: session.profile.userId, orgId: session.profile.orgId } : null;
  const drafts = useDrafts(owner);
  const mine = useApplications('mine');
  const [query, setQuery] = useState('');
  const [tag, setTag] = useState<string | null>(null);
  const [period, setPeriod] = useState<Period | null>(null);

  const all = useMemo(() => buildUploads(drafts, mine.data ?? []), [drafts, mine.data]);
  const tags = useMemo(() => tagCounts(all).slice(0, 20), [all]);
  const shown = useMemo(() => filterUploads(all, { query, tag, period }), [all, query, tag, period]);
  const searching = query.trim().length > 0 || tag !== null || period !== null;
  const clearAll = () => {
    setQuery('');
    setTag(null);
    setPeriod(null);
  };

  return (
    <Screen refreshing={mine.isRefetching} onRefresh={() => void mine.refetch()}>
      <OfflineBanner />
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          gap: 10,
          minHeight: 56,
          paddingHorizontal: 16,
          borderRadius: radius.lg,
          borderWidth: 1.5,
          borderColor: p.lineStrong,
          backgroundColor: p.surface,
        }}
      >
        <Search size={22} color={p.ink3} />
        <TextInput
          value={query}
          onChangeText={setQuery}
          placeholder="Search name, tag, amount…"
          placeholderTextColor={p.ink4}
          autoCorrect={false}
          returnKeyType="search"
          accessibilityLabel="Search your uploads"
          style={{ flex: 1, fontSize: 18, color: p.ink, paddingVertical: 14 }}
        />
        {searching ? (
          <Pressable onPress={() => setQuery('')} accessibilityRole="button" accessibilityLabel="Clear search" hitSlop={12}>
            <X size={22} color={p.ink3} />
          </Pressable>
        ) : null}
      </View>

      {all.length > 0 ? (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8, paddingRight: 16 }} style={{ marginHorizontal: -16, paddingLeft: 16, flexGrow: 0 }}>
          <Chip label="This week" on={period === 'week'} onPress={() => setPeriod(period === 'week' ? null : 'week')} />
          <Chip label="This month" on={period === 'month'} onPress={() => setPeriod(period === 'month' ? null : 'month')} />
          {tags.length > 0 ? <View style={{ width: 1, backgroundColor: p.line, marginVertical: 8 }} /> : null}
          {tags.map((t) => (
            <Chip key={t.tag} label={t.tag} count={t.count} on={tag?.toLowerCase() === t.tag.toLowerCase()} onPress={() => setTag(tag?.toLowerCase() === t.tag.toLowerCase() ? null : t.tag)} />
          ))}
        </ScrollView>
      ) : null}

      {mine.error ? <ErrorState error={mine.error} onRetry={() => void mine.refetch()} /> : null}
      {mine.isLoading && all.length === 0 ? <LoadingCard rows={5} /> : null}

      {!mine.isLoading || all.length > 0 ? (
        shown.length === 0 ? (
          <Card>
            <Empty
              icon={searching ? Search : FileText}
              title={searching ? 'Nothing matches' : 'You have not sent anything yet'}
              action={searching ? <Pressable onPress={clearAll} accessibilityRole="button" hitSlop={8}><T v="label" tone="accent">Show everything</T></Pressable> : undefined}
            >
              {searching ? 'Try fewer words, another tag, or part of the name or amount' : 'Bills and receipts you send will appear here'}
            </Empty>
          </Card>
        ) : (
          <View style={{ gap: 10 }}>
            <T v="caption" tone="ink3">
              {searching ? `${shown.length} of ${all.length} found` : `${all.length} ${all.length === 1 ? 'upload' : 'uploads'}, newest first`}
            </T>
            {shown.map((i) => (
              <UploadCard key={i.key} item={i} />
            ))}
          </View>
        )
      ) : null}
    </Screen>
  );
}

function UploadCard({ item }: { item: UploadItem }) {
  const p = usePalette();
  const tone: Record<UploadTone, { color: string; Icon: typeof CircleCheck }> = {
    progress: { color: p.accentText, Icon: CloudUpload },
    ok: { color: p.pass, Icon: CircleCheck },
    problem: { color: p.block, Icon: CircleAlert },
    neutral: { color: p.ink3, Icon: FileText },
  };
  const { color, Icon } = tone[item.tone];
  const open = () => (item.target.kind === 'draft' ? router.push(`/capture/${item.target.id}`) : router.push(`/application/${item.target.id}`));
  return (
    <Pressable
      onPress={open}
      accessibilityRole="button"
      accessibilityLabel={`${item.title}, ${item.status}, ${ago(item.at)}`}
      style={({ pressed }) => ({
        backgroundColor: pressed ? p.sunken : p.surface,
        borderRadius: radius.lg,
        borderWidth: 1,
        borderColor: p.line,
        padding: 16,
        gap: 8,
      })}
    >
      <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 12 }}>
        <T v="heading" numberOfLines={2} style={{ flex: 1, fontSize: 18, lineHeight: 24 }}>
          {item.title}
        </T>
        <T v="caption" tone="ink3" style={{ fontSize: 14 }}>
          {ago(item.at)}
        </T>
      </View>
      {item.description ? (
        <T v="body" tone="ink2" numberOfLines={2}>
          {item.description}
        </T>
      ) : null}
      {item.detail ? (
        <T v="caption" tone="ink3" numberOfLines={1}>
          {item.detail}
        </T>
      ) : null}
      {item.tags.length > 0 ? (
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
          {item.tags.map((t) => (
            <View key={t} style={{ borderRadius: radius.sm, backgroundColor: p.sunken, paddingHorizontal: 8, paddingVertical: 2 }}>
              <T v="caption" tone="ink2">
                {t}
              </T>
            </View>
          ))}
        </View>
      ) : null}
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        <Icon size={18} color={color} />
        <T v="label" style={{ color, flex: 1, fontSize: 15 }}>
          {item.status}
        </T>
        {item.amount ? <T v="amount">{item.amount}</T> : null}
      </View>
    </Pressable>
  );
}

/** A filter button: one tap narrows the list, another tap undoes it. */
function Chip({ label, count, on, onPress }: { label: string; count?: number; on: boolean; onPress: () => void }) {
  const p = usePalette();
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityState={{ selected: on }}
      accessibilityLabel={count !== undefined ? `${label}, ${count}` : label}
      style={({ pressed }) => ({
        minHeight: 44,
        paddingHorizontal: 14,
        borderRadius: radius.md,
        borderWidth: 1,
        borderColor: on ? p.ink : p.lineStrong,
        backgroundColor: on ? p.ink : pressed ? p.sunken : p.surface,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
      })}
    >
      <T v="label" style={{ color: on ? p.canvas : p.ink }}>
        {label}
      </T>
      {count !== undefined ? (
        <T v="caption" style={{ color: on ? p.canvas : p.ink3, fontVariant: ['tabular-nums'] }}>
          {count}
        </T>
      ) : null}
    </Pressable>
  );
}
