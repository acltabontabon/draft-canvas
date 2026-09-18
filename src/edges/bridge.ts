/**
 * Crossing bridges — the small arc one connector makes over another where the two cross, so a
 * crossing reads as a crossing rather than as a join.
 *
 * This module is pure path geometry: a `d` string in, the same `d` with bridges in it out. It
 * knows nothing about edges, nodes or the document — `edges/crossings.ts` decides *where* bridges
 * belong and *who* owns them; this decides what one looks like.
 *
 * Two constraints shape everything here:
 *
 * 1. **It runs after `roughenPath`, never before.** That function jitters a path by *point
 *    ordinal* (see `render/roughness/roughPath.ts`), so inserting points would change the wobble of
 *    every point after them — which pops the whole line whenever an unrelated crossing appears, and
 *    frays a fan-in bundle's shared stem, since each member would re-wobble it differently and
 *    `strokeSeed` exists precisely to stop that. Bridging afterwards leaves the wobble untouched.
 *    The cost is that at `bow > 0` there are no straight `L` runs left to bridge — every one has
 *    become a `Q` — so a bridge has to be able to sit on a curve, which is why everything below
 *    works in Bézier control points rather than in line segments.
 *
 * 2. **A crossing point is a hint, not a coordinate.** The point comes from the canonical route,
 *    but the path being bridged has since been wobbled, and on the live canvas it was routed from
 *    React Flow's measured rects rather than the document's. So every bridge is *snapped* to the
 *    nearest point on the path it is actually being drawn into, and dropped if that is further than
 *    `MAX_SNAP`. That absorbs the wobble and the sub-pixel drift, and rejects the case where the
 *    route has changed shape wholesale. It is deliberately not a staleness check — it cannot notice
 *    that the *other* line moved away; `movingNodeIds` does that job at the call sites.
 */
import type { Crossing } from './crossings';

/** Half the span a bridge occupies along the line, in flow units. */
export const BRIDGE_RADIUS = 7;

/**
 * How far the hump rises off the line. Deliberately well under `BRIDGE_RADIUS`, so the hump is
 * twice as wide as it is tall. Two reasons: a taller hump on one lane of a parallel pair would
 * reach its sibling, which sits only `LANE_SPACING` (10) away; and width is what actually makes a
 * hump legible at 100% zoom — the eye reads the long soft shoulders, not the height.
 */
export const BRIDGE_RISE = 5;

/**
 * How far the hump's control points reach along the line, as a fraction of its half-span. This is
 * what makes the shoulders soft: at 0.5 the curve leaves the line travelling exactly *along* it and
 * arrives at the top travelling along it too, so there is no corner at either end — the line simply
 * swells and settles again. Lower values sharpen it towards a semicircle, which meets the line at a
 * visible right angle and reads as damage rather than as a line passing over.
 */
const SHOULDER = 0.5;

/** How far a crossing point may sit from the path before its bridge is abandoned. Must exceed
 *  Sketch's own wobble (`outline: 2.2`, `bow: 3.4`) or the roughest preset would lose every
 *  bridge; far below the tens of units a genuinely different route moves by. */
const MAX_SNAP = 5;

/** How far the path may stray from a straight chord across the bridge's own span before the span
 *  is judged too curved to host one. This is what quietly excludes `stepCorner`'s rounded corners:
 *  at a 10-unit radius, an 8-unit span across one bends far more than this, and a bridge there
 *  would read as a kink rather than a crossing. A long bezier run is flat enough at this scale. */
const FLATNESS = 0.8;

/** Samples per segment used for the arc-length table. Enough that a 10-unit corner and a
 *  several-hundred-unit bezier are both located to well under a pixel. */
const SAMPLES = 24;

interface Point {
  x: number;
  y: number;
}

/**
 * One path command as a Bézier: its control points including the start, so degree is implicit.
 * An `L` is a degree-1 Bézier, which is what lets splitting be written once for all three.
 */
interface Segment {
  /** 2 points for `L`, 3 for `Q`, 4 for `C`. */
  points: Point[];
  /** Cumulative chord length at each of `SAMPLES + 1` evenly spaced `t` values. */
  arc: number[];
  length: number;
}

