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
 * only as big as its words need: a wider Gateway is the same Gateway with more words under it. It
 * also keeps such a shape near the size of the card it replaced, which is what the layouts around
 * it were drawn for. A box with room to spare beyond its words gives it to the glyph (`standingOf`).
 */
const SERVICE_GLYPH_SCALE = 114 / DS_UNIT_HEIGHT;

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

/** How far below the glyph box's top an Adapter's body starts, at its normal size: its cup and its
 *  plug are shorter still, so the glyph is drawn with air over it and its top anchors stand on the
 *  body, not on the box. */
export const ADAPTER_BODY_INSET = 5;

/** How far below its glyph box's top a shape's drawing starts, at the scale it is drawn at. */
export function glyphHeadroom(node: Sized & Kinded & Worded): number {
  return node.type === 'component' && node.componentKind === 'adapter' ? ADAPTER_BODY_INSET * dataStoreScale(node) : 0;
}

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
type Worded = { text?: string; technology?: string; description?: string; databaseKind?: string; artifactKind?: string };

/** The line heights the words under a glyph are set at (`render/text/fonts.ts`: 14, 9, 10 and 11
 *  point, each at the label ratio of 1.35), and the gaps `nodes/describe.ts` puts between them. */
const NAME_LINE = 14 * 1.35;
const KIND_LINE = 9 * 1.35;
const TECHNOLOGY_LINE = 10 * 1.35;
const DESCRIPTION_LINE = 11 * 1.35;
const WORDS_TOP = 5;
const WORDS_BOTTOM = 4;

/** Counts the lines a name or a description is set in across a width. */
export type WordsMeasure = (text: string, width: number, part: 'name' | 'description') => number;

let measureWords: WordsMeasure | null = null;
const measured = new Map<string, number>();

/**
 * Gives this module a way to count lines. Nothing in `document/` can measure a font, so the module
 * that lays the words out (`nodes/describe.ts`) hands over the count it would arrive at itself;
 * without one (a migration, a test of the geometry alone) every count is rounded up instead.
 */
export function setWordsMeasure(measure: WordsMeasure | null): void {
  measureWords = measure;
  measured.clear();
}

/**
 * How many lines `text` is set in across `width`, never fewer than it really takes. A paragraph that
 * would fit even if every letter were as wide as the font is tall (`advance`) is one line, and
 * nothing is asked or built for it, which is nearly every name. Anything longer is measured when
 * there is a measure, and otherwise counted at that width with one more line for words that will
 * not break where the count says.
 */
function linesOf(text: string | undefined, width: number, advance: number, part: 'name' | 'description'): number {
  const words = text?.trim();
  if (!words) return 0;
  const broken = /[\r\n]/.test(words);
  if (!broken && words.length * advance <= width) return 1;
  if (measureWords) {
    const key = `${part}${width}\u0000${words}`;
    let lines = measured.get(key);
    if (lines === undefined) {
      lines = Math.max(1, measureWords(words, width, part));
      // A diagram's worth and more: cleared whole when it fills, since what is in it is cheap to count again.
      if (measured.size >= 4096) measured.clear();
      measured.set(key, lines);
    }
    return lines;
  }
  let lines = 0;
  for (const line of words.split(/\r\n|\r|\n/)) {
    const wide = line.trim().length * advance;
    lines += wide <= width ? 1 : Math.ceil(wide / width) + 1;
  }
  return lines;
}

/** Whether a shape's kind is written under its name: every glyph Service and Component, and the Data
 *  Stores and Artifacts that are something more particular than the family's plain one. */
function hasKindWord(node: Kinded & Worded): boolean {
  if (node.type === 'database') return node.databaseKind !== undefined && node.databaseKind !== 'generic';
  if (node.type === 'artifact') return node.artifactKind !== undefined && node.artifactKind !== 'file';
  return true;
}

/**
 * The height the words under a glyph take, from the glyph's foot to the box's: the gap, the name, the
 * kind, a technology and a description, at the line heights they are set in. Never less than they
 * really take (`linesOf`): the glyph is only ever given what the words leave.
 */
function wordsAtMost(node: Sized & Kinded & Worded, nameLines?: number): number {
  const across = Math.max(16, node.width - DS_GLYPH_MARGIN * 2);
  // A shape with no name yet keeps a name's room: it stands where it will once it has one, and a
  // box asked about before its shape exists (a suggestion's, a turned shape's) is asked the same.
  const lines = nameLines ?? Math.max(1, linesOf(node.text, across, 14, 'name'));
  const name = lines * NAME_LINE;
  const kind = hasKindWord(node) ? (lines ? 2 : 0) + KIND_LINE : 0;
  const technology = node.technology?.trim() ? TECHNOLOGY_LINE : 0;
  const description = linesOf(node.description, across, 11, 'description') * DESCRIPTION_LINE;
  const detail = technology || description ? 3 + technology + (technology && description ? 2 : 0) + description : 0;
  return WORDS_TOP + name + kind + detail + WORDS_BOTTOM;
}

