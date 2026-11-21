import { minSizeFor } from '../document/factory';
import type { DraftNode } from '../document/types';
import { describeContext, naturalSequenceSizeFor, noteLayout } from '../nodes/describe';
import { LIGHT } from '../render/theme/tokens';
import type { Rect } from '../edges/routing';
import { computeSnap, SNAP_THRESHOLD, type Guide } from './snapping';

/** Tagged notes need their tag plus one body line; the generic floor only fits a plain note. */
export function minResizeSizeFor(node: Pick<DraftNode, 'type' | 'noteKind' | 'sequence' | 'text'>): { width: number; height: number } {
  const min = minSizeFor(node.type);
  // A sequence resizes down to what it holds and no further.
  if (node.type === 'sequence') {
    const needed = naturalSequenceSizeFor(node, describeContext(LIGHT));
    return { width: Math.max(min.width, needed.width), height: Math.max(min.height, needed.height) };
  }
  if (node.type !== 'note') return min;
  const geo = noteLayout(node);
  return { ...min, height: Math.max(min.height, Math.ceil(geo.top + geo.lineHeight + geo.bottom)) };
}

export interface SizeLimits {
  min: { width: number; height: number };
  max: { width: number; height: number };
}

/**
 * The increment a hand resize lands on: a shape's width and height come out as multiples of this, so
 * two shapes sized by eye to "about the same" are the same, and a diagram holds a few sizes rather
 * than one per shape. A neighbour's edge within reach still wins, and Alt resizes freely.
 */
export const SIZE_STEP = 12;

/** The shapes whose size is the person's to choose, and so steps. A boundary fits what it holds, a
 *  note, text, code or sequence fits its content, and a Junction stays round. */
const STEPPED: ReadonlySet<DraftNode['type']> = new Set(['service', 'database', 'queue', 'actor', 'component']);

/** The size step for a shape, or none. */
export function sizeStepFor(node: Pick<DraftNode, 'type'>): number | undefined {
  return STEPPED.has(node.type) ? SIZE_STEP : undefined;
}

/** `size` on the step grid, when the nearest step is inside the limits; otherwise as it is. */
function stepped(size: number, step: number, min: number, max: number): number {
  const next = Math.round(size / step) * step;
  return next >= min && next <= max ? next : size;
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
 *
 * `threshold` is in canvas units: `snapReach(zoom).threshold`, which is the same 6 screen pixels at
 * every zoom. The default is that at zoom 1.
 *
 * With `step`, an axis no neighbour caught lands its size on the step grid instead (`SIZE_STEP`),
 * the far edge staying put. It shows no guide: there is nothing on the canvas it lined up with.
 */
export function snapResize(
  start: Rect,
  rect: Rect,
  statics: readonly Rect[],
  limits: SizeLimits,
  threshold = SNAP_THRESHOLD,
  step?: number,
): { rect: Rect; guides: Guide[] } {
  if (statics.length === 0 && !step) return { rect, guides: [] };
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
    } else if (step && !snap.guides.some((guide) => guide.axis === 'x')) {
      // (An edge already exactly on a neighbour's shows its guide with no pull: it stays there.)
      width = stepped(rect.width, step, limits.min.width, limits.max.width);
      if (leftMoved) x = rect.x + rect.width - width;
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
    } else if (step && !snap.guides.some((guide) => guide.axis === 'y')) {
      height = stepped(rect.height, step, limits.min.height, limits.max.height);
      if (topMoved) y = rect.y + rect.height - height;
    }
  }

  return { rect: { x, y, width, height }, guides };
}
