/**
 * Smart Ink's recognizer: what a handful of rough strokes look like, geometrically.
 *
 * Deliberately only geometry. It says "this is a closed four-sided outline" or "this is a straight
 * line with a head at its end" and how sure it is; what that *means* in a diagram — a Component, a
 * Boundary, a connector between two shapes — is `interpret.ts`'s question, asked with the canvas
 * around it. Nothing here knows about nodes, the store or the DOM.
 *
 * Every measure is taken in screen pixels (room units × zoom), because that is the precision a hand
 * actually has: a wobble of four pixels is the same wobble at any zoom. Each candidate is scored by
 * the weakest of a few independent measures — coverage of the outline, closeness to it, corners
 * present or absent — each a linear ramp between "certainly not" and "certainly", so a score reads as
 * how comfortably a drawing cleared its worst test rather than as a probability. The thresholds were
 * set against the generated corpus in `tests/ink/`, which holds clean, uneven, open, shaky and
 * multi-stroke versions of every shape alongside scribbles that must stay ink.
 */
import {
  angleBetween,
  boxOf,
  dist,
  distToLine,
  heading,
  pathLength,
  ramp,
  resample,
  simplify,
  unionBox,
  type Box,
  type Pt,
} from './geometry';
import { CONVERT_CONFIDENCE, MIN_DIAGONAL_PX, OFFER_CONFIDENCE, RESAMPLE_STEP_PX } from './thresholds';

export type InkGeometry = 'rectangle' | 'ellipse' | 'cylinder' | 'tube' | 'person' | 'line' | 'arrow';

/** Which ends of a line carry an arrowhead. */
export type InkHeads = 'none' | 'start' | 'end' | 'both';

export interface Recognition {
  /** The best reading, or `null` when nothing scored at all. */
  geometry: InkGeometry | null;
  /** How comfortably the best reading cleared its tests, discounted when a rival came close. 0–1. */
  confidence: number;
  /** The drawing's extent, in room coordinates. */
  box: Box;
  /** For a line or arrow: where it starts and ends (room coordinates), and its heads. */
  line?: { from: Pt; to: Pt; heads: InkHeads };
  /** Every candidate's own score, for tests and for the alternatives offered. */
  scores: Partial<Record<InkGeometry, number>>;
}

// Every threshold, with its unit, is in `thresholds.ts`; the two a caller reads are re-exported.
export { CONVERT_CONFIDENCE, OFFER_CONFIDENCE };

interface Prepared {
  /** Each stroke resampled, in screen pixels. */
  strokes: Pt[][];
  all: Pt[];
  box: Box;
  inkLength: number;
}

export function recognize(strokes: readonly (readonly Pt[])[], options: { scale: number }): Recognition {
  const scale = options.scale > 0 ? options.scale : 1;
  const prepared = prepare(strokes, scale);
  const roomBox = toRoom(prepared.box, scale);
  const empty: Recognition = { geometry: null, confidence: 0, box: roomBox, scores: {} };
  if (prepared.all.length < 2 || Math.hypot(prepared.box.width, prepared.box.height) < MIN_DIAGONAL_PX) return empty;

  const scores: Partial<Record<InkGeometry, number>> = {};
  const line = lineReading(prepared);
  if (line) scores.line = line.score;
  const arrow = arrowReading(prepared);
  if (arrow) scores.arrow = arrow.score;
  scores.rectangle = rectangleScore(prepared);
  scores.ellipse = ellipseScore(prepared.all, prepared.box);
  scores.cylinder = cylinderScore(prepared, 'vertical');
  scores.tube = cylinderScore(prepared, 'horizontal');
  scores.person = personScore(prepared);

  const ranked = (Object.entries(scores) as Array<[InkGeometry, number]>).filter(([, score]) => score > 0).sort((a, b) => b[1] - a[1]);
  const best = ranked[0];
  if (!best) return { ...empty, scores };
  const [geometry, score] = best;
  // A rival that nearly matched makes the reading less certain. A cylinder is also, partly, an
  // ellipse and a rectangle, and an arrow partly a line: those overlaps are expected, not rivals.
  const rival = ranked.slice(1).find(([other]) => !nested(geometry, other))?.[1] ?? 0;
  const confidence = score * (0.7 + 0.3 * ramp(score - rival, 0, 0.35));

  const result: Recognition = { geometry, confidence, box: roomBox, scores };
  if (geometry === 'line' && line) result.line = { from: toRoomPt(line.from, scale), to: toRoomPt(line.to, scale), heads: 'none' };
  if (geometry === 'arrow' && arrow) result.line = { from: toRoomPt(arrow.from, scale), to: toRoomPt(arrow.to, scale), heads: arrow.heads };
  return result;
}

