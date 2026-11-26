import * as DocumentPicker from 'expo-document-picker';
import * as Haptics from 'expo-haptics';
import * as ImagePicker from 'expo-image-picker';
import { router, Stack, useLocalSearchParams } from 'expo-router';
import { useMemo, useState } from 'react';
import { Alert, Image, Linking, Modal, Pressable, StyleSheet, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import ArrowLeft from 'lucide-react-native/icons/arrow-left';
import ArrowRight from 'lucide-react-native/icons/arrow-right';
import Camera from 'lucide-react-native/icons/camera';
import CircleCheck from 'lucide-react-native/icons/circle-check';
import FileText from 'lucide-react-native/icons/file-text';
import FileUp from 'lucide-react-native/icons/file-up';
import FolderOpen from 'lucide-react-native/icons/folder-open';
import Images from 'lucide-react-native/icons/images';
import Plus from 'lucide-react-native/icons/plus';
import RotateCw from 'lucide-react-native/icons/rotate-cw';
import Send from 'lucide-react-native/icons/send';
import Trash2 from 'lucide-react-native/icons/trash';
import X from 'lucide-react-native/icons/x';
import { amountInput, parseAmount } from '@/lib/amount';
import { useTags } from '@/lib/queries';
import { addToDraft, deleteDraft, useDrafts, DraftLimitError, isSendable, MAX_DRAFT_FILES, moveInDraft, removeFromDraft, rotatePhoto, updateDraft, useDraft, type DraftFile, type IncomingSource } from '@/lib/drafts';
import { bytes, plural } from '@/lib/format';
import { useSignedIn } from '@/lib/auth';
import { submitDraft } from '@/lib/sender';
import { radius, usePalette } from '@/theme';
import { Banner, Button, Card, Field, IconButton, Row, Screen, Section, T } from '@/ui/kit';
import { OfflineBanner, useOnline } from '@/ui/parts';

export default function DraftScreen() {
  const p = usePalette();
  const { id, shared } = useLocalSearchParams<{ id: string; shared?: string }>();
  const session = useSignedIn();
  const draft = useDraft(id);
  const online = useOnline();
  const [busy, setBusy] = useState<string | null>(null);
  const [preview, setPreview] = useState<DraftFile | null>(null);

  if (!draft) {
    return (
      <Screen>
        <Banner tone="neutral" title="This draft is no longer on this phone" />
        <Button label="Back to captures" kind="secondary" onPress={() => router.replace('/capture')} />
      </Screen>
    );
  }

  const locked = draft.status === 'sending' || draft.status === 'queued' || draft.status === 'submitted';
  const remaining = MAX_DRAFT_FILES - draft.files.length;

  const add = async (label: string, pick: () => Promise<IncomingSource[] | null>) => {
    try {
      const sources = await pick();
      if (!sources || sources.length === 0) return;
      setBusy(label);
      await addToDraft(draft.id, sources);
      void Haptics.selectionAsync();
    } catch (err) {
      Alert.alert('Not added', err instanceof DraftLimitError ? err.message : 'That could not be added. Try again.');
    } finally {
      setBusy(null);
    }
  };

  const fromCamera = () =>
    add('camera', async () => {
      const perm = await ImagePicker.requestCameraPermissionsAsync();
      if (!perm.granted) {
        Alert.alert('Camera access is off', 'Allow Zephric to use the camera in your phone’s settings to photograph documents.', [
          { text: 'Not now', style: 'cancel' },
          { text: 'Open settings', onPress: () => void Linking.openSettings() },
        ]);
        return null;
      }
      const r = await ImagePicker.launchCameraAsync({ mediaTypes: ['images'], quality: 0.9, exif: false });
      return r.canceled ? null : r.assets.map((a) => ({ uri: a.uri, name: a.fileName, mimeType: a.mimeType ?? 'image/jpeg', fromCamera: true }));
    });

  const fromPhotos = () =>
    add('photos', async () => {
      const r = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], allowsMultipleSelection: true, selectionLimit: remaining, orderedSelection: true, quality: 0.9, exif: false });
      return r.canceled ? null : r.assets.map((a) => ({ uri: a.uri, name: a.fileName, mimeType: a.mimeType ?? 'image/jpeg' }));
    });

  const fromFiles = () =>
    add('files', async () => {
      const r = await DocumentPicker.getDocumentAsync({ type: ['application/pdf', 'image/*'], multiple: true, copyToCacheDirectory: true });
      return r.canceled ? null : r.assets.map((a) => ({ uri: a.uri, name: a.name, mimeType: a.mimeType ?? null, size: a.size ?? null }));
    });

  // No "send without a subcontract?" question: Zephric matches it from the
  // documents, and choosing the job stays available below for those who know it.
  const submit = () => submitDraft(draft.id);

  const remove = () =>
    Alert.alert('Delete this draft?', 'Its photos and files are removed from this phone. Anything already received by Zephric stays there.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete',
        style: 'destructive',
        onPress: () => {
          deleteDraft(draft.id);
          router.back();
        },
      },
    ]);

  return (
    <>
      <Stack.Screen options={{ title: draft.title.trim() || 'Send a bill', headerRight: () => (draft.status !== 'sending' ? <IconButton icon={Trash2} label="Delete draft" onPress={remove} /> : null) }} />
      <Screen>
        <OfflineBanner />

        {shared === '1' && draft.status === 'draft' ? (
          <Banner tone="neutral" icon={FileUp} title="Added from another app">
            {`This capture is for ${session.profile.orgName ?? 'your organisation'}. Check the files, choose the subcontract, and press Send when it is ready.`}
          </Banner>
        ) : null}

        {draft.status === 'submitted' ? (
          <Banner tone="pass" icon={CircleCheck} title="Sent – Zephric has it" action={draft.applicationId ? <Button label="Open" size="sm" kind="secondary" onPress={() => router.replace(`/application/${draft.applicationId}`)} /> : undefined}>
            You can find it any time under My uploads.
          </Banner>
        ) : null}
        {draft.status === 'failed' ? (
          <Banner tone="block" title="Not sent">
            {draft.error ?? 'This could not be sent.'} Your files are still here. Change anything you need, then send again.
          </Banner>
        ) : null}
        {draft.status === 'queued' || draft.status === 'sending' ? <Progress progress={draft.progress} status={draft.status} note={draft.error} /> : null}

        <Section title={draft.files.length ? `Photos and files · ${draft.files.length}` : 'Photos and files'}>
          {draft.files.length > 0 ? (
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10 }}>
              {draft.files.map((f, i) => (
                <Thumb
                  key={f.id}
                  f={f}
                  locked={locked}
                  first={i === 0}
                  last={i === draft.files.length - 1}
                  busy={busy === f.id}
                  onOpen={() => setPreview(f)}
                  onRotate={async () => {
                    setBusy(f.id);
                    try {
                      await rotatePhoto(draft.id, f.id);
                    } finally {
                      setBusy(null);
                    }
                  }}
                  onMove={(by) => moveInDraft(draft.id, f.id, by)}
                  onRemove={() =>
                    Alert.alert(`Remove ${f.name}?`, undefined, [
                      { text: 'Cancel', style: 'cancel' },
                      { text: 'Remove', style: 'destructive', onPress: () => removeFromDraft(draft.id, f.id) },
                    ])
                  }
                />
              ))}
            </View>
          ) : (
            <Card>
              <T v="caption" tone="ink2">
                Take a photo of the receipt or bill. Several pages? Take one photo per page, in order
              </T>
            </Card>
          )}
        </Section>

        {!locked ? (
          <View style={{ flexDirection: 'row', gap: 10 }}>
            <AddButton icon={Camera} label="Camera" onPress={fromCamera} busy={busy === 'camera'} disabled={remaining <= 0} />
            <AddButton icon={Images} label="Photos" onPress={fromPhotos} busy={busy === 'photos'} disabled={remaining <= 0} />
            <AddButton icon={FolderOpen} label="Files" onPress={fromFiles} busy={busy === 'files'} disabled={remaining <= 0} />
          </View>
        ) : null}


        <Field label="Name" value={draft.title} onChangeText={(title) => updateDraft(draft.id, { title })} placeholder="For example, Concrete for level 2" editable={!locked} maxLength={120} />

        <AmountField draftId={draft.id} cents={draft.amountCents} locked={locked} />

        <Field
          label="Description (optional)"
          value={draft.description}
          onChangeText={(description) => updateDraft(draft.id, { description })}
          placeholder="What it is for, who it is from"
          editable={!locked}
          maxLength={1000}
          multiline
          style={{ minHeight: 88 }}
        />

        <TagPicker draftId={draft.id} tags={draft.tags} locked={locked} />

        <Section title="Which job is it for? (optional)">
          <Card padded={false}>
            <Row
              title={draft.contract ? draft.contract.label.split(' · ')[0]! : 'Let Zephric work it out'}
              subtitle={draft.contract ? `${draft.contract.group} · ${draft.contract.label.split(' · ').slice(1).join(' · ')}` : 'Or choose the subcontract yourself'}
              onPress={locked ? undefined : () => router.push(`/pick-contract/${draft.id}`)}
            />
          </Card>
        </Section>

        {draft.status !== 'submitted' ? (
          <View style={{ gap: 8 }}>
            <Button
              label={draft.status === 'failed' ? 'Send again' : draft.status === 'queued' || draft.status === 'sending' ? 'Sending…' : 'Send'}
              icon={Send}
              size="lg"
              onPress={submit}
              disabled={!isSendable(draft) || draft.status === 'queued' || draft.status === 'sending'}
            />
            <T v="caption" tone="ink3" style={{ textAlign: 'center' }}>
              {draft.files.length === 0
                ? 'Add a photo or file first'
                : !online
                  ? 'No internet right now. It will send by itself when you are back online'
                  : `${plural(draft.files.length, 'file')} · ${bytes(draft.files.reduce((n, f) => n + f.size, 0))}`}
            </T>
          </View>
        ) : null}
      </Screen>
      <PreviewModal file={preview} onClose={() => setPreview(null)} />
    </>
  );
}

