/**
 * An orthogonal pathfinder for the connectors the quick router can't draw clear of shapes.
 *
 * The router (`routing.ts`) draws most stepped connectors in one go: a smoothstep elbow, or a single
 * detour round a shape sitting directly between two ends. When that line would cut through a shape,
 * this searches for one that doesn't: A* over a sparse grid whose lines run along every shape's edges
 * (kept `clearance` away), the two ends' stubs and the midline between them, costing length plus a
 * fixed price per bend so the answer reads like a line a person would draw.
 *
 * Correctness rules the search keeps:
 *
 * - Each end leaves along its side's outward normal for `STUB` before anything else, and the last
 *   move arrives the same way: the state carries the direction of travel, and a U-turn is never a move.
 * - Every link between two grid points is checked, not just the points.
 * - The search never leaves `bounds`, the area the caller collected every shape in: a route can't
 *   pass a shape it was never told about.
 * - A retry widens the area searched, never the clearance; the last retry narrows the clearance to
 *   thread a corridor the first could not.
 * - Work is bounded per line (`MAX_POPS`, grid size, shapes in the area), and running out says so
 *   (`budget`) rather than pretending the line is clear.
 *
 * Pure and deterministic: the same request draws the same line, on the canvas, in an export and in
 * the agent's checks.
 */

import type { Side } from '../document/types';

export interface Point {
  x: number;
  y: number;
}

export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Whether a connector's drawn line is clear of every shape it was routed around. `unchecked`: it was
 *  never asked (a straight, curved or hand-bent line, or a frame of a gesture). */
export type RouteStatus = 'clear' | 'blocked' | 'budget' | 'unchecked';

export interface PathRequest {
  from: Point;
  fromSide: Side;
  to: Point;
  toSide: Side;
  /** Every other shape in `bounds`. */
  obstacles: readonly Box[];
  /** The two end shapes, as the part their anchors land on: the line may only touch them at its ends. */
  ends: readonly Box[];
  /** The area every shape in `obstacles` was collected from. The search stays inside it. */
  bounds: Box;
  /** A line to keep apart from — the request line, when routing its reply. */
  avoid?: readonly Point[];
}

export interface PathResult {
  /** The corners from `from` to `to`, or `null` when no clear line was found. */
  points: Point[] | null;
  status: 'clear' | 'blocked' | 'budget';
  /** Heap pops spent, for a caller sharing one budget among many lines. */
  work: number;
}

/** How far a line runs straight out of a side before it may turn — `getSmoothStepPath`'s offset. */
export const STUB = 20;
/** What a turn costs, in pixels of length — the agent's `BEND_COST`. */
export const BEND_COST = 48;
const CLEARANCE = 16;
const NARROW_CLEARANCE = 8;
/** Searched areas, each the ends' box widened this far (and never past `bounds`). */
const REACHES = [64, 128, 256] as const;
/** Heap pops one line may spend across all its tries. */
export const MAX_POPS = 4000;
/** Grid lines per axis; past this the area is too busy to search line by line. */
const MAX_LINES = 160;
/** Shapes in one searched area; past this the line reports `budget`. */
const MAX_REGION_OBSTACLES = 400;
/** A reply line closer than this alongside its request reads as the same line. */
const SAME_LINE = 6;
/** Where a reply may run beside its request: this far to either side of each of its runs. */
const REPLY_GAP = 12;
/** What running alongside the `avoid` line costs, per pixel, on top of the length. */
const ALONGSIDE_COST = 2;
/** How far into a shape a line may graze before it counts as passing through — `segmentEntersRect`'s. */
const INSET = 3;

const DX = [1, 0, -1, 0] as const;
const DY = [0, 1, 0, -1] as const;
const DIRECTION: Record<Side, number> = { right: 0, bottom: 1, left: 2, top: 3 };

const inflate = (b: Box, by: number): Box => ({ x: b.x - by, y: b.y - by, width: b.width + 2 * by, height: b.height + 2 * by });
const meets = (a: Box, b: Box) => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
const within = (p: Point, b: Box) => p.x >= b.x && p.x <= b.x + b.width && p.y >= b.y && p.y <= b.y + b.height;
const round = (v: number) => Math.round(v * 2) / 2;

/** Liang–Barsky: does any part of segment `a`→`b` lie inside `box` shrunk by `INSET`? */
export function segmentEnters(a: Point, b: Point, box: Box): boolean {
  const left = box.x + INSET;
  const right = box.x + box.width - INSET;
  const top = box.y + INSET;
  const bottom = box.y + box.height - INSET;
  if (left >= right || top >= bottom) return false;
  let t0 = 0;
  let t1 = 1;
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const clip = (p: number, q: number) => {
    if (p === 0) return q >= 0;
    const t = q / p;
    if (p < 0) {
      if (t > t1) return false;
      if (t > t0) t0 = t;
    } else {
      if (t < t0) return false;
      if (t < t1) t1 = t;
    }
    return true;
  };
  return clip(-dx, a.x - left) && clip(dx, right - a.x) && clip(-dy, a.y - top) && clip(dy, bottom - a.y) && t1 - t0 > 1e-6;
}

