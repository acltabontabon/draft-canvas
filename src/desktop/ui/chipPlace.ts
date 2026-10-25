import { getViewportForBounds, type Viewport } from '@xyflow/react';
import type { Bounds } from '../../document/geometry';

/** The chip's size, for placing it beside the change before it has drawn (`desktop.css`). */
export const CHIP_WIDTH = 300;
export const CHIP_HEIGHT = 150;
const CHIP_GAP = 12;

/** A rectangle in the canvas's own pixels. */
export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Where the chip goes, in the canvas's own pixels: beside the change rather than over it — to its
 *  left first (the companion keeps the bottom-right), then above, right or below — and always inside
 *  the canvas, so it can be found while the change is off screen. `height` is the chip as drawn (it
 *  grows with its history and problems); `keepOut` covers the companion and Depth chrome. */
export function chipPlace(bounds: Bounds | null, transform: [number, number, number], view: { width: number; height: number }, height = CHIP_HEIGHT, keepOut: Box | readonly Box[] | null = null) {
  const obstacles: readonly Box[] = keepOut === null ? [] : 'x' in keepOut ? [keepOut] : keepOut;
  const clamp = (value: number, max: number) => Math.round(Math.min(Math.max(value, CHIP_GAP), Math.max(CHIP_GAP, max)));
  const clear = (at: { left: number; top: number }) =>
    obstacles.every((box) => at.left + CHIP_WIDTH <= box.x || at.left >= box.x + box.width || at.top + height <= box.y || at.top >= box.y + box.height);
  const bounded = (at: { left: number; top: number }) => ({ left: clamp(at.left, view.width - CHIP_WIDTH - CHIP_GAP), top: clamp(at.top, view.height - height - CHIP_GAP) });
  const settle = (at: { left: number; top: number }) => {
    const placed = bounded(at);
    if (clear(placed)) return placed;
    // Try beside each piece of chrome, then intersections of their free bands. Every candidate is
    // bounded and checked against *all* obstacles, so avoiding Nodi cannot put the chip under Depth.
    const xs = [placed.left, ...obstacles.flatMap((box) => [box.x - CHIP_GAP - CHIP_WIDTH, box.x + box.width + CHIP_GAP])];
    const ys = [placed.top, ...obstacles.flatMap((box) => [box.y - CHIP_GAP - height, box.y + box.height + CHIP_GAP])];
    const candidates = [
      ...xs.slice(1).map((left) => bounded({ left, top: placed.top })),
      ...ys.slice(1).map((top) => bounded({ left: placed.left, top })),
      ...xs.flatMap((left) => ys.map((top) => bounded({ left, top }))),
    ];
    return candidates.find(clear) ?? placed;
  };
  if (!bounds) return settle({ left: CHIP_GAP, top: CHIP_GAP });
  const [tx, ty, zoom] = transform;
  const left = bounds.x * zoom + tx;
  const top = bounds.y * zoom + ty;
  const right = (bounds.x + bounds.width) * zoom + tx;
  const bottom = (bounds.y + bounds.height) * zoom + ty;
  const fitsX = (x: number) => x >= CHIP_GAP && x + CHIP_WIDTH <= view.width - CHIP_GAP;
  const fitsY = (y: number) => y >= CHIP_GAP && y + height <= view.height - CHIP_GAP;
  const candidates = [
    { left: left - CHIP_GAP - CHIP_WIDTH, top },
    { left, top: top - CHIP_GAP - height },
    { left: right + CHIP_GAP, top },
    { left, top: bottom + CHIP_GAP },
  ];
  return settle(candidates.find((c) => fitsX(c.left) && fitsY(c.top) && clear(c)) ?? candidates[0]!);
}

/** How far from the free area's edges a revealed change sits. */
const REVEAL_MARGIN = 48;

/**
 * The camera that shows `bounds` inside `free` (the canvas left of the companion) with as little
 * movement as possible: `null` when it is already in view, else a pan just far enough at the same zoom,
 * or, when it can't fit at that zoom, the zoom that fits it (never closer than now).
 */
export function revealViewport(bounds: Bounds | null, transform: [number, number, number], free: { width: number; height: number }): Viewport | null {
  if (!bounds || free.width <= 0 || free.height <= 0) return null;
  const [tx, ty, zoom] = transform;
  const m = REVEAL_MARGIN;
  if (bounds.width * zoom + 2 * m > free.width || bounds.height * zoom + 2 * m > free.height) {
    return getViewportForBounds(bounds, free.width, free.height, 0.1, zoom, 0.2);
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
