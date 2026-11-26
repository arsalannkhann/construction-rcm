/** The app's building blocks, drawn from the website's design language. */
import { type ComponentType, type ReactNode } from 'react';
import {
  ActivityIndicator,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  type PressableProps,
  type StyleProp,
  type TextInputProps,
  type TextStyle,
  type ViewStyle,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Svg, { Path } from 'react-native-svg';
import ChevronRight from 'lucide-react-native/icons/chevron-right';
import { radius, usePalette, type Palette } from '@/theme';
import type { AppStatus } from '@/lib/api';

export type IconType = ComponentType<{ size?: number; color?: string; strokeWidth?: number }>;

// ── Text ────────────────────────────────────────────────────────────────────

type Variant = 'display' | 'title' | 'heading' | 'body' | 'label' | 'caption' | 'eyebrow' | 'amount' | 'amountLarge';

// Weights stay at 400–600 and hierarchy comes from size and colour. Sizes lean
// large: many people using this are not used to reading dense software.
// Tight tracking only on the large display sizes, never on small text.
const variants: Record<Variant, TextStyle> = {
  display: { fontSize: 30, lineHeight: 36, fontWeight: '600', letterSpacing: -0.4 },
  title: { fontSize: 24, lineHeight: 30, fontWeight: '600', letterSpacing: -0.2 },
  heading: { fontSize: 17, lineHeight: 24, fontWeight: '600' },
  body: { fontSize: 16, lineHeight: 22 },
  label: { fontSize: 15, lineHeight: 20, fontWeight: '500' },
  caption: { fontSize: 14, lineHeight: 19 },
  /** Section labels: sentence case, a quiet step above the content. */
  eyebrow: { fontSize: 14, lineHeight: 19, fontWeight: '500' },
  amount: { fontSize: 16, lineHeight: 22, fontWeight: '600', fontVariant: ['tabular-nums'] },
  amountLarge: { fontSize: 28, lineHeight: 34, fontWeight: '600', letterSpacing: -0.3, fontVariant: ['tabular-nums'] },
};

type Tone = 'ink' | 'ink2' | 'ink3' | 'accent' | 'pass' | 'warn' | 'block' | 'onAccent' | 'aqua';

function toneColor(p: Palette, tone: Tone): string {
  switch (tone) {
    case 'ink':
      return p.ink;
    case 'ink2':
      return p.ink2;
    case 'ink3':
      return p.ink3;
    case 'accent':
      return p.accentText;
    case 'aqua':
      return p.aquaText;
    case 'pass':
      return p.pass;
    case 'warn':
      return p.warn;
    case 'block':
      return p.block;
    case 'onAccent':
      return '#ffffff';
  }
}

export function T({
  children,
  v = 'body',
  tone = 'ink',
  style,
  numberOfLines,
  selectable,
  accessibilityRole,
}: {
  children: ReactNode;
  v?: Variant;
  tone?: Tone;
  style?: StyleProp<TextStyle>;
  numberOfLines?: number;
  selectable?: boolean;
  accessibilityRole?: 'header' | 'text';
}) {
  const p = usePalette();
  return (
    <Text style={[variants[v], { color: toneColor(p, tone) }, style]} numberOfLines={numberOfLines} selectable={selectable} accessibilityRole={accessibilityRole} maxFontSizeMultiplier={1.6}>
      {children}
    </Text>
  );
}

// ── Layout ──────────────────────────────────────────────────────────────────

export function Screen({
  children,
  scroll = true,
  refreshing,
  onRefresh,
  padded = true,
  contentStyle,
}: {
  children: ReactNode;
  scroll?: boolean;
  refreshing?: boolean;
  onRefresh?: () => void;
  padded?: boolean;
  contentStyle?: StyleProp<ViewStyle>;
}) {
  const p = usePalette();
  const insets = useSafeAreaInsets();
  const pad: ViewStyle = padded ? { paddingHorizontal: 16, paddingTop: 12, paddingBottom: insets.bottom + 32 } : {};
  if (!scroll) return <View style={[{ flex: 1, backgroundColor: p.canvas }, pad, contentStyle]}>{children}</View>;
  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: p.canvas }}
      contentContainerStyle={[pad, { gap: 16 }, contentStyle]}
      keyboardShouldPersistTaps="handled"
      contentInsetAdjustmentBehavior="automatic"
      refreshControl={onRefresh ? <RefreshControl refreshing={!!refreshing} onRefresh={onRefresh} tintColor={p.ink3} colors={[p.accent]} /> : undefined}
    >
      {children}
    </ScrollView>
  );
}

