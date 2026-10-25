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
 * The older scale remains the floor for saved diagrams. A box with room beyond that grows the
 * glyph further while reserving space for its name and optional C4 detail.
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
const DS_MAX_GLYPH_WIDTH = 56;
const DS_CAPTION_RESERVE = 64;
const DS_MARK_RESERVE = 25;

/**
 * Keep the established scale for ordinary diagram sizes, then use spare width and height in boxes
 * enlarged past both thresholds. The limits reserve space for the caption, C4 detail and a possible
 * technology mark beside the glyph.
 */
export function dataStoreScale(node: { width: number; height: number }): number {
  const original = Math.max(1, Math.min(node.width / DS_UNIT_WIDTH, node.height / DS_UNIT_HEIGHT));
  const growth = Math.min(Math.max(0, node.width - 250), Math.max(0, node.height - 200)) / 45;
  if (growth === 0) return original;
  return Math.max(original, Math.min(
    original + growth,
    (node.width - DS_GLYPH_MARGIN * 2 - DS_MARK_RESERVE) / DS_MAX_GLYPH_WIDTH,
    (node.height - 22 - DS_CAPTION_RESERVE) / DS_GLYPH_HEIGHT,
  ));
}

/** The original top inset eases toward a smaller one as an enlarged glyph consumes the box. */
export function dataStoreGlyphTop(node: { width: number; height: number }): number {
  const original = Math.max(1, Math.min(node.width / DS_UNIT_WIDTH, node.height / DS_UNIT_HEIGHT));
  const growth = dataStoreScale(node) - original;
  return Math.max(DS_GLYPH_TOP, DS_GLYPH_TOP * original - growth * 5);
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
  const top = node.y + Math.min(dataStoreGlyphTop(node), node.height);
  return {
    top,
    bottom: Math.min(node.y + node.height, top + DS_GLYPH_HEIGHT * scale),
    left: centre - width / 2,
    right: centre + width / 2,
  };
}