function Progress({ progress, status, note }: { progress: number; status: 'queued' | 'sending'; note: string | null }) {
  const p = usePalette();
  return (
    <Card style={{ gap: 10 }}>
      {/* A one-photo capture is a single piece, so a percentage would sit at 0% until it is done: say so plainly instead. */}
      <T v="label">{status === 'sending' ? (progress > 0 ? `Sending… ${Math.round(progress * 100)}%` : 'Sending…') : 'Waiting to send'}</T>
      <View style={{ height: 6, borderRadius: 3, backgroundColor: p.sunken, overflow: 'hidden' }}>
        <View style={{ width: `${Math.max(4, Math.round(progress * 100))}%`, height: 6, backgroundColor: p.accent }} />
      </View>
      <T v="caption" tone="ink3">
        {note ?? 'Safe on this phone until Zephric has it. You can leave this screen. Find it later under My uploads.'}
      </T>
    </Card>
  );
}

function AddButton({ icon: Icon, label, onPress, busy, disabled }: { icon: typeof Camera; label: string; onPress: () => void; busy: boolean; disabled: boolean }) {
  const p = usePalette();
  return (
    <Pressable
      onPress={onPress}
      disabled={busy || disabled}
      accessibilityRole="button"
      accessibilityLabel={`Add from ${label}`}
      style={({ pressed }) => ({
        flex: 1,
        height: 76,
        borderRadius: radius.lg,
        borderWidth: StyleSheet.hairlineWidth * 2,
        borderColor: p.lineStrong,
        borderStyle: 'dashed',
        backgroundColor: pressed ? p.sunken : p.surface,
        alignItems: 'center',
        justifyContent: 'center',
        gap: 6,
        opacity: disabled ? 0.5 : 1,
      })}
    >
      <Icon size={22} color={busy ? p.ink4 : p.accentText} />
      <T v="caption" tone="ink2" style={{ fontWeight: '600' }}>
        {busy ? 'Adding…' : label}
      </T>
    </Pressable>
  );
}

