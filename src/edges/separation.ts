/**
 * Parallel tracks for connectors that would otherwise run on top of each other.
 *
 * Two stepped connectors between different shapes often take the same corridor — the midline between
 * two columns, the clear lane past a tall shape — and drew one line over the other, so neither could
 * be followed. This plan finds those shared stretches and moves each line's run onto its own track,
 * `SPACING` apart, the way a person would draw them.
 *
 * It is a checked change, not a rule applied blindly:
 *
 * - Only a stepped line's **inner** runs move, never its first or last (where it leaves and meets a
 *   shape — `endpoints.ts` decides those), and only runs long enough to round both corners.
 * - Lines drawn as one on purpose are left together: a trunk's members, connectors sharing a label,
 *   a connector and its own reply. Bent, straight and curved lines, and trunks, never move; another
 *   line may move clear of them.
 * - Runs in one corridor are ordered by which way each turns at its two ends, so lines that leave on
 *   the same side stay on that side and the shift adds no crossing it can avoid.
 * - Every shifted line is checked whole before it is kept: its neighbouring runs still turn the same
 *   way with room for their corners, it touches no shape, it lands on no other line, and crossings
 *   among it and the lines it passes do not go up. A corridor that fails is tried once more at
 *   `NARROW_SPACING`, then left as it was and recorded in `skipped`.
 *
 * Presentation only, like trunks and line jumps: nothing is saved. Built once per document change from
 * the routes before separation (`rawRouteInputs`) and memoized like `routingPlan`; within budgets
 * (`MAX_RUNS`, `MAX_MEMBERS`, `MAX_WORK`) it stops early and the same diagram always stops in the same
 * place.
 */

import type { DraftEdge, DraftNode } from '../document/types';
import { routingPlan } from './bundles';
import { edgeRoutes, rawRouteInputs, type EdgeRouteInputs } from './edgeRoutes';
import { labelLook } from './endpoints';
import { polylineClear, type Box, type Point } from './pathfinder';
import { flattenPath, roundedStepPath, shiftRuns, type Track } from './routing';
import { sameNodeGeometry, type PlanScope } from './sameGeometry';
import { stepPolyline } from './waypoints';

export interface EdgeTracks {
  request?: readonly Track[];
  response?: readonly Track[];
}

export interface SeparationPlan {
  tracksFor(edgeId: string): EdgeTracks | undefined;
  /** Corridors left as they were, because no separation passed its checks or the budget ran out. */
  skipped: number;
}

const SPACING = 10;
const NARROW_SPACING = 6;
/** Closer than this, two parallel runs read as one line. */
const SAME_LINE = 6;
/** Runs within this of each other belong to one corridor, however they chain. */
const CORRIDOR = 3 * SAME_LINE;
/** Two runs share a stretch when they overlap this far along it. */
const MIN_OVERLAP = 8;
/** A run must be this long to move: room to round both its corners (radius 10) and a little more. */
const MIN_RUN = 24;
/** The runs either side of a moved one must keep this much: their corners still round. */
const MIN_LEG = 20;
const MAX_RUNS = 20_000;
const MAX_MEMBERS = 24;
const MAX_WORK = 200_000;

interface Line {
  key: string;
  edge: DraftEdge;
  role: 'request' | 'response';
  corners: Point[];
  movable: boolean;
  /** What the line may not touch: the shapes it was routed around and its own two ends. */
  blockers: readonly Box[];
  spine?: string;
  label?: string;
  bounds: Box;
}

interface Run {
  line: Line;
  index: number;
  horizontal: boolean;
  coord: number;
  from: number;
  to: number;
  movable: boolean;
}

const EMPTY: SeparationPlan = { tracksFor: () => undefined, skipped: 0 };
const cache = new WeakMap<readonly DraftNode[], WeakMap<readonly DraftEdge[], SeparationPlan>>();
const transientCache = new WeakMap<readonly DraftNode[], WeakMap<readonly DraftEdge[], SeparationPlan>>();
let last: { nodes: readonly DraftNode[]; edges: readonly DraftEdge[]; plan: SeparationPlan } | null = null;
const interned = new Map<string, EdgeTracks>();
const MAX_INTERNED = 8192;

