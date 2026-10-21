import type { DraftPoint, Side } from '../document/types';

/**
 * Hand-routed connectors: the geometry behind `DraftEdge.waypoints`.
 *
 * A connector the user has bent keeps its two ends on its shapes, like any other, and passes
 * through the points they placed in between. A stepped connector stays orthogonal whatever those
 * points are: the elbows it needs are derived here at draw time rather than stored, so a shape
 * moving under a fixed bend still meets it with a clean right angle instead of a diagonal.
 *
 * Pure and React-free — the canvas, the exporter and line jumps all route through `routing.ts`,
 * which calls into this module, so a bent line is drawn identically everywhere.
 */

type Point = DraftPoint;

/** How far a stepped line runs straight out of a shape before its first turn — the same leg
 *  `routing.ts`'s detours and React Flow's own smoothstep use. */
export const STUB_LEG = 20;

/** Coordinates closer than this are the same line — a stored point is rounded, a live one is not. */
const EPSILON = 0.5;

const near = (a: number, b: number) => Math.abs(a - b) < EPSILON;
const samePoint = (a: Point, b: Point) => near(a.x, b.x) && near(a.y, b.y);

export const OUTWARD: Record<Side, Point> = {
  top: { x: 0, y: -1 },
  bottom: { x: 0, y: 1 },
  left: { x: -1, y: 0 },
  right: { x: 1, y: 0 },
};

/** -1, 0 or 1 per axis: the direction of travel from `a` to `b` along an orthogonal run. */
function heading(a: Point, b: Point): Point {
  return { x: near(a.x, b.x) ? 0 : Math.sign(b.x - a.x), y: near(a.y, b.y) ? 0 : Math.sign(b.y - a.y) };
}

/** What turning at `q` costs, travelling `p → q → r`: nothing straight on, one corner for a right
 *  angle, and a lot for doubling back over the line just drawn. Only meaningful for orthogonal runs;
 *  a diagonal or zero-length leg has no opinion. */
function turnCost(p: Point, q: Point, r: Point): number {
  const a = heading(p, q);
  const b = heading(q, r);
  if ((a.x !== 0 && a.y !== 0) || (b.x !== 0 && b.y !== 0)) return 0;
  if ((a.x === 0 && a.y === 0) || (b.x === 0 && b.y === 0)) return 0;
  if (a.x === b.x && a.y === b.y) return 0;
  if (a.x === -b.x && a.y === -b.y) return 3;
  return 1;
}

/**
 * Makes a run of points orthogonal, inserting one elbow between any two that are not already level
 * or plumb. Of the two possible elbows, the one that adds fewer turns where it joins the run before
 * and after it wins — so an elbow carries on in the direction the line was already going, and
 * arrives in the direction the next run leaves, instead of zig-zagging.
 */
function orthogonalize(points: readonly Point[]): Point[] {
  const out: Point[] = [points[0]!];
  for (let i = 1; i < points.length; i += 1) {
    const a = out[out.length - 1]!;
    const b = points[i]!;
    if (near(a.x, b.x) || near(a.y, b.y)) {
      out.push(b);
      continue;
    }
    const before = out.length >= 2 ? out[out.length - 2] : undefined;
    const after = points[i + 1];
    const across = { x: b.x, y: a.y };
    const down = { x: a.x, y: b.y };
    const cost = (elbow: Point) => (before ? turnCost(before, a, elbow) : 0) + (after ? turnCost(elbow, b, after) : 0);
    out.push(cost(down) < cost(across) ? down : across, b);
  }
  return out;
}

/**
 * Drops repeated points and the middle of any three in a straight line — the vertices that
 * actually turn are all a stepped line needs, and what a bend handle is drawn for. A point that
 * doubles back is a real turn and stays.
 */
export function simplifyPolyline(points: readonly Point[]): Point[] {
  const deduped: Point[] = [];
  for (const point of points) {
    const last = deduped[deduped.length - 1];
    if (last && samePoint(last, point)) continue;
    deduped.push(point);
  }
  const out: Point[] = [];
  for (const point of deduped) {
    while (out.length >= 2) {
      const a = out[out.length - 2]!;
      const b = out[out.length - 1]!;
      const cross = (b.x - a.x) * (point.y - b.y) - (b.y - a.y) * (point.x - b.x);
      const dot = (b.x - a.x) * (point.x - b.x) + (b.y - a.y) * (point.y - b.y);
      if (Math.abs(cross) > EPSILON * Math.max(1, Math.hypot(point.x - a.x, point.y - a.y)) || dot < 0) break;
      out.pop();
    }
    out.push(point);
  }
  return out;
}