export function Card({ children, style, padded = true }: { children: ReactNode; style?: StyleProp<ViewStyle>; padded?: boolean }) {
  const p = usePalette();
  return (
    <View
      style={[
        {
          backgroundColor: p.surface,
          borderRadius: radius.lg,
          borderWidth: StyleSheet.hairlineWidth,
          borderColor: p.line,
          ...(padded ? { padding: 16 } : {}),
        },
        p.scheme === 'light' ? styles.shadow : null,
        style,
      ]}
    >
      {children}
    </View>
  );
}

export function Section({ title, action, children }: { title: string; action?: ReactNode; children: ReactNode }) {
  return (
    <View style={{ gap: 8 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 4 }}>
        <T v="eyebrow" tone="ink3">
          {title}
        </T>
        {action}
      </View>
      {children}
    </View>
  );
}

export function Divider({ inset = 0 }: { inset?: number }) {
  const p = usePalette();
  return <View style={{ height: StyleSheet.hairlineWidth, backgroundColor: p.line, marginLeft: inset }} />;
}

/** A tappable row inside a Card list. */
export function Row({
  title,
  subtitle,
  meta,
  right,
  left,
  onPress,
  chevron = true,
  accessibilityLabel,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  meta?: ReactNode;
  right?: ReactNode;
  left?: ReactNode;
  onPress?: () => void;
  chevron?: boolean;
  accessibilityLabel?: string;
}) {
  const p = usePalette();
  return (
    <Pressable
      onPress={onPress}
      disabled={!onPress}
      accessibilityRole={onPress ? 'button' : undefined}
      accessibilityLabel={accessibilityLabel}
      style={({ pressed }) => [{ flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 13, paddingHorizontal: 16, minHeight: 56 }, pressed && { backgroundColor: p.sunken }]}
    >
      {left}
      <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
        {typeof title === 'string' ? (
          <T v="label" numberOfLines={1}>
            {title}
          </T>
        ) : (
          title
        )}
        {subtitle ? (
          typeof subtitle === 'string' ? (
            <T v="caption" tone="ink3" numberOfLines={1}>
              {subtitle}
            </T>
          ) : (
            subtitle
          )
        ) : null}
        {meta}
      </View>
      {right}
      {onPress && chevron ? <ChevronRight size={18} color={p.ink4} /> : null}
    </Pressable>
  );
}

// ── Controls ────────────────────────────────────────────────────────────────

type ButtonKind = 'primary' | 'secondary' | 'ghost' | 'danger' | 'approve';

export function Button({
  label,
  onPress,
  kind = 'primary',
  icon: Icon,
  loading,
  disabled,
  style,
  size = 'md',
  accessibilityHint,
}: {
  label: string;
  onPress?: () => void;
  kind?: ButtonKind;
  icon?: IconType;
  loading?: boolean;
  disabled?: boolean;
  style?: StyleProp<ViewStyle>;
  size?: 'md' | 'lg' | 'sm';
  accessibilityHint?: string;
}) {
  const p = usePalette();
  const fills: Record<ButtonKind, { bg: string; fg: string; border: string }> = {
    primary: { bg: p.scheme === 'dark' ? p.accent : p.ink, fg: '#ffffff', border: 'transparent' },
    approve: { bg: '#15803d', fg: '#ffffff', border: 'transparent' },
    secondary: { bg: p.surface, fg: p.ink, border: p.lineStrong },
    ghost: { bg: 'transparent', fg: p.accentText, border: 'transparent' },
    danger: { bg: p.blockSoft, fg: p.block, border: 'transparent' },
  };
  const f = fills[kind];
  // Large touch targets: many people using this are on a site, with gloves or in a hurry.
  const height = size === 'lg' ? 56 : size === 'sm' ? 40 : 48;
  const off = disabled || loading;
  return (
    <Pressable
      onPress={onPress}
      disabled={off}
      accessibilityRole="button"
      // The label must be explicit. Without it React Native on Android sets the
      // description to "busy" while loading and never clears it, so the button
      // is read out as "busy" after every failed attempt.
      accessibilityLabel={label}
      accessibilityState={{ disabled: !!off, busy: !!loading }}
      accessibilityHint={accessibilityHint}
      style={({ pressed }) => [
        {
          height,
          borderRadius: radius.md,
          backgroundColor: f.bg,
          borderWidth: kind === 'secondary' ? StyleSheet.hairlineWidth * 2 : 0,
          borderColor: f.border,
          paddingHorizontal: size === 'sm' ? 14 : 20,
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 8,
          opacity: off ? 0.5 : 1,
          transform: [{ scale: pressed && !off ? 0.98 : 1 }],
        },
        style,
      ]}
    >
      {loading ? <ActivityIndicator size="small" color={f.fg} /> : Icon ? <Icon size={18} color={f.fg} strokeWidth={1.75} /> : null}
      <Text style={{ color: f.fg, fontSize: size === 'sm' ? 15 : 16, fontWeight: '600' }} maxFontSizeMultiplier={1.4}>
        {label}
      </Text>
    </Pressable>
  );
}

