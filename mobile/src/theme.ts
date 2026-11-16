/**
 * The Zephric palette, from the website's tokens (src/app/globals.css), with
 * a dark set chosen for contrast on navy rather than flipped automatically.
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
  /** Button fills. White text on it passes contrast in both schemes. */
  accent: string;
  /** Links and accent text on the surface. */
  accentText: string;
  accentSoft: string;
  aqua: string;
  aquaText: string;
  aquaSoft: string;
  pass: string;
  passSoft: string;
  warn: string;
  warnSoft: string;
  block: string;
  blockSoft: string;
  navy: string;
  overlay: string;
};

export const light: Palette = {
  scheme: 'light',
  canvas: '#f5f6f8',
  surface: '#ffffff',
  raised: '#ffffff',
  sunken: '#eef0f3',
  line: '#e3e6eb',
  lineStrong: '#cdd2da',
  ink: '#0b1220',
  ink2: '#4a5468',
  ink3: '#737c8f',
  ink4: '#a6adbb',
  accent: '#1f4fd1',
  accentText: '#1f4fd1',
  accentSoft: '#ebf0fd',
  aqua: '#12c2b4',
  aquaText: '#0b7d74',
  aquaSoft: '#e3f8f6',
  pass: '#1b7a4a',
  passSoft: '#e7f4ed',
  warn: '#96580a',
  warnSoft: '#fcf2df',
  block: '#b42d1d',
  blockSoft: '#fcebe8',
  navy: '#070d1a',
  overlay: 'rgba(7,13,26,0.5)',
};

export const dark: Palette = {
  scheme: 'dark',
  canvas: '#070d1a',
  surface: '#0e1729',
  raised: '#132038',
  sunken: '#0a1222',
  line: '#1f2a40',
  lineStrong: '#2c3a55',
  ink: '#eef1f6',
  ink2: '#b6bfce',
  ink3: '#8792a8',
  ink4: '#5b6680',
  accent: '#3d63e6',
  accentText: '#8ea6ff',
  accentSoft: '#16224a',
  aqua: '#12c2b4',
  aquaText: '#4fd8cb',
  aquaSoft: '#0c2a2e',
  pass: '#4cc98a',
  passSoft: '#0f2a1f',
  warn: '#e7b25a',
  warnSoft: '#2e2410',
  block: '#ff8a7a',
  blockSoft: '#341714',
  navy: '#070d1a',
  overlay: 'rgba(0,0,0,0.6)',
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
