/**
 * Which side of its shapes an automatic end uses, decided with the rest of the diagram in view.
 *
 * `chooseSides` looks at two shapes and nothing else: the pair of facing sides across the wider gap.
 * On a diagram someone is still drawing that is often the wrong answer — the line it gives crosses
 * three others, or is blocked and has to be searched round a shape — while leaving from the bottom
 * instead of the right would have been one clean elbow. Fixing that by hand, connector by connector,
 * is the busywork this plan removes.
 *
 * It is a repair, not a restyle:
 *
 * - Only a line with something wrong is looked at: it crosses another connector, it is drawn through
 *   a shape, or it had to be searched for (`pathfinder.ts`). A line that is already clean is never
 *   touched, so a tidy diagram draws exactly as it did.
 * - Only automatic ends move, and only to another side. A pin keeps its side and point (the pin
 *   contract in `routing.ts`); hand-placed bends, trunks, parallel pairs, shared labels, and straight
 *   and curved lines stay as they are, and are only ever routed around.
 * - Every other pair of sides is drawn the quick way and kept only when it is clear of every shape.
 *   The best one replaces the line when it is better by `MARGIN` on one scale: length, plus
 *   `BEND_COST` a bend, `CROSS_COST` for each connector it crosses and `SHARED_COST` for each it
 *   would be drawn on top of.
 * - Lines are settled in id order, each against the others as they now stand, for `PASSES` rounds.
 *   Each change lowers the diagram's total on that scale, so the rounds converge and the same diagram
 *   always settles the same way.
 *
 * Presentation only, like trunks and line jumps: nothing is saved. `endpoints.ts` asks for the sides
 * once it has placed every end where the shapes alone put it — those are the lines judged here — and
 * places the moved ends again among their new neighbours; everything downstream (tracks, labels, line
 * jumps, export) follows from there with no knowledge of this plan. A gesture's frames draw a moving
 * shape's lines the quick way, as they always have, and the drop settles them. Within a budget
 * (`MAX_TRIALS`, `MAX_SEARCH`) it stops early, in the same place every time.
 */

import type { DraftEdge, DraftNode, EdgeAnchor, Side } from '../document/types';
import { routingPlan } from './bundles';
import { labelLook } from './labelLook';
import { obstaclesForEdge } from './obstacles';
import { BEND_COST, type Point } from './pathfinder';
import { anchorPoint, flattenPath, laneIndex, rectOf, routeBetween, type EdgeSpine, type Rect, type RouteAnchors, type RoutedEdge } from './routing';
import type { PlanScope } from './sameGeometry';
import { stepPolyline } from './waypoints';

/** The sides chosen for a connector's automatic ends; an end left where `chooseSides` put it is absent. */
export interface EdgeSides {
  source?: Side;
  target?: Side;
}

const SIDES: readonly Side[] = ['right', 'left', 'bottom', 'top'];
/** What crossing another connector costs, in pixels of run: a line may go about this far out of its
 *  way, or turn twice more, to stay clear of one. Line jumps keep a crossing readable, so not more. */
const CROSS_COST = 100;
/** What running along another connector costs: two lines drawn as one can't be told apart, which is
 *  worse than crossing. `separation.ts` parts most that remain; it can't part them all. */
const SHARED_COST = 300;
/** Closer than this, two parallel runs read as one line; past `SHARED_RUN` of it they are one (`separation.ts`). */
const SAME_LINE = 6;
const SHARED_RUN = 30;
/** A line through a shape is never preferred to one that is clear. */
const BLOCKED_COST = 100_000;
/** How much better another pair of sides must be before a line leaves the one it has. */
const MARGIN = 30;
/** Rounds of settling. The second lets a line answer the moves the first one made. */
const PASSES = 2;
const NONE: ReadonlyMap<string, EdgeSides> = new Map();
/** Routes tried per plan, across all lines: beyond it the rest stay as they are. */
const MAX_TRIALS = 1500;
/** Search work the plan may spend drawing blocked lines as the router will (`edgeRoutes.ts`'s `COMMIT_POPS`). */
const MAX_SEARCH = 400_000;
/** Two segments meeting this close to either's end touch rather than cross. */
const TOUCH = 2;

/** One connector's request line as the plan sees it. */
interface Line {
  edge: DraftEdge;
  /** The corners of a stepped line; a straight or curved one, flattened. */
  points: Point[];
  left: number;
  top: number;
  right: number;
  bottom: number;
  sourceSide: Side;
  targetSide: Side;
  /** Length plus bends — `pathfinder.ts`'s scale. */
  cost: number;
  blocked: boolean;
  /** The router had to search for this line: it is clear, and usually longer than it need be. */
  searched: boolean;
  /** Lines drawn as one on purpose (a trunk's members) cross another line once, not once each. */
  group?: string;
}

