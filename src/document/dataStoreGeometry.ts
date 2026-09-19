/**
 * Where a Data Store's glyph sits inside its box. The glyph is a compact mark near the top of the
 * node, centred, with the name and kind caption in the space below it — so it is narrower than the
 * box and its centre sits well above the box's vertical midpoint.
 *
 * Lives in `document/` rather than beside the renderer for the reason `queueGeometry.ts` does: it
 * is *placement* knowledge. `edges/routing.ts` reads it (via `anchorBandOf`) so a connector lands
 * on the glyph instead of on the empty margin around it. `nodes/describe.ts` draws from the same
 * numbers.
 */

/** The glyph's top edge, from the box's top. */
export const DS_GLYPH_TOP = 9;
export const DS_GLYPH_HEIGHT = 42;
/** Space kept clear on each side of the glyph — the drawing's own `PADDING`. */
export const DS_GLYPH_MARGIN = 12;
/** The widest any kind's glyph draws (`dataStoreCylinder`'s and `dataStoreTable`'s 54, `dataStoreFileSystem`'s
 *  56 rounds to it: the others are narrower, and a connector a pixel or two off a narrower glyph
 *  reads as touching). */
const DS_GLYPH_WIDTH = 54;

export interface DataStoreGlyphBounds {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

/**
 * The glyph's box in the same coordinates as the node, or its extent from the node's own origin
 * when `x`/`y` are 0. Every kind is centred in the box and shares the top and height.
 */
export function dataStoreGlyphBounds(node: { x: number; y: number; width: number; height: number }): DataStoreGlyphBounds {
  const width = Math.min(DS_GLYPH_WIDTH, Math.max(0, node.width - DS_GLYPH_MARGIN * 2));
  const centre = node.x + node.width / 2;
  const top = node.y + Math.min(DS_GLYPH_TOP, node.height);
  return {
    top,
    bottom: Math.min(node.y + node.height, top + DS_GLYPH_HEIGHT),
    left: centre - width / 2,
    right: centre + width / 2,
  };
}