export function separationPlan(nodes: readonly DraftNode[], edges: readonly DraftEdge[], scope: PlanScope = 'canvas'): SeparationPlan {
  const known = (scope === 'canvas' ? cache : transientCache).get(nodes)?.get(edges) ?? cache.get(nodes)?.get(edges);
  if (known) return known;
  const previous = last;
  const reusable = previous && previous.edges === edges && sameNodeGeometry(previous.nodes, nodes) ? previous.plan : null;
  const plan = reusable ?? compute(nodes, edges, scope);
  if (scope === 'canvas') last = { nodes, edges, plan };
  const store = scope === 'canvas' ? cache : transientCache;
  const byNodes = store.get(nodes);
  if (byNodes) byNodes.set(edges, plan);
  else store.set(nodes, new WeakMap([[edges, plan]]));
  return plan;
}

function boundsOf(points: readonly Point[]): Box {
  let left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity;
  for (const p of points) {
    left = Math.min(left, p.x);
    top = Math.min(top, p.y);
    right = Math.max(right, p.x);
    bottom = Math.max(bottom, p.y);
  }
  return { x: left, y: top, width: right - left, height: bottom - top };
}

const meets = (a: Box, b: Box, pad = 0) => a.x - pad <= b.x + b.width && b.x - pad <= a.x + a.width && a.y - pad <= b.y + b.height && b.y - pad <= a.y + a.height;

/** The part of a shape a line lands on — `routing.ts`'s rule, for checking a moved line. */
function glyph(rect: EdgeRouteInputs['source']): Box {
  const band = rect.anchorBand;
  if (!band) return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
  const left = band.left ?? rect.x;
  const right = band.right ?? rect.x + rect.width;
  const top = band.glyphTop ?? rect.y;
  return { x: left, y: top, width: right - left, height: rect.y + rect.height - top };
}

function compute(nodes: readonly DraftNode[], edges: readonly DraftEdge[], scope: PlanScope): SeparationPlan {
  if (edges.length < 2) return EMPTY;
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const spines = routingPlan(nodes, edges, scope);
  const lines: Line[] = [];
  for (const edge of edges) {
    const inputs = rawRouteInputs(edge, { nodes, edges }, scope, byId);
    if (!inputs) continue;
    const routes = edgeRoutes(inputs, scope);
    const spine = spines.spineFor(edge.id);
    const stepped = edge.routing === 'smoothstep' && !edge.waypoints?.length;
    const look = labelLook(edge);
    for (const [role, route] of [['request', routes.request], ['response', routes.response]] as const) {
      if (!route) continue;
      const corners = stepped ? stepPolyline(route.d) : flattenPath(route.d).map(({ x, y }) => ({ x, y }));
      if (corners.length < 2) continue;
      lines.push({
        key: `${edge.id}:${role}`,
        edge,
        role,
        corners,
        movable: stepped && !spine,
        blockers: [...inputs.obstacles, glyph(inputs.source), glyph(inputs.target)],
        spine: spine?.id,
        label: role === 'request' && look ? `${edge.source}:${route.source.side}:${look}` : undefined,
        bounds: boundsOf(corners),
      });
    }
  }

  const runs: Run[] = [];
  for (const line of lines) {
    const c = line.corners;
    // A movable line's inner runs only; every run of a fixed line, which others keep clear of.
    const first = line.movable ? 1 : 0;
    const lastRun = line.movable ? c.length - 3 : c.length - 2;
    for (let i = first; i <= lastRun; i += 1) {
      const a = c[i]!;
      const b = c[i + 1]!;
      const horizontal = Math.abs(a.y - b.y) < 0.5;
      const vertical = Math.abs(a.x - b.x) < 0.5;
      if (!horizontal && !vertical) continue;
      const from = horizontal ? Math.min(a.x, b.x) : Math.min(a.y, b.y);
      const to = horizontal ? Math.max(a.x, b.x) : Math.max(a.y, b.y);
      if (to - from < MIN_OVERLAP) continue;
      runs.push({ line, index: i, horizontal, coord: horizontal ? a.y : a.x, from, to, movable: line.movable && to - from >= MIN_RUN });
    }
    if (runs.length > MAX_RUNS) return EMPTY;
  }

  const together = (a: Line, b: Line) =>
    a.edge === b.edge || Boolean(a.spine && a.spine === b.spine) || Boolean(a.label && a.label === b.label);

  // Corridors: runs of one direction within `SAME_LINE` of the one before, `CORRIDOR` wide at most.
  const components: Run[][] = [];
  for (const horizontal of [true, false]) {
    const ordered = runs.filter((r) => r.horizontal === horizontal).sort((a, b) => a.coord - b.coord || a.from - b.from || (a.line.key < b.line.key ? -1 : 1));
    let corridor: Run[] = [];
    const flush = () => {
      if (corridor.length > 1) components.push(...overlapping(corridor, together));
      corridor = [];
    };
    for (const run of ordered) {
      const previous = corridor[corridor.length - 1];
      if (previous && (run.coord - previous.coord > SAME_LINE || run.coord - corridor[0]!.coord > CORRIDOR)) flush();
      corridor.push(run);
    }
    flush();
  }

  const shifts = new Map<Line, Map<number, number>>();
  let work = 0;
  let skipped = 0;
  for (const component of components) {
    if (work > MAX_WORK || component.length > MAX_MEMBERS || component.filter((r) => !r.movable).length > 1 || component.every((r) => !r.movable)) {
      skipped += 1;
      continue;
    }
    // Every order at the wider spacing first; of those that pass, the one leaving the fewest
    // crossings — two lines that turn alike nest without crossing only one way round, and the first
    // order to pass is not always that one. The narrower spacing only when the wider can't pass.
    let best: { proposal: Map<Run, number>; result: ReturnType<typeof check> } | undefined;
    for (const spacing of [SPACING, NARROW_SPACING]) {
      for (const order of orders(component)) {
        const proposal = place(order, spacing);
        if (!proposal) continue;
        const result = check(proposal, lines, together);
        work += result.work;
        if (result.ok && (!best || result.crossings < best.result.crossings)) best = { proposal, result };
      }
      if (best) break;
    }
    if (!best) {
      skipped += 1;
      continue;
    }
    for (const [line, corners] of best.result.shifted) {
      line.corners = corners;
      line.bounds = boundsOf(corners);
    }
    for (const [run, delta] of best.proposal) {
      if (!delta) continue;
      const map = shifts.get(run.line) ?? new Map<number, number>();
      map.set(run.index, (map.get(run.index) ?? 0) + delta);
      shifts.set(run.line, map);
    }
  }

  if (shifts.size === 0) return skipped ? { tracksFor: () => undefined, skipped } : EMPTY;
  const byEdge = new Map<string, EdgeTracks>();
  for (const [line, map] of shifts) {
    const tracks = [...map.entries()].sort(([a], [b]) => a - b).map(([run, delta]) => ({ run, delta }));
    const entry = byEdge.get(line.edge.id) ?? {};
    entry[line.role] = tracks;
    byEdge.set(line.edge.id, entry);
  }
  const handed = new Map<string, EdgeTracks>();
  for (const [id, tracks] of byEdge) handed.set(id, scope === 'canvas' ? intern(id, tracks) : tracks);
  return planOf(handed, skipped);
}