/** What one connector is drawn between, and everything worked out from that alone. */
interface Memo {
  sourceRect: Rect;
  targetRect: Rect;
  obstacles: readonly Rect[];
  lane: number;
  spine: EdgeSpine | undefined;
  /** Where `endpoints.ts` placed its ends on the sides the shapes alone give them. */
  spread: RouteAnchors | undefined;
  /** The line as `chooseSides` and the pins draw it the quick way, checked against the shapes. */
  quick: Line;
  /** The same line searched for (`pathfinder.ts`), once a blocked quick one has been, and the work it took. */
  searched?: { line: Line; work: number };
  /** The line from other sides, by `source|target`: `null` where that line is not clear. */
  trials: Map<string, Line | null>;
}

/**
 * A connector's lines depend on its own two shapes and the shapes near it, not on the rest of the
 * diagram — so they are kept per connector and drawn again only when one of those moves. Without it
 * every move of one shape redrew every line of a large diagram, and tried their other sides, to
 * settle the handful that could have changed.
 */
const memos = new WeakMap<DraftEdge, Memo>();

/**
 * The sides to draw each connector's automatic ends on, for the ones the plan moved. `spreadFor` is
 * where `endpoints.ts` places every end on the sides the shapes alone give it: the lines as they are
 * drawn before this plan, which is what it judges and what every other side is weighed against.
 */
export function chooseEdgeSides(
  nodes: readonly DraftNode[],
  edges: readonly DraftEdge[],
  scope: PlanScope,
  spreadFor: (edgeId: string) => RouteAnchors | undefined,
): ReadonlyMap<string, EdgeSides> {
  if (edges.length < 2) return NONE;
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const spines = routingPlan(nodes, edges, scope);
  const lanes = laneIndex(edges);
  const sharedLabels = sharedLabelKeys(edges);
  const ordered = [...edges].sort(byEdgeId);
  const isFree = (edge: DraftEdge) => {
    if (edge.routing !== 'smoothstep' || edge.waypoints?.length || (edge.sourceAnchor && edge.targetAnchor)) return false;
    if (spines.spineFor(edge.id) || (lanes.get(edge.id)?.count ?? 1) !== 1) return false;
    const look = labelLook(edge);
    return !(look && sharedLabels.has(`${edge.source}:${look}`));
  };
  // Nothing the plan may move: no line needs drawing to find that out.
  if (!ordered.some(isFree)) return NONE;

  const lines: Line[] = [];
  const memoOf: Memo[] = [];
  const free: boolean[] = [];
  let searchSpent = 0;
  for (const edge of ordered) {
    const source = byId.get(edge.source);
    const target = byId.get(edge.target);
    if (!source || !target || source === target || source.type === 'group' || target.type === 'group') continue;
    const spine = spines.spineFor(edge.id);
    const memo = memoFor(edge, rectOf(source), rectOf(target), obstaclesForEdge(nodes, edge.source, edge.target, scope), lanes.get(edge.id)?.offset ?? 0, spine, spreadFor(edge.id));
    // A blocked line is searched for while the plan has budget, as the router will draw it — spent
    // in id order, whether or not the answer was already known, so a plan never depends on what an
    // earlier one happened to work out.
    let base = memo.quick;
    if (base.blocked && searchSpent < MAX_SEARCH) {
      const found = searchedLine(memo, edge);
      searchSpent += found.work;
      base = found.line;
    }
    lines.push(spine ? { ...base, group: spine.id } : base);
    memoOf.push(memo);
    free.push(isFree(edge));
  }

  const drawn = [...lines];
  let trials = 0;
  for (let pass = 0; pass < PASSES && trials < MAX_TRIALS; pass += 1) {
    let moved = false;
    for (let i = 0; i < lines.length && trials < MAX_TRIALS; i += 1) {
      if (!free[i]) continue;
      const line = lines[i]!;
      const memo = memoOf[i]!;
      const crossings = crossingsOf(line, lines);
      // Nothing wrong with it: left exactly as drawn.
      if (!line.blocked && !line.searched && crossings === 0) continue;
      const current = line.cost + crossings * CROSS_COST + sharedRunsOf(line, lines) * SHARED_COST + (line.blocked ? BLOCKED_COST : 0);
      let best: Line | null = null;
      let bestScore = current - MARGIN;
      // A pinned end has its one side; an automatic end may take any. One turned away from the other
      // shape is a long way round, and wins only when what it clears is worth that much line.
      for (const sourceSide of line.edge.sourceAnchor ? [line.edge.sourceAnchor.side] : SIDES) {
        for (const targetSide of line.edge.targetAnchor ? [line.edge.targetAnchor.side] : SIDES) {
          if (sourceSide === line.sourceSide && targetSide === line.targetSide) continue;
          // No line from these sides can be shorter than straight across with the turns they force.
          if (leastCost(memo, line.edge, sourceSide, targetSide) >= bestScore) continue;
          if (trials >= MAX_TRIALS) break;
          trials += 1;
          const candidate = trial(memo, line.edge, sourceSide, targetSide);
          // A candidate is only ever a clear, quick line: never one that needs a search of its own.
          if (!candidate || candidate.cost >= bestScore) continue;
          const shared = sharedRunsOf(candidate, lines) * SHARED_COST;
          if (candidate.cost + shared >= bestScore) continue;
          const score = candidate.cost + shared + crossingsOf(candidate, lines) * CROSS_COST;
          if (score < bestScore) {
            best = candidate;
            bestScore = score;
          }
        }
      }
      if (best) {
        lines[i] = best;
        moved = true;
      }
    }
    if (!moved) break;
  }

  // Only what the plan changed: an end it left alone is placed as it always was.
  const chosen = new Map<string, EdgeSides>();
  lines.forEach((line, i) => {
    const before = drawn[i]!;
    const sides: EdgeSides = {};
    if (!line.edge.sourceAnchor && line.sourceSide !== before.sourceSide) sides.source = line.sourceSide;
    if (!line.edge.targetAnchor && line.targetSide !== before.targetSide) sides.target = line.targetSide;
    if (sides.source || sides.target) chosen.set(line.edge.id, sides);
  });
  return chosen;
}

