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
 * The scale a Service or a Component glyph is drawn at in its default box, and in any box that is
 * only as big as its words need: a wider Gateway is the same Gateway with more words under it,
 * where a bigger Data Store reads as a bigger store. It also keeps such a shape near the size of the
 * card it replaced, which is what the layouts around it were drawn for. A box with room to spare
 * beyond its words gives that room to the glyph (`dataStoreScale`).
 */
const SERVICE_GLYPH_SCALE = 114 / DS_UNIT_HEIGHT;
/** The width of the box that scale is drawn in by default: a glyph grows across at the pace it
 *  grows down, from there. */
const SERVICE_GLYPH_BOX = 120;

type Sized = { width: number; height: number; type?: string };
type Kinded = { type?: string; serviceKind?: string; componentKind?: string };

/**
 * The glyphs drawn narrower than the box they share: a Scheduler's page, a Module's block and its
 * lugs, a Port's plate and ball. `nodes/describe.ts` draws them from these numbers.
 *
 * Every glyph used to be given the full box's width here, on the grounds that a connector a pixel or
 * two off a narrower one reads as touching. That holds for a pixel or two. A Port is seven short on
 * each side, and at the size a glyph is drawn its side handles hung in the air beside it, with
 * every line into it stopping the same distance away.
 */
export const SCHEDULER_GLYPH_WIDTH = 44;
export const MODULE_GLYPH_WIDTH = 46;
export const PORT_GLYPH_WIDTH = 40;

/** How wide a shape's glyph is drawn at its normal size: the box's width, but for the three above. */
function glyphUnitWidth(node: Kinded): number {
  if (node.type === 'service' && node.serviceKind === 'scheduler') return SCHEDULER_GLYPH_WIDTH;
  if (node.type === 'component' && node.componentKind === 'module') return MODULE_GLYPH_WIDTH;
  if (node.type === 'component' && node.componentKind === 'port') return PORT_GLYPH_WIDTH;
  return DS_GLYPH_WIDTH;
}

/** The scale a box asks for before any growth: the older rule, which saved diagrams depend on. */
function unitScale(node: Sized): number {
  const scale = Math.max(1, Math.min(node.width / DS_UNIT_WIDTH, node.height / DS_UNIT_HEIGHT));
  return node.type === 'service' || node.type === 'component' ? Math.min(scale, SERVICE_GLYPH_SCALE) : scale;
}

/**
 * Keep the established scale for ordinary diagram sizes, then use spare width and height in boxes
 * enlarged past both thresholds. The limits reserve space for the caption, C4 detail and a possible
 * technology mark beside the glyph.
 */
function establishedScale(node: Sized): number {
  const original = unitScale(node);
  const growth = Math.min(Math.max(0, node.width - 250), Math.max(0, node.height - 200)) / 45;
  if (growth === 0) return original;
  return Math.max(original, Math.min(
    original + growth,
    (node.width - DS_GLYPH_MARGIN * 2 - DS_MARK_RESERVE) / DS_MAX_GLYPH_WIDTH,
    (node.height - 22 - DS_CAPTION_RESERVE) / DS_GLYPH_HEIGHT,
  ));
}

/** The words under a glyph, which is all of them: what the room for it is measured against. */
type Worded = { text?: string; technology?: string; description?: string };

/** The most lines `text` could be set in across `width`, at `advance` a letter: every letter taken
 *  to be as wide as the widest (the font's own size), and one more line for words that will not
 *  break where the count says. Never fewer than the text really takes. */
function linesAtMost(text: string | undefined, width: number, advance: number): number {
  if (!text?.trim()) return 0;
  const perLine = Math.max(1, Math.floor(Math.max(16, width) / advance));
  let lines = 0;
  for (const line of text.split(/\r\n|\r|\n/)) lines += Math.max(1, Math.ceil(line.trim().length / perLine));
  return lines + 1;
}

/**
 * The height the words under a Service's or a Component's glyph could need at most: the gap below
 * the glyph, the name, the kind, a technology and a description, each at its own line height and
 * rounded up. An estimate, because nothing in `document/` can measure a font, and a deliberate
 * overestimate, because the glyph is only ever given what is left after it.
 */
function wordsAtMost(node: Sized & Worded): number {
  const across = node.width - DS_GLYPH_MARGIN * 2;
  const name = Math.max(1, linesAtMost(node.text, across, 14)) * 19;
  const technology = node.technology?.trim() ? 18 : 0;
  const description = node.description?.trim() ? 8 + linesAtMost(node.description, across, 11) * 16 : 0;
  return 26 + name + technology + description;
}

