/**
 * The small amount of plane geometry handwriting needs: lengths, resampling, simplification,
 * distances. Pure functions over plain points, no allocation beyond what they return.
 */

export interface Pt {
  x: number;
  y: number;
}

export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

export function dist(a: Pt, b: Pt): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

export function pathLength(points: readonly Pt[]): number {
  let length = 0;
  for (let i = 1; i < points.length; i += 1) length += dist(points[i - 1]!, points[i]!);
  return length;
}

export function boxOf(points: readonly Pt[]): Box {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of points) {
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
  }
  if (!Number.isFinite(minX)) return { x: 0, y: 0, width: 0, height: 0 };
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

export function unionBox(boxes: readonly Box[]): Box {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const b of boxes) {
    minX = Math.min(minX, b.x);
    minY = Math.min(minY, b.y);
    maxX = Math.max(maxX, b.x + b.width);
    maxY = Math.max(maxY, b.y + b.height);
  }
  if (!Number.isFinite(minX)) return { x: 0, y: 0, width: 0, height: 0 };
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

/** The shortest distance between two boxes; 0 when they touch or overlap. */
export function boxGap(a: Box, b: Box): number {
  const dx = Math.max(0, Math.max(a.x, b.x) - Math.min(a.x + a.width, b.x + b.width));
  const dy = Math.max(0, Math.max(a.y, b.y) - Math.min(a.y + a.height, b.y + b.height));
  return Math.hypot(dx, dy);
}

/**
 * The polyline walked at an even spacing: the same drawing made quickly or slowly, by mouse or
 * stylus, comes out with the same density of points — which every measure below assumes.
 */
export function resample(points: readonly Pt[], spacing: number): Pt[] {
  if (points.length === 0) return [];
  const out: Pt[] = [{ x: points[0]!.x, y: points[0]!.y }];
  if (points.length === 1 || spacing <= 0) return out;
  let carried = 0;
  let prev = points[0]!;
  for (let i = 1; i < points.length; i += 1) {
    const next = points[i]!;
    let segment = dist(prev, next);
    let from = prev;
    while (carried + segment >= spacing) {
      const t = (spacing - carried) / segment;
      const point = { x: from.x + (next.x - from.x) * t, y: from.y + (next.y - from.y) * t };
      out.push(point);
      segment -= spacing - carried;
      carried = 0;
      from = point;
    }
    carried += segment;
    prev = next;
  }
  const last = points[points.length - 1]!;
  const tail = out[out.length - 1]!;
  if (dist(tail, last) > spacing * 0.25) out.push({ x: last.x, y: last.y });
  return out;
}

export function distToSegment(p: Pt, a: Pt, b: Pt): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lengthSq = dx * dx + dy * dy;
  if (lengthSq === 0) return dist(p, a);
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / lengthSq));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

/** Distance from a point to the infinite line through `a` and `b`. */
export function distToLine(p: Pt, a: Pt, b: Pt): number {
  const length = dist(a, b);
  if (length === 0) return dist(p, a);
  return Math.abs((b.x - a.x) * (a.y - p.y) - (a.x - p.x) * (b.y - a.y)) / length;
}

export function distToPolyline(p: Pt, points: readonly Pt[]): number {
  if (points.length === 1) return dist(p, points[0]!);
  let best = Infinity;
  for (let i = 1; i < points.length; i += 1) best = Math.min(best, distToSegment(p, points[i - 1]!, points[i]!));
  return best;
}

/** Whether two segments cross or touch. */
export function segmentsIntersect(a: Pt, b: Pt, c: Pt, d: Pt): boolean {
  const orient = (p: Pt, q: Pt, r: Pt) => Math.sign((q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x));
  const o1 = orient(a, b, c);
  const o2 = orient(a, b, d);
  const o3 = orient(c, d, a);
  const o4 = orient(c, d, b);
  if (o1 !== o2 && o3 !== o4) return true;
  const onSegment = (p: Pt, q: Pt, r: Pt) => Math.min(p.x, r.x) <= q.x && q.x <= Math.max(p.x, r.x) && Math.min(p.y, r.y) <= q.y && q.y <= Math.max(p.y, r.y);
  return (o1 === 0 && onSegment(a, c, b)) || (o2 === 0 && onSegment(a, d, b)) || (o3 === 0 && onSegment(c, a, d)) || (o4 === 0 && onSegment(c, b, d));
}

/** Shortest distance between two segments. */
export function segmentDistance(a: Pt, b: Pt, c: Pt, d: Pt): number {
  if (segmentsIntersect(a, b, c, d)) return 0;
  return Math.min(distToSegment(a, c, d), distToSegment(b, c, d), distToSegment(c, a, b), distToSegment(d, a, b));
}

/**
 * Ramer–Douglas–Peucker: the fewest points that keep the line within `epsilon` of where it was.
 * Iterative, so a stroke of thousands of points never recurses deep.
 */
export function simplify(points: readonly Pt[], epsilon: number): Pt[] {
  if (points.length <= 2) return points.slice();
  const keep = new Uint8Array(points.length);
  keep[0] = 1;
  keep[points.length - 1] = 1;
  const stack: Array<[number, number]> = [[0, points.length - 1]];
  while (stack.length > 0) {
    const [from, to] = stack.pop()!;
    let worst = -1;
    let index = -1;
    for (let i = from + 1; i < to; i += 1) {
      const d = distToSegment(points[i]!, points[from]!, points[to]!);
      if (d > worst) {
        worst = d;
        index = i;
      }
    }
    if (index !== -1 && worst > epsilon) {
      keep[index] = 1;
      stack.push([from, index], [index, to]);
    }
  }
  const out: Pt[] = [];
  for (let i = 0; i < points.length; i += 1) if (keep[i]) out.push(points[i]!);
  return out;
}

/** The angle of `b - a`, in radians. */
export function heading(a: Pt, b: Pt): number {
  return Math.atan2(b.y - a.y, b.x - a.x);
}

/** The smallest angle between two directions, 0..π. */
export function angleBetween(a: number, b: number): number {
  let d = Math.abs(a - b) % (Math.PI * 2);
  if (d > Math.PI) d = Math.PI * 2 - d;
  return d;
}

/** A linear ramp: 0 at or past `bad`, 1 at or past `good` — whichever way round they are. */
export function ramp(value: number, bad: number, good: number): number {
  if (bad === good) return value >= good ? 1 : 0;
  const t = (value - bad) / (good - bad);
  return Math.max(0, Math.min(1, t));
}

export function boxContains(outer: Box, inner: Box, tolerance = 0): boolean {
  return (
    inner.x >= outer.x - tolerance &&
    inner.y >= outer.y - tolerance &&
    inner.x + inner.width <= outer.x + outer.width + tolerance &&
    inner.y + inner.height <= outer.y + outer.height + tolerance
  );
}

export function boxIntersects(a: Box, b: Box): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

export function pointInBox(p: Pt, box: Box, tolerance = 0): boolean {
  return p.x >= box.x - tolerance && p.x <= box.x + box.width + tolerance && p.y >= box.y - tolerance && p.y <= box.y + box.height + tolerance;
}
