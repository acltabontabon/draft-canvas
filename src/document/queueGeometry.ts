import { artifactGlyphBounds, dataStoreGlyphBounds, glyphHeadroom, isGlyphShape } from './dataStoreGeometry';
import type { DraftNode, Side } from './types';

/**
 * Where a Queue/Topic/Stream node's tube glyph sits, vertically, relative to the node's own top
 * edge — shared with `nodes/describe.ts` so drawing, handles and routing use the same tube.
 * A box enlarged beyond the usual diagram sizes gives the tube more height and centres the
 * tube-and-caption block vertically. Smaller boxes retain their established layout.
 *
 * Lives in `document/` rather than beside the renderer because it's *placement* knowledge, not
 * drawing: `edges/routing.ts` reads it (via `anchorBandOf`) so a left/right connector lands on the
 * glyph instead of on the gap between the tube and its caption.
 */
export function queueTubeSpan(height: number, width = Infinity): { top: number; bottom: number } {
  const h = height - 1.5;
  const compact = Math.min(32, h * 0.5);
  const growth = Math.min(Math.max(0, height - 110) * 1.25, Math.max(0, width - 200) * 0.65);
  const tubeH = growth === 0 ? compact : Math.min(32 + growth, (width - 1.5) * 0.38, height - 39);
  const centredTop = (height - tubeH - 22) / 2;
  const top = 0.75 + Math.max(0, centredTop - 0.75) * Math.min(1, growth / 20);
  return { top, bottom: top + tubeH };
}

/**
 * Where a connector's anchors land, when that isn't simply the box's own edge — for a node whose
 * drawn glyph is smaller than its box. Only anchor placement reads it: obstacle, overlap and
 * selection geometry always use the full box.
 *
 * `top`/`bottom` is the absolute vertical band a left/right connector is distributed over. The
 * optional `left`/`right` are the absolute x of the glyph's own edges, where a left/right
 * connector meets it instead of the box edge, and between which a top or bottom connector is
 * distributed (`bandSpan`); `glyphTop` is the y a top connector meets it at. Absent means the box
 * edge.
 */
export interface AnchorBand {
  top: number;
  bottom: number;
  left?: number;
  right?: number;
  glyphTop?: number;
}

/**
 * The band a node's connectors should land on — the tube for a queue-family node (vertical only:
 * it fills the box's width), the glyph for a Data Store or an Artifact (which is narrow, centred and sits near the
 * top of its box, so a left/right arrow used to stop a good way short of it), `undefined` (meaning
 * the whole side) for everything else, whose drawn body fills its box. A bottom connector is
 * unaffected: it leaves below the captions rather than through them.
 */
export function anchorBandOf(
  node: Pick<DraftNode, 'type' | 'x' | 'y' | 'width' | 'height'> & Pick<Partial<DraftNode>, 'serviceKind' | 'componentKind' | 'databaseKind' | 'artifactKind' | 'text' | 'technology' | 'description'>,
): AnchorBand | undefined {
  if (node.type === 'queue') {
    const span = queueTubeSpan(node.height, node.width);
    return {
      top: node.y + span.top,
      bottom: node.y + span.bottom,
      ...(span.top > 0.75 ? { glyphTop: node.y + span.top } : {}),
    };
  }
  if (node.type === 'database' || isGlyphShape(node)) {
    const glyph = dataStoreGlyphBounds(node);
    return { top: glyph.top, bottom: glyph.bottom, left: glyph.left, right: glyph.right, glyphTop: glyph.top + glyphHeadroom(node) };
  }
  if (node.type === 'artifact') {
    const glyph = artifactGlyphBounds(node);
    return { top: glyph.top, bottom: glyph.bottom, left: glyph.left, right: glyph.right, glyphTop: glyph.top };
  }
  return undefined;
}

