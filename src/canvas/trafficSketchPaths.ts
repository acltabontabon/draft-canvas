import { createRng } from '../render/roughness/seed';
import type { Point, Rect } from '../traffic/sketchLayout';

/**
 * The strokes of a whiteboard markup, as SVG paths: a marker loop around a shape, and an arrow
 * flicked from a note to it. Seeded by the finding's id, so the same finding is drawn the same way
 * every time — a hand, not noise.
 */

/**
 * A loop drawn the way a marker draws one: started anywhere, a little lopsided, tilted, and carried
 * past where it began so the two ends overlap — never a perfect ellipse, which reads as UI chrome
 * rather than someone's note.
 */
export function markerLoop(ring: Rect, seed: string): string {
  const rng = createRng(`loop:${seed}`);
  const cx = ring.x + ring.width / 2;
  const cy = ring.y + ring.height / 2;
  const a = ring.width / 2;
  const b = ring.height / 2;
  const start = rng() * Math.PI * 2;
  const sweep = Math.PI * 2 * (1.08 + rng() * 0.06);
  const tilt = (rng() - 0.5) * 0.09;
  const phase = rng() * Math.PI * 2;
  const steps = 30;
  const points: Point[] = [];
  for (let index = 0; index <= steps; index += 1) {
    const t = index / steps;
    const angle = start + sweep * t;
    // Lopsided, and drifting outward as the hand comes round, so the overlap shows.
    const wobble = 1 + 0.035 * Math.sin(angle * 3 + phase) + 0.05 * t;
    const x = Math.cos(angle) * a * wobble;
    const y = Math.sin(angle) * b * wobble;
    points.push({ x: cx + x * Math.cos(tilt) - y * Math.sin(tilt), y: cy + x * Math.sin(tilt) + y * Math.cos(tilt) });
  }
  return smooth(points);
}

/** A curved arrow with a two-stroke head, flicked from `from` to `to` through `control`. */
export function markerArrow(arrow: { from: Point; control: Point; to: Point }, seed: string): { shaft: string; head: string } {
  const rng = createRng(`arrow:${seed}`);
  const { from, control, to } = arrow;
  const shaft = `M${f(from.x)} ${f(from.y)} Q${f(control.x)} ${f(control.y)} ${f(to.x)} ${f(to.y)}`;
  // The head follows the curve's own direction where it lands.
  const angle = Math.atan2(to.y - control.y, to.x - control.x);
  const length = 9 + rng() * 3;
  const spread = 0.42 + rng() * 0.1;
  const wing = (side: number) => ({
    x: to.x - Math.cos(angle + side * spread) * length,
    y: to.y - Math.sin(angle + side * spread) * length,
  });
  const left = wing(1);
  const right = wing(-1);
  const head = `M${f(left.x)} ${f(left.y)} L${f(to.x)} ${f(to.y)} L${f(right.x)} ${f(right.y)}`;
  return { shaft, head };
}

/** Catmull-Rom through the points, as cubic Béziers — a hand's curve rather than a polygon. */
function smooth(points: Point[]): string {
  let d = `M${f(points[0]!.x)} ${f(points[0]!.y)}`;
  for (let index = 0; index < points.length - 1; index += 1) {
    const p0 = points[Math.max(0, index - 1)]!;
    const p1 = points[index]!;
    const p2 = points[index + 1]!;
    const p3 = points[Math.min(points.length - 1, index + 2)]!;
    const c1 = { x: p1.x + (p2.x - p0.x) / 6, y: p1.y + (p2.y - p0.y) / 6 };
    const c2 = { x: p2.x - (p3.x - p1.x) / 6, y: p2.y - (p3.y - p1.y) / 6 };
    d += ` C${f(c1.x)} ${f(c1.y)} ${f(c2.x)} ${f(c2.y)} ${f(p2.x)} ${f(p2.y)}`;
  }
  return d;
}

function f(value: number): string {
  return value.toFixed(1);
}
