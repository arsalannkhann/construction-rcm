/**
 * The rubber stamp and the bill slip: Zephric's one physical moment.
 *
 * Every status in the app's simple screens is shown as a stamp, the way a site
 * office marks a paper bill "Received" or "Approved", and nothing else uses
 * this look. The slip is the latest bill as a sheet torn from a carbon-copy
 * book: off-white paper, a torn top edge, the name the person gave it, the
 * amount, and the stamp.
 */
import { Pressable, View } from 'react-native';
import Svg, { Polygon } from 'react-native-svg';
import { useState } from 'react';
import type { UploadItem, UploadTone } from '@/lib/uploads';
import { ago } from '@/lib/format';
import { radius, usePalette } from '@/theme';
import { T } from './kit';

export function stampColor(tone: UploadTone, p: ReturnType<typeof usePalette>, onPaper = false): string {
  switch (tone) {
    case 'ok':
      return onPaper ? '#15803d' : p.pass;
    case 'problem':
      return onPaper ? '#b91c1c' : p.block;
    case 'progress':
      return onPaper ? '#c2410c' : p.accentText;
    default:
      return onPaper ? '#6b655b' : p.ink3;
  }
}

/** An inked stamp: an outline in the status colour, set at a slight angle. */
export function Stamp({ label, tone, onPaper = false, size = 'md' }: { label: string; tone: UploadTone; onPaper?: boolean; size?: 'sm' | 'md' }) {
  const p = usePalette();
  const color = stampColor(tone, p, onPaper);
  const sm = size === 'sm';
  return (
    <View
      accessibilityLabel={label}
      style={{
        borderWidth: 2,
        borderColor: color,
        borderRadius: 6,
        paddingHorizontal: sm ? 8 : 10,
        paddingVertical: sm ? 2 : 4,
        transform: [{ rotate: '-4deg' }],
        opacity: 0.92,
        alignSelf: 'flex-start',
      }}
    >
      <T v="label" style={{ color, fontSize: sm ? 13 : 15, lineHeight: sm ? 18 : 20, fontWeight: '600', letterSpacing: 0.4 }}>
        {label}
      </T>
    </View>
  );
}

/** The torn top edge of the slip: a row of small teeth in the page colour. */
function TornEdge({ width, color }: { width: number; color: string }) {
  if (width <= 0) return null;
  const tooth = 12;
  const n = Math.ceil(width / tooth);
  const points = [`0,0`];
  for (let i = 0; i < n; i++) points.push(`${i * tooth + tooth / 2},6`, `${(i + 1) * tooth},0`);
  points.push(`${width},0`);
  return (
    <Svg width={width} height={6} style={{ position: 'absolute', top: 0, left: 0 }}>
      <Polygon points={points.join(' ')} fill={color} />
    </Svg>
  );
}

export function BillSlip({ item, onPress, caption = 'Your last bill' }: { item: UploadItem; onPress?: () => void; caption?: string }) {
  const p = usePalette();
  const [width, setWidth] = useState(0);
  return (
    <Pressable
      onPress={onPress}
      disabled={!onPress}
      accessibilityRole={onPress ? 'button' : 'summary'}
      accessibilityLabel={`${caption}: ${item.title}, ${item.status}${item.amount ? `, ${item.amount}` : ''}`}
      onLayout={(e) => setWidth(e.nativeEvent.layout.width)}
      style={({ pressed }) => ({
        backgroundColor: p.paper,
        borderRadius: radius.md,
        borderTopLeftRadius: 0,
        borderTopRightRadius: 0,
        paddingTop: 24,
        paddingHorizontal: 20,
        paddingBottom: 20,
        gap: 16,
        shadowColor: '#000',
        shadowOpacity: 0.08,
        shadowRadius: 8,
        shadowOffset: { width: 0, height: 2 },
        elevation: 2,
        transform: [{ scale: pressed && onPress ? 0.99 : 1 }],
      })}
    >
      <TornEdge width={width} color={p.canvas} />
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
        <T v="caption" style={{ color: p.paperInk2 }}>
          {caption}
        </T>
        <T v="caption" style={{ color: p.paperInk2 }}>
          {ago(item.at)}
        </T>
      </View>
      <View style={{ gap: 4 }}>
        <T v="title" numberOfLines={2} style={{ color: p.paperInk }}>
          {item.title}
        </T>
        {item.description || item.detail ? (
          <T v="body" numberOfLines={2} style={{ color: p.paperInk2 }}>
            {item.description ?? item.detail}
          </T>
        ) : null}
        {item.tags.length > 0 ? (
          <T v="caption" numberOfLines={1} style={{ color: p.paperInk2 }}>
            {item.tags.join(' · ')}
          </T>
        ) : null}
      </View>
      <View style={{ height: 1, backgroundColor: p.paperEdge }} />
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
        <T v="amountLarge" style={{ color: item.amount ? p.paperInk : p.paperInk2, fontSize: item.amount ? 28 : 17 }}>
          {item.amount ?? 'Amount not read yet'}
        </T>
        <Stamp label={item.stamp} tone={item.tone} onPaper />
      </View>
    </Pressable>
  );
}
