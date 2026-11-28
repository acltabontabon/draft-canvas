import { getViewportForBounds, type Viewport } from '@xyflow/react';
import type { Bounds } from '../../document/geometry';
import { fitPadding } from '../../lib/fitPadding';

/** How far from the free area's edges a revealed change sits. */
const REVEAL_MARGIN = 48;

/**
 * The camera that shows `bounds` inside `free` (the canvas clear of the review panel) with as little
 * movement as possible: `null` when it is already in view, else a pan just far enough at the same zoom,
 * or, when it can't fit at that zoom, the zoom that fits it (never closer than now).
 */
export function revealViewport(bounds: Bounds | null, transform: [number, number, number], free: { width: number; height: number }): Viewport | null {
  if (!bounds || free.width <= 0 || free.height <= 0) return null;
  const [tx, ty, zoom] = transform;
  const m = REVEAL_MARGIN;
  if (bounds.width * zoom + 2 * m > free.width || bounds.height * zoom + 2 * m > free.height) {
    return getViewportForBounds(bounds, free.width, free.height, 0.1, zoom, fitPadding(0.2));
  }
  const left = bounds.x * zoom + tx;
  const right = (bounds.x + bounds.width) * zoom + tx;
  const top = bounds.y * zoom + ty;
  const bottom = (bounds.y + bounds.height) * zoom + ty;
  const dx = left < m ? m - left : right > free.width - m ? free.width - m - right : 0;
  const dy = top < m ? m - top : bottom > free.height - m ? free.height - m - bottom : 0;
  if (dx === 0 && dy === 0) return null;
  return { x: tx + dx, y: ty + dy, zoom };
}
