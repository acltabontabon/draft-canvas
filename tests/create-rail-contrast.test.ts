import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { normalizeStyle } from '../src/document/style';
import { contrast } from '../src/lib/colour';
import { CANVAS_SWATCHES, STYLE_PALETTES, schemesForCanvas } from '../src/render/style/palettes';
import { resolveStyle } from '../src/render/style/resolve';

/**
 * The create rail's one word, "Shapes", is text on the rail's surface, so it is held to WCAG's 4.5:1
 * where the drawings beside it need 3:1. It is the editor's text colour mixed toward transparent
 * (`app.css`); this works the mix out over the surface, as the browser composites it, on every canvas
 * swatch and palette the app offers, in light and dark. At the drawings' 62% it read at 4.2:1 on the
 * Paper palette and under 4.5:1 on every light canvas swatch.
 */
const css = readFileSync(resolve(process.cwd(), 'src/styles/app.css'), 'utf8');

/** How much of the text colour the word is drawn in, from its rule in `app.css`. */
function share(): number {
  const body = /\n\.dc-tool-shapes-word \{([^}]*)\}/.exec(css)?.[1];
  const percent = body && /\bcolor:\s*color-mix\(in srgb, var\(--dc-text\) (\d+(?:\.\d+)?)%, transparent\)/.exec(body)?.[1];
  if (!percent) throw new Error('no colour of its own for .dc-tool-shapes-word');
  return Number(percent) / 100;
}

const channels = (colour: string) => [1, 3, 5].map((at) => parseInt(colour.slice(at, at + 2), 16));

/** `text` at `alpha` over `surface`, a byte a channel, as the screen shows it. */
function over(text: string, surface: string, alpha: number): string {
  const under = channels(surface);
  return `#${channels(text)
    .map((value, i) => Math.round(value * alpha + under[i]! * (1 - alpha)).toString(16).padStart(2, '0'))
    .join('')}`;
}

const CASES = [
  ...CANVAS_SWATCHES.map((swatch) => [`the ${swatch.label} canvas`, schemesForCanvas(swatch.colour)] as const),
  ...STYLE_PALETTES.map((palette) => [`the ${palette.label} palette`, palette.schemes] as const),
];

describe('the create rail’s Shapes word', () => {
  it.each(CASES)('reads at 4.5:1 or better on %s, in light and dark', (_name, schemes) => {
    const { style } = normalizeStyle({ v: 1, hand: { base: 'clean' }, ...(schemes ? { schemes } : {}) });
    for (const device of ['light', 'dark'] as const) {
      const theme = resolveStyle(style).theme(device);
      expect(contrast(over(theme.text, theme.surface, share()), theme.surface), device).toBeGreaterThanOrEqual(4.5);
    }
  });
});
