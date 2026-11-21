import type { DraftPoint } from '../document/types';
import { flattenPath } from './routing';

/**
 * The geometry of a route easing into another: both paths read as the same number of points, spaced
 * evenly along their length, so the nth point of one travels to the nth point of the other. Pure, and
 * presentation only — nothing here is saved, and the route a connector ends on is the router's own.
 */

/** Points per route while it moves: enough that a rounded corner still reads as round. */
export const MORPH_SAMPLES = 36;
/** A change smaller than this is not worth playing; a larger one than `MORPH_MAX` would sweep across
 *  the whole diagram, which reads as a glitch and not as a line settling. Canvas units. */
export const MORPH_MIN = 3;
export const MORPH_MAX = 900;

/** `count` points evenly spaced along a polyline, ends included. Empty for a line with no length. */
export function resample(points: readonly DraftPoint[], count = MORPH_SAMPLES): DraftPoint[] {
  if (points.length < 2 || count < 2) return [];
  const lengths = [0];
  for (let i = 1; i < points.length; i += 1) {
    lengths.push(lengths[i - 1]! + Math.hypot(points[i]!.x - points[i - 1]!.x, points[i]!.y - points[i - 1]!.y));
  }
  const total = lengths[lengths.length - 1]!;
  if (total === 0) return [];
  const out: DraftPoint[] = [];
  let segment = 1;
  for (let k = 0; k < count; k += 1) {
    const at = (total * k) / (count - 1);
    while (segment < points.length - 1 && lengths[segment]! < at) segment += 1;
    const a = points[segment - 1]!;
    const b = points[segment]!;
    const span = lengths[segment]! - lengths[segment - 1]!;
    const t = span === 0 ? 0 : (at - lengths[segment - 1]!) / span;
    out.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
  }
  return out;
}

/** A route's path as evenly spaced points; empty when the path is not one the router draws. */
export function samplesOf(d: string, count = MORPH_SAMPLES): DraftPoint[] {
  return resample(flattenPath(d), count);
}

/** The furthest any point travels between two sampled routes. */
export function morphTravel(from: readonly DraftPoint[], to: readonly DraftPoint[]): number {
  let furthest = 0;
  for (let i = 0; i < from.length && i < to.length; i += 1) {
    furthest = Math.max(furthest, Math.hypot(to[i]!.x - from[i]!.x, to[i]!.y - from[i]!.y));
  }
  return furthest;
}

/** Whether a change of route is one to play: both readable, and neither trivial nor a leap. */
export function worthMorphing(from: readonly DraftPoint[], to: readonly DraftPoint[]): boolean {
  if (from.length < 2 || from.length !== to.length) return false;
  const travel = morphTravel(from, to);
  return travel >= MORPH_MIN && travel <= MORPH_MAX;
}

/** The route `t` of the way from one to the other (0–1), as a path. */
export function morphPath(from: readonly DraftPoint[], to: readonly DraftPoint[], t: number): string {
  let d = '';
  for (let i = 0; i < from.length; i += 1) {
    const x = from[i]!.x + (to[i]!.x - from[i]!.x) * t;
    const y = from[i]!.y + (to[i]!.y - from[i]!.y) * t;
    d += `${i === 0 ? 'M' : 'L'}${Math.round(x * 10) / 10} ${Math.round(y * 10) / 10}`;
  }
  return d;
}