const NUMBER_RE = /-?\d*\.?\d+(?:[eE][-+]?\d+)?/g;

/** Parses the absolute `M`/`L`/`Q`/`C` path set `edges/routing.ts` produces into Bézier segments.
 *  Anything else yields `null` and the caller keeps the path exactly as it found it. */
function parse(d: string): Segment[] | null {
  const commandRe = /([MLQCmlqc])([^MLQCmlqc]*)/g;
  const segments: Segment[] = [];
  let current: Point | null = null;
  let match: RegExpExecArray | null;
  while ((match = commandRe.exec(d))) {
    const cmd = match[1]!;
    if (cmd !== cmd.toUpperCase()) return null;
    const nums = (match[2]?.match(NUMBER_RE) ?? []).map(Number);
    if (nums.some(Number.isNaN)) return null;
    const pts: Point[] = [];
    for (let i = 0; i + 1 < nums.length; i += 2) pts.push({ x: nums[i]!, y: nums[i + 1]! });
    if (cmd === 'M') {
      current = pts[pts.length - 1] ?? current;
      continue;
    }
    const expected = cmd === 'L' ? 1 : cmd === 'Q' ? 2 : 3;
    if (!current || pts.length !== expected) return null;
    segments.push(measure([current, ...pts]));
    current = pts[pts.length - 1]!;
  }
  return segments.length > 0 ? segments : null;
}

function bezier(points: readonly Point[], t: number): Point {
  let xs = points.map((p) => p.x);
  let ys = points.map((p) => p.y);
  while (xs.length > 1) {
    const nx: number[] = [];
    const ny: number[] = [];
    for (let i = 0; i + 1 < xs.length; i += 1) {
      nx.push(xs[i]! + (xs[i + 1]! - xs[i]!) * t);
      ny.push(ys[i]! + (ys[i + 1]! - ys[i]!) * t);
    }
    xs = nx;
    ys = ny;
  }
  return { x: xs[0]!, y: ys[0]! };
}

function measure(points: Point[]): Segment {
  const arc: number[] = [0];
  let total = 0;
  let previous = points[0]!;
  for (let i = 1; i <= SAMPLES; i += 1) {
    const point = bezier(points, i / SAMPLES);
    total += Math.hypot(point.x - previous.x, point.y - previous.y);
    arc.push(total);
    previous = point;
  }
  return { points, arc, length: total };
}

/** How far along a segment a given `t` sits, interpolated within the sample table — the inverse of
 *  `tAt`, and what turns a refined parameter back into a distance the bridge span is measured in. */
function arcAt(segment: Segment, t: number): number {
  const scaled = Math.min(Math.max(t, 0), 1) * SAMPLES;
  const index = Math.min(Math.floor(scaled), SAMPLES - 1);
  const previous = segment.arc[index]!;
  return previous + (segment.arc[index + 1]! - previous) * (scaled - index);
}

/** The `t` at a given distance along a segment, interpolated within the sample table. */
function tAt(segment: Segment, distance: number): number {
  const { arc } = segment;
  if (distance <= 0) return 0;
  if (distance >= segment.length) return 1;
  for (let i = 1; i < arc.length; i += 1) {
    const previous = arc[i - 1]!;
    const here = arc[i]!;
    if (distance <= here) {
      const span = here - previous;
      const within = span > 0 ? (distance - previous) / span : 0;
      return (i - 1 + within) / SAMPLES;
    }
  }
  return 1;
}

/** De Casteljau: the left half of a Bézier at `t`, as control points. */
function left(points: readonly Point[], t: number): Point[] {
  const out: Point[] = [points[0]!];
  let level = [...points];
  while (level.length > 1) {
    const next: Point[] = [];
    for (let i = 0; i + 1 < level.length; i += 1) {
      next.push({
        x: level[i]!.x + (level[i + 1]!.x - level[i]!.x) * t,
        y: level[i]!.y + (level[i + 1]!.y - level[i]!.y) * t,
      });
    }
    level = next;
    out.push(level[0]!);
  }
  return out;
}

