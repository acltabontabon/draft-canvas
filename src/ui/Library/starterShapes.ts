import { libraryShapeOf } from '../../document/shape';
import type { LibraryShape } from '../../document/types';
import { buildStarter } from '../../starters/build';
import type { ArchitectureStarter, StarterId } from '../../starters/types';
import { layoutShape, type ShapeBox } from './shapeLayout';

/** The glyph's drawing box on a home-screen tile, in CSS pixels (drawn 1:1). */
export const GLYPH_WIDTH = 144;
export const GLYPH_HEIGHT = 76;
const GLYPH_PAD = 5;

export interface StarterShape {
  shape: LibraryShape;
  /** `shape.nodes` laid out in the glyph box — fitted and centred on both axes, so every tile
   *  carries the same optical footprint whatever the drawing's proportions. */
  boxes: ShapeBox[];
  /** Horizontal middle of the drawing, as a fraction of the glyph's width. */
  centerX: number;
  /** The drawing's own extent inside the glyph box — what a selection frame should hug. */
  bounds: { x: number; y: number; width: number; height: number };
}

const cache = new Map<StarterId, StarterShape>();

/**
 * A starter's topology, derived from the starter itself — the same `buildStarter` a click on it
 * runs, reduced by the same `libraryShapeOf` every saved canvas's fingerprint goes through. No
 * second, hand-maintained drawing of any architecture exists: change a starter in the catalog and
 * its tile on the home screen changes with it. Built once per starter, on first use.
 */
export function starterShape(starter: ArchitectureStarter): StarterShape {
  const cached = cache.get(starter.id);
  if (cached) return cached;
  const { nodes, edges } = buildStarter(starter, { x: 0, y: 0 });
  const result = glyphShapeOf(libraryShapeOf(nodes, edges));
  cache.set(starter.id, result);
  return result;
}

/**
 * Any topology laid out as a tile glyph. Starters come through here, and so do the desktop Home's
 * own files, so a diagram someone drew and a starter they might pick are drawn in one hand.
 */
export function glyphShapeOf(shape: LibraryShape): StarterShape {
  const boxes = layoutShape(shape, GLYPH_WIDTH, GLYPH_HEIGHT, GLYPH_PAD);
  const drawn = boxes.length > 0;
  const left = drawn ? Math.min(...boxes.map((box) => box.x)) : 0;
  const right = drawn ? Math.max(...boxes.map((box) => box.x + box.w)) : GLYPH_WIDTH;
  const top = drawn ? Math.min(...boxes.map((box) => box.y)) : 0;
  const bottom = drawn ? Math.max(...boxes.map((box) => box.y + box.h)) : GLYPH_HEIGHT;
  const centerX = (left + right) / 2 / GLYPH_WIDTH;
  const bounds = { x: left, y: top, width: right - left, height: bottom - top };
  return { shape, boxes, centerX, bounds };
}
