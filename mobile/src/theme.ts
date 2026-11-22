/**
 * The Zephric palette: graphite neutrals for everything people look at all
 * day, and one accent, a burnt safety orange from the job site, used rarely
 * (the main action, the selected tab, the one figure that matters). Status
 * colours only carry meaning and are toned down to sit with the graphite.
 * `paper` is for the bill slip on the home screen, a real-looking paper
 * object, so it stays light in both schemes.
 */
import { createContext, useContext } from 'react';
import { useColorScheme } from 'react-native';

export type Palette = {
  scheme: 'light' | 'dark';
  canvas: string;
  surface: string;
  raised: string;
  sunken: string;
  line: string;
  lineStrong: string;
  ink: string;
  ink2: string;
  ink3: string;
  ink4: string;
  /** Button fills. White text on it passes contrast (5.2:1) in both schemes. */
  accent: string;
  /** Links and accent text on the surface. */
  accentText: string;
  accentSoft: string;
  /** Kept for older call sites; now a quiet neutral, not a second accent. */
  aqua: string;
  aquaText: string;
  aquaSoft: string;
  pass: string;
  passSoft: string;
  warn: string;
  warnSoft: string;
  block: string;
  blockSoft: string;
  /** The darkest graphite, for a solid dark surface in light mode. */
  navy: string;
  overlay: string;
  /** The bill slip: paper, its ink and its torn-edge shadow. */
  paper: string;
  paperInk: string;
  paperInk2: string;
  paperEdge: string;
};

export const light: Palette = {
  scheme: 'light',
  canvas: '#f4f4f5',
  surface: '#ffffff',
  raised: '#ffffff',
  sunken: '#ededef',
  line: '#e4e4e7',
  lineStrong: '#d4d4d8',
  ink: '#18181b',
  ink2: '#52525b',
  ink3: '#71717a',
  ink4: '#a1a1aa',
  accent: '#c2410c',
  accentText: '#c2410c',
  accentSoft: '#fbeee6',
  aqua: '#52525b',
  aquaText: '#3f3f46',
  aquaSoft: '#ededef',
  pass: '#15803d',
  passSoft: '#e8f3ec',
  warn: '#8a6a0c',
  warnSoft: '#f6f0dc',
  block: '#b91c1c',
  blockSoft: '#fbeaea',
  navy: '#18181b',
  overlay: 'rgba(24,24,27,0.5)',
  paper: '#fbf8f1',
  paperInk: '#1c1a17',
  paperInk2: '#6b655b',
  paperEdge: '#e7e1d4',
};

export const dark: Palette = {
  scheme: 'dark',
  canvas: '#111113',
  surface: '#19191c',
  raised: '#202024',
  sunken: '#0c0c0e',
  line: '#27272b',
  lineStrong: '#36363c',
  ink: '#f4f4f5',
  ink2: '#c4c4ca',
  ink3: '#8e8e96',
  ink4: '#5d5d65',
  accent: '#c2410c',
  accentText: '#fb923c',
  accentSoft: '#2a1a10',
  aqua: '#c4c4ca',
  aquaText: '#d4d4d8',
  aquaSoft: '#202024',
  pass: '#5cc98a',
  passSoft: '#12241a',
  warn: '#d8b45a',
  warnSoft: '#2a2412',
  block: '#f08a80',
  blockSoft: '#2c1515',
  navy: '#0c0c0e',
  overlay: 'rgba(0,0,0,0.6)',
  paper: '#ece6d8',
  paperInk: '#1c1a17',
  paperInk2: '#5f594f',
  paperEdge: '#c9c1af',
};

export type ThemePref = 'system' | 'light' | 'dark';

export const ThemeContext = createContext<{ pref: ThemePref; setPref: (p: ThemePref) => void }>({ pref: 'system', setPref: () => undefined });

export function usePalette(): Palette {
  const system = useColorScheme();
  const { pref } = useContext(ThemeContext);
  const scheme = pref === 'system' ? (system === 'dark' ? 'dark' : 'light') : pref;
  return scheme === 'dark' ? dark : light;
}

export const radius = { sm: 8, md: 12, lg: 16, xl: 20, pill: 999 };
export const space = (n: number) => n * 4;
