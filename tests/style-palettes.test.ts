/**
 * The colours this app works out for a style: a palette, a canvas swatch, a canvas colour of one's
 * own. Each must clear the floors a style is held to (`render/style/scheme.ts`), so nothing a
 * person picks falls back to the built-in colours, and the marks the editor draws in its own
 * colours (what is chosen, what would be removed) can still be seen on whatever canvas it has.
 */
import { describe, expect, it } from 'vitest';
import { normalizeStyle, type DocumentStyle } from '../src/document/style';
import { ACCENTS } from '../src/document/types';
import { contrast } from '../src/lib/colour';
import { CANVAS_SWATCHES, STYLE_PALETTES, schemesForCanvas } from '../src/render/style/palettes';
import { CONTRAST, schemeTheme, styleThemes } from '../src/render/style/scheme';
import { applyThemeVariables, DARK, LIGHT, THEMES, type Theme } from '../src/render/theme/tokens';

const hex = (value: number) => value.toString(16).padStart(2, '0');

/** Every three-digit colour, `#000` to `#fff`: 4,096 canvases spread evenly over the whole of RGB. */
const GRID: string[] = [];
for (let r = 0; r < 256; r += 17) for (let g = 0; g < 256; g += 17) for (let b = 0; b < 256; b += 17) GRID.push(`#${hex(r)}${hex(g)}${hex(b)}`);

/**
 * Colours people bring: brands' own (Fluent, Windows and Bootstrap blue were once drawn on the
 * built-in dark canvas instead), the greys where black and white words read about the same, and
 * the swatches the app offers.
 */
const BRANDS = [
  '#0078d4', '#0078d7', '#0d6efd', '#007bff', '#006eff', '#0073f5', '#1877f2', '#0a66c2', '#0070f3', '#1da1f2', '#3b82f6', '#2563eb',
  '#0f62fe', '#2496ed', '#0052cc', '#00a1e0', '#326ce5', '#ff4500', '#e50914', '#fc6d26', '#1db954', '#4a154b', '#0f766e', '#15803d',
  '#d205e1', '#2c6f68', '#3d8a82', '#767676', '#777777', '#787878', '#797979', '#7a7a7a',
  ...CANVAS_SWATCHES.map((swatch) => swatch.colour),
];

const CANVASES = [...new Set([...GRID, ...BRANDS])];

interface Drawn {
  theme: Theme;
  scheme: NonNullable<ReturnType<typeof schemesForCanvas>['light']>;
  /** One scheme, and one theme for the device's light and dark settings alike. */
  both: boolean;
}

/** Worked out once per canvas and shared by the sweeps below, which only read it. */
const DRAWN = new Map<string, Drawn>();

/** The one theme a canvas colour of one's own is drawn in, light and dark alike. */
function drawnOn(canvas: string): Drawn {
  let drawn = DRAWN.get(canvas);
  if (!drawn) {
    const schemes = schemesForCanvas(canvas);
    const { style } = normalizeStyle({ v: 1, hand: { base: 'clean' }, schemes });
    const themes = styleThemes(style);
    drawn = { theme: themes.light, scheme: (schemes.light ?? schemes.dark)!, both: Object.keys(schemes).length === 1 && themes.light === themes.dark };
    DRAWN.set(canvas, drawn);
  }
  return drawn;
}

describe('a canvas colour of one’s own, over the whole of RGB', () => {
  it('is drawn on, with every colour worked out for it kept', () => {
    const refused: string[] = [];
    for (const canvas of CANVASES) {
      const { theme, scheme, both } = drawnOn(canvas);
      const kept =
        both &&
        theme.canvas === canvas &&
        (['text', 'textMuted', 'edge', 'edgeText', 'edgeLabelBg', 'grid'] as const).every((key) => theme[key] === scheme[key]) &&
        ACCENTS.every((accent) => JSON.stringify(theme.accents[accent]) === JSON.stringify(scheme.accents![accent]));
      if (!kept) refused.push(`${canvas} drawn on ${theme.canvas}`);
    }
    expect(refused).toEqual([]);
    // It works out every canvas the sweeps below read: about a second, more on a busy machine.
  }, 20_000);

  it('writes words that read on it, and on the bars and panels beside it', () => {
    const unreadable: string[] = [];
    for (const canvas of CANVASES) {
      const { theme } = drawnOn(canvas);
      const checks: [string, string, string, number][] = [
        ['words', theme.text, theme.canvas, CONTRAST.text],
        ['words on a panel', theme.text, theme.surfaceRaised, CONTRAST.text],
        ['quiet words on a bar', theme.textMuted, theme.surface, CONTRAST.muted],
        ['faintest words', theme.textFaint, theme.canvas, CONTRAST.muted],
        ['faintest words on a bar', theme.textFaint, theme.surface, CONTRAST.muted],
      ];
      for (const [what, colour, ground, floor] of checks) if (contrast(colour, ground) < floor) unreadable.push(`${canvas}: ${what} ${contrast(colour, ground).toFixed(2)}:1`);
    }
    expect(unreadable).toEqual([]);
  });

  it('marks what is chosen and what would be removed in colours that can be seen on it', () => {
    // Canvas-coloured words are written on the selection (a solid button), and the danger colour is
    // words too (a Delete), so both are held where words are: on the canvas and on a panel.
    const unseen: string[] = [];
    for (const canvas of CANVASES) {
      const { theme } = drawnOn(canvas);
      for (const [what, colour] of [['selection', theme.selection], ['danger', theme.danger]] as const) {
        for (const ground of [theme.canvas, theme.surfaceRaised]) {
          if (contrast(colour, ground) < CONTRAST.text) unseen.push(`${canvas}: ${what} ${colour} ${contrast(colour, ground).toFixed(2)}:1 on ${ground}`);
        }
      }
    }
    expect(unseen).toEqual([]);
  });

  it('gives every colour a chip that reads as words on the canvas, both ways round', () => {
    // A Text in a colour is written in its chip, and a banner writes the canvas's colour on the chip.
    const faint: string[] = [];
    for (const canvas of CANVASES) {
      const { theme } = drawnOn(canvas);
      for (const accent of ACCENTS) {
        const ratio = contrast(theme.accents[accent].chip, theme.canvas);
        if (ratio < CONTRAST.text) faint.push(`${canvas} ${accent} ${ratio.toFixed(2)}:1`);
      }
    }
    expect(faint).toEqual([]);
  });
});

