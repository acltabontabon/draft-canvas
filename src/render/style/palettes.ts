import { ACCENTS, type Accent } from '../../document/types';
import type { AccentColours, DocumentStyle, StyleScheme } from '../../document/style';
import { LIGHT } from '../theme/tokens';

/**
 * The palettes a person can pick for a style, each a full set of colours for light and for dark.
 *
 * A palette is written into the style as plain colours: a diagram never names a palette, so one
 * that changes or goes away here leaves every diagram exactly as it was. Each is the built-in
 * colours leaned toward a tone, which is what keeps the seven named colours telling apart and
 * every palette inside the contrast floors a style is held to (`tests/style-palettes.test.ts`).
 */

type Schemes = NonNullable<DocumentStyle['schemes']>;

export interface StylePalette {
  id: string;
  label: string;
  description: string;
  /** Absent for the built-in colours: a style with no `schemes` at all. */
  schemes?: Schemes;
}

function mix(a: string, b: string, amount: number): string {
  const channel = (hex: string, at: number) => parseInt(hex.slice(at, at + 2), 16);
  const part = (at: number) => Math.round(channel(a, at) + (channel(b, at) - channel(a, at)) * amount).toString(16).padStart(2, '0');
  return `#${part(1)}${part(3)}${part(5)}`;
}

interface Tone {
  canvas: string;
  grid: string;
  text: string;
  textMuted: string;
  edge: string;
  edgeLabelBg: string;
  codeBg: string;
  codeBorder: string;
  /** What a shape's fill leans toward, and how far. */
  fill: [string, number];
  /** What its outline, chip and name lean toward, and how far. */
  ink: [string, number];
}

function lightScheme(tone: Tone): StyleScheme {
  const accents = {} as Record<Accent, AccentColours>;
  for (const accent of ACCENTS) {
    const base = LIGHT.accents[accent];
    accents[accent] = {
      fill: mix(base.fill, tone.fill[0], tone.fill[1]),
      line: mix(base.line, tone.ink[0], tone.ink[1]),
      text: mix(base.text, tone.ink[0], tone.ink[1]),
      chip: mix(base.chip, tone.ink[0], tone.ink[1]),
    };
  }
  return {
    canvas: tone.canvas,
    grid: tone.grid,
    text: tone.text,
    textMuted: tone.textMuted,
    edge: tone.edge,
    edgeText: tone.textMuted,
    edgeLabelBg: tone.edgeLabelBg,
    codeBg: tone.codeBg,
    codeBorder: tone.codeBorder,
    accents,
  };
}

/** A dark scheme from the light one's accents: deep fills, the light scheme's outlines lifted, pale names. */
function darkScheme(tone: Tone, light: StyleScheme): StyleScheme {
  const accents = {} as Record<Accent, AccentColours>;
  for (const accent of ACCENTS) {
    const from = light.accents![accent]!;
    accents[accent] = {
      fill: mix(tone.canvas, from.line, 0.16),
      line: mix(from.line, '#ffffff', 0.28),
      text: mix(from.line, '#ffffff', 0.78),
      chip: mix(from.line, '#ffffff', 0.4),
    };
  }
  return {
    canvas: tone.canvas,
    grid: tone.grid,
    text: tone.text,
    textMuted: tone.textMuted,
    edge: tone.edge,
    edgeText: tone.textMuted,
    edgeLabelBg: tone.edgeLabelBg,
    codeBg: tone.codeBg,
    codeBorder: tone.codeBorder,
    accents,
  };
}

function palette(id: string, label: string, description: string, light: Tone, dark: Tone): StylePalette {
  const lightColours = lightScheme(light);
  return { id, label, description, schemes: { light: lightColours, dark: darkScheme(dark, lightColours) } };
}

export const STYLE_PALETTES: readonly StylePalette[] = [
  { id: 'builtin', label: 'Standard', description: 'The colours Draft Canvas comes with.' },
  palette(
    'paper',
    'Paper',
    'Warm paper and brown ink.',
    { canvas: '#f7efdd', grid: '#e6dabd', text: '#33261a', textMuted: '#6a553d', edge: '#8a7355', edgeLabelBg: '#fcf6e8', codeBg: '#f2e8d0', codeBorder: '#decfad', fill: ['#f4e6c4', 0.45], ink: ['#5a3d1c', 0.28] },
    { canvas: '#1b1712', grid: '#2e271d', text: '#efe5d0', textMuted: '#b9aa8f', edge: '#9a8a70', edgeLabelBg: '#241f18', codeBg: '#221d16', codeBorder: '#3a3125', fill: ['#000000', 0], ink: ['#000000', 0] },
  ),
  palette(
    'blueprint',
    'Blueprint',
    'Cool paper and drafting blue.',
    { canvas: '#f1f5fa', grid: '#d6e0ec', text: '#14253b', textMuted: '#4a6079', edge: '#6b83a0', edgeLabelBg: '#fafcfe', codeBg: '#e9eff7', codeBorder: '#d0dbe8', fill: ['#e3edf9', 0.45], ink: ['#1f4f86', 0.3] },
    { canvas: '#0e1622', grid: '#1d2a3c', text: '#dfe9f6', textMuted: '#9fb3cb', edge: '#7f97b3', edgeLabelBg: '#152032', codeBg: '#131d2c', codeBorder: '#263750', fill: ['#000000', 0], ink: ['#000000', 0] },
  ),
  palette(
    'ink',
    'Ink',
    'Nearly one colour, for print.',
    { canvas: '#fbfbfa', grid: '#e2e2df', text: '#191919', textMuted: '#585856', edge: '#7c7c79', edgeLabelBg: '#ffffff', codeBg: '#f4f4f2', codeBorder: '#dededb', fill: ['#f6f6f4', 0.8], ink: ['#3a3a38', 0.78] },
    { canvas: '#121212', grid: '#272726', text: '#ececea', textMuted: '#adadaa', edge: '#8b8b88', edgeLabelBg: '#1c1c1b', codeBg: '#191918', codeBorder: '#313130', fill: ['#000000', 0], ink: ['#000000', 0] },
  ),
];

/** The palette a style's colours came from, or `null` for colours that are no palette's (a pack's own). */
export function paletteOf(style: Pick<DocumentStyle, 'schemes'>): StylePalette | null {
  if (!style.schemes) return STYLE_PALETTES[0]!;
  const wanted = JSON.stringify(style.schemes);
  return STYLE_PALETTES.find((entry) => entry.schemes && JSON.stringify(entry.schemes) === wanted) ?? null;
}