/** Built outside `compute`, so the plan keeps the answers and none of the working state. */
function planOf(tracks: ReadonlyMap<string, EdgeTracks>, skipped: number): SeparationPlan {
  return { tracksFor: (edgeId) => tracks.get(edgeId), skipped };
}

function intern(edgeId: string, tracks: EdgeTracks): EdgeTracks {
  const before = interned.get(edgeId);
  if (before && JSON.stringify(before) === JSON.stringify(tracks)) return before;
  if (interned.size >= MAX_INTERNED) interned.clear();
  interned.set(edgeId, tracks);
  return tracks;
}

/** The groups of a corridor's runs that share a stretch with a run of another line, joined through each other. */
function overlapping(corridor: readonly Run[], together: (a: Line, b: Line) => boolean): Run[][] {
  const parent = corridor.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i]!)));
  const linked = new Set<number>();
  for (let i = 0; i < corridor.length; i += 1) {
    for (let j = i + 1; j < corridor.length; j += 1) {
      const a = corridor[i]!;
      const b = corridor[j]!;
      if (a.line === b.line || together(a.line, b.line)) continue;
      if (Math.min(a.to, b.to) - Math.max(a.from, b.from) < MIN_OVERLAP) continue;
      parent[find(i)] = find(j);
      linked.add(i);
      linked.add(j);
    }
  }
  const groups = new Map<number, Run[]>();
  for (const i of linked) {
    const root = find(i);
    const group = groups.get(root);
    if (group) group.push(corridor[i]!);
    else groups.set(root, [corridor[i]!]);
  }
  return [...groups.values()];
}

