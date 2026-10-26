/** Shared geometry for repair decisions and the legibility reported to agents. */
import type { Box } from './route';

type Point = { x: number; y: number };

/** A connector counts as a detour when it is longer than this many times the distance between the
 *  middles of the two shapes it joins… */
const DETOUR_RATIO = 1.5;
/** …plus this much, so a short hop round a corner (or out of a side facing away) doesn't count. */
const DETOUR_EXTRA = 200;

/** Whether a route drawn as `points` goes the long way round between the shapes it joins. */
export function isDetour(points: readonly Point[], source: Box, target: Box): boolean {
  const direct = Math.abs(source.x + source.width / 2 - (target.x + target.width / 2)) + Math.abs(source.y + source.height / 2 - (target.y + target.height / 2));
  return lengthOf(points) > direct * DETOUR_RATIO + DETOUR_EXTRA;
}

export const lengthOf = (points: readonly Point[]) => points.reduce((sum, p, i) => (i ? sum + Math.abs(p.x - points[i - 1]!.x) + Math.abs(p.y - points[i - 1]!.y) : 0), 0);

/** A route as its runs: zero-length steps dropped and straight stretches merged. The router splits
 *  a straight line at its midpoint, which is exactly where another connector tends to cross it. */
export function runsOf(points: readonly Point[]): Point[] {
  const out: Point[] = [];
  for (const p of points) {
    const last = out[out.length - 1];
    if (last && Math.abs(last.x - p.x) < 0.5 && Math.abs(last.y - p.y) < 0.5) continue;
    const before = out[out.length - 2];
    if (last && before && ((Math.abs(before.x - last.x) < 0.5 && Math.abs(last.x - p.x) < 0.5) || (Math.abs(before.y - last.y) < 0.5 && Math.abs(last.y - p.y) < 0.5))) out[out.length - 1] = p;
    else out.push(p);
  }
  return out;
}

/** Proper crossings between two orthogonal polylines: a horizontal run of one through a vertical run
 *  of the other, away from either's ends (two connectors leaving one handle don't "cross"). */
export function crossingsBetween(a: readonly Point[], b: readonly Point[]): Point[] {
  const out: Point[] = [];
  const margin = 4;
  for (let i = 1; i < a.length; i += 1) {
    const [a0, a1] = [a[i - 1]!, a[i]!];
    for (let j = 1; j < b.length; j += 1) {
      const [b0, b1] = [b[j - 1]!, b[j]!];
      const [h0, h1, v0, v1] = Math.abs(a0.y - a1.y) < 1 && Math.abs(b0.x - b1.x) < 1 ? [a0, a1, b0, b1] : Math.abs(b0.y - b1.y) < 1 && Math.abs(a0.x - a1.x) < 1 ? [b0, b1, a0, a1] : [];
      if (!h0 || !h1 || !v0 || !v1) continue;
      const x = v0.x;
      const y = h0.y;
      if (x > Math.min(h0.x, h1.x) + margin && x < Math.max(h0.x, h1.x) - margin && y > Math.min(v0.y, v1.y) + margin && y < Math.max(v0.y, v1.y) - margin) out.push({ x, y });
    }
  }
  return out;
}