/** Readings that contain another: a winning cylinder is not doubted for also looking like a box. */
function nested(winner: InkGeometry, other: InkGeometry): boolean {
  if (winner === 'arrow') return other === 'line';
  if (winner === 'cylinder' || winner === 'tube') return other === 'rectangle' || other === 'ellipse' || other === 'cylinder' || other === 'tube';
  if (winner === 'person') return other === 'ellipse';
  return false;
}

function prepare(strokes: readonly (readonly Pt[])[], scale: number): Prepared {
  const resampled = strokes
    .filter((stroke) => stroke.length > 0)
    .map((stroke) => resample(stroke.map((p) => ({ x: p.x * scale, y: p.y * scale })), RESAMPLE_STEP_PX));
  const all = resampled.flat();
  return { strokes: resampled, all, box: boxOf(all), inkLength: resampled.reduce((sum, s) => sum + pathLength(s), 0) };
}

function toRoom(box: Box, scale: number): Box {
  return { x: box.x / scale, y: box.y / scale, width: box.width / scale, height: box.height / scale };
}

function toRoomPt(p: Pt, scale: number): Pt {
  return { x: p.x / scale, y: p.y / scale };
}

/* ---------------------------------------------------------------- lines -- */

function lineReading(prepared: Prepared): { score: number; from: Pt; to: Pt } | null {
  if (prepared.strokes.length !== 1) return null;
  const stroke = prepared.strokes[0]!;
  const from = stroke[0]!;
  const to = stroke[stroke.length - 1]!;
  const chord = dist(from, to);
  if (chord < 30) return null;
  const length = pathLength(stroke);
  let deviation = 0;
  for (const p of stroke) deviation = Math.max(deviation, distToLine(p, from, to));
  const score = Math.min(ramp(chord / length, 0.86, 0.96), ramp(deviation / chord, 0.12, 0.045));
  return score > 0 ? { score, from, to } : null;
}

interface Segment {
  a: Pt;
  b: Pt;
  length: number;
  /** When it was drawn: earlier strokes, and earlier runs within a stroke, come first. */
  order: number;
}

/** A stroke as straight runs: simplified, then neighbouring runs that barely turn merged. */
function runsOf(stroke: readonly Pt[], epsilon: number, strokeIndex: number): Segment[] {
  const simple = simplify(stroke, epsilon);
  const corners: Pt[] = [simple[0]!];
  for (let i = 1; i < simple.length - 1; i += 1) {
    const prev = corners[corners.length - 1]!;
    const here = simple[i]!;
    const next = simple[i + 1]!;
    if (angleBetween(heading(prev, here), heading(here, next)) > (16 * Math.PI) / 180) corners.push(here);
  }
  if (simple.length > 1) corners.push(simple[simple.length - 1]!);
  const runs: Segment[] = [];
  for (let i = 1; i < corners.length; i += 1) {
    const length = dist(corners[i - 1]!, corners[i]!);
    if (length > 0) runs.push({ a: corners[i - 1]!, b: corners[i]!, length, order: strokeIndex * 10_000 + i });
  }
  return runs;
}

/**
 * A straight shaft with a head at one or both ends — drawn in one stroke (shaft, then a barb or
 * two) or several (a shaft and a separate "V"). The shaft is the longest straight run; every other
 * run must sit at one of its ends, opening backwards along it at a barb's angle. Ink anywhere else
 * means this is something else.
 */