/** Which way a run's line turns at each end, across the run: −1 towards smaller coordinates, +1 larger. */
function turns(run: Run): number {
  const c = run.line.corners;
  const across = (p: Point) => (run.horizontal ? p.y : p.x);
  const along = (p: Point) => (run.horizontal ? p.x : p.y);
  const here = across(c[run.index]!);
  const before = c[run.index - 1];
  const after = c[run.index + 2];
  // At the run's low end and its high end, whichever way the corners run.
  const lowFirst = along(c[run.index]!) <= along(c[run.index + 1]!);
  const sideOf = (p: Point | undefined) => (p ? Math.sign(across(p) - here) : 0);
  const low = lowFirst ? sideOf(before) : sideOf(after);
  const high = lowFirst ? sideOf(after) : sideOf(before);
  return low + high;
}

/**
 * How far a run may move across its direction: the runs either side of it must keep running the same
 * way and keep `MIN_LEG` (or what they had, if less). A run that can't move has `[0, 0]`.
 */
function rangeOf(run: Run): [number, number] {
  if (!run.movable) return [0, 0];
  const c = run.line.corners;
  const across = (p: Point) => (run.horizontal ? p.y : p.x);
  const here = across(c[run.index]!);
  let lo = -Infinity;
  let hi = Infinity;
  for (const neighbour of [c[run.index - 1], c[run.index + 2]]) {
    if (!neighbour) continue;
    const gap = across(neighbour) - here;
    const keep = Math.min(MIN_LEG, Math.abs(gap));
    // The leg runs from the run towards `neighbour`: moving the run by d changes it to gap - d.
    if (gap > 0) hi = Math.min(hi, gap - keep);
    else if (gap < 0) lo = Math.max(lo, gap + keep);
    else return [0, 0];
  }
  return [lo, hi];
}

/**
 * Each run's shift for one order of the corridor's runs: `spacing` apart in that order, as near to
 * centred on where they ran as every run's `rangeOf` allows — or `null` when no placement fits them all.
 */
function place(ordered: readonly Run[], spacing: number): Map<Run, number> | null {
  const centre = ordered.reduce((sum, r) => sum + r.coord, 0) / ordered.length;
  // Run i goes to t + i * spacing; each range bounds t.
  let lo = -Infinity;
  let hi = Infinity;
  ordered.forEach((run, i) => {
    const [min, max] = rangeOf(run);
    lo = Math.max(lo, run.coord + min - i * spacing);
    hi = Math.min(hi, run.coord + max - i * spacing);
  });
  if (lo > hi + 1e-9) return null;
  const ideal = centre - ((ordered.length - 1) / 2) * spacing;
  const t = Math.min(hi, Math.max(lo, ideal));
  const out = new Map<Run, number>();
  ordered.forEach((run, i) => out.set(run, run.movable ? Math.round((t + i * spacing - run.coord) * 2) / 2 : 0));
  return out;
}

/**
 * The orders worth trying for a corridor: by how each run's line turns at its two ends (lines that
 * leave towards one side stay on that side), ties broken one way and then the other — two lines that
 * turn alike nest one inside the other, and which goes inside is what keeps them from crossing.
 */
function orders(component: readonly Run[]): Run[][] {
  const key = (r: Run) => `${r.line.key}#${r.index}`;
  const base = (tie: 1 | -1) => [...component].sort((a, b) => turns(a) - turns(b) || tie * (a.coord - b.coord) || tie * (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));
  return [base(1), base(-1)];
}

