import { describe, expect, it } from 'vitest';
import { createDocument } from '../src/document/factory';
import { addEdges, addNodes } from '../src/document/operations';
import { describeContext, describeNode } from '../src/nodes/describe';
import type { Shape, TextShape } from '../src/render/displayList';
import { renderDocumentSvg } from '../src/render/svg/document';
import { THEMES, type ThemeName } from '../src/render/theme/tokens';
import { PERSONALITY_PRESETS } from '../src/ui/personality/usePersonality';
import { ARCHITECTURE_STARTERS } from '../src/starters';
import { buildStarter } from '../src/starters/build';

/**
 * A starter sets document content and nothing else — no colour, no font, no personality — so it is
 * supposed to be correct in every theme and every Intentional Roughness preset for free. These
 * tests are the guard on "for free": they fail if a starter ever starts asserting appearance, and
 * they catch the one composition mistake the geometry tests can't see, which is a label too long
 * for the box it was authored into.
 */

const COMBINATIONS = (['light', 'dark'] as const).flatMap((theme) =>
  PERSONALITY_PRESETS.map((preset) => [theme, preset] as const),
);

/** Every colour any theme can legitimately produce, so anything else in the output is hardcoded. */
const THEME_COLORS = new Set(
  Object.values(THEMES).flatMap((theme) =>
    Object.entries(theme).flatMap(([key, value]) =>
      key === 'accents'
        ? Object.values(value as Record<string, Record<string, string>>).flatMap((palette) =>
            Object.values(palette),
          )
        : typeof value === 'string'
          ? [value]
          : [],
    ),
  ),
);

function documentFor(starterIndex: number) {
  const starter = ARCHITECTURE_STARTERS[starterIndex]!;
  const { nodes, edges } = buildStarter(starter, { x: 0, y: 0 });
  return { starter, document: addEdges(addNodes(createDocument(starter.name), nodes), edges) };
}

/** Captions sit inside `GroupShape`s, so a flat pass over the top level would miss most of them. */
function textShapes(shapes: readonly Shape[]): TextShape[] {
  return shapes.flatMap((shape) =>
    shape.t === 'text' ? [shape] : shape.t === 'group' ? textShapes(shape.children) : [],
  );
}

const cases = ARCHITECTURE_STARTERS.flatMap((starter, index) =>
  COMBINATIONS.map(([theme, preset]) => [starter.name, theme, preset, index] as const),
);

describe('starters across themes and personalities', () => {
  it.each(cases)('%s renders in %s / %s', (_name, theme, preset, index) => {
    const { document } = documentFor(index);
    const { svg, width, height } = renderDocumentSvg(document, { theme, preset });
    expect(svg.startsWith('<svg')).toBe(true);
    expect(width).toBeGreaterThan(0);
    expect(height).toBeGreaterThan(0);
  });

  it.each(cases)('%s uses only theme colours in %s / %s', (_name, theme, preset, index) => {
    const { document } = documentFor(index);
    const { svg } = renderDocumentSvg(document, { theme, preset, transparent: true });
    const used = new Set(svg.match(/#[0-9a-fA-F]{3,8}\b/g) ?? []);
    for (const color of used) {
      expect(THEME_COLORS.has(color), `${color} is not a theme token`).toBe(true);
    }
  });

  it.each(
    ARCHITECTURE_STARTERS.map((starter, index) => [starter.name, index] as const),
  )('%s never clips a label into an ellipsis', (_name, index) => {
    const { document } = documentFor(index);
    for (const theme of ['light', 'dark'] as ThemeName[]) {
      const ctx = describeContext(THEMES[theme], 'clean');
      for (const node of document.nodes) {
        for (const text of textShapes(describeNode(node, ctx).shapes)) {
          expect(
            text.layout.truncated,
            `"${node.text ?? node.type}" does not fit the box it was authored into`,
          ).toBe(false);
        }
      }
    }
  });
});