const byEdgeId = (a: DraftEdge, b: DraftEdge) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/** `source:look` for every label that two or more connectors leaving one shape share: those leave
 *  as one (`labelGroups.ts`), which a change of side would break up. */
function sharedLabelKeys(edges: readonly DraftEdge[]): ReadonlySet<string> {
  const seen = new Set<string>();
  const shared = new Set<string>();
  for (const edge of edges) {
    const look = labelLook(edge);
    if (!look) continue;
    const key = `${edge.source}:${look}`;
    if (seen.has(key)) shared.add(key);
    else seen.add(key);
  }
  return shared;
}

/** A connector's memo, drawn again only when what it is drawn between has changed. */
function memoFor(edge: DraftEdge, sourceRect: Rect, targetRect: Rect, obstacles: readonly Rect[], lane: number, spine: EdgeSpine | undefined, spread: RouteAnchors | undefined): Memo {
  const known = memos.get(edge);
  if (
    known
    && known.lane === lane
    && sameRect(known.sourceRect, sourceRect)
    && sameRect(known.targetRect, targetRect)
    && sameRects(known.obstacles, obstacles)
    && sameSpine(known.spine, spine)
    && sameAnchor(known.spread?.source, spread?.source)
    && sameAnchor(known.spread?.target, spread?.target)
  ) {
    return known;
  }
  const anchors = { source: edge.sourceAnchor, target: edge.targetAnchor };
  const route = routeBetween(sourceRect, targetRect, edge.routing, { anchors, waypoints: edge.waypoints, lane, obstacles, spine, spread, fallback: false });
  const memo: Memo = {
    sourceRect,
    targetRect,
    obstacles,
    lane,
    spine,
    spread,
    quick: lineOf(edge, route),
    trials: new Map(),
  };
  memos.set(edge, memo);
  return memo;
}

/** A blocked connector's line as the router's search draws it. */
function searchedLine(memo: Memo, edge: DraftEdge): { line: Line; work: number } {
  if (memo.searched) return memo.searched;
  const route = routeBetween(memo.sourceRect, memo.targetRect, edge.routing, {
    anchors: { source: edge.sourceAnchor, target: edge.targetAnchor },
    waypoints: edge.waypoints,
    lane: memo.lane,
    obstacles: memo.obstacles,
    spine: memo.spine,
    spread: memo.spread,
  });
  memo.searched = { line: lineOf(edge, route), work: Math.max(route.work, 1) };
  return memo.searched;
}