function arrowReading(prepared: Prepared): { score: number; from: Pt; to: Pt; heads: InkHeads } | null {
  const diagonal = Math.hypot(prepared.box.width, prepared.box.height);
  const epsilon = Math.max(4, diagonal * 0.035);
  const runs = prepared.strokes.flatMap((stroke, index) => runsOf(stroke, epsilon, index));
  if (runs.length < 2) return null;
  const shaft = runs.reduce((longest, run) => (run.length > longest.length ? run : longest));
  if (shaft.length < 40 || shaft.length < prepared.inkLength * 0.42) return null;

  const ends = [shaft.a, shaft.b] as const;
  const reach = Math.max(12, shaft.length * 0.16);
  const barbs: Array<{ end: 0 | 1; side: number; angle: number; length: number; after: boolean }> = [];
  let stray = 0;
  for (const run of runs) {
    if (run === shaft) continue;
    let placed = false;
    for (const end of [0, 1] as const) {
      const tip = ends[end];
      const tail = ends[end === 0 ? 1 : 0];
      const near = dist(run.a, tip) <= dist(run.b, tip) ? run.a : run.b;
      const far = near === run.a ? run.b : run.a;
      if (dist(near, tip) > reach || dist(far, tip) > shaft.length * 0.6) continue;
      const back = heading(tip, tail);
      const out = heading(tip, far);
      const angle = angleBetween(back, out);
      const length = dist(near, far);
      // A head is drawn at a hand's size, not the shaft's: a long arrow keeps a small head.
      if (angle < (10 * Math.PI) / 180 || angle > (80 * Math.PI) / 180 || length < Math.max(7, Math.min(shaft.length * 0.05, 12))) continue;
      const cross = (tail.x - tip.x) * (far.y - tip.y) - (tail.y - tip.y) * (far.x - tip.x);
      barbs.push({ end, side: Math.sign(cross), angle, length, after: run.order > shaft.order });
      placed = true;
      break;
    }
    if (!placed) stray += run.length;
  }
  const headScore = (end: 0 | 1) => {
    const here = barbs.filter((barb) => barb.end === end);
    const sides = new Set(here.map((barb) => barb.side));
    if (sides.size >= 2) return 1;
    // A head with one barb is how a lazy arrow is drawn — and also how a tick, a "V" or an "L" is.
    // Only a barb drawn after the shaft, short and sharply swept back, counts: a tick starts with
    // its short arm, and its arms open far wider than a barb does.
    const half = here.some((barb) => barb.after && barb.angle <= (55 * Math.PI) / 180 && barb.length <= shaft.length * 0.4);
    return half && shaft.length >= 60 ? 0.72 : 0;
  };
  const start = headScore(0);
  const finish = headScore(1);
  const head = Math.max(start, finish);
  if (head === 0) return null;
  const score = Math.min(head, ramp(stray / prepared.inkLength, 0.22, 0.06));
  if (score <= 0) return null;
  const heads: InkHeads = start > 0 && finish > 0 ? 'both' : finish > 0 ? 'end' : 'start';
  // `from` is always the tail: an arrow with its head at the shaft's start points the other way.
  return heads === 'start' ? { score, from: shaft.b, to: shaft.a, heads: 'end' } : { score, from: shaft.a, to: shaft.b, heads };
}

/* ------------------------------------------------------- closed outlines -- */

function cornersHit(points: readonly Pt[], box: Box, tolerance: number): number {
  const corners = [
    { x: box.x, y: box.y },
    { x: box.x + box.width, y: box.y },
    { x: box.x + box.width, y: box.y + box.height },
    { x: box.x, y: box.y + box.height },
  ];
  let hits = 0;
  for (const corner of corners) if (points.some((p) => dist(p, corner) <= tolerance)) hits += 1;
  return hits;
}

/**
 * A four-sided outline: nearly every point close to the box's edges, every side substantially
 * drawn, and (unlike an ellipse, which cuts them) its corners reached. Measured on all strokes at
 * once, so one continuous box and four separate lines read the same.
 */