export function Field({ label, hint, error, ...props }: TextInputProps & { label: string; hint?: string; error?: string | null }) {
  const p = usePalette();
  return (
    <View style={{ gap: 6 }}>
      <T v="label" tone="ink2">
        {label}
      </T>
      <TextInput
        placeholderTextColor={p.ink4}
        {...props}
        style={[
          {
            minHeight: 48,
            borderRadius: radius.md,
            borderWidth: 1,
            borderColor: error ? p.block : p.lineStrong,
            backgroundColor: p.surface,
            paddingHorizontal: 14,
            paddingVertical: 12,
            fontSize: 16,
            color: p.ink,
          },
          props.multiline ? { minHeight: 120, textAlignVertical: 'top' } : null,
          props.style,
        ]}
        accessibilityLabel={label}
      />
      {error ? (
        <T v="caption" tone="block">
          {error}
        </T>
      ) : hint ? (
        <T v="caption" tone="ink3">
          {hint}
        </T>
      ) : null}
    </View>
  );
}

export function Segmented<V extends string>({ value, options, onChange }: { value: V; options: Array<{ value: V; label: string }>; onChange: (v: V) => void }) {
  const p = usePalette();
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8 }}>
      {options.map((o) => {
        const on = o.value === value;
        return (
          <Pressable
            key={o.value}
            onPress={() => onChange(o.value)}
            accessibilityRole="tab"
            accessibilityState={{ selected: on }}
            style={{
              height: 40,
              paddingHorizontal: 16,
              borderRadius: radius.md,
              justifyContent: 'center',
              backgroundColor: on ? p.ink : p.surface,
              borderWidth: 1,
              borderColor: on ? p.ink : p.lineStrong,
            }}
          >
            <Text style={{ color: on ? p.canvas : p.ink, fontSize: 15, fontWeight: '500' }}>{o.label}</Text>
          </Pressable>
        );
      })}
    </ScrollView>
  );
}