/**
 * Where a stepped line leaves (or meets) a shape on its way to (or from) `toward`: straight out of
 * the side for at most `STUB_LEG`, but never past the point it is heading for — otherwise a bend
 * placed just off the shape would get a hook back to it.
 */
function stubFor(end: Point, side: Side, toward: Point): Point {
  const out = OUTWARD[side];
  const ahead = (toward.x - end.x) * out.x + (toward.y - end.y) * out.y;
  const leg = ahead > EPSILON ? Math.min(ahead, STUB_LEG) : STUB_LEG;
  return { x: end.x + out.x * leg, y: end.y + out.y * leg };
}

/**
 * A stepped connector's whole polyline through hand-placed bends: out of `sourceSide`, through every
 * waypoint in order, and into `targetSide`, square at both ends and orthogonal throughout.
 */
export function orthogonalThrough(
  from: Point,
  sourceSide: Side,
  waypoints: readonly Point[],
  to: Point,
  targetSide: Side,
): Point[] {
  const first = waypoints[0] ?? to;
  const last = waypoints[waypoints.length - 1] ?? from;
  const run = [from, stubFor(from, sourceSide, first), ...waypoints, stubFor(to, targetSide, last), to];
  return squareUp(simplifyPolyline(orthogonalize(run)));
}

/**
 * Makes every run that `near` calls level or plumb exactly so, keeping both ends where the shapes put
 * them. Stored bends are whole units but a shape's side can fall between them (an anchor at y 157.25),
 * and the rounded-corner drawing compares exactly: a quarter-unit slant read as a turn and drew a
 * diagonal into the first bend.
 */
function squareUp(points: readonly Point[]): Point[] {
  const out = points.map((p) => ({ ...p }));
  const last = out.length - 1;
  for (let i = 1; i < last; i += 1) {
    const a = out[i - 1]!;
    const b = out[i]!;
    if (near(a.y, b.y)) b.y = a.y;
    else if (near(a.x, b.x)) b.x = a.x;
  }
  // The target end is fixed too: carry its line back onto the run that meets it.
  for (let i = last - 1; i > 0; i -= 1) {
    const a = out[i]!;
    const b = out[i + 1]!;
    if (a.x === b.x || a.y === b.y) break;
    if (near(a.y, b.y)) a.y = b.y;
    else if (near(a.x, b.x)) a.x = b.x;
    else break;
  }
  return out;
}

/**
 * The corners of an orthogonal path `d` as `routing.ts` and React Flow's smoothstep draw it — the
 * start, every rounded corner's control point (which is where the corner would be, unrounded), and
 * the end. What a stepped connector the router drew looks like as bend points, so the first drag
 * of one starts from the line on screen rather than from nothing.
 */
export function stepPolyline(d: string): Point[] {
  const tokens = d.match(/[A-Za-z]|-?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?/g);
  if (!tokens) return [];
  const out: Point[] = [];
  let command = '';
  let last: Point | undefined;
  let i = 0;
  const num = () => Number(tokens[i++]);
  while (i < tokens.length) {
    const token = tokens[i]!;
    if (/[A-Za-z]/.test(token)) {
      command = token.toUpperCase();
      i += 1;
      continue;
    }
    if (command === 'M') {
      last = { x: num(), y: num() };
      out.push(last);
    } else if (command === 'L') {
      last = { x: num(), y: num() };
    } else if (command === 'Q') {
      out.push({ x: num(), y: num() });
      last = { x: num(), y: num() };
    } else if (command === 'C') {
      i += 4;
      last = { x: num(), y: num() };
    } else {
      return [];
    }
  }
  if (last) out.push(last);
  return out.some((p) => Number.isNaN(p.x) || Number.isNaN(p.y)) ? [] : simplifyPolyline(out);
}

/** Whether a run is level (`true`), plumb (`false`), or neither. */
export function isLevel(a: Point, b: Point): boolean | undefined {
  if (near(a.y, b.y) && !near(a.x, b.x)) return true;
  if (near(a.x, b.x) && !near(a.y, b.y)) return false;
  return undefined;
}

/**
 * Slides one run of a stepped polyline sideways, to `value` on its own cross axis (a level run's
 * new y, a plumb one's new x). Its neighbours stretch to follow, so the line stays orthogonal.
 *
 * The first and last runs are where the line meets a shape, and that end must not move: a short
 * stub stays on the shape and a new jog carries the line across to the slid run instead — the same
 * thing dragging that run of a connector does in any diagram editor.
 */
