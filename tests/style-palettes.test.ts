/**
 * The colours this app works out for a style: a palette, a canvas swatch, a canvas colour of one's
 * own. Each must clear the floors a style is held to (`render/style/scheme.ts`), so nothing a
 * person picks falls back to the built-in colours.
 */
import { describe, expect, it } from 'vitest';
import { normalizeStyle, type DocumentStyle } from '../src/document/style';
import { ACCENTS } from '../src/document/types';
import { CANVAS_SWATCHES, STYLE_PALETTES, schemesForCanvas } from '../src/render/style/palettes';
import { styleThemes } from '../src/render/style/scheme';
import type { Theme } from '../src/render/theme/tokens';

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

/** The one theme a canvas colour of one's own is drawn in, light and dark alike. */
function drawnOn(canvas: string): { theme: Theme; scheme: NonNullable<ReturnType<typeof schemesForCanvas>['light']>; both: boolean } {
  const schemes = schemesForCanvas(canvas);
  const { style } = normalizeStyle({ v: 1, hand: { base: 'clean' }, schemes });
  const themes = styleThemes(style);
  return { theme: themes.light, scheme: (schemes.light ?? schemes.dark)!, both: Object.keys(schemes).length === 1 && themes.light === themes.dark };
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
