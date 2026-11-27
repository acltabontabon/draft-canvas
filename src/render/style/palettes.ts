import { ACCENTS, type Accent } from '../../document/types';
import type { AccentColours, DocumentStyle, StyleScheme } from '../../document/style';
import { contrast } from '../../lib/colour';
import { DARK, LIGHT } from '../theme/tokens';
import { CONTRAST } from './scheme';

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
  const schemes = withoutBrand(style.schemes);
  if (!schemes) return STYLE_PALETTES[0]!;
  const wanted = JSON.stringify(schemes);
  return STYLE_PALETTES.find((entry) => entry.schemes && JSON.stringify(entry.schemes) === wanted) ?? null;
}

/** Canvas colours offered before a colour of one's own: papers, then boards. */
export const CANVAS_SWATCHES: readonly { label: string; colour: string }[] = [
  { label: 'White', colour: '#ffffff' },
  { label: 'Linen', colour: '#f6f1e7' },
  { label: 'Mist', colour: '#eef2f6' },
  { label: 'Sage', colour: '#e9efe6' },
  { label: 'Blush', colour: '#f8ebe8' },
  { label: 'Slate', colour: '#1c232d' },
  { label: 'Midnight', colour: '#10162b' },
  { label: 'Forest', colour: '#12211c' },
  { label: 'Charcoal', colour: '#161616' },
];

/**
 * A full set of colours for a canvas of any colour: someone's brand colour, say.
 *
 * Words and lines are the canvas colour pulled toward black or white, whichever reads better on
 * it, and each named colour is the built-in one for that side, leaned toward the canvas and
 * pushed until it clears the floors a style is held to. A canvas of one's own is one colour, so
 * the result is a single scheme: the diagram is drawn on it in light and in dark alike.
 *
 * Every colour has room for this. Pure black and pure white are at least 4.58:1 from any colour
 * (their two contrasts with it multiply to 21), which clears every floor, so a colour a few steps
 * leave short of its floor is the pure one. Once the side was judged by a near-black and the steps
 * could stop short: a band of mid-tones (Fluent's and Bootstrap's blues among them) missed the
 * floor for words by a hair, and the diagram was drawn on the built-in canvas instead.
 */
export function schemesForCanvas(canvas: string): Schemes {
  const dark = contrast('#ffffff', canvas) >= contrast('#000000', canvas);
  // What words and lines lean toward on a light canvas keeps the cool of the built-in words.
  const ink = dark ? '#ffffff' : '#0b0d10';
  const pure = dark ? '#ffffff' : '#000000';
  const base = dark ? DARK : LIGHT;
  /** `colour` pushed toward the ink until it clears `floor` by `margin`, and never left under `floor`. */
  const reach = (colour: string, against: string, floor: number, margin: number): string => {
    let out = colour;
    for (let step = 0; step < 8 && contrast(out, against) < floor + margin; step += 1) out = mix(out, ink, 0.3);
    return contrast(out, against) < floor ? pure : out;
  };
  const accents = {} as Record<Accent, AccentColours>;
  for (const accent of ACCENTS) {
    const from = base.accents[accent];
    const fill = mix(from.fill, canvas, 0.22);
    accents[accent] = {
      fill,
      line: reach(from.line, canvas, CONTRAST.line, 0.4),
      text: reach(from.text, fill, CONTRAST.label, 0.5),
      // Words, not only a mark: a Text in this colour is written in its chip, and a banner writes the
      // canvas's colour on it. Held to the line floor alone, a banner read at 4.1:1 on Slate.
      chip: reach(from.chip, canvas, CONTRAST.text, 0.3),
    };
  }
  const edgeLabelBg = mix(canvas, dark ? '#000000' : '#ffffff', 0.35);
  const scheme: StyleScheme = {
    canvas,
    grid: mix(canvas, ink, 0.13),
    text: reach(mix(canvas, ink, 0.9), canvas, CONTRAST.text, 2),
    textMuted: reach(mix(canvas, ink, 0.62), canvas, CONTRAST.muted, 1),
    edge: reach(mix(canvas, ink, 0.5), canvas, CONTRAST.line, 0.6),
    edgeText: reach(mix(canvas, ink, 0.68), edgeLabelBg, CONTRAST.muted, 1),
    edgeLabelBg,
    codeBg: mix(canvas, ink, 0.05),
    codeBorder: mix(canvas, ink, 0.14),
    accents,
  };
  return dark ? { dark: scheme } : { light: scheme };
}

/** The canvas colour a style draws on in `theme`, when it names one. */
export function canvasOf(style: Pick<DocumentStyle, 'schemes'>, theme: 'light' | 'dark'): string | undefined {
  const schemes = style.schemes;
  if (!schemes) return undefined;
  return (schemes[theme] ?? schemes.light ?? schemes.dark)?.canvas;
}

/** The colour a style marks what is chosen in, when it names one. */
export function brandOf(style: Pick<DocumentStyle, 'schemes'>): string | undefined {
  return (style.schemes?.light ?? style.schemes?.dark)?.selection;
}

/** `schemes` with no brand colour in them: what a palette is compared by. `undefined` when nothing else is left. */
export function withoutBrand(schemes: Schemes | undefined): Schemes | undefined {
  if (!schemes) return undefined;
  const out: Schemes = {};
  for (const name of ['light', 'dark'] as const) {
    const scheme = schemes[name];
    if (!scheme) continue;
    const { selection: _selection, ...rest } = scheme;
    if (Object.keys(rest).length > 0) out[name] = rest;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * `schemes` marked in `brand`, in every theme they draw in. A style with no colours of its own
 * gets the brand alone, for light and for dark, and keeps the built-in colours for the rest.
 */
export function withBrand(schemes: Schemes | undefined, brand: string | undefined): Schemes | undefined {
  const plain = withoutBrand(schemes);
  if (!brand) return plain;
  if (!plain) return { light: { selection: brand }, dark: { selection: brand } };
  const out: Schemes = {};
  for (const name of ['light', 'dark'] as const) if (plain[name]) out[name] = { ...plain[name], selection: brand };
  return out;
}

/** Brand colours offered before one's own. */
export const BRAND_SWATCHES: readonly { label: string; colour: string }[] = [
  { label: 'Indigo', colour: '#4f46e5' },
  { label: 'Azure', colour: '#0b84d8' },
  { label: 'Emerald', colour: '#0f9d6e' },
  { label: 'Amber', colour: '#d98a0b' },
  { label: 'Coral', colour: '#e5533d' },
  { label: 'Magenta', colour: '#c9338f' },
];