const sameAnchor = (a: EdgeAnchor | undefined, b: EdgeAnchor | undefined) => a === b || (a !== undefined && b !== undefined && a.side === b.side && a.offset === b.offset);
const sameBand = (a: Rect['anchorBand'], b: Rect['anchorBand']) =>
  a === b || (a !== undefined && b !== undefined && a.top === b.top && a.bottom === b.bottom && a.left === b.left && a.right === b.right && a.glyphTop === b.glyphTop);
const sameRect = (a: Rect, b: Rect) => a === b || (a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height && sameBand(a.anchorBand, b.anchorBand));
const sameRects = (a: readonly Rect[], b: readonly Rect[]) => a === b || (a.length === b.length && a.every((rect, i) => sameRect(rect, b[i]!)));
const sameSpine = (a: EdgeSpine | undefined, b: EdgeSpine | undefined) =>
  a === b || (a !== undefined && b !== undefined && a.id === b.id && a.hub === b.hub && a.hubSide === b.hubSide && a.trunkGap === b.trunkGap && a.corridor === b.corridor && a.count === b.count);

function lineOf(edge: DraftEdge, route: RoutedEdge): Line {
  const corners = edge.routing === 'smoothstep' ? stepPolyline(route.d) : [];
  const points = corners.length >= 2 ? corners : flattenPath(route.d).map(({ x, y }) => ({ x, y }));
  let left = Infinity;
  let top = Infinity;
  let right = -Infinity;
  let bottom = -Infinity;
  let cost = 0;
  for (let i = 0; i < points.length; i += 1) {
    const p = points[i]!;
    left = Math.min(left, p.x);
    top = Math.min(top, p.y);
    right = Math.max(right, p.x);
    bottom = Math.max(bottom, p.y);
    if (i) cost += Math.hypot(p.x - points[i - 1]!.x, p.y - points[i - 1]!.y);
  }
  if (corners.length >= 2) cost += Math.max(0, corners.length - 2) * BEND_COST;
  return {
    edge,
    points,
    left,
    top,
    right,
    bottom,
    sourceSide: route.source.side,
    targetSide: route.target.side,
    cost,
    blocked: route.status === 'blocked' || route.status === 'budget',
    searched: route.work > 0 && route.status === 'clear',
  };
}

const OPPOSITE: Record<Side, Side> = { top: 'bottom', bottom: 'top', left: 'right', right: 'left' };

/**
 * Where an end is tried on `side`: a pin where it is pinned; an end that stays on its side, on its
 * point there; one that moves, from the middle of its new side — `endpoints.ts` places it among its
 * neighbours once it is chosen.
 */
function trialAnchor(side: Side, pin: EdgeAnchor | undefined, placed: EdgeAnchor | undefined): EdgeAnchor {
  return pin ?? (placed?.side === side ? placed : { side, offset: 0.5 });
}

/** The least a line between these two sides could cost: straight across, with the turns the pair forces. */
function leastCost(memo: Memo, edge: DraftEdge, sourceSide: Side, targetSide: Side): number {
  const from = anchorPoint(memo.sourceRect, sourceSide, trialAnchor(sourceSide, edge.sourceAnchor, memo.spread?.source).offset);
  const to = anchorPoint(memo.targetRect, targetSide, trialAnchor(targetSide, edge.targetAnchor, memo.spread?.target).offset);
  const bends = sourceSide === targetSide ? 2 : sourceSide === OPPOSITE[targetSide] ? 0 : 1;
  return Math.abs(from.x - to.x) + Math.abs(from.y - to.y) + bends * BEND_COST;
}

/** A connector drawn from other sides, the quick way — or `null` when that line is not clear. */
function trial(memo: Memo, edge: DraftEdge, sourceSide: Side, targetSide: Side): Line | null {
  const key = `${sourceSide}|${targetSide}`;
  const known = memo.trials.get(key);
  if (known !== undefined) return known;
  const route = routeBetween(memo.sourceRect, memo.targetRect, 'smoothstep', {
    anchors: { source: trialAnchor(sourceSide, edge.sourceAnchor, memo.spread?.source), target: trialAnchor(targetSide, edge.targetAnchor, memo.spread?.target) },
    obstacles: memo.obstacles,
    fallback: false,
  });
  const line = route.status === 'clear' ? lineOf(edge, route) : null;
  memo.trials.set(key, line);
  return line;
}

