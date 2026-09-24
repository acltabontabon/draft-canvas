/**
 * A connector as the canvas will actually draw it — its path and its caption chip — for checking an
 * arranged diagram and for choosing its anchors.
 *
 * Reproduces `canvas/DraftEdgeView.tsx`'s inputs exactly: the obstacles it routes around, the shared
 * fan-out trunk (`routingPlan`), the lane of a parallel pair (`laneIndex`), the caption's lane nudge,
 * and label groups where one chip speaks for several connectors (`labelGroupPlan`). A check against
 * anything less judges a route nobody sees — the gallery found exactly that: captions on fan-out
 * branches drawn under the queue they point at, invisible to a spine-less approximation.
 *
 * `layout/anchors.ts` picks sides by rule; `repairAnchors` then asks this module, and where the drawn
 * route or caption would run over a shape, tries the other side pairs in a fixed order.
 */

import type { DraftEdge, DraftNode, Side } from '../document/types';
import { routingPlan } from '../edges/bundles';
import { labelChipBox, labelGroupPlan } from '../edges/labelGroups';
import { obstaclesForEdge } from '../edges/obstacles';
import { labelLaneOffset, laneIndex, routeEdge } from '../edges/routing';

export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

type Point = { x: number; y: number };

/** The size of an edge's caption chip on the canvas; zero when it has none. */
export type CaptionSize = (edge: DraftEdge) => { width: number; height: number };

const SIDES: Side[] = ['right', 'left', 'bottom', 'top'];
const OFFSET_PAIRS: [number, number][] = [
  [0.5, 0.5],
  [0.25, 0.25],
  [0.75, 0.75],
  [0.25, 0.5],
  [0.5, 0.25],
  [0.75, 0.5],
  [0.5, 0.75],
  [0.25, 0.75],
  [0.75, 0.25],
];
/** What a bend costs, in pixels of run: a connector that turns once more should be that much shorter. */
const BEND_COST = 48;
/** A small preference for the middle handle, all else being equal. */
const OFF_CENTRE_COST = 8;

/** Length plus bends — how much work a reader's eye does to follow a route. Rounded corners are a few
 *  short pieces, so only runs longer than a corner count as a change of direction. */
export function routeCost(points: readonly Point[]): number {
  let length = 0;
  for (let i = 1; i < points.length; i += 1) length += Math.hypot((points[i] as Point).x - (points[i - 1] as Point).x, (points[i] as Point).y - (points[i - 1] as Point).y);
  return length + bendsOf(points) * BEND_COST;
}

/** How many times a route changes direction; rounded corners are a few short pieces, not bends. */
export function bendsOf(points: readonly Point[]): number {
  let bends = 0;
  let heading: 'h' | 'v' | undefined;
  for (let i = 1; i < points.length; i += 1) {
    const a = points[i - 1] as Point;
    const b = points[i] as Point;
    if (Math.hypot(b.x - a.x, b.y - a.y) < 12) continue;
    const next = Math.abs(b.x - a.x) >= Math.abs(b.y - a.y) ? 'h' : 'v';
    if (heading && next !== heading) bends += 1;
    heading = next;
  }
  return bends;
}

/** How far a connector may cut into a shape it has nothing to do with — a corner, not a crossing. */
const THROUGH_INSET = 4;
/** How far a caption may overlap a shape's border before it counts as covering the shape. */
const CAPTION_INSET = 6;

/** The corners of an SVG path as a polyline — every coordinate pair in order. Curves at a bend are
 *  a few pixels wide, so their control points stand in for them well enough to test a crossing. */
export function pathPoints(d: string): Point[] {
  const numbers = d.match(/-?\d*\.?\d+(?:e-?\d+)?/gi)?.map(Number) ?? [];
  const points: Point[] = [];
  for (let i = 0; i + 1 < numbers.length; i += 2) points.push({ x: numbers[i] as number, y: numbers[i + 1] as number });
  return points;
}