export function IconButton({ icon: Icon, onPress, label, tone }: { icon: IconType; onPress: () => void; label: string; tone?: string }) {
  const p = usePalette();
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
      hitSlop={8}
      style={({ pressed }) => ({ width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center', backgroundColor: pressed ? p.sunken : 'transparent' })}
    >
      <Icon size={20} color={tone ?? p.ink2} strokeWidth={1.75} />
    </Pressable>
  );
}

// ── Status and feedback ─────────────────────────────────────────────────────

export function statusTone(status: AppStatus): 'neutral' | 'accent' | 'aqua' | 'warn' | 'pass' | 'block' {
  switch (status) {
    case 'pending_approval':
      return 'aqua';
    case 'needs_review':
      return 'accent';
    case 'needs_matching':
    case 'on_hold':
      return 'warn';
    case 'approved':
      return 'pass';
    case 'rejected':
      return 'block';
    default:
      return 'neutral';
  }
}

export function Pill({ label, tone = 'neutral' }: { label: string; tone?: 'neutral' | 'accent' | 'aqua' | 'warn' | 'pass' | 'block' }) {
  const p = usePalette();
  const map = {
    neutral: [p.sunken, p.ink2],
    accent: [p.accentSoft, p.accentText],
    aqua: [p.aquaSoft, p.aquaText],
    warn: [p.warnSoft, p.warn],
    pass: [p.passSoft, p.pass],
    block: [p.blockSoft, p.block],
  } as const;
  const [bg, fg] = map[tone];
  return (
    <View style={{ backgroundColor: bg, borderRadius: 6, paddingHorizontal: 8, paddingVertical: 2, alignSelf: 'flex-start' }}>
      <Text style={{ color: fg, fontSize: 13, fontWeight: '500' }} maxFontSizeMultiplier={1.3}>
        {label}
      </Text>
    </View>
  );
}

export function Banner({ tone = 'neutral', icon: Icon, title, children, action }: { tone?: 'neutral' | 'warn' | 'block' | 'pass' | 'accent'; icon?: IconType; title?: string; children?: ReactNode; action?: ReactNode }) {
  const p = usePalette();
  const map = { neutral: [p.sunken, p.ink2], warn: [p.warnSoft, p.warn], block: [p.blockSoft, p.block], pass: [p.passSoft, p.pass], accent: [p.accentSoft, p.accentText] } as const;
  const [bg, fg] = map[tone];
  return (
    <View style={{ backgroundColor: bg, borderRadius: radius.md, padding: 16, flexDirection: 'row', gap: 12 }} accessibilityRole="summary">
      {Icon ? <Icon size={20} color={fg} strokeWidth={1.75} /> : null}
      <View style={{ flex: 1, gap: 2 }}>
        {title ? <Text style={{ color: fg, fontSize: 16, lineHeight: 22, fontWeight: '600' }}>{title}</Text> : null}
        {children ? <Text style={{ color: p.ink2, fontSize: 15, lineHeight: 21 }}>{children}</Text> : null}
        {action ? <View style={{ marginTop: 8, alignItems: 'flex-start' }}>{action}</View> : null}
      </View>
    </View>
  );
}

export function Empty({ icon: Icon, title, children, action }: { icon?: IconType; title: string; children?: ReactNode; action?: ReactNode }) {
  const p = usePalette();
  return (
    <View style={{ alignItems: 'center', paddingVertical: 36, paddingHorizontal: 24, gap: 8 }}>
      {Icon ? (
        <View style={{ width: 48, height: 48, borderRadius: 24, backgroundColor: p.sunken, alignItems: 'center', justifyContent: 'center', marginBottom: 4 }}>
          <Icon size={22} color={p.ink3} strokeWidth={1.75} />
        </View>
      ) : null}
      <T v="heading" style={{ textAlign: 'center' }}>
        {title}
      </T>
      {children ? (
        <T v="caption" tone="ink3" style={{ textAlign: 'center', maxWidth: 300 }}>
          {children}
        </T>
      ) : null}
      {action ? <View style={{ marginTop: 8 }}>{action}</View> : null}
    </View>
  );
}

export function Skeleton({ height = 16, width = '100%', style }: { height?: number; width?: number | `${number}%`; style?: StyleProp<ViewStyle> }) {
  const p = usePalette();
  return <View style={[{ height, width, borderRadius: 8, backgroundColor: p.sunken }, style]} />;
}

export function LoadingCard({ rows = 3 }: { rows?: number }) {
  return (
    <Card style={{ gap: 14 }}>
      {Array.from({ length: rows }, (_, i) => (
        <View key={i} style={{ gap: 6 }}>
          <Skeleton width="60%" />
          <Skeleton width="35%" height={12} />
        </View>
      ))}
    </Card>
  );
}

export function PressableCard({ children, onPress, style, ...rest }: PressableProps & { children: ReactNode; style?: StyleProp<ViewStyle> }) {
  const p = usePalette();
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      {...rest}
      style={({ pressed }) => [
        { backgroundColor: p.surface, borderRadius: radius.lg, borderWidth: StyleSheet.hairlineWidth, borderColor: p.line, padding: 16 },
        p.scheme === 'light' ? styles.shadow : null,
        pressed && { backgroundColor: p.sunken },
        style,
      ]}
    >
      {children}
    </Pressable>
  );
}

// ── Brand ───────────────────────────────────────────────────────────────────

/**
 * The Zephric mark, drawn flat: the two bars in graphite and the stroke in the
 * accent, the same shape as the website's mark without its gradients.
 */
export function BrandMark({ size = 28 }: { size?: number }) {
  const p = usePalette();
  return (
    <Svg width={size} height={size} viewBox="0 0 64 64" accessibilityLabel="Zephric">
      <Path fill={p.ink} d="M18 8h36L38 24H5zM25 40h34L44 56H10z" />
      <Path fill={p.accent} d="M51 8c9 0 12 10 4 17L18 55c-8 6-16-4-9-11L46 10z" />
    </Svg>
  );
}

const styles = StyleSheet.create({
  shadow: {
    shadowColor: '#000000',
    shadowOpacity: 0.05,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 2 },
    elevation: 1,
  },
});
