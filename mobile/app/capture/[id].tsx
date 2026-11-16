import * as DocumentPicker from 'expo-document-picker';
import * as Haptics from 'expo-haptics';
import * as ImagePicker from 'expo-image-picker';
import { router, Stack, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { Alert, Image, Linking, Modal, Pressable, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import ArrowLeft from 'lucide-react-native/icons/arrow-left';
import ArrowRight from 'lucide-react-native/icons/arrow-right';
import Camera from 'lucide-react-native/icons/camera';
import CircleCheck from 'lucide-react-native/icons/circle-check';
import FileText from 'lucide-react-native/icons/file-text';
import FileUp from 'lucide-react-native/icons/file-up';
import FolderOpen from 'lucide-react-native/icons/folder-open';
import Images from 'lucide-react-native/icons/images';
import RotateCw from 'lucide-react-native/icons/rotate-cw';
import Send from 'lucide-react-native/icons/send';
import Trash2 from 'lucide-react-native/icons/trash';
import X from 'lucide-react-native/icons/x';
import { addToDraft, deleteDraft, DraftLimitError, isSendable, MAX_DRAFT_FILES, moveInDraft, removeFromDraft, rotatePhoto, updateDraft, useDraft, type DraftFile, type IncomingSource } from '@/lib/drafts';
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

  const submit = () => {
    if (!draft.contract) {
      Alert.alert('Send without a subcontract?', 'Zephric will try to match it from the documents. If it cannot, a reviewer matches it by hand.', [
        { text: 'Choose one', onPress: () => router.push(`/pick-contract/${draft.id}`) },
        { text: 'Send', onPress: () => submitDraft(draft.id) },
      ]);
      return;
    }
    submitDraft(draft.id);
  };

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
      <Stack.Screen options={{ title: draft.title.trim() || 'New capture', headerRight: () => (draft.status !== 'sending' ? <IconButton icon={Trash2} label="Delete draft" onPress={remove} /> : null) }} />
      <Screen>
        <OfflineBanner />

        {shared === '1' && draft.status === 'draft' ? (
          <Banner tone="neutral" icon={FileUp} title="Added from another app">
            {`This capture is for ${session.profile.orgName ?? 'your organisation'}. Check the files, choose the subcontract, and press Send when it is ready.`}
          </Banner>
        ) : null}

        {draft.status === 'submitted' ? (
          <Banner tone="pass" icon={CircleCheck} title="Received by Zephric" action={draft.applicationId ? <Button label="View application" size="sm" kind="secondary" onPress={() => router.replace(`/application/${draft.applicationId}`)} /> : undefined}>
            Zephric confirmed it has this submission and is reading it now. The copies on this phone have been removed.
          </Banner>
        ) : null}
        {draft.status === 'failed' ? (
          <Banner tone="block" title="Not sent">
            {draft.error ?? 'This could not be sent.'} Your files are still here. Change anything you need, then send again.
          </Banner>
        ) : null}
        {draft.status === 'queued' || draft.status === 'sending' ? <Progress progress={draft.progress} status={draft.status} note={draft.error} /> : null}

        <Field label="Name (optional)" value={draft.title} onChangeText={(title) => updateDraft(draft.id, { title })} placeholder="For example, Lone Star Electric pay app 4" editable={!locked} maxLength={120} />

        <Section title="Subcontract">
          <Card padded={false}>
            <Row
              title={draft.contract ? draft.contract.label.split(' · ')[0]! : 'Let Zephric match it'}
              subtitle={draft.contract ? `${draft.contract.group} · ${draft.contract.label.split(' · ').slice(1).join(' · ')}` : 'Or choose the subcontract this billing is for'}
              onPress={locked ? undefined : () => router.push(`/pick-contract/${draft.id}`)}
            />
          </Card>
        </Section>

        <Section title={draft.files.length ? `Pages and files · ${draft.files.length}` : 'Pages and files'}>
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
                Photograph each page in order, flat and well lit. Photos of one document are joined into a single PDF when sent. PDFs are sent as they are.
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

        {draft.status !== 'submitted' ? (
          <View style={{ gap: 8 }}>
            <Button
              label={draft.status === 'failed' ? 'Send again' : draft.status === 'queued' || draft.status === 'sending' ? 'Sending…' : 'Send to Zephric'}
              icon={Send}
              size="lg"
              onPress={submit}
              disabled={!isSendable(draft) || draft.status === 'queued' || draft.status === 'sending'}
            />
            <T v="caption" tone="ink3" style={{ textAlign: 'center' }}>
              {draft.files.length === 0
                ? 'Add at least one page or file.'
                : !online
                  ? 'You are offline. It will send when you are back online.'
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
      <T v="label">{status === 'sending' ? `Sending… ${Math.round(progress * 100)}%` : 'Waiting to send'}</T>
      <View style={{ height: 6, borderRadius: 3, backgroundColor: p.sunken, overflow: 'hidden' }}>
        <View style={{ width: `${Math.max(4, Math.round(progress * 100))}%`, height: 6, backgroundColor: p.accent }} />
      </View>
      <T v="caption" tone="ink3">
        {note ?? 'Kept on this phone until Zephric confirms it has it. You can leave this screen.'}
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
      <View style={{ flex: 1, backgroundColor: '#05080f' }}>
        {file && isPhoto ? <Image source={{ uri: file.path }} style={{ flex: 1 }} resizeMode="contain" /> : null}
        {file && !isPhoto ? (
          <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', gap: 10, padding: 24 }}>
            <FileText size={40} color="#a9b4c8" />
            <T v="heading" style={{ color: '#ffffff', textAlign: 'center' }}>
              {file.name}
            </T>
            <T v="caption" style={{ color: '#a9b4c8' }}>
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