/** The right half at `t` — the left half of the reversed curve at `1 - t`, reversed back. */
function right(points: readonly Point[], t: number): Point[] {
  return left([...points].reverse(), 1 - t).reverse();
}

/** The piece of a Bézier between two parameters, as control points of the same degree. */
function between(points: readonly Point[], t0: number, t1: number): Point[] {
  if (t0 <= 0 && t1 >= 1) return [...points];
  const tail = right(points, t0);
  if (t1 >= 1) return tail;
  return left(tail, t0 >= 1 ? 1 : (t1 - t0) / (1 - t0));
}

/** The command letter a control-point run of this length is written with. */
function command(points: readonly Point[]): string {
  return points.length === 2 ? 'L' : points.length === 3 ? 'Q' : 'C';
}

const round = (value: number) => Math.round(value * 100) / 100;

function emit(points: readonly Point[]): string {
  return command(points) + points.slice(1).map((p) => `${round(p.x)} ${round(p.y)}`).join(' ');
}

/** A placed bridge: where on the path it sits, and which way it arcs. */
interface Placement {
  segment: number;
  /** Distance along that segment at which the crossing sits. */
  at: number;
  normal: Point;
}

/** Locates a crossing on the path, or returns `null` if it is too far away or cannot host a
 *  bridge there — off the end of a segment, or on a stretch too curved for one. */
function place(segments: readonly Segment[], crossing: Crossing): Placement | null {
  let bestSegment = -1;
  let bestSample = 0;
  let bestDistance = Infinity;
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index]!;
    for (let i = 0; i <= SAMPLES; i += 1) {
      const point = bezier(segment.points, i / SAMPLES);
      const distance = Math.hypot(point.x - crossing.x, point.y - crossing.y);
      if (distance < bestDistance) {
        bestSegment = index;
        bestSample = i;
        bestDistance = distance;
      }
    }
  }
  if (bestSegment < 0) return null;

  const segment = segments[bestSegment]!;
  // The sample scan only narrows it to one step of the table — on a long run that is a dozen units,
  // which would visibly park the arc beside the crossing instead of over it. Close in on the true
  // nearest point between the neighbouring samples before committing.
  let low = Math.max(0, (bestSample - 1) / SAMPLES);
  let high = Math.min(1, (bestSample + 1) / SAMPLES);
  const distanceAt = (t: number) => {
    const point = bezier(segment.points, t);
    return Math.hypot(point.x - crossing.x, point.y - crossing.y);
  };
  for (let i = 0; i < 24 && high - low > 1e-6; i += 1) {
    const third = (high - low) / 3;
    if (distanceAt(low + third) < distanceAt(high - third)) high -= third;
    else low += third;
  }
  const t = (low + high) / 2;
  if (distanceAt(t) > MAX_SNAP) return null;
  const bestAt = arcAt(segment, t);
  if (bestAt - BRIDGE_RADIUS < 0 || bestAt + BRIDGE_RADIUS > segment.length) return null;

  // Too curved to bridge: measure how far the path strays from a straight chord across the span
  // the bridge would occupy. A rounded corner fails this; a long, gently curved run passes it.
  const t0 = tAt(segment, bestAt - BRIDGE_RADIUS);
  const t1 = tAt(segment, bestAt + BRIDGE_RADIUS);
  const a = bezier(segment.points, t0);
  const b = bezier(segment.points, t1);
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const chord = Math.hypot(dx, dy);
  if (chord < BRIDGE_RADIUS) return null;
  for (let i = 1; i < 4; i += 1) {
    const point = bezier(segment.points, t0 + ((t1 - t0) * i) / 4);
    const deviation = Math.abs((point.x - a.x) * dy - (point.y - a.y) * dx) / chord;
    if (deviation > FLATNESS) return null;
  }
  return { segment: bestSegment, at: bestAt, normal: { x: crossing.nx, y: crossing.ny } };
}

/**
 * Draws the hump: the line eases up off its own course at `a`, runs level across the crossing at
 * `BRIDGE_RISE` above it, and eases back down at `b`.
 *
 * Two cubics rather than one, because a single one cannot do this. A lone cubic bulging off a
 * chord has to point its control arms away from the line, so it leaves and rejoins at a hard
 * angle — a semicircle stuck on top of the stroke, which reads as a kink or a break. Splitting it
 * at the apex lets every tangent line up: along the line at each foot, along the line again at the
 * top. The result is one continuous stroke that swells over the connector beneath it and settles
 * back, with no corner anywhere in it.
 */