/** Whether a polyline keeps out of every box (its own ends included: it touches them only at their borders). */
export function polylineClear(points: readonly Point[], boxes: readonly Box[]): boolean {
  for (let i = 1; i < points.length; i += 1) {
    const a = points[i - 1]!;
    const b = points[i]!;
    const span: Box = { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), width: Math.abs(b.x - a.x) + 0.01, height: Math.abs(b.y - a.y) + 0.01 };
    for (const box of boxes) {
      if (meets(span, box) && segmentEnters(a, b, box)) return false;
    }
  }
  return true;
}

/** Drops corners that don't turn. */
function simplify(points: readonly Point[]): Point[] {
  const out: Point[] = [];
  for (const p of points) {
    const last = out[out.length - 1];
    if (last && Math.abs(last.x - p.x) < 0.01 && Math.abs(last.y - p.y) < 0.01) continue;
    const before = out[out.length - 2];
    if (before && last && ((Math.abs(before.x - last.x) < 0.01 && Math.abs(last.x - p.x) < 0.01) || (Math.abs(before.y - last.y) < 0.01 && Math.abs(last.y - p.y) < 0.01))) {
      out[out.length - 1] = p;
      continue;
    }
    out.push(p);
  }
  return out;
}

/** A binary min-heap of search states, ordered by estimate, then remaining distance, then id: the
 *  same request always expands in the same order. */
class Heap {
  private f: number[] = [];
  private h: number[] = [];
  private id: number[] = [];

  get size(): number {
    return this.id.length;
  }

  private less(i: number, j: number): boolean {
    return this.f[i]! < this.f[j]! || (this.f[i] === this.f[j] && (this.h[i]! < this.h[j]! || (this.h[i] === this.h[j] && this.id[i]! < this.id[j]!)));
  }

  private swap(i: number, j: number): void {
    [this.f[i], this.f[j]] = [this.f[j]!, this.f[i]!];
    [this.h[i], this.h[j]] = [this.h[j]!, this.h[i]!];
    [this.id[i], this.id[j]] = [this.id[j]!, this.id[i]!];
  }

  push(f: number, h: number, id: number): void {
    this.f.push(f);
    this.h.push(h);
    this.id.push(id);
    let i = this.id.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (!this.less(i, parent)) break;
      this.swap(i, parent);
      i = parent;
    }
  }

  pop(): number {
    const top = this.id[0]!;
    const last = this.id.length - 1;
    this.swap(0, last);
    this.f.pop();
    this.h.pop();
    this.id.pop();
    let i = 0;
    for (;;) {
      const l = 2 * i + 1;
      const r = l + 1;
      let m = i;
      if (l < this.id.length && this.less(l, m)) m = l;
      if (r < this.id.length && this.less(r, m)) m = r;
      if (m === i) break;
      this.swap(i, m);
      i = m;
    }
    return top;
  }
}

/** Sorted, distinct, rounded coordinates within `[lo, hi]`. */
function linesOf(values: readonly number[], lo: number, hi: number): number[] {
  const out = [...new Set(values.map(round))].filter((v) => v >= lo && v <= hi);
  out.sort((a, b) => a - b);
  return out;
}

