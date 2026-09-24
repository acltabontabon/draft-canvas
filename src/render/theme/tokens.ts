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
  selection: '#6cb3aa',
  selectionSoft: 'rgba(108, 179, 170, 0.16)',
  edge: '#6d7885',
  edgeLabelBg: '#12151a',
  codeBg: '#12151a',
  codeBorder: '#2c333d',
  shadow: 'rgba(0, 0, 0, 0.45)',
  accents: {
    // Not a chrome-token alias: a shape with no explicit accent should read as
    // an intentional slate surface sitting *on* the canvas, not flush with it —
    // `fill` lifts to `surfaceRaised` rather than `surface`, and `line`/`chip`
    // carry a faint cool lean of their own instead of reusing UI-chrome grays.
    neutral: { fill: '#1e222a', line: '#4b5563', text: '#e6e9ee', chip: '#9aa4b2' },
    // Low-chroma, deeper hues — pigments rather than highlighter. The previous set led with a mint
    // `#5fd6c9` and a sky `#6aa9f0`, which at full saturation across a whole diagram read as
    // playful; the identifying work a colour does here is done by *hue*, and hue survives having
    // most of the saturation taken out of it. Each stays a recognisably distinct family while
    // sitting quietly next to the neutral slate the default shapes wear.
    teal: { fill: '#15201f', line: '#3d7a74', text: '#9ccbc4', chip: '#5ba49c' },
    blue: { fill: '#161c25', line: '#456b96', text: '#a6c1dc', chip: '#6390bf' },
    violet: { fill: '#1b1926', line: '#61578f', text: '#b6aed4', chip: '#8479b8' },
    amber: { fill: '#211d15', line: '#8a6f3c', text: '#d6bf95', chip: '#b89a5f' },
    rose: { fill: '#211719', line: '#8c5a62', text: '#d3a7ad', chip: '#b87d85' },
    green: { fill: '#171e18', line: '#4f7a4f', text: '#a8c7a4', chip: '#6f9b69' },
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
  selection: '#2c6f68',
  selectionSoft: 'rgba(44, 111, 104, 0.12)',
  edge: '#7c8492',
  edgeLabelBg: '#ffffff',
  codeBg: '#f7f8fa',
  codeBorder: '#e2e6eb',
  shadow: 'rgba(19, 24, 32, 0.10)',
  accents: {
    // Same reasoning as DARK.neutral, tuned independently rather than inverted:
    // a hair warmer than pure white, and a line/chip with a touch more presence
    // than the plain UI-chrome border/muted-text grays they used to alias.
    neutral: { fill: '#fdfcfa', line: '#a9b1bd', text: '#1a1d23', chip: '#5b6472' },
    // The same pigments read from the other side: tinted-paper surfaces, and a line/chip deep
    // enough to hold its own against near-white without turning fluorescent. Text is darker than
    // the chip it belongs to, so a name stays the most legible thing in its own shape.
    teal: { fill: '#f4f8f7', line: '#4e8c85', text: '#1f5650', chip: '#357a72' },
    blue: { fill: '#f4f7fb', line: '#5a83aa', text: '#254a70', chip: '#3d6890' },
    violet: { fill: '#f7f5fb', line: '#7b71a8', text: '#413a68', chip: '#5d5387' },
    amber: { fill: '#faf7f0', line: '#a4844b', text: '#644f20', chip: '#876c37' },
    rose: { fill: '#fbf5f6', line: '#ac7981', text: '#733e46', chip: '#8f545c' },
    green: { fill: '#f5f8f4', line: '#5f8759', text: '#2d522e', chip: '#497043' },
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
 * A boundary's outline colour. Drawn at full strength — a boundary stays quieter than the shapes it
 * holds through a thinner, broken line and no heavy fill, never by fading the colour the user
 * picked (which is what made a recoloured boundary nearly indistinguishable from a neutral one).
 */
export function boundaryLine(theme: Theme, accent: Accent | undefined): string {
  return accentOf(theme, accent).line;
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
    // No `-line`: nothing in CSS draws with an accent's line colour (connectors get it from the theme
    // object, in the display list).
    set(`accent-${name}-fill`, palette.fill);
    set(`accent-${name}-text`, palette.text);
    set(`accent-${name}-chip`, palette.chip);
  }
  root.dataset.theme = theme.name;
  root.style.colorScheme = theme.name;
}