/** The room a default box leaves under a one-line name, with or without a kind beneath it: what is
 *  left of 114 below a glyph at the default scale. */
function footOf(kinded: boolean): number {
  return 114 - (DS_GLYPH_TOP + DS_GLYPH_HEIGHT) * SERVICE_GLYPH_SCALE - WORDS_TOP - NAME_LINE - (kinded ? 2 + KIND_LINE : 0) - WORDS_BOTTOM;
}

/**
 * How much room a box may have to spare before its glyph starts to take it, and the stretch over
 * which it catches up. Boxes are not all fitted to the pixel: one a migration sized from a table
 * (143 high for any description, where one line needs 132) has most of a line more than its words
 * use, and its connectors were laid against the glyph where it stands. Those stay exactly as they
 * are. Past that the box was made bigger on purpose, and over the next few pixels the glyph takes
 * all of it.
 */
const SPARE_KEPT = 12;
/** A Data Store or an Artifact was never sized from that table, only fitted or drawn: less is kept. */
const SPARE_KEPT_STORE = 8;
const SPARE_TAKEN = 12;

/**
 * How a glyph stands in its box: the scale it is drawn at and how far down its top is.
 *
 * It used to stand at the top at a scale read from the box alone, with whatever the box had left
 * over below its name. In a default box that is a few pixels. In a box somebody made bigger it was a
 * band of nothing between the name and the bottom connection points, which sit on the box's foot:
 * the selection grew, and the picture and its points stayed where they were. A Service or Component
 * glyph did not grow at all until its box passed 250 by 200.
 *
 * The room is now measured. In a box with room to spare, the glyph grows into the height its words
 * do not need, as far as the box's width lets it, and whatever is still left over goes above it,
 * where nothing is drawn and no connection point stands: the bottom three stay under the name at
 * any size. A box that is only as big as its words need draws exactly as it did.
 */
function standingOf(node: Sized & Kinded & Worded): { scale: number; top: number } {
  const original = unitScale(node);
  const words = wordsAtMost(node);
  const topAt = (scale: number) => Math.max(DS_GLYPH_TOP, DS_GLYPH_TOP * original - (scale - original) * 5);
  const was = establishedScale(node);
  const wasTop = topAt(was);
  const spare = node.height - wasTop - DS_GLYPH_HEIGHT * was - words - footOf(hasKindWord(node));
  const kept = node.type === 'service' || node.type === 'component' ? SPARE_KEPT : SPARE_KEPT_STORE;
  if (spare <= kept) return { scale: was, top: wasTop };

  // Filled: as large as the height and the width allow, lowered onto the foot a kind line leaves.
  const foot = footOf(true);
  const scale = Math.max(was, Math.min(
    (node.height - words - foot) / (DS_GLYPH_TOP + DS_GLYPH_HEIGHT),
    (node.width - DS_GLYPH_MARGIN * 2 - DS_MARK_RESERVE) / DS_MAX_GLYPH_WIDTH,
  ));
  const top = topAt(scale) + Math.max(0, node.height - topAt(scale) - DS_GLYPH_HEIGHT * scale - words - foot);
  const taken = Math.min(1, (spare - kept) / SPARE_TAKEN);
  return { scale: was + (scale - was) * taken, top: wasTop + (top - wasTop) * taken };
}

/** The scale a shape's glyph is drawn at (`standingOf`). */
export function dataStoreScale(node: Sized & Kinded & Worded): number {
  return standingOf(node).scale;
}

/** How far below its box's top a shape's glyph starts (`standingOf`). */
export function dataStoreGlyphTop(node: Sized & Kinded & Worded): number {
  return standingOf(node).top;
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
export function artifactGlyphBounds(node: { x: number; y: number; width: number; height: number } & Kinded & Worded): DataStoreGlyphBounds {
  const bounds = dataStoreGlyphBounds(node);
  const width = Math.min(ARTIFACT_GLYPH_WIDTH * dataStoreScale(node), Math.max(0, node.width - DS_GLYPH_MARGIN * 2));
  const centre = node.x + node.width / 2;
  return { ...bounds, left: centre - width / 2, right: centre + width / 2 };
}

/**
 * The Service kinds drawn as a glyph with their name underneath rather than as a card: every kind
 * but Generic and External. A card says "a thing that runs" and nothing more, so the two kinds that
 * are nothing more keep it, one drawn as yours and one as somebody else's; the rest are in a diagram
 * for what they do with traffic, time or work, and that is the picture. They take a Data Store's
 * arrangement whole (same glyph box, same scale), so everything that knows where a Data Store's
 * glyph is knows where theirs is.
 *
 * The two have changed places. An API was a card with a notch in its side, told from Generic by the
 * word in its corner, and it is the kind with the clearest thing to draw: what it offers. An
 * External system was a glyph (a small card in a dashed frame), and it says nothing about what the
 * system does, only whose it is, so there was no mechanism to draw.
 */
export function isGlyphServiceKind(kind: string | undefined): boolean {
  return kind !== undefined && kind !== 'generic' && kind !== 'external';
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
