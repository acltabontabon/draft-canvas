/** `n` held within `[min, max]`. */
export const clamp = (n: number, min: number, max: number): number => Math.max(min, Math.min(max, n));

interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** The middle of an axis-aligned box — a node, a rect, a bounds. */
export function centerOf(box: Box): { x: number; y: number } {
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

/** Whether a point lies inside (or on the edge of) an axis-aligned box. */
export function pointInBox(point: { x: number; y: number }, box: Box): boolean {
  return point.x >= box.x && point.x <= box.x + box.width && point.y >= box.y && point.y <= box.y + box.height;
}