/**
 * The scale a Service's or a Component's glyph is drawn at: the established one, or larger when its
 * box has room to spare beyond its words.
 *
 * A glyph of these two families used to stay one size until its box passed 250 by 200, so a wider
 * External was the same External with more words under it. That protected a box stretched to hold a
 * description, and it also meant that dragging a Load Balancer larger did nothing at all for the
 * first hundred pixels: the selection grew, and the picture and its connection points sat where
 * they were inside it. The room is now measured, not assumed: a box that is only as big as its
 * words need draws exactly as it did, and one made bigger than that gives the difference to the
 * glyph from the first pixel.
 */
export function dataStoreScale(node: Sized & Worded): number {
  const established = establishedScale(node);
  if (node.type !== 'service' && node.type !== 'component') return established;
  const spare = Math.min(
    (node.width * SERVICE_GLYPH_SCALE) / SERVICE_GLYPH_BOX,
    (node.height - wordsAtMost(node)) / (DS_GLYPH_TOP + DS_GLYPH_HEIGHT),
    (node.width - DS_GLYPH_MARGIN * 2 - DS_MARK_RESERVE) / DS_MAX_GLYPH_WIDTH,
  );
  return Math.max(established, spare);
}

/** The original top inset eases toward a smaller one as an enlarged glyph consumes the box. */
export function dataStoreGlyphTop(node: Sized & Worded): number {
  const original = unitScale(node);
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
export function dataStoreGlyphBounds(node: { x: number; y: number; width: number; height: number } & Kinded & Worded): DataStoreGlyphBounds {
  const scale = dataStoreScale(node);
  const width = Math.min(glyphUnitWidth(node) * scale, Math.max(0, node.width - DS_GLYPH_MARGIN * 2));
  const centre = node.x + node.width / 2;
  const top = node.y + Math.min(dataStoreGlyphTop(node), node.height);
  return {
    top,
    bottom: Math.min(node.y + node.height, top + DS_GLYPH_HEIGHT * scale),
    left: centre - width / 2,
    right: centre + width / 2,
  };
}

/** An Artifact's sheet is narrower than any Data Store glyph: a connector has to reach it, not the
 *  width a cylinder would have had. */
export const ARTIFACT_GLYPH_WIDTH = 36;

/** An Artifact's glyph: a Data Store's arrangement (same top, height and scale), at its own width. */
export function artifactGlyphBounds(node: { x: number; y: number; width: number; height: number; type?: string }): DataStoreGlyphBounds {
  const bounds = dataStoreGlyphBounds(node);
  const width = Math.min(ARTIFACT_GLYPH_WIDTH * dataStoreScale(node), Math.max(0, node.width - DS_GLYPH_MARGIN * 2));
  const centre = node.x + node.width / 2;
  return { ...bounds, left: centre - width / 2, right: centre + width / 2 };
}

/**
 * The Service kinds drawn as a glyph with their name underneath rather than as a card: every kind
 * but Generic, API and External. A card is a box with room on every side for the lines that reach
 * it, and those three are the ones a diagram hangs the most lines on: a plain service, the thing
 * everything calls, and the system everybody depends on. The rest are in a diagram for what they do
 * with traffic, time or work, and that is the picture. They take a Data Store's arrangement whole
 * (same glyph box, same scale), so everything that knows where a Data Store's glyph is knows where
 * theirs is.
 *
 * External was a glyph for a while (a small card in a dashed frame). It says nothing about what the
 * system does, only whose it is, so there was no mechanism to draw: the glyph was a card made small,
 * in a box that resizing did nothing to. It is a card again, and the dashed outline is its own.
 */
export function isGlyphServiceKind(kind: string | undefined): boolean {
  return kind !== undefined && kind !== 'generic' && kind !== 'api' && kind !== 'external';
}

/**
 * The Component kinds drawn the same way: every kind but Generic. A Module, an Adapter and a Port
 * were one box with a different small mark on its edge, told apart mostly by the word in the
 * corner; each is now the thing it is, in the Service glyphs' arrangement and at their size.
 */
export function isGlyphComponentKind(kind: string | undefined): boolean {
  return kind === 'module' || kind === 'adapter' || kind === 'port';
}

/** A shape's kind within its own family, whichever family that is: what the two tests above read. */
export function familyKindOf(node: { serviceKind?: string; componentKind?: string; type?: string }): string | undefined {
  return node.type === 'component' ? node.componentKind : node.serviceKind;
}

/** Whether a Service or a Component of this kind is drawn as a glyph with its name underneath. */
export function isGlyphKind(type: string | undefined, kind: string | undefined): boolean {
  return (type === 'service' && isGlyphServiceKind(kind)) || (type === 'component' && isGlyphComponentKind(kind));
}

/** The same test for a whole shape. */
export function isGlyphShape(node: { type?: string; serviceKind?: string; componentKind?: string }): boolean {
  return isGlyphKind(node.type, familyKindOf(node));
}
