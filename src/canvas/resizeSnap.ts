import type { Rect } from '../edges/routing';
import { computeSnap, SNAP_THRESHOLD, type Guide } from './snapping';

export interface SizeLimits {
  min: { width: number; height: number };
  max: { width: number; height: number };
}

/** Below this, an edge counts as where it started (sub-pixel noise from zoomed pointer maths). */
const MOVED = 0.5;

/**
 * Snaps a resize in progress. Only the edges the handle is actually moving snap — the far edges stay
 * exactly where the gesture started — found by comparing against the rect the node had when it
 * began: a top-right handle moves the top and right edges, so `x` never changes and `y` does.
 * (React Flow's own changes can't say this: it reports a position change whenever either axis
 * moves, carrying the other axis unchanged.)
 *
 * A snap that would take the size outside `limits` is dropped for that axis rather than clamped,
 * so the edge never lands short of the guide it shows.
 */
export function snapResize(
  start: Rect,
  rect: Rect,
  statics: readonly Rect[],
  limits: SizeLimits,
  threshold = SNAP_THRESHOLD,
): { rect: Rect; guides: Guide[] } {
  if (statics.length === 0) return { rect, guides: [] };
  const guides: Guide[] = [];
  let { x, y, width, height } = rect;

  const leftMoved = Math.abs(rect.x - start.x) > MOVED;
  const rightMoved = Math.abs(rect.x + rect.width - (start.x + start.width)) > MOVED;
  if (leftMoved || rightMoved) {
    const edge = leftMoved ? rect.x : rect.x + rect.width;
    const snap = computeSnap({ x: edge, y: rect.y, width: 0, height: rect.height }, statics, threshold);
    const nextWidth = leftMoved ? rect.width - snap.dx : rect.width + snap.dx;
    if (snap.dx !== 0 && nextWidth >= limits.min.width && nextWidth <= limits.max.width) {
      width = nextWidth;
      if (leftMoved) x = rect.x + snap.dx;
      guides.push(...snap.guides.filter((guide) => guide.axis === 'x'));
    }
  }

  const topMoved = Math.abs(rect.y - start.y) > MOVED;
  const bottomMoved = Math.abs(rect.y + rect.height - (start.y + start.height)) > MOVED;
  if (topMoved || bottomMoved) {
    const edge = topMoved ? rect.y : rect.y + rect.height;
    const snap = computeSnap({ x: rect.x, y: edge, width: rect.width, height: 0 }, statics, threshold);
    const nextHeight = topMoved ? rect.height - snap.dy : rect.height + snap.dy;
    if (snap.dy !== 0 && nextHeight >= limits.min.height && nextHeight <= limits.max.height) {
      height = nextHeight;
      if (topMoved) y = rect.y + snap.dy;
      guides.push(...snap.guides.filter((guide) => guide.axis === 'y'));
    }
  }

  return { rect: { x, y, width, height }, guides };
}