/**
 * Whether a shape has only the middle point of each side to connect to. A Junction (`ellipse`) is a
 * circle that touches its box only there, so its handles (`DraftNodeView`) are those four alone; every
 * other shape has three per side. An end pinned anywhere else on a Junction named a handle that does
 * not exist ("left@2"): React Flow could not find it (error 008) and drew no connector at all, which
 * is how agent-made diagrams that ended lines at junctions lost them.
 */
export function middlePointsOnly(type: DraftNode['type'] | undefined): boolean {
  return type === 'ellipse';
}

/** `anchor` on a point a shape of `type` really has: a Junction's end moves to the middle of its
 *  side (`middlePointsOnly`), every other shape's is returned as it is. */
export function anchorOnShape<A extends { offset: number }>(type: DraftNode['type'] | undefined, anchor: A): A {
  return middlePointsOnly(type) && anchor.offset !== 0.5 ? { ...anchor, offset: 0.5 } : anchor;
}

/**
 * How much wider than a glyph the stretch its top and bottom anchors are spread along is: the width
 * of a default glyph box (120) over the glyph drawn in it (54 at 114 / 88, a hair under 70). A shape
 * at its default size therefore has its anchors exactly where they always were, a quarter, a half
 * and three quarters of the way across its box, and that puts the outer two just inside the glyph's
 * corners.
 */
const GLYPH_REACH = (120 * 88) / (54 * 114);

/**
 * The stretch of one side a shape's anchors are spread along: where it starts and how long it is, on
 * the axis the side runs along. The one statement of it, for the router, the handles and the layout.
 *
 * Left and right use the band's height. Top and bottom use the box's width, held to the glyph's
 * reach when there is a glyph: its anchors were spread across the whole box, so a box made wider
 * for the words under the glyph pushed the outer two out into the air beside it, further the wider
 * the box. They now stay on the glyph's shoulders whatever the box does, and move only when the
 * glyph itself grows.
 */
export function bandSpan(
  box: { x: number; y: number; width: number; height: number },
  band: AnchorBand | undefined,
  side: Side,
): { start: number; length: number } {
  if (side === 'left' || side === 'right') {
    return band ? { start: band.top, length: band.bottom - band.top } : { start: box.y, length: box.height };
  }
  if (band?.left === undefined || band.right === undefined) return { start: box.x, length: box.width };
  const length = Math.min(box.width, (band.right - band.left) * GLYPH_REACH);
  return { start: (band.left + band.right) / 2 - length / 2, length };
}

/** How far along a top or bottom side an end may sit at all: the glyph's own width when there is
 *  one, so an end nudged or straightened along the side never leaves what is drawn. */
export function bandReach(box: { x: number; width: number }, band: AnchorBand | undefined): { min: number; max: number } {
  return { min: band?.left ?? box.x, max: band?.right ?? box.x + box.width };
}

/**
 * The fields `bandWords` takes, named one by one for whatever compares two shapes by them
 * (`edges/sameGeometry.ts`). Read off what `bandWords({})` returns, the list would come out empty
 * the day it stopped writing out the fields a shape leaves unset, and every shape would compare
 * equal. `tests/plan-reuse.test.ts` holds the two to the same fields.
 */
export const BAND_WORD_FIELDS = ['serviceKind', 'componentKind', 'databaseKind', 'artifactKind', 'text', 'technology', 'description'] as const satisfies readonly (keyof DraftNode)[];

type BandWord = (typeof BAND_WORD_FIELDS)[number];

/**
 * What of a shape decides where its glyph stands, beside its box: the kind it is drawn as and the
 * words under it. Anything that builds a box to ask `anchorBandOf` about, from a live size or a
 * shape not made yet, takes these from the shape whole, so the handles, the lines and the drawing
 * are asked about the same thing.
 */
export function bandWords(shape: Pick<Partial<DraftNode>, BandWord>): Pick<Partial<DraftNode>, BandWord> {
  return {
    serviceKind: shape.serviceKind,
    componentKind: shape.componentKind,
    databaseKind: shape.databaseKind,
    artifactKind: shape.artifactKind,
    text: shape.text,
    technology: shape.technology,
    description: shape.description,
  };
}