/** Liang–Barsky: does any part of the segment lie inside the box? */
export function segmentHitsBox(a: Point, b: Point, box: Box): boolean {
  let t0 = 0;
  let t1 = 1;
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const sides: [number, number][] = [
    [-dx, a.x - box.x],
    [dx, box.x + box.width - a.x],
    [-dy, a.y - box.y],
    [dy, box.y + box.height - a.y],
  ];
  for (const [p, q] of sides) {
    if (p === 0) {
      if (q < 0) return false;
      continue;
    }
    const r = q / p;
    if (p < 0) {
      if (r > t1) return false;
      if (r > t0) t0 = r;
    } else {
      if (r < t0) return false;
      if (r < t1) t1 = r;
    }
  }
  return t0 < t1;
}

export const overlaps = (a: Box, b: Box) => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

const inset = (n: Box, by: number): Box => ({ x: n.x + by, y: n.y + by, width: n.width - by * 2, height: n.height - by * 2 });

/** `captionAnchor` (`edges/routing.ts`): a caption's baseline sits this far off a horizontal line… */
const CAPTION_DROP = 14;
/** …with its words rising this far above the baseline, and this tall in all (connector caption type). */
const CAPTION_RISE = 9;
const CAPTION_TEXT = 12;

export interface Drawn {
  points: Point[];
  /** The caption chip this connector draws, if it draws one (a label group's other members don't). */
  chip: Box | null;
  /** The Smart Routing trunk it shares, if any: members of one run along it together on purpose. */
  spine?: string;
}

/** Longer than a connector's stub off its shape (20) — two leaving one point share that much. */
export const SHARED_RUN = 30;

/** The longest stretch two polylines draw along the same horizontal or vertical line. */
export function sharedRun(a: readonly Point[], b: readonly Point[]): number {
  let longest = 0;
  for (let i = 1; i < a.length; i += 1) {
    const [a0, a1] = [a[i - 1] as Point, a[i] as Point];
    for (let j = 1; j < b.length; j += 1) {
      const [b0, b1] = [b[j - 1] as Point, b[j] as Point];
      if (Math.abs(a0.y - a1.y) < 1 && Math.abs(b0.y - b1.y) < 1 && Math.abs(a0.y - b0.y) < 2) {
        const lo = Math.max(Math.min(a0.x, a1.x), Math.min(b0.x, b1.x));
        const hi = Math.min(Math.max(a0.x, a1.x), Math.max(b0.x, b1.x));
        longest = Math.max(longest, hi - lo);
      } else if (Math.abs(a0.x - a1.x) < 1 && Math.abs(b0.x - b1.x) < 1 && Math.abs(a0.x - b0.x) < 2) {
        const lo = Math.max(Math.min(a0.y, a1.y), Math.min(b0.y, b1.y));
        const hi = Math.min(Math.max(a0.y, a1.y), Math.max(b0.y, b1.y));
        longest = Math.max(longest, hi - lo);
      }
    }
  }
  return longest;
}

/**
 * Two connectors drawn on top of each other for a stretch read as one: which way either goes can't be
 * told. A shared trunk or a shared label is that on purpose, and doesn't count.
 */
export function stacked(a: Drawn & { id: string }, b: Other): boolean {
  if (a.id === b.id || together(a, b)) return false;
  return sharedRun(a.points, b.points) > SHARED_RUN;
}

/**
 * Connectors drawn as one on purpose: members of one Smart Routing trunk (which also collapse their
 * captions to one on it), or of one label group. Their lines and captions meet by design.
 */
export function together(a: { id?: string; spine?: string }, b: Other): boolean {
  return Boolean((a.spine && a.spine === b.spine) || (a.id && b.shares?.includes(a.id)));
}