function Thumb({ f, locked, first, last, busy, onOpen, onRotate, onMove, onRemove }: { f: DraftFile; locked: boolean; first: boolean; last: boolean; busy: boolean; onOpen: () => void; onRotate: () => void; onMove: (by: -1 | 1) => void; onRemove: () => void }) {
  const p = usePalette();
  const isPhoto = f.kind === 'photo' || f.kind === 'image';
  return (
    <View style={{ width: '31%', gap: 6 }}>
      <Pressable onPress={onOpen} accessibilityRole="imagebutton" accessibilityLabel={`Preview ${f.name}`} style={{ aspectRatio: 0.77, borderRadius: radius.md, overflow: 'hidden', backgroundColor: p.sunken, borderWidth: StyleSheet.hairlineWidth, borderColor: p.line, alignItems: 'center', justifyContent: 'center', opacity: busy ? 0.5 : 1 }}>
        {isPhoto ? <Image source={{ uri: f.path }} style={{ width: '100%', height: '100%' }} resizeMode="cover" /> : <FileText size={30} color={p.ink3} />}
      </Pressable>
      <T v="caption" tone="ink2" numberOfLines={1}>
        {f.name}
      </T>
      {!locked ? (
        <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
          {f.kind === 'photo' ? <SmallIcon icon={RotateCw} label="Rotate" onPress={onRotate} /> : <View style={{ width: 28 }} />}
          <SmallIcon icon={ArrowLeft} label="Move earlier" onPress={() => onMove(-1)} disabled={first} />
          <SmallIcon icon={ArrowRight} label="Move later" onPress={() => onMove(1)} disabled={last} />
          <SmallIcon icon={X} label="Remove" onPress={onRemove} tone={p.block} />
        </View>
      ) : null}
    </View>
  );
}

