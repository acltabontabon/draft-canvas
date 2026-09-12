import { libraryShapeOf } from '../../document/shape';
import type { LibraryShape } from '../../document/types';
import { buildStarter } from '../../starters/build';
import type { ArchitectureStarter, StarterId } from '../../starters/types';
import { layoutShape, type ShapeBox } from './shapeLayout';

/** Deeper than this and a pulse through the topology stops reading as one gesture. */
export const MAX_PULSE_DEPTH = 4;

/** The glyph's drawing box on a home-screen tile, in CSS pixels (drawn 1:1). */
export const GLYPH_WIDTH = 144;
export const GLYPH_HEIGHT = 76;
const GLYPH_PAD = 5;

export interface StarterShape {
  shape: LibraryShape;
  /** Per `shape.edges` entry: how many hops its source sits from a node nothing points into. */
  depths: number[];
  /** `shape.nodes` laid out in the glyph box — fitted, vertically centred, flush left so every
   *  drawing starts on the same edge as the name under it. */
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
  const shape = libraryShapeOf(nodes, edges);
  const fitted = layoutShape(shape, GLYPH_WIDTH, GLYPH_HEIGHT, GLYPH_PAD);
  const left = Math.min(...fitted.map((box) => box.x));
  const right = Math.max(...fitted.map((box) => box.x + box.w));
  const shift = Number.isFinite(left) ? GLYPH_PAD - left : 0;
  const boxes = fitted.map((box) => ({ ...box, x: box.x + shift, cx: box.cx + shift }));
  const drawn = Number.isFinite(left);
  const top = drawn ? Math.min(...boxes.map((box) => box.y)) : 0;
  const bottom = drawn ? Math.max(...boxes.map((box) => box.y + box.h)) : GLYPH_HEIGHT;
  const width = drawn ? right - left : GLYPH_WIDTH;
  const centerX = drawn ? (GLYPH_PAD + width / 2) / GLYPH_WIDTH : 0.5;
  const bounds = { x: drawn ? GLYPH_PAD : 0, y: top, width, height: bottom - top };
  const result = { shape, depths: edgeDepths(shape), boxes, centerX, bounds };
  cache.set(starter.id, result);
  return result;
}

/**
 * Breadth-first from every node with no incoming edge, so a pulse can travel producer → topic →
 * consumers in the order the diagram reads. A cycle with no entry point starts from its first
 * edge's source; anything still unreached (a disconnected island) goes first.
 */
export function edgeDepths(shape: LibraryShape): number[] {
  const incoming = new Array<number>(shape.nodes.length).fill(0);
  const outgoing = shape.nodes.map(() => [] as number[]);
  for (const [from, to] of shape.edges) {
    incoming[to] = (incoming[to] ?? 0) + 1;
    outgoing[from]?.push(to);
  }
  const depth = new Array<number>(shape.nodes.length).fill(-1);
  const queue: number[] = [];
  for (const [from] of shape.edges) {
    if (incoming[from] === 0 && depth[from] === -1) {
      depth[from] = 0;
      queue.push(from);
    }
  }
  if (queue.length === 0 && shape.edges.length > 0) {
    const [from] = shape.edges[0]!;
    depth[from] = 0;
    queue.push(from);
  }
  for (let head = 0; head < queue.length; head += 1) {
    const node = queue[head]!;
    for (const next of outgoing[node] ?? []) {
      if (depth[next] !== -1) continue;
      depth[next] = depth[node]! + 1;
      queue.push(next);
    }
  }
  return shape.edges.map(([from]) => Math.min(MAX_PULSE_DEPTH, Math.max(0, depth[from] ?? 0)));
}