/** `edge` as the canvas draws it among `nodes` and `edges` (which must include `edge`). */
export function drawnRoute(edge: DraftEdge, nodes: readonly DraftNode[], edges: readonly DraftEdge[], caption?: CaptionSize): Drawn | null {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const spine = routingPlan(nodes, edges).spineFor(edge.id);
  let route;
  try {
    route = routeEdge(edge, byId, {
      obstacles: obstaclesForEdge(nodes, edge.source, edge.target),
      spine,
      lane: laneIndex(edges).get(edge.id)?.offset ?? 0,
    });
  } catch {
    return null;
  }
  if (!route) return null;
  let chip: Box | null = null;
  const size = caption?.(edge);
  if (size && size.width > 0) {
    const group = labelGroupPlan(nodes, edges).groupFor(edge.id);
    if (group) {
      if (group.members[0] === edge.id) chip = labelChipBox(group.side, group.x, group.y, size.width, size.height);
    } else {
      const lane = laneIndex(edges).get(edge.id)?.offset ?? 0;
      const nudge = labelLaneOffset(route.source.side, route.target.side, lane);
      if (edge.label) chip = labelChipBox(route.labelSide, route.labelX + nudge.x, route.labelY + nudge.y, size.width, size.height);
      else {
        // A relationship caption (no label of its own) is drawn by `captionAnchor`, not as a chip: on a
        // shared trunk's one point when it collapses there, and under a horizontal line whichever side
        // a chip would have taken — only a request/response pair's reply line moves it above.
        const at = route.trunkLabel ?? { x: route.labelX + nudge.x, y: route.labelY + nudge.y };
        const side = route.trunkLabel ? (route.trunkLabelSide ?? route.labelSide) : route.labelSide;
        if (side === 'left' || side === 'right') chip = labelChipBox(side, at.x, at.y, size.width, size.height);
        else {
          const above = Boolean(edge.hasResponse) && lane > 0;
          const baseline = above ? at.y - CAPTION_DROP : at.y + CAPTION_DROP;
          chip = { x: at.x - size.width / 2, y: baseline - CAPTION_RISE - (size.height - CAPTION_TEXT) / 2, width: size.width, height: size.height };
        }
      }
    }
  }
  return { points: pathPoints(route.d), chip, ...(spine ? { spine: spine.id } : {}) };
}

/** Another connector as drawn, for judging this one against it. `shares` names connectors that draw
 *  one caption between them (a label group), whose lines run through it by design. */
export interface Other {
  id: string;
  chip: Box | null;
  points: Point[];
  shares?: readonly string[];
  spine?: string;
}

/** How far a line may graze a caption's chip — its rounded ends — before it runs through the words. */
const CHIP_GRAZE = 3;

/** Does either connector's line run through the other's caption? */
export function crosses(a: Drawn & { id?: string }, b: Other): boolean {
  if (together(a, b)) return false;
  const through = (points: readonly Point[], chip: Box | null) => {
    if (!chip) return false;
    const box = inset(chip, CHIP_GRAZE);
    if (box.width <= 0 || box.height <= 0) return false;
    return points.some((p, k) => k > 0 && segmentHitsBox(points[k - 1] as Point, p, box));
  };
  return through(b.points, a.chip) || through(a.points, b.chip);
}

/** Every connector in `edges` as drawn, for `routeProblem`'s `others`. */
export function othersOf(nodes: readonly DraftNode[], edges: readonly DraftEdge[], caption?: CaptionSize, except?: string): Other[] {
  const groups = labelGroupPlan(nodes, edges);
  return edges.flatMap((e) => {
    if (e.id === except) return [];
    const drawn = drawnRoute(e, nodes, edges, caption);
    const members = groups.groupFor(e.id)?.members;
    return drawn ? [{ id: e.id, chip: drawn.chip, points: drawn.points, ...(drawn.spine ? { spine: drawn.spine } : {}), ...(members ? { shares: members } : {}) }] : [];
  });
}

/** The ends of `edge` and every boundary around them — what its route may legitimately touch. */
function endsOf(edge: DraftEdge, byId: Map<string, DraftNode>): Set<string> {
  const ends = new Set([edge.source, edge.target]);
  for (const end of [edge.source, edge.target]) {
    let at = byId.get(end)?.parentId;
    while (at && !ends.has(at)) {
      ends.add(at);
      at = byId.get(at)?.parentId;
    }
  }
  return ends;
}

export interface RouteProblem {
  kind: 'through-node' | 'label-over-node' | 'label-collision' | 'label-crossed' | 'shared-run';
  /** The shape, or (for a collision) the other connector, in the way. */
  node: string;
}

/** The first thing wrong with how `edge` is drawn: its line through an unrelated shape, its caption
 *  over any shape (its own ends included — a caption over a name hides the name), or its caption on
 *  top of another connector's (`others`, when given). */