function rectangleScore(prepared: Prepared): number {
  const { all, box } = prepared;
  const short = Math.min(box.width, box.height);
  const long = Math.max(box.width, box.height);
  if (short < 14 || short / long < 0.08) return 0;
  // A hand wanders a few pixels whatever the size, and proportionally more on a big box.
  const tolerance = Math.min(24, Math.max(6, short * 0.12 + 3));
  const BINS = 10;
  const sides = [new Uint8Array(BINS), new Uint8Array(BINS), new Uint8Array(BINS), new Uint8Array(BINS)];
  let near = 0;
  for (const p of all) {
    const distances = [p.y - box.y, box.x + box.width - p.x, box.y + box.height - p.y, p.x - box.x];
    let side = 0;
    for (let i = 1; i < 4; i += 1) if (distances[i]! < distances[side]!) side = i;
    if (distances[side]! > tolerance) continue;
    near += 1;
    const along = side === 0 || side === 2 ? (p.x - box.x) / (box.width || 1) : (p.y - box.y) / (box.height || 1);
    sides[side]![Math.min(BINS - 1, Math.max(0, Math.floor(along * BINS)))] = 1;
  }
  const coverage = sides.map((bins) => bins.reduce((sum, bin) => sum + bin, 0) / BINS);
  const onOutline = near / all.length;
  const corners = cornersHit(all, box, Math.min(30, Math.max(5, short * 0.16)));
  return Math.min(
    ramp(onOutline, 0.78, 0.95),
    ramp(Math.min(...coverage), 0.4, 0.75),
    ramp(coverage.reduce((a, b) => a + b, 0) / 4, 0.6, 0.88),
    ramp(corners, 2.2, 3.6),
  );
}

/**
 * An oval: every point near the ellipse inscribed in the box, all the way round, and the box's
 * corners left empty — which is what tells a circle from a box drawn with very round corners.
 */
function ellipseScore(points: readonly Pt[], box: Box): number {
  const short = Math.min(box.width, box.height);
  const long = Math.max(box.width, box.height);
  if (short < 14 || short / long < 0.12) return 0;
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  const a = box.width / 2;
  const b = box.height / 2;
  const BINS = 24;
  const bins = new Uint8Array(BINS);
  const errors: number[] = [];
  for (const p of points) {
    const nx = (p.x - cx) / a;
    const ny = (p.y - cy) / b;
    errors.push(Math.abs(Math.hypot(nx, ny) - 1));
    const angle = Math.atan2(ny, nx) + Math.PI;
    bins[Math.min(BINS - 1, Math.floor((angle / (Math.PI * 2)) * BINS))] = 1;
  }
  errors.sort((x, y) => x - y);
  const mean = errors.reduce((sum, e) => sum + e, 0) / errors.length;
  const p90 = errors[Math.floor(errors.length * 0.9)] ?? 1;
  const coverage = bins.reduce((sum, bin) => sum + bin, 0) / BINS;
  const corners = cornersHit(points, box, Math.min(30, Math.max(5, short * 0.13)));
  return Math.min(ramp(mean, 0.16, 0.065), ramp(p90, 0.3, 0.15), ramp(coverage, 0.72, 0.92), ramp(corners, 2, 0.5));
}

/** `points` turned so that the cap of a lying-down tube sits on top, the way a store's does. */
function orient(points: readonly Pt[], how: 'identity' | 'left' | 'right'): Pt[] {
  if (how === 'identity') return points as Pt[];
  if (how === 'left') return points.map((p) => ({ x: p.y, y: p.x }));
  return points.map((p) => ({ x: p.y, y: -p.x }));
}

/**
 * A cylinder: one stroke an ellipse lying across the top of the drawing, as wide as it, and the
 * rest of the ink running down both sides and round the bottom. `horizontal` asks the same of a
 * tube on its side, its cap at either end — the Queue's silhouette.
 */
