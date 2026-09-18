/**
 * How far a point is from a connector's route.
 *
 * Used by drag-to-attach, where several connectors' (deliberately forgiving) hit corridors
 * overlap on a crowded canvas: the DOM can say *which* connectors are under the pointer, but
 * paint order decides which one it names first, and paint order has nothing to do with which
 * line the user is aiming at. Distance does.
 *
 * Everything here works on a route's own `d` string, in flow coordinates — the same space an
 * aim point is in — rather than on measured DOM geometry: `getPointAtLength` would force a
 * layout on every probe, and this runs mid-drag.
 */
import { flattenPath } from './routing';

export interface Point {
  x: number;
  y: number;
}

/** The distance from `point` to the segment `a`–`b` (not to the infinite line through them). */
export function distanceToSegment(point: Point, a: Point, b: Point): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lengthSquared = dx * dx + dy * dy;
  // A degenerate segment is just its own endpoint.
  if (lengthSquared === 0) return Math.hypot(point.x - a.x, point.y - a.y);
  // How far along a→b the perpendicular foot falls, clamped to the segment itself.
  const t = Math.max(0, Math.min(1, ((point.x - a.x) * dx + (point.y - a.y) * dy) / lengthSquared));
  return Math.hypot(point.x - (a.x + t * dx), point.y - (a.y + t * dy));
}

/**
 * The closest distance from `point` to a polyline, or `null` when there is nothing to measure
 * against — the caller keeps whatever fallback it had rather than treating "no geometry" as
 * "infinitely far".
 */
export function distanceToPolyline(point: Point, vertices: readonly Point[]): number | null {
  if (vertices.length === 0) return null;
  if (vertices.length === 1) return Math.hypot(point.x - vertices[0]!.x, point.y - vertices[0]!.y);
  let best = Infinity;
  for (let i = 1; i < vertices.length; i += 1) {
    const distance = distanceToSegment(point, vertices[i - 1]!, vertices[i]!);
    if (distance < best) best = distance;
  }
  return best;
}

/**
 * `flattenPath` is pure but not free, and a drag probes the same handful of routes over and
 * over while nothing about them changes. Keyed by the `d` string itself, so a rerouted
 * connector simply misses and re-flattens; `clearPathCache()` runs at the end of a gesture so
 * this never grows into a leak across a long editing session.
 */
const flattened = new Map<string, Point[]>();

export function verticesOf(d: string): Point[] {
  let vertices = flattened.get(d);
  if (!vertices) {
    // `flattenPath` yields nothing for a path it doesn't recognise; caching that empty result
    // is still right — it saves re-parsing the same unrecognised path every probe.
    vertices = flattenPath(d).map(({ x, y }) => ({ x, y }));
    flattened.set(d, vertices);
  }
  return vertices;
}

export function clearPathCache(): void {
  flattened.clear();
}

/** How far from `point` the route drawn by `d` runs, or `null` when `d` can't be read. */
export function distanceToPath(point: Point, d: string): number | null {
  return distanceToPolyline(point, verticesOf(d));
}