describe('the marks the editor draws in its own colours', () => {
  it('stay the built-in ones on every canvas they were made for, and on every palette', () => {
    for (const name of ['light', 'dark'] as const) {
      expect(schemeTheme(THEMES[name], { accents: { teal: THEMES[name].accents.teal } }).selection).toBe(THEMES[name].selection);
    }
    for (const palette of STYLE_PALETTES) {
      const themes = styleThemes(normalizeStyle({ v: 1, hand: { base: 'clean' }, ...(palette.schemes ? { schemes: palette.schemes } : {}) }).style);
      for (const name of ['light', 'dark'] as const) {
        expect([themes[name].selection, themes[name].selectionSoft, themes[name].danger], `${palette.id} ${name}`).toEqual([THEMES[name].selection, THEMES[name].selectionSoft, THEMES[name].danger]);
      }
    }
  });

  it('are made to stand out from a canvas the built-in ones vanish into, and keep a brand that can be seen', () => {
    // Words and lines of the person's own on a blue canvas, where the built-in teal is 1.4:1.
    const blue = { canvas: '#1877f2', text: '#000000', textMuted: '#06182f', edge: '#0a2f60', edgeText: '#000000', edgeLabelBg: '#6aa8f6' };
    const theme = schemeTheme(LIGHT, blue);
    expect(theme.canvas).toBe('#1877f2');
    expect(contrast(theme.selection, theme.canvas)).toBeGreaterThanOrEqual(CONTRAST.text);
    expect(contrast(theme.danger, theme.canvas)).toBeGreaterThanOrEqual(CONTRAST.text);
    // The soft wash a selection is laid in follows it.
    const [r, g, b] = [1, 3, 5].map((at) => parseInt(theme.selection.slice(at, at + 2), 16));
    expect(theme.selectionSoft).toBe(`rgba(${r}, ${g}, ${b}, 0.12)`);
    // A brand colour the person chose is theirs wherever it can be seen.
    expect(schemeTheme(LIGHT, { ...blue, selection: '#3b0764' }).selection).toBe('#3b0764');
    // A dark canvas is no different: on Netflix red the built-in pink was 1.6:1.
    const red = schemeTheme(DARK, { canvas: '#e50914', text: '#ffffff', textMuted: '#ffe9ea', edge: '#ffc2c5', edgeText: '#ffffff', edgeLabelBg: '#95060d' });
    expect(red.canvas).toBe('#e50914');
    expect(contrast(red.danger, red.canvas)).toBeGreaterThanOrEqual(CONTRAST.text);
    expect(contrast(red.selection, red.surfaceRaised)).toBeGreaterThanOrEqual(CONTRAST.text);
  });

  it('reach the stylesheets in the colours the canvas draws them in', () => {
    const element = document.createElement('div');
    const theme = drawnOn('#e50914').theme;
    applyThemeVariables(theme, element);
    expect(element.style.getPropertyValue('--dc-selection')).toBe(theme.selection);
    // Removed items in a preview are drawn in `theme.danger` on the canvas and `--dc-danger` beside it.
    expect(element.style.getPropertyValue('--dc-danger')).toBe(theme.danger);
  });
});

describe('a palette', () => {
  it('is drawn in exactly the colours it names', () => {
    for (const palette of STYLE_PALETTES) {
      if (!palette.schemes) continue;
      const style: DocumentStyle = { v: 1, hand: { base: 'clean' }, schemes: palette.schemes };
      const themes = styleThemes(normalizeStyle(style).style);
      for (const name of ['light', 'dark'] as const) {
        const scheme = palette.schemes[name]!;
        expect(themes[name].canvas, `${palette.id} ${name}`).toBe(scheme.canvas);
        for (const accent of ACCENTS) expect(themes[name].accents[accent], `${palette.id} ${name} ${accent}`).toEqual(scheme.accents![accent]);
      }
    }
  });
});