function SmallIcon({ icon: Icon, label, onPress, disabled, tone }: { icon: typeof X; label: string; onPress: () => void; disabled?: boolean; tone?: string }) {
  const p = usePalette();
  return (
    <Pressable onPress={onPress} disabled={disabled} hitSlop={6} accessibilityRole="button" accessibilityLabel={label} style={{ width: 28, height: 28, alignItems: 'center', justifyContent: 'center', opacity: disabled ? 0.3 : 1 }}>
      <Icon size={16} color={tone ?? p.ink2} />
    </Pressable>
  );
}

function PreviewModal({ file, onClose }: { file: DraftFile | null; onClose: () => void }) {
  const insets = useSafeAreaInsets();
  const isPhoto = file && (file.kind === 'photo' || file.kind === 'image');
  return (
    <Modal visible={!!file} animationType="fade" onRequestClose={onClose} transparent={false}>
      <View style={{ flex: 1, backgroundColor: '#0c0c0e' }}>
        {file && isPhoto ? <Image source={{ uri: file.path }} style={{ flex: 1 }} resizeMode="contain" /> : null}
        {file && !isPhoto ? (
          <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', gap: 10, padding: 24 }}>
            <FileText size={40} color="#a1a1aa" strokeWidth={1.5} />
            <T v="heading" style={{ color: '#ffffff', textAlign: 'center' }}>
              {file.name}
            </T>
            <T v="caption" style={{ color: '#a1a1aa' }}>
              {bytes(file.size)} · sent exactly as it is
            </T>
          </View>
        ) : null}
        <View style={{ position: 'absolute', top: insets.top + 8, right: 12 }}>
          <IconButton icon={X} label="Close preview" onPress={onClose} tone="#ffffff" />
        </View>
      </View>
    </Modal>
  );
}

/** The amount on the receipt, typed as the person reads it: "12,400.50", "$85", "85". */
function AmountField({ draftId, cents, locked }: { draftId: string; cents: number | null; locked: boolean }) {
  const p = usePalette();
  const [text, setText] = useState(() => amountInput(cents));
  const parsed = parseAmount(text);
  const invalid = parsed === 'invalid';
  return (
    <View style={{ gap: 6 }}>
      <T v="label" tone="ink2">
        Amount (optional)
      </T>
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          minHeight: 56,
          borderRadius: radius.md,
          borderWidth: 1,
          borderColor: invalid ? p.block : p.lineStrong,
          backgroundColor: p.surface,
          paddingHorizontal: 14,
          gap: 6,
        }}
      >
        <T v="title" tone="ink3">
          $
        </T>
        <TextInput
          value={text}
          onChangeText={(t) => {
            setText(t);
            const v = parseAmount(t);
            if (v !== 'invalid') updateDraft(draftId, { amountCents: v });
          }}
          editable={!locked}
          keyboardType="decimal-pad"
          placeholder="0.00"
          placeholderTextColor={p.ink4}
          accessibilityLabel="Amount on the receipt"
          style={{ flex: 1, fontSize: 24, fontWeight: '600', color: p.ink, paddingVertical: 10, fontVariant: ['tabular-nums'] }}
        />
      </View>
      <T v="caption" tone={invalid ? 'block' : 'ink3'}>
        {invalid ? 'Type the amount in numbers, like 1250.50' : 'The total on the receipt. Helps you find it later'}
      </T>
    </View>
  );
}