export function routeProblem(
  edge: DraftEdge,
  nodes: readonly DraftNode[],
  edges: readonly DraftEdge[],
  caption?: CaptionSize,
  others?: readonly Other[],
): RouteProblem | undefined {
  const drawn = drawnRoute(edge, nodes, edges, caption);
  if (!drawn) return undefined;
  const byId = new Map(nodes.map((n) => [n.id, n]));
  if (drawn.chip) {
    const covered = nodes.find((n) => n.type !== 'group' && overlaps(drawn.chip!, inset(n, CAPTION_INSET)));
    if (covered) return { kind: 'label-over-node', node: covered.id };
    const clash = others?.find((o) => o.id !== edge.id && o.chip && !together({ ...drawn, id: edge.id }, o) && overlaps(drawn.chip!, o.chip));
    if (clash) return { kind: 'label-collision', node: clash.id };
  }
  const crossed = others?.find((o) => o.id !== edge.id && crosses({ ...drawn, id: edge.id }, o));
  if (crossed) return { kind: 'label-crossed', node: crossed.id };
  const onTop = others?.find((o) => stacked({ ...drawn, id: edge.id }, o));
  if (onTop) return { kind: 'shared-run', node: onTop.id };
  const ends = endsOf(edge, byId);
  for (const node of nodes) {
    if (ends.has(node.id) || node.type === 'group') continue;
    const box = inset(node, THROUGH_INSET);
    if (box.width <= 0 || box.height <= 0) continue;
    for (let k = 0; k + 1 < drawn.points.length; k += 1) {
      if (segmentHitsBox(drawn.points[k]!, drawn.points[k + 1]!, box)) return { kind: 'through-node', node: node.id };
    }
  }
  return undefined;
}

/** How many alternative anchorings are drawn in full for one connector before it is left as it is. */
const MAX_CHECKS = 24;

/** The time (`performance.now()`) repairs stop by, set around a whole request by `withDeadline`. */
let activeDeadline = Number.POSITIVE_INFINITY;

/**
 * Runs `work` with repairs bounded by `deadline`: past it, `repairAnchors` leaves the rest as they are
 * and the quality check reports what is left, so a request that can't be arranged in time fails as
 * unreadable instead of holding the editor.
 */
export function withDeadline<T>(deadline: number, work: () => T): T {
  const outer = activeDeadline;
  activeDeadline = Math.min(outer, deadline);
  try {
    return work();
  } finally {
    activeDeadline = outer;
  }
}

/** Whether the request's time is up (see `withDeadline`). */
export const pastDeadline = () => performance.now() > activeDeadline;

/**
 * Re-anchors, in place, every edge in `targets` whose drawn route or caption runs over a shape or
 * another caption, judged among `all` edges (fan-out spines and lanes depend on the neighbours).
 *
 * Work is bounded: the whole diagram is drawn once, and a candidate re-draws only the connectors
 * sharing an end with the one being moved (they are all its anchors can disturb), planned over
 * their neighbourhood rather than the whole diagram. Candidates are
 * ranked by a route drawn without trunks or lanes — cheap, and close enough to order them — and at
 * most `MAX_CHECKS` are drawn in full. `deadline` (a `performance.now()` time) stops the search
 * early; what is left unrepaired, the quality check then reports.
 */
