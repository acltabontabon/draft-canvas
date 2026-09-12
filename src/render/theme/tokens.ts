/**
 * The single source of colour for the whole application.
 *
 * These values are consumed twice: as CSS custom properties for the live DOM,
 * and as literal hex strings by the SVG exporter. Defining them once in
 * TypeScript is what stops an exported diagram from drifting away from what the
 * user saw on screen.
 */
import type { Accent } from '../../document/types';

export type ThemeName = 'dark' | 'light';

export interface AccentPalette {
  /** Node fill. */
  fill: string;
  /** Border and connector stroke. */
  line: string;
  /** Label text. */
  text: string;
  /** Small accent chip used by presets and note headers. */
  chip: string;
}

export interface Theme {
  name: ThemeName;
  canvas: string;
  grid: string;
  surface: string;
  surfaceRaised: string;
  border: string;
  borderStrong: string;
  text: string;
  textMuted: string;
  textFaint: string;
  selection: string;
  selectionSoft: string;
  edge: string;
  edgeLabelBg: string;
  codeBg: string;
  codeBorder: string;
  shadow: string;
  accents: Record<Accent, AccentPalette>;
}

export const DARK: Theme = {
  name: 'dark',
  canvas: '#0f1115',
  grid: '#252a33',
  surface: '#181b21',
  surfaceRaised: '#1e222a',
  border: '#2c333d',
  borderStrong: '#3d4653',
  text: '#e6e9ee',
  textMuted: '#98a1b0',
  textFaint: '#808998',
  selection: '#5fd6c9',
  selectionSoft: 'rgba(95, 214, 201, 0.16)',
  edge: '#6d7885',
  edgeLabelBg: '#12151a',
  codeBg: '#12151a',
  codeBorder: '#2c333d',
  shadow: 'rgba(0, 0, 0, 0.45)',
  accents: {
    neutral: { fill: '#181b21', line: '#3d4653', text: '#e6e9ee', chip: '#98a1b0' },
    teal: { fill: '#12211f', line: '#3e8f85', text: '#8ee6db', chip: '#5fd6c9' },
    blue: { fill: '#141b28', line: '#4172a8', text: '#93c0f0', chip: '#6aa9f0' },
    violet: { fill: '#1a1727', line: '#7059b0', text: '#c0abf2', chip: '#9c83ea' },
    amber: { fill: '#221c11', line: '#9b7326', text: '#ecc46f', chip: '#e0aa3e' },
    rose: { fill: '#241419', line: '#a04b5e', text: '#f0a1b0', chip: '#e2687f' },
    green: { fill: '#13201a', line: '#418a5f', text: '#8fdda8', chip: '#5cc47d' },
  },
};

export const LIGHT: Theme = {
  name: 'light',
  canvas: '#fbfbfc',
  grid: '#dfe3e8',
  surface: '#ffffff',
  surfaceRaised: '#ffffff',
  border: '#dde1e7',
  borderStrong: '#b9c0ca',
  text: '#1a1d23',
  textMuted: '#59606d',
  textFaint: '#6a7280',
  selection: '#0b7c72',
  selectionSoft: 'rgba(15, 143, 132, 0.12)',
  edge: '#7c8492',
  edgeLabelBg: '#ffffff',
  codeBg: '#f7f8fa',
  codeBorder: '#e2e6eb',
  shadow: 'rgba(19, 24, 32, 0.10)',
  accents: {
    neutral: { fill: '#ffffff', line: '#b9c0ca', text: '#1a1d23', chip: '#59606d' },
    teal: { fill: '#f0faf8', line: '#3f9d92', text: '#0d5f57', chip: '#0f8f84' },
    blue: { fill: '#f1f6fd', line: '#5089c9', text: '#1b4f88', chip: '#2f76c4' },
    violet: { fill: '#f6f3fd', line: '#8570c9', text: '#4a3690', chip: '#6f55c9' },
    amber: { fill: '#fdf7ec', line: '#c08f2c', text: '#7a5610', chip: '#b3801f' },
    rose: { fill: '#fdf2f4', line: '#c46e80', text: '#8c2c41', chip: '#c2455f' },
    green: { fill: '#f1faf3', line: '#4d9a68', text: '#1f6237', chip: '#2f8a51' },
  },
};

export const THEMES: Record<ThemeName, Theme> = { dark: DARK, light: LIGHT };

export function themeFor(name: ThemeName): Theme {
  return THEMES[name];
}

export function accentOf(theme: Theme, accent: Accent | undefined): AccentPalette {
  return theme.accents[accent ?? 'neutral'];
}

/**
 * Mirrors the theme onto the document root as CSS custom properties, so the
 * stylesheets and the exporter can never disagree about what "teal" means.
 */
export function applyThemeVariables(theme: Theme, root: HTMLElement): void {
  const set = (key: string, value: string) => root.style.setProperty(`--dc-${key}`, value);
  set('canvas', theme.canvas);
  set('grid', theme.grid);
  set('surface', theme.surface);
  set('surface-raised', theme.surfaceRaised);
  set('border', theme.border);
  set('border-strong', theme.borderStrong);
  set('text', theme.text);
  set('text-muted', theme.textMuted);
  set('text-faint', theme.textFaint);
  set('selection', theme.selection);
  set('selection-soft', theme.selectionSoft);
  set('edge', theme.edge);
  set('edge-label-bg', theme.edgeLabelBg);
  set('code-bg', theme.codeBg);
  set('shadow', theme.shadow);
  for (const [name, palette] of Object.entries(theme.accents)) {
    set(`accent-${name}-fill`, palette.fill);
    set(`accent-${name}-line`, palette.line);
    set(`accent-${name}-text`, palette.text);
    set(`accent-${name}-chip`, palette.chip);
  }
  root.dataset.theme = theme.name;
  root.style.colorScheme = theme.name;
}
