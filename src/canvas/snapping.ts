import type { Rect } from '../edges/routing';

/**
 * Alignment snapping.
 *
 * The brief this tool is built against is that a user should almost never reach
 * for an "align" command, because dragging already lands things in the right
 * place. Nodes snap to the edges and centres of their neighbours, and to an
 * even spacing with them.
 */

/** How close, in canvas units, before a candidate takes hold. */
export const SNAP_THRESHOLD = 6;

export interface Guide {
  axis: 'x' | 'y';
  /** Position of the guide on its axis. */
  at: number;
  /** The extent to draw, so a guide spans only the nodes it relates. */
  from: number;
  to: number;
}

export interface SnapResult {
  dx: number;
  dy: number;
  guides: Guide[];
}

const NO_SNAP: SnapResult = { dx: 0, dy: 0, guides: [] };

interface Candidate {
  delta: number;
  at: number;
  from: number;
  to: number;
}

export function boundsOfRects(rects: readonly Rect[]): Rect | null {
  if (rects.length === 0) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const rect of rects) {
    minX = Math.min(minX, rect.x);
    minY = Math.min(minY, rect.y);
    maxX = Math.max(maxX, rect.x + rect.width);
    maxY = Math.max(maxY, rect.y + rect.height);
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

/**
 * Finds the nearest alignment for the moving bounds against static neighbours.
 *
 * Only the closest candidate per axis wins, so a node cannot be pulled two ways
 * at once, and the guide returned spans just far enough to show what it lined
 * up with.
 */
export function computeSnap(
  moving: Rect,
  statics: readonly Rect[],
  threshold = SNAP_THRESHOLD,
): SnapResult {
  if (statics.length === 0) return NO_SNAP;

  const movingEdgesX = [moving.x, moving.x + moving.width / 2, moving.x + moving.width];
  const movingEdgesY = [moving.y, moving.y + moving.height / 2, moving.y + moving.height];

  let bestX: Candidate | null = null;
  let bestY: Candidate | null = null;

  for (const other of statics) {
    const otherEdgesX = [other.x, other.x + other.width / 2, other.x + other.width];
    const otherEdgesY = [other.y, other.y + other.height / 2, other.y + other.height];

    for (const from of movingEdgesX) {
      for (const to of otherEdgesX) {
        const delta = to - from;
        if (Math.abs(delta) > threshold) continue;
        if (bestX && Math.abs(bestX.delta) <= Math.abs(delta)) continue;
        bestX = {
          delta,
          at: to,
          from: Math.min(moving.y, other.y),
          to: Math.max(moving.y + moving.height, other.y + other.height),
        };
      }
    }

    for (const from of movingEdgesY) {
      for (const to of otherEdgesY) {
        const delta = to - from;
        if (Math.abs(delta) > threshold) continue;
        if (bestY && Math.abs(bestY.delta) <= Math.abs(delta)) continue;
        bestY = {
          delta,
          at: to,
          from: Math.min(moving.x, other.x),
          to: Math.max(moving.x + moving.width, other.x + other.width),
        };
      }
    }
  }

  const guides: Guide[] = [];
  if (bestX) guides.push({ axis: 'x', at: bestX.at, from: bestX.from, to: bestX.to });
  if (bestY) guides.push({ axis: 'y', at: bestY.at, from: bestY.from, to: bestY.to });

  return { dx: bestX?.delta ?? 0, dy: bestY?.delta ?? 0, guides };
}

/** Guides only change when alignment is gained or lost, not every frame. */
export function sameGuides(a: readonly Guide[], b: readonly Guide[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((guide, index) => {
    const other = b[index]!;
    return (
      guide.axis === other.axis &&
      Math.abs(guide.at - other.at) < 0.5 &&
      Math.abs(guide.from - other.from) < 0.5 &&
      Math.abs(guide.to - other.to) < 0.5
    );
  });
}