export function repairAnchors(
  targets: DraftEdge[],
  nodes: readonly DraftNode[],
  caption?: CaptionSize,
  all: readonly DraftEdge[] = targets,
  deadline = activeDeadline,
): void {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const moving = new Map(targets.map((t) => [t.id, t]));
  const current = () => all.map((e) => moving.get(e.id) ?? e);
  let edges = current();
  let drawn = new Map(othersOf(nodes, edges, caption).map((o) => [o.id, o]));
  /**
   * Re-anchors `mover` until every connector in `clean` is drawn without a problem — the first such
   * anchoring, cheapest first — or puts it back and says it couldn't.
   */
  const tryMove = (mover: DraftEdge, clean: readonly DraftEdge[]): boolean => {
    const original = { sourceAnchor: mover.sourceAnchor, targetAnchor: mover.targetAnchor };
    const ends = new Set(clean.flatMap((e) => [e.source, e.target]));
    const touching = edges.filter((e) => ends.has(e.source) || ends.has(e.target));
    const neighbours = new Set(touching.map((e) => e.id));
    const hood = new Set(touching.flatMap((e) => [e.source, e.target]));
    const edge = mover;
    const candidates: { source: DraftEdge['sourceAnchor']; target: DraftEdge['targetAnchor']; cost: number }[] = [];
    for (const [sourceOffset, targetOffset] of OFFSET_PAIRS) {
      for (const source of SIDES) {
        for (const target of SIDES) {
          const sourceAnchor = { side: source, offset: sourceOffset };
          const targetAnchor = { side: target, offset: targetOffset };
          const cost = roughCost({ ...edge, sourceAnchor, targetAnchor }, nodes, byId);
          if (cost === undefined) continue;
          const offCentre = (sourceOffset === 0.5 ? 0 : OFF_CENTRE_COST) + (targetOffset === 0.5 ? 0 : OFF_CENTRE_COST);
          candidates.push({ source: sourceAnchor, target: targetAnchor, cost: cost + offCentre });
        }
      }
    }
    candidates.sort((a, b) => a.cost - b.cost);
    // The cheapest way out of each pair of sides first, then the rest: otherwise every check can go
    // on offset variants of one shape (an L) while the one that works (a U under both ends, for a
    // connector coming back) is never drawn at all.
    const seenSides = new Set<string>();
    const firsts: typeof candidates = [];
    const rest: typeof candidates = [];
    for (const candidate of candidates) {
      const key = `${candidate.source?.side}|${candidate.target?.side}`;
      (seenSides.has(key) ? rest : firsts).push(candidate);
      seenSides.add(key);
    }
    let fixed = false;
    for (const candidate of [...firsts, ...rest].slice(0, MAX_CHECKS)) {
      if (performance.now() > deadline) break;
      edge.sourceAnchor = candidate.source;
      edge.targetAnchor = candidate.target;
      // A fresh array per arrangement (the routing caches are keyed by it), and planned over the
      // neighbourhood only: trunks, lanes and label groups form among connectors sharing an end, so
      // two hops out is everything that can move. The final quality check plans the whole diagram.
      const next = current();
      const local = next.filter((e) => hood.has(e.source) || hood.has(e.target));
      const fresh = new Map(othersOf(nodes, local, caption).filter((o) => neighbours.has(o.id)).map((o) => [o.id, o]));
      const others = [...drawn.values()].map((o) => fresh.get(o.id) ?? o);
      if (clean.every((e) => !routeProblem(moving.get(e.id) ?? e, nodes, local, caption, others))) {
        fixed = true;
        edges = next;
        drawn = new Map(others.map((o) => [o.id, o]));
        break;
      }
    }
    if (!fixed) Object.assign(edge, original);
    return fixed;
  };

  for (const edge of targets) {
    if (performance.now() > deadline) return;
    const problem = routeProblem(edge, nodes, edges, caption, [...drawn.values()]);
    if (!problem) continue;
    // Trouble between two connectors (a line through the other's caption, the two on top of each
    // other): moving the *other* one first often keeps this one straight — cheaper than sending a
    // straight connector on a detour around its neighbour's line.
    const between = problem.kind === 'label-crossed' || problem.kind === 'label-collision' || problem.kind === 'shared-run';
    const other = between ? moving.get(problem.node) : undefined;
    if (other && other !== edge && tryMove(other, [edge, other])) continue;
    tryMove(edge, [edge]);
  }
}

/** A route's cost as `routeCost` would give it, drawn without trunks or lanes (see `repairAnchors`). */
function roughCost(edge: DraftEdge, nodes: readonly DraftNode[], byId: Map<string, DraftNode>): number | undefined {
  try {
    const route = routeEdge(edge, byId, { obstacles: obstaclesForEdge(nodes, edge.source, edge.target) });
    return route ? routeCost(pathPoints(route.d)) : undefined;
  } catch {
    return undefined;
  }
}