function cylinderScore(prepared: Prepared, orientation: 'vertical' | 'horizontal'): number {
  if (prepared.strokes.length < 2) return 0;
  const turns: Array<'identity' | 'left' | 'right'> = orientation === 'vertical' ? ['identity'] : ['left', 'right'];
  let best = 0;
  for (const turn of turns) {
    const strokes = prepared.strokes.map((stroke) => orient(stroke, turn));
    const box = boxOf(strokes.flat());
    if (box.height < 24 || box.width < 18) continue;
    for (let capIndex = 0; capIndex < strokes.length; capIndex += 1) {
      const cap = strokes[capIndex]!;
      const capBox = boxOf(cap);
      if (capBox.width < box.width * 0.68 || capBox.height > box.height * 0.5 || capBox.height > capBox.width * 0.85) continue;
      if (capBox.y - box.y > box.height * 0.15) continue;
      const capScore = ellipseScore(cap, capBox);
      if (capScore <= 0) continue;
      const rest = strokes.filter((_, i) => i !== capIndex).flat();
      if (rest.length === 0) continue;
      const bodyTop = capBox.y + capBox.height / 2;
      const bodyHeight = box.y + box.height - bodyTop;
      if (bodyHeight < capBox.height * 0.8) continue;
      const tolerance = Math.max(5, box.width * 0.12);
      const BINS = 8;
      const left = new Uint8Array(BINS);
      const right = new Uint8Array(BINS);
      const bottom = new Uint8Array(BINS);
      let stray = 0;
      const bottomBand = Math.max(tolerance, capBox.height * 0.75);
      for (const p of rest) {
        const down = (p.y - bodyTop) / bodyHeight;
        const row = Math.min(BINS - 1, Math.max(0, Math.floor(down * BINS)));
        const column = Math.min(BINS - 1, Math.max(0, Math.floor(((p.x - box.x) / box.width) * BINS)));
        let used = false;
        if (Math.abs(p.x - box.x) <= tolerance && down >= -0.1) {
          left[row] = 1;
          used = true;
        }
        if (Math.abs(box.x + box.width - p.x) <= tolerance && down >= -0.1) {
          right[row] = 1;
          used = true;
        }
        if (box.y + box.height - p.y <= bottomBand) {
          bottom[column] = 1;
          used = true;
        }
        if (!used) stray += 1;
      }
      const cover = (bins: Uint8Array) => bins.reduce((sum, bin) => sum + bin, 0) / BINS;
      const score = Math.min(
        capScore,
        ramp(cover(left), 0.35, 0.7),
        ramp(cover(right), 0.35, 0.7),
        ramp(cover(bottom), 0.4, 0.75),
        ramp(stray / rest.length, 0.25, 0.08),
      );
      best = Math.max(best, score);
    }
  }
  return best;
}

/**
 * A stick figure: a small round head at the top centre, and below it a body wider than the head
 * (arms, legs) with no ink above. Only offered with real confidence — a circle over a line is also
 * how a provided interface is drawn, which is why the arms are required.
 */
function personScore(prepared: Prepared): number {
  if (prepared.strokes.length < 2) return 0;
  const { box } = prepared;
  let best = 0;
  for (let headIndex = 0; headIndex < prepared.strokes.length; headIndex += 1) {
    const head = prepared.strokes[headIndex]!;
    const headBox = boxOf(head);
    if (headBox.width < 8 || headBox.height < 8) continue;
    if (headBox.y - box.y > box.height * 0.12 || headBox.height > box.height * 0.45) continue;
    const headCentre = headBox.x + headBox.width / 2;
    if (Math.abs(headCentre - (box.x + box.width / 2)) > box.width * 0.22) continue;
    const headScore = ellipseScore(head, headBox);
    if (headScore <= 0) continue;
    const body = prepared.strokes.filter((_, i) => i !== headIndex).flat();
    const bodyLength = prepared.inkLength - pathLength(head);
    const below = body.filter((p) => p.y >= headBox.y + headBox.height * 0.6).length / Math.max(1, body.length);
    const bodyBox = boxOf(body);
    const score = Math.min(
      headScore,
      ramp(bodyBox.width / headBox.width, 1.05, 1.5),
      ramp(below, 0.8, 0.96),
      ramp((box.y + box.height - (headBox.y + headBox.height)) / headBox.height, 1, 1.7),
      ramp(bodyLength / headBox.height, 2, 3.5),
    );
    best = Math.max(best, score);
  }
  return best;
}

/** The extent of a set of strokes, in their own coordinates. */
export function strokesBox(strokes: readonly (readonly Pt[])[]): Box {
  return unionBox(strokes.map((stroke) => boxOf(stroke)));
}