export function slideSegment(polyline: readonly Point[], index: number, value: number): Point[] {
  const a = polyline[index];
  const b = polyline[index + 1];
  if (!a || !b) return [...polyline];
  const level = isLevel(a, b);
  if (level === undefined) return [...polyline];
  const moved = (p: Point): Point => (level ? { x: p.x, y: value } : { x: value, y: p.y });
  const length = Math.hypot(b.x - a.x, b.y - a.y);
  const unit = { x: (b.x - a.x) / length, y: (b.y - a.y) / length };
  const stub = Math.min(STUB_LEG, length / 3);
  const run: Point[] = [];
  if (index === 0) {
    const s = { x: a.x + unit.x * stub, y: a.y + unit.y * stub };
    run.push(a, s, moved(s));
  } else {
    run.push(moved(a));
  }
  if (index + 1 === polyline.length - 1) {
    const t = { x: b.x - unit.x * stub, y: b.y - unit.y * stub };
    run.push(moved(t), t, b);
  } else {
    run.push(moved(b));
  }
  return [...polyline.slice(0, index), ...run, ...polyline.slice(index + 2)];
}

/** The bends a polyline stores — everything but its two ends, which belong to the shapes. */
export function bendsOf(polyline: readonly Point[]): Point[] {
  return polyline.slice(1, -1).map((p) => ({ x: Math.round(p.x), y: Math.round(p.y) }));
}

/** The point halfway along a polyline, by length. */
export function polylineMidpoint(points: readonly Point[]): Point {
  let total = 0;
  for (let i = 1; i < points.length; i += 1) total += Math.hypot(points[i]!.x - points[i - 1]!.x, points[i]!.y - points[i - 1]!.y);
  let remaining = total / 2;
  for (let i = 1; i < points.length; i += 1) {
    const a = points[i - 1]!;
    const b = points[i]!;
    const length = Math.hypot(b.x - a.x, b.y - a.y);
    if (length >= remaining && length > 0) {
      const t = remaining / length;
      return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
    }
    remaining -= length;
  }
  return points[0] ?? { x: 0, y: 0 };
}

/** The middle of a polyline's longest run — where a stepped line's label has the most room. */
export function longestRunMidpoint(points: readonly Point[]): Point {
  let best = 0;
  let bestLength = -1;
  for (let i = 1; i < points.length; i += 1) {
    const length = Math.hypot(points[i]!.x - points[i - 1]!.x, points[i]!.y - points[i - 1]!.y);
    if (length > bestLength) {
      bestLength = length;
      best = i;
    }
  }
  const a = points[Math.max(0, best - 1)] ?? { x: 0, y: 0 };
  const b = points[best] ?? a;
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

/** A straight connector through its bends: one sharp corner at each. */
export function polylinePath(points: readonly Point[]): string {
  return points.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x} ${p.y}`).join('');
}

/**
 * A curved connector through its bends: a Catmull-Rom spline, leaving the source and arriving at
 * the target square to their sides — the same promise React Flow's bezier makes, which is what
 * lets the arrowhead keep pointing straight into the shape (`endTangent`).
 */
export function smoothPath(points: readonly Point[], sourceSide: Side, targetSide: Side): string {
  if (points.length < 2) return '';
  const tangents = points.map((p, i) => {
    if (i === 0) {
      const reach = Math.hypot(points[1]!.x - p.x, points[1]!.y - p.y);
      return { x: OUTWARD[sourceSide].x * reach, y: OUTWARD[sourceSide].y * reach };
    }
    if (i === points.length - 1) {
      const reach = Math.hypot(p.x - points[i - 1]!.x, p.y - points[i - 1]!.y);
      return { x: -OUTWARD[targetSide].x * reach, y: -OUTWARD[targetSide].y * reach };
    }
    return { x: (points[i + 1]!.x - points[i - 1]!.x) / 2, y: (points[i + 1]!.y - points[i - 1]!.y) / 2 };
  });
  let d = `M${points[0]!.x} ${points[0]!.y}`;
  for (let i = 1; i < points.length; i += 1) {
    const a = points[i - 1]!;
    const b = points[i]!;
    const ta = tangents[i - 1]!;
    const tb = tangents[i]!;
    d += `C${a.x + ta.x / 3} ${a.y + ta.y / 3} ${b.x - tb.x / 3} ${b.y - tb.y / 3} ${b.x} ${b.y}`;
  }
  return d;
}

/** Bends shifted by `dx`, `dy` — a connector carried along with both of its shapes. */
export function translateWaypoints(points: readonly Point[], dx: number, dy: number): Point[] {
  return points.map((p) => ({ x: p.x + dx, y: p.y + dy }));
}

/**
 * The reply line of a bent request/response connector: the same bends in reverse, shifted by the
 * reply's lane. Shifting every point by the same amount on both axes moves each level run down and
 * each plumb run across by that amount — a parallel copy of an orthogonal line, the same offset
 * `laneNudge` gives its two ends.
 */
export function responseWaypoints(points: readonly Point[], shift: number): Point[] {
  return translateWaypoints([...points].reverse(), shift, shift);
}
