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

/**
 * The box the glyph is drawn at its normal size for. Deliberately a frozen pair rather than
 * `DEFAULTS.dataStoreWidth`/`dataStoreHeight`: the default box is now a little larger than this,
 * so a Data Store someone drops on the canvas reads at the weight of the shapes around it — but a
 * store already in a saved diagram keeps the box it was created with, and has to keep the glyph
 * that went with it. Tying the scale to the default instead would silently redraw every store in
 * every diagram the moment the default moved.
 *
 * The width is what sets how much of its box the glyph fills (54 of 90, not 54 of 148): with the
 * wider figure a glyph grown to fit its box still left a wide empty frame around it. Height is the
 * side that limits a wide box, so a store at any aspect wider than ~1 keeps the scale it had.
 */
const DS_UNIT_WIDTH = 90;
const DS_UNIT_HEIGHT = 88;

/** The glyph's top edge, from the box's top, at its normal size. */
export const DS_GLYPH_TOP = 9;
export const DS_GLYPH_HEIGHT = 42;
/** Space kept clear on each side of the glyph — the drawing's own `PADDING`. */
export const DS_GLYPH_MARGIN = 12;
/** The widest any kind's glyph draws (`dataStoreCylinder`'s and `dataStoreTable`'s 54, `dataStoreFileSystem`'s
 *  56 rounds to it: the others are narrower, and a connector a pixel or two off a narrower glyph
 *  reads as touching). */
const DS_GLYPH_WIDTH = 54;

/**
 * How much bigger than normal a Data Store's glyph is drawn: 1 at the unit box above and at every
 * smaller one, then growing with the box — uniformly, by whichever side has grown the least, so a
 * box stretched only one way keeps its glyph and one dragged out from a corner scales it. A store
 * at today's default box is a little over 1; one at the old default is exactly 1.
 */
export function dataStoreScale(node: { width: number; height: number }): number {
  return Math.max(1, Math.min(node.width / DS_UNIT_WIDTH, node.height / DS_UNIT_HEIGHT));
}

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
  const scale = dataStoreScale(node);
  const width = Math.min(DS_GLYPH_WIDTH * scale, Math.max(0, node.width - DS_GLYPH_MARGIN * 2));
  const centre = node.x + node.width / 2;
  const top = node.y + Math.min(DS_GLYPH_TOP * scale, node.height);
  return {
    top,
    bottom: Math.min(node.y + node.height, top + DS_GLYPH_HEIGHT * scale),
    left: centre - width / 2,
    right: centre + width / 2,
  };
}