/**
 * Tags: the company's own, most used first, as big buttons to tap, and a box
 * to add a new one. Picking from what is there keeps tags consistent without
 * anyone having to set up a list.
 */
function TagPicker({ draftId, tags, locked }: { draftId: string; tags: string[]; locked: boolean }) {
  const p = usePalette();
  const session = useSignedIn();
  const owner = session.profile.orgId ? { userId: session.profile.userId, orgId: session.profile.orgId } : null;
  const company = useTags();
  const drafts = useDrafts(owner);
  const [typing, setTyping] = useState('');

  // Chosen tags first, then the company's most used, then ones used on this phone.
  const choices = useMemo(() => {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const t of [...tags, ...(company.data ?? []).map((c) => c.tag), ...drafts.flatMap((d) => d.tags ?? [])]) {
      const key = t.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(t);
    }
    return out.slice(0, 16);
  }, [tags, company.data, drafts]);

  const has = (t: string) => tags.some((x) => x.toLowerCase() === t.toLowerCase());
  const toggle = (t: string) => updateDraft(draftId, { tags: has(t) ? tags.filter((x) => x.toLowerCase() !== t.toLowerCase()) : [...tags, t].slice(0, 12) });
  const addTyped = () => {
    const t = typing.replace(/\s+/g, ' ').trim().slice(0, 40);
    if (t && !has(t)) updateDraft(draftId, { tags: [...tags, t].slice(0, 12) });
    setTyping('');
  };

  return (
    <View style={{ gap: 8 }}>
      <T v="label" tone="ink2">
        Tags (optional)
      </T>
      {choices.length > 0 ? (
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
          {choices.map((t) => {
            const on = has(t);
            return (
              <Pressable
                key={t}
                disabled={locked}
                onPress={() => toggle(t)}
                accessibilityRole="button"
                accessibilityState={{ selected: on }}
                accessibilityLabel={`Tag ${t}`}
                style={({ pressed }) => ({
                  minHeight: 44,
                  paddingHorizontal: 16,
                  borderRadius: radius.md,
                  borderWidth: 1,
                  borderColor: on ? p.ink : p.lineStrong,
                  backgroundColor: on ? p.ink : pressed ? p.sunken : p.surface,
                  justifyContent: 'center',
                })}
              >
                <T v="label" style={{ color: on ? p.canvas : p.ink }}>
                  {t}
                </T>
              </Pressable>
            );
          })}
        </View>
      ) : null}
      {!locked ? (
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <TextInput
            value={typing}
            onChangeText={setTyping}
            onSubmitEditing={addTyped}
            returnKeyType="done"
            placeholder={choices.length > 0 ? 'Add another tag' : 'Add a tag, like Concrete or Site 2'}
            placeholderTextColor={p.ink4}
            accessibilityLabel="Add a tag"
            maxLength={40}
            style={{ flex: 1, minHeight: 48, borderRadius: radius.md, borderWidth: 1, borderColor: p.lineStrong, backgroundColor: p.surface, paddingHorizontal: 14, fontSize: 16, color: p.ink }}
          />
          <Pressable
            onPress={addTyped}
            disabled={!typing.trim()}
            accessibilityRole="button"
            accessibilityLabel="Add this tag"
            style={({ pressed }) => ({ width: 48, height: 48, borderRadius: radius.md, alignItems: 'center', justifyContent: 'center', backgroundColor: pressed ? p.sunken : p.surface, borderWidth: 1, borderColor: p.lineStrong, opacity: typing.trim() ? 1 : 0.5 })}
          >
            <Plus size={20} color={p.ink2} strokeWidth={1.75} />
          </Pressable>
        </View>
      ) : null}
    </View>
  );
}