function hump(a: Point, b: Point, normal: Point): string {
  // Each half spans from a foot to the apex, so the control arms are measured against *that* run,
  // not the whole hump — reaching a full half-span forward would put the second control point
  // behind the first and fold the curve into a wiggle instead of a rise.
  const alongX = ((b.x - a.x) / 2) * SHOULDER;
  const alongY = ((b.y - a.y) / 2) * SHOULDER;
  const apex = {
    x: (a.x + b.x) / 2 + normal.x * BRIDGE_RISE,
    y: (a.y + b.y) / 2 + normal.y * BRIDGE_RISE,
  };
  const rise = emit([
    a,
    { x: a.x + alongX, y: a.y + alongY },
    { x: apex.x - alongX, y: apex.y - alongY },
    apex,
  ]);
  const fall = emit([
    apex,
    { x: apex.x + alongX, y: apex.y + alongY },
    { x: b.x - alongX, y: b.y - alongY },
    b,
  ]);
  return rise + fall;
}

/** Bridges computed for one `d` are reused across the many renders that don't move the line — a
 *  connector re-renders for selection, lens, playback and hover far more often than its geometry
 *  changes. Keyed on the plan's own identity-stable crossing array, so a document that hasn't
 *  changed hits the cache on the first lookup. */
const bridged = new WeakMap<readonly Crossing[], Map<string, string>>();

/**
 * Returns `d` with a small arc drawn over each of `crossings` that lands on it.
 *
 * Identity when there is nothing to draw, so a connector that crosses nothing — the common case —
 * pays nothing and keeps the exact path string it already had.
 */
export function bridgePath(d: string, crossings: readonly Crossing[]): string {
  if (crossings.length === 0) return d;
  let cache = bridged.get(crossings);
  if (!cache) bridged.set(crossings, (cache = new Map()));
  const hit = cache.get(d);
  if (hit !== undefined) return hit;
  const built = buildBridged(d, crossings);
  cache.set(d, built);
  return built;
}

function buildBridged(d: string, crossings: readonly Crossing[]): string {
  const segments = parse(d);
  if (!segments) return d;

  const placed: Placement[] = [];
  for (const crossing of crossings) {
    const placement = place(segments, crossing);
    if (placement) placed.push(placement);
  }
  if (placed.length === 0) return d;

  // Two bridges closer together than their own width would overlap into a shape that reads as
  // neither. Keeping the first of each such run is what the brief asks for — better one clean arc
  // than two malformed ones. Sorting first makes "the first" mean the leftmost along the path.
  const bySegment = new Map<number, Placement[]>();
  for (const placement of placed) {
    const list = bySegment.get(placement.segment);
    if (list) list.push(placement);
    else bySegment.set(placement.segment, [placement]);
  }
  for (const [index, list] of bySegment) {
    list.sort((a, b) => a.at - b.at);
    const kept: Placement[] = [];
    for (const placement of list) {
      const previous = kept[kept.length - 1];
      if (previous && placement.at - previous.at < BRIDGE_RADIUS * 2) continue;
      kept.push(placement);
    }
    bySegment.set(index, kept);
  }

  const start = segments[0]!.points[0]!;
  let out = `M${round(start.x)} ${round(start.y)}`;
  segments.forEach((segment, index) => {
    const list = bySegment.get(index);
    if (!list || list.length === 0) {
      out += emit(segment.points);
      return;
    }
    let cursor = 0;
    for (const placement of list) {
      const t0 = tAt(segment, placement.at - BRIDGE_RADIUS);
      const t1 = tAt(segment, placement.at + BRIDGE_RADIUS);
      if (t0 > cursor) out += emit(between(segment.points, cursor, t0));
      out += hump(bezier(segment.points, t0), bezier(segment.points, t1), placement.normal);
      cursor = t1;
    }
    if (cursor < 1) out += emit(between(segment.points, cursor, 1));
  });
  return out;
}
