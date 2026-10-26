import { LIMITS } from '../../document/limits';
import { Lru } from '../../lib/lru';
import { jitter } from './seed';

type Point = { x: number; y: number };
const pencilled = new Lru<string, string>(LIMITS.maxEdges * 3);
const NUMBER = /-?\d*\.?\d+(?:[eE][-+]?\d+)?/g;
const point = (p: Point) => `${p.x} ${p.y}`;
const rounded = (p: Point): Point => ({ x: Math.round(p.x * 100) / 100, y: Math.round(p.y * 100) / 100 });
const lerp = (a: Point, b: Point, t: number): Point => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });

/** De Casteljau subdivision keeps the routed curve itself exact before adding the pencil drift. */
function split(points: Point[], t: number): [Point[], Point[]] {
  const left = [points[0]!], right = [points.at(-1)!];
  let row = points;
  while (row.length > 1) {
    row = row.slice(1).map((p, i) => lerp(row[i]!, p, t));
    left.push(row[0]!);
    right.unshift(row.at(-1)!);
  }
  return [left, right];
}

function cubic(points: Point[]): Point[] {
  const [a, b, c] = points as [Point, Point, Point?];
  if (points.length === 4) return points;
  if (c) return [a, lerp(a, b, 2 / 3), lerp(c, b, 2 / 3), c];
  return [a, lerp(a, b, 1 / 3), lerp(a, b, 2 / 3), b];
}

/** Visible graphite character along the stroke, rather than one nearly invisible bow per run.
 * Both passes are deterministic, stay within three units of the route, and meet the original
 * segment ends exactly. The taper keeps short connectors and precise hand-placed bends tidy.
 * Subdivision is bounded even on exceptionally long lines; nothing depends on the DOM. */
export function pencilPath(d: string, seedId: string, cache = true): string {
  if (!cache) return pencilled.get(`${seedId}|${d}`) ?? build(d, seedId);
  return pencilled.getOrCreate(`${seedId}|${d}`, () => build(d, seedId));
}

function build(d: string, seedId: string): string {
  if (/[^MLQC\d\s.,eE+-]/.test(d)) return d;
  const segments = [...d.matchAll(/([MLQC])([^MLQC]*)/g)];
  let current: Point | undefined;
  let result = '';
  let index = 0;
  for (const [, command, raw] of segments) {
    const values = raw!.match(NUMBER)?.map(Number) ?? [];
    const expected = command === 'C' ? 6 : command === 'Q' ? 4 : 2;
    if (values.length !== expected || values.some(n => !Number.isFinite(n))) return d;
    const points: Point[] = [];
    for (let i = 0; i < values.length; i += 2) points.push({ x: values[i]!, y: values[i + 1]! });
    if (command === 'M') {
      current = points[0]!;
      result += `M${point(current)}`;
      continue;
    }
    if (!current) return d;
    const base = cubic([current, ...points]);
    const length = base.slice(1).reduce((sum, p, i) => sum + Math.hypot(p.x - base[i]!.x, p.y - base[i]!.y), 0);
    if (length < 24) {
      result += `${command}${values.join(' ')}`;
      current = points.at(-1)!;
      continue;
    }
    const count = Math.min(64, Math.max(2, Math.ceil(length / 24)));
    const phase = jitter(seedId, index++, Math.PI);
    const bias = jitter(seedId, index++, 0.7);
    let remainder = base;
    for (let i = 0; i < count; i += 1) {
      const [part, rest] = split(remainder, 1 / (count - i));
      remainder = rest;
      const drawn = part.map((p, k) => {
        const t = (i + k / 3) / count;
        if (t === 0) return base[0]!;
        if (t === 1) return base.at(-1)!;
        const at = split(base, t)[0];
        const a = at.at(-2)!, b = at.at(-1)!;
        const magnitude = Math.hypot(b.x - a.x, b.y - a.y) || 1;
        const distance = t * length;
        const taper = Math.sin(Math.min(1, distance / 18, (length - distance) / 18) * Math.PI / 2) ** 2;
        const drift = taper * (Math.sin(distance / 14 + phase) * 1.5 + Math.sin(distance / 6 + phase * 2) * 0.45 + bias);
        return rounded({ x: p.x - (b.y - a.y) / magnitude * drift, y: p.y + (b.x - a.x) / magnitude * drift });
      });
      result += `C${point(drawn[1]!)} ${point(drawn[2]!)} ${point(drawn[3]!)}`;
    }
    current = points.at(-1)!;
  }
  return result || d;
}