/** The index of `value` in sorted `lines`, or of the first line past it. */
function lowerBound(lines: readonly number[], value: number): number {
  let lo = 0;
  let hi = lines.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (lines[mid]! < value) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

interface Attempt {
  points: Point[] | null;
  status: 'clear' | 'blocked' | 'budget';
  work: number;
}

function search(request: PathRequest, start: Point, goal: Point, region: Box, clearance: number, pops: number): Attempt {
  const shapes = [...request.obstacles, ...request.ends].filter((box) => meets(inflate(box, clearance), region));
  if (shapes.length > MAX_REGION_OBSTACLES) return { points: null, status: 'budget', work: 0 };
  const inflated = shapes.map((box) => inflate(box, clearance));

  const avoid = request.avoid ?? [];
  const avoidX: number[] = [];
  const avoidY: number[] = [];
  for (let i = 1; i < avoid.length; i += 1) {
    const [a, b] = [avoid[i - 1]!, avoid[i]!];
    if (Math.abs(a.x - b.x) < 0.5) avoidX.push(a.x - REPLY_GAP, a.x + REPLY_GAP);
    if (Math.abs(a.y - b.y) < 0.5) avoidY.push(a.y - REPLY_GAP, a.y + REPLY_GAP);
  }
  const xs = linesOf([start.x, goal.x, (start.x + goal.x) / 2, region.x, region.x + region.width, ...inflated.flatMap((b) => [b.x, b.x + b.width]), ...avoidX], region.x, region.x + region.width);
  const ys = linesOf([start.y, goal.y, (start.y + goal.y) / 2, region.y, region.y + region.height, ...inflated.flatMap((b) => [b.y, b.y + b.height]), ...avoidY], region.y, region.y + region.height);
  if (xs.length > MAX_LINES || ys.length > MAX_LINES) return { points: null, status: 'budget', work: 0 };
  const nx = xs.length;
  const ny = ys.length;
  const si = lowerBound(xs, round(start.x));
  const sj = lowerBound(ys, round(start.y));
  const gi = lowerBound(xs, round(goal.x));
  const gj = lowerBound(ys, round(goal.y));

  // Points and links strictly inside an inflated shape. Every shape's border is a grid line, so a
  // shape covers whole index ranges: its interior lines and the links between them.
  const vertexBlocked = new Uint8Array(nx * ny);
  const hBlocked = new Uint8Array(nx * ny); // link (i, j) → (i + 1, j)
  const vBlocked = new Uint8Array(nx * ny); // link (i, j) → (i, j + 1)
  let marking = 0;
  for (const box of inflated) {
    const i0 = lowerBound(xs, round(box.x));
    const i1 = lowerBound(xs, round(box.x + box.width));
    const j0 = lowerBound(ys, round(box.y));
    const j1 = lowerBound(ys, round(box.y + box.height));
    // A shape reaching past the region: its border is the region's edge, which is a line too.
    for (let j = j0; j <= Math.min(j1, ny - 1); j += 1) {
      const interiorRow = ys[j]! > box.y && ys[j]! < box.y + box.height;
      for (let i = i0; i <= Math.min(i1, nx - 1); i += 1) {
        marking += 1;
        const interiorColumn = xs[i]! > box.x && xs[i]! < box.x + box.width;
        if (interiorRow && interiorColumn) vertexBlocked[j * nx + i] = 1;
        if (interiorRow && i + 1 < nx && xs[i]! >= box.x && xs[i + 1]! <= box.x + box.width) hBlocked[j * nx + i] = 1;
        if (interiorColumn && j + 1 < ny && ys[j]! >= box.y && ys[j + 1]! <= box.y + box.height) vBlocked[j * nx + i] = 1;
      }
    }
  }
  // The stubs' tips may sit inside another shape's clearance (it is right beside the end). They
  // stay usable, and so do the links out of them: the finished line is checked against the shapes
  // themselves.
  for (const [i, j] of [[si, sj], [gi, gj]] as const) {
    vertexBlocked[j * nx + i] = 0;
    if (i < nx - 1) hBlocked[j * nx + i] = 0;
    if (i > 0) hBlocked[j * nx + i - 1] = 0;
    if (j < ny - 1) vBlocked[j * nx + i] = 0;
    if (j > 0) vBlocked[(j - 1) * nx + i] = 0;
  }

  const startDir = DIRECTION[request.fromSide];
  // The last move into the goal shape runs against its outward normal.
  const intoGoal = (DIRECTION[request.toSide] + 2) % 4;
  const alongside = (x0: number, y0: number, x1: number, y1: number): number => {
    let cost = 0;
    for (let k = 1; k < avoid.length; k += 1) {
      const [a, b] = [avoid[k - 1]!, avoid[k]!];
      if (y0 === y1 && Math.abs(a.y - b.y) < 0.5 && Math.abs(a.y - y0) < SAME_LINE) {
        cost += Math.max(0, Math.min(Math.max(x0, x1), Math.max(a.x, b.x)) - Math.max(Math.min(x0, x1), Math.min(a.x, b.x)));
      } else if (x0 === x1 && Math.abs(a.x - b.x) < 0.5 && Math.abs(a.x - x0) < SAME_LINE) {
        cost += Math.max(0, Math.min(Math.max(y0, y1), Math.max(a.y, b.y)) - Math.max(Math.min(y0, y1), Math.min(a.y, b.y)));
      }
    }
    return cost * ALONGSIDE_COST;
  };

  const states = nx * ny * 4;
  const g = new Float64Array(states).fill(Infinity);
  const parent = new Int32Array(states).fill(-1);
  const goalX = xs[gi]!;
  const goalY = ys[gj]!;
  const estimate = (i: number, j: number) => {
    const dx = Math.abs(xs[i]! - goalX);
    const dy = Math.abs(ys[j]! - goalY);
    return dx + dy + (dx > 0.01 && dy > 0.01 ? BEND_COST : 0);
  };
  const heap = new Heap();
  const first = (sj * nx + si) * 4 + startDir;
  g[first] = 0;
  heap.push(estimate(si, sj), estimate(si, sj), first);
  let work = Math.ceil(marking / 64);
  let best = -1;
  let bestCost = Infinity;
  while (heap.size) {
    if (work >= pops) return { points: null, status: 'budget', work };
    const state = heap.pop();
    work += 1;
    const dir = state & 3;
    const vertex = state >> 2;
    const i = vertex % nx;
    const j = (vertex - i) / nx;
    const cost = g[state]!;
    if (cost >= bestCost) break;
    if (i === gi && j === gj) {
      // Arriving: a U-turn into the shape is no move, any other direction needs one more bend.
      if (dir !== DIRECTION[request.toSide]) {
        const total = cost + (dir === intoGoal ? 0 : BEND_COST);
        if (total < bestCost) {
          bestCost = total;
          best = state;
        }
      }
      continue;
    }
    for (let next = 0; next < 4; next += 1) {
      if (next === (dir + 2) % 4) continue;
      const ni = i + DX[next]!;
      const nj = j + DY[next]!;
      if (ni < 0 || nj < 0 || ni >= nx || nj >= ny) continue;
      if (vertexBlocked[nj * nx + ni]) continue;
      const link = next === 0 ? hBlocked[j * nx + i] : next === 2 ? hBlocked[j * nx + ni] : next === 1 ? vBlocked[j * nx + i] : vBlocked[nj * nx + i];
      if (link) continue;
      const step = Math.abs(xs[ni]! - xs[i]!) + Math.abs(ys[nj]! - ys[j]!) + (next === dir ? 0 : BEND_COST) + (avoid.length ? alongside(xs[i]!, ys[j]!, xs[ni]!, ys[nj]!) : 0);
      const id = (nj * nx + ni) * 4 + next;
      const total = cost + step;
      if (total < g[id]!) {
        g[id] = total;
        parent[id] = state;
        const h = estimate(ni, nj);
        heap.push(total + h, h, id);
      }
    }
  }
  if (best < 0) return { points: null, status: 'blocked', work };
  const corners: Point[] = [];
  for (let state = best; state >= 0; state = parent[state]!) {
    const vertex = state >> 2;
    const i = vertex % nx;
    corners.push({ x: xs[i]!, y: ys[(vertex - i) / nx]! });
  }
  corners.reverse();
  return { points: corners, status: 'clear', work };
}

/**
 * A clear orthogonal line from `from` to `to`, leaving and arriving square to their sides — or why
 * there isn't one. The finished corners are checked against the shapes themselves before they are
 * returned; a caller rounding the corners checks the rounded line again (see `routing.ts`).
 */
export function orthogonalRoute(request: PathRequest, pops = MAX_POPS): PathResult {
  const { from, to, fromSide, toSide, bounds } = request;
  const start = { x: round(from.x + DX[DIRECTION[fromSide]]! * STUB), y: round(from.y + DY[DIRECTION[fromSide]]! * STUB) };
  const goal = { x: round(to.x + DX[DIRECTION[toSide]]! * STUB), y: round(to.y + DY[DIRECTION[toSide]]! * STUB) };
  // A stub that runs into a shape can't be routed from at all.
  const shapes = [...request.obstacles, ...request.ends];
  if (!polylineClear([from, start], request.obstacles) || !polylineClear([goal, to], request.obstacles)) return { points: null, status: 'blocked', work: 0 };
  if (!within(start, bounds) || !within(goal, bounds)) return { points: null, status: 'blocked', work: 0 };

  const span = {
    x: Math.min(from.x, to.x, start.x, goal.x),
    y: Math.min(from.y, to.y, start.y, goal.y),
    right: Math.max(from.x, to.x, start.x, goal.x),
    bottom: Math.max(from.y, to.y, start.y, goal.y),
  };
  const regionAt = (reach: number): Box => {
    const x = Math.max(bounds.x, span.x - reach);
    const y = Math.max(bounds.y, span.y - reach);
    const right = Math.min(bounds.x + bounds.width, span.right + reach);
    const bottom = Math.min(bounds.y + bounds.height, span.bottom + reach);
    return { x, y, width: right - x, height: bottom - y };
  };
  const tries: [number, number][] = [...REACHES.map((reach): [number, number] => [reach, CLEARANCE]), [REACHES[REACHES.length - 1]!, NARROW_CLEARANCE]];
  let work = 0;
  let exhausted = false;
  for (const [reach, clearance] of tries) {
    const attempt = search(request, start, goal, regionAt(reach), clearance, pops - work);
    work += attempt.work;
    if (attempt.status === 'budget') {
      exhausted = true;
      if (work >= pops) break;
      continue;
    }
    if (!attempt.points) continue;
    const points = simplify([from, ...attempt.points, to]);
    if (polylineClear(points, shapes)) return { points, status: 'clear', work };
  }
  return { points: null, status: exhausted ? 'budget' : 'blocked', work };
}
