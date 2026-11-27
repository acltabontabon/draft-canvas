import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { contrast } from '../../src/lib/colour';
import { CANVAS_SWATCHES, schemesForCanvas } from '../../src/render/style/palettes';
import { THEMES, type ThemeName } from '../../src/render/theme/tokens';

/**
 * A collaborator's colour marks their cursor and the ring round what they hold, on the canvas. An
 * editor wearing a diagram's own colours is its own light or dark whatever the app around it is
 * (`canvas/useEditorDress.ts`), so the palette has to be the editor's: picked by the root's theme, a
 * light canvas on a dark device drew those rings at 1.2:1.
 */
const css = readFileSync(resolve(process.cwd(), 'src/styles/collab.css'), 'utf8');

/** The peer colours one rule declares, by name, from the first rule whose selector is exactly `selector`. */
function palette(selector: string): Record<string, string> {
  const at = css.indexOf(`\n${selector} {`);
  if (at < 0) throw new Error(`no rule for ${selector}`);
  const body = css.slice(css.indexOf('{', at) + 1, css.indexOf('}', at));
  return Object.fromEntries([...body.matchAll(/--dc-peer-(ink|\d):\s*(#[0-9a-f]{6})/g)].map((match) => [match[1]!, match[2]!]));
}

const APP: Record<ThemeName, Record<string, string>> = { dark: palette(':root'), light: palette(":root[data-theme='light']") };

describe('the colours collaborators are drawn in', () => {
  it('follow the editor’s own light or dark, not the app’s', () => {
    for (const name of ['dark', 'light'] as const) {
      expect(Object.keys(APP[name]), name).toHaveLength(9);
      expect(palette(`.dc-editor[data-theme='${name}']`), name).toEqual(APP[name]);
    }
  });

  it('are the ones that can be seen on every canvas swatch, by the theme each swatch is drawn in', () => {
    for (const { label, colour } of CANVAS_SWATCHES) {
      const name: ThemeName = schemesForCanvas(colour).light ? 'light' : 'dark';
      const worst = Math.min(...Object.entries(APP[name]).filter(([key]) => key !== 'ink').map(([, peer]) => contrast(peer, colour)));
      // A ring is a graphical object: 3:1 at least. The other theme's set fell to 1.2:1.
      expect(worst, label).toBeGreaterThanOrEqual(3);
    }
    for (const name of ['dark', 'light'] as const) {
      for (const [key, peer] of Object.entries(APP[name])) if (key !== 'ink') expect(contrast(peer, THEMES[name].canvas), `${name} ${key}`).toBeGreaterThanOrEqual(3);
    }
  });
});