/** How many places `line` crosses the other connectors' lines. */
function crossingsOf(line: Line, lines: readonly Line[]): number {
  const { points, left, top, right, bottom } = line;
  let count = 0;
  let grouped: Set<string> | null = null;
  for (const other of lines) {
    if (other.edge === line.edge) continue;
    if (other.left > right || other.right < left || other.top > bottom || other.bottom < top) continue;
    for (let i = 1; i < points.length; i += 1) {
      for (let j = 1; j < other.points.length; j += 1) {
        const at = crossing(points[i - 1]!, points[i]!, other.points[j - 1]!, other.points[j]!);
        if (!at) continue;
        if (!other.group) {
          count += 1;
          continue;
        }
        // A trunk's members overlay each other: one crossing, however many of them pass here.
        const key = `${other.group}:${Math.round(at.x)}:${Math.round(at.y)}`;
        grouped ??= new Set();
        if (!grouped.has(key)) {
          grouped.add(key);
          count += 1;
        }
      }
    }
  }
  return count;
}

/**
 * How many other lines `candidate` runs along. Two lines leaving one side of one shape share their
 * first stretch only until `endpoints.ts` spreads them, so that stretch is not counted.
 */
function sharedRunsOf(candidate: Line, lines: readonly Line[]): number {
  const points = candidate.points;
  let count = 0;
  for (const other of lines) {
    if (other.edge === candidate.edge) continue;
    if (other.left > candidate.right + SAME_LINE || other.right < candidate.left - SAME_LINE || other.top > candidate.bottom + SAME_LINE || other.bottom < candidate.top - SAME_LINE) continue;
    const firstTogether = sameEnd(candidate, 'source', other);
    const lastTogether = sameEnd(candidate, 'target', other);
    let shared = 0;
    for (let i = 1; i < points.length; i += 1) {
      const a0 = points[i - 1]!;
      const a1 = points[i]!;
      const level = Math.abs(a0.y - a1.y) < 1;
      if (!level && Math.abs(a0.x - a1.x) >= 1) continue;
      const mine = i === 1 ? firstTogether : i === points.length - 1 ? lastTogether : null;
      for (let j = 1; j < other.points.length; j += 1) {
        if (mine !== null && (mine === 'source' ? j === 1 : j === other.points.length - 1)) continue;
        const b0 = other.points[j - 1]!;
        const b1 = other.points[j]!;
        if (level) {
          if (Math.abs(b0.y - b1.y) >= 1 || Math.abs(a0.y - b0.y) >= SAME_LINE) continue;
          shared += Math.max(0, Math.min(Math.max(a0.x, a1.x), Math.max(b0.x, b1.x)) - Math.max(Math.min(a0.x, a1.x), Math.min(b0.x, b1.x)));
        } else {
          if (Math.abs(b0.x - b1.x) >= 1 || Math.abs(a0.x - b0.x) >= SAME_LINE) continue;
          shared += Math.max(0, Math.min(Math.max(a0.y, a1.y), Math.max(b0.y, b1.y)) - Math.max(Math.min(a0.y, a1.y), Math.min(b0.y, b1.y)));
        }
      }
    }
    if (shared > SHARED_RUN) count += 1;
  }
  return count;
}

/** Which end of `other` leaves the same side of the same shape as `line`'s `role` end, if either does. */
function sameEnd(line: Line, role: 'source' | 'target', other: Line): 'source' | 'target' | null {
  const nodeId = role === 'source' ? line.edge.source : line.edge.target;
  const side = role === 'source' ? line.sourceSide : line.targetSide;
  if (other.edge.source === nodeId && other.sourceSide === side) return 'source';
  if (other.edge.target === nodeId && other.targetSide === side) return 'target';
  return null;
}

/** Where two segments cross, clear of both their ends — lines that only touch (two leaving one
 *  point, one ending on another's corner) do not cross. */
function crossing(a: Point, b: Point, c: Point, d: Point): Point | null {
  const rx = b.x - a.x;
  const ry = b.y - a.y;
  const sx = d.x - c.x;
  const sy = d.y - c.y;
  const denom = rx * sy - ry * sx;
  if (Math.abs(denom) < 1e-9) return null;
  const t = ((c.x - a.x) * sy - (c.y - a.y) * sx) / denom;
  const u = ((c.x - a.x) * ry - (c.y - a.y) * rx) / denom;
  const lenR = Math.hypot(rx, ry);
  const lenS = Math.hypot(sx, sy);
  if (t * lenR < TOUCH || (1 - t) * lenR < TOUCH || u * lenS < TOUCH || (1 - u) * lenS < TOUCH) return null;
  return { x: a.x + t * rx, y: a.y + t * ry };
}