/** A proposal's lines, shifted, if every one passes the checks in this module's comment. */
function check(proposal: ReadonlyMap<Run, number>, lines: readonly Line[], together: (a: Line, b: Line) => boolean): { ok: boolean; shifted: Map<Line, Point[]>; work: number; crossings: number } {
  const byLine = new Map<Line, Track[]>();
  for (const [run, delta] of proposal) {
    if (!delta) continue;
    const tracks = byLine.get(run.line) ?? [];
    tracks.push({ run: run.index, delta });
    byLine.set(run.line, tracks);
  }
  const shifted = new Map<Line, Point[]>();
  let work = 0;
  for (const [line, tracks] of byLine) {
    const corners = shiftRuns(line.corners, tracks);
    if (!corners) return { ok: false, shifted, work, crossings: Infinity };
    // The runs either side still run the same way, with room for their corners.
    for (let i = 1; i < corners.length; i += 1) {
      const [a0, a1, b0, b1] = [line.corners[i - 1]!, line.corners[i]!, corners[i - 1]!, corners[i]!];
      const before = Math.hypot(a1.x - a0.x, a1.y - a0.y);
      const after = Math.hypot(b1.x - b0.x, b1.y - b0.y);
      if (before === after) continue;
      const sameWay = Math.sign(a1.x - a0.x) === Math.sign(b1.x - b0.x) && Math.sign(a1.y - a0.y) === Math.sign(b1.y - b0.y);
      if (!sameWay || after < MIN_LEG) return { ok: false, shifted, work, crossings: Infinity };
    }
    // Checked as drawn: rounded corners cut inside the square ones.
    const drawn = flattenPath(roundedStepPath(corners, 10));
    work += line.blockers.length * drawn.length;
    if (!polylineClear(drawn, line.blockers)) return { ok: false, shifted, work, crossings: Infinity };
    shifted.set(line, corners);
  }
  // Against every line nearby: no new crossing, and no new stretch drawn on top of another line.
  const now = (line: Line) => shifted.get(line) ?? line.corners;
  let crossingsBefore = 0;
  let crossingsAfter = 0;
  const counted = new Set<string>();
  for (const line of shifted.keys()) {
    const box = boundsOf(now(line));
    for (const other of lines) {
      if (other === line) continue;
      if (!meets(other.bounds, line.bounds, SAME_LINE) && !meets(other.bounds, box, SAME_LINE)) continue;
      const pair = line.key < other.key ? `${line.key}|${other.key}` : `${other.key}|${line.key}`;
      if (counted.has(pair)) continue;
      counted.add(pair);
      work += line.corners.length * other.corners.length;
      crossingsBefore += crossingsOf(line.corners, other.corners);
      crossingsAfter += crossingsOf(now(line), now(other));
      if (together(line, other) && line.edge !== other.edge) continue;
      if (sharedLength(now(line), now(other)) > sharedLength(line.corners, other.corners) + 0.5) return { ok: false, shifted, work, crossings: Infinity };
    }
  }
  return { ok: crossingsAfter <= crossingsBefore, shifted, work, crossings: crossingsAfter };
}

/** Where two polylines properly cross, away from each segment's ends. */
function crossingsOf(a: readonly Point[], b: readonly Point[]): number {
  let count = 0;
  for (let i = 1; i < a.length; i += 1) {
    for (let j = 1; j < b.length; j += 1) {
      const [p, p2, q, q2] = [a[i - 1]!, a[i]!, b[j - 1]!, b[j]!];
      const r = { x: p2.x - p.x, y: p2.y - p.y };
      const s = { x: q2.x - q.x, y: q2.y - q.y };
      const denom = r.x * s.y - r.y * s.x;
      if (Math.abs(denom) < 1e-9) continue;
      const t = ((q.x - p.x) * s.y - (q.y - p.y) * s.x) / denom;
      const u = ((q.x - p.x) * r.y - (q.y - p.y) * r.x) / denom;
      if (t > 1e-6 && t < 1 - 1e-6 && u > 1e-6 && u < 1 - 1e-6) count += 1;
    }
  }
  return count;
}

/** How far two polylines run along the same horizontal or vertical line, within `SAME_LINE`. */
function sharedLength(a: readonly Point[], b: readonly Point[]): number {
  let total = 0;
  for (let i = 1; i < a.length; i += 1) {
    const [a0, a1] = [a[i - 1]!, a[i]!];
    for (let j = 1; j < b.length; j += 1) {
      const [b0, b1] = [b[j - 1]!, b[j]!];
      if (Math.abs(a0.y - a1.y) < 0.5 && Math.abs(b0.y - b1.y) < 0.5 && Math.abs(a0.y - b0.y) < SAME_LINE) {
        total += Math.max(0, Math.min(Math.max(a0.x, a1.x), Math.max(b0.x, b1.x)) - Math.max(Math.min(a0.x, a1.x), Math.min(b0.x, b1.x)));
      } else if (Math.abs(a0.x - a1.x) < 0.5 && Math.abs(b0.x - b1.x) < 0.5 && Math.abs(a0.x - b0.x) < SAME_LINE) {
        total += Math.max(0, Math.min(Math.max(a0.y, a1.y), Math.max(b0.y, b1.y)) - Math.max(Math.min(a0.y, a1.y), Math.min(b0.y, b1.y)));
      }
    }
  }
  return total;
}
