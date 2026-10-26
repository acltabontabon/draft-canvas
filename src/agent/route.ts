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

import { isCollapsedCompensation, visibleEdges } from '../document/compensation';
import { crossingsBetween, isDetour, runsOf } from './routeMetrics';
import type { DraftEdge, DraftNode, Side } from '../document/types';
import { routingPlan } from '../edges/bundles';
import { labelChipBox, labelGroupPlan } from '../edges/labelGroups';
import { obstaclesForEdge } from '../edges/obstacles';
import { connectorRoutes } from '../edges/connectorRoutes';
import { stepPolyline } from '../edges/waypoints';
import { anchorsHold, labelChipSide, labelLaneOffset, labelSideAwayFromResponse, laneIndex, responseAwayFor, routeEdge } from '../edges/routing';

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
  /** The chip is the connector's own label, on its own branch — not a relationship caption collapsed
   *  onto a shared trunk's one point, which every member of the trunk reports alike. */
  ownChip?: boolean;
  /** The Smart Routing trunk it shares, if any: members of one run along it together on purpose. */
  spine?: string;
  /** Set when the line could not be drawn clear of every shape (`pathfinder.ts`). */
  status?: 'blocked' | 'budget';
}

/**
 * Where a connector is drawn, for `read_diagram`'s geometry: the side each end uses, and its path as
 * the points where it turns, ends included (a curved line's are its ends and bends — between them it
 * curves). The same numbers `route.via` takes back, so an agent can read a line, move a point, and
 * send it. `pins` holds the offset of each pinned end (an end not there attaches automatically and
 * follows its shape), and `status` says when the line could not be drawn clear of every shape.
 */
export function routeGeometry(edge: DraftEdge, nodes: readonly DraftNode[], edges: readonly DraftEdge[], byId?: Map<string, DraftNode>): { from: Side; to: Side; path: [number, number][]; pins: { from?: number; to?: number }; status?: 'blocked' | 'budget' } | undefined {
  if (isCollapsedCompensation(edge)) return undefined;
  edges = visibleEdges(edges);
  const nodeMap = byId ?? new Map(nodes.map((n) => [n.id, n]));
  let route;
  try {
    route = connectorRoutes(edge, { nodes, edges }, 'transient', nodeMap)?.request;
  } catch {
    return undefined;
  }
  if (!route) return undefined;
  const turns = route.points ?? (edge.routing === 'smoothstep' ? stepPolyline(route.d) : [route.source, route.target]);
  const pins = {
    ...(edge.sourceAnchor ? { from: edge.sourceAnchor.offset } : {}),
    ...(edge.targetAnchor ? { to: edge.targetAnchor.offset } : {}),
  };
  const unresolved = route.status === 'blocked' || route.status === 'budget' ? { status: route.status } : {};
  return { from: route.source.side, to: route.target.side, path: turns.map((p) => [Math.round(p.x), Math.round(p.y)]), pins, ...unresolved };
}

/** Longer than a connector's stub off its shape (20) — two leaving one point share that much. */
export const SHARED_RUN = 30;

/** How far apart two parallel runs may be and still read as one line: under a lane's spacing (10),
 *  over the couple of pixels two lines a few pixels apart blur into at any zoom. */
const SAME_LINE = 6;

/** The longest stretch two polylines draw along the same horizontal or vertical line. */
export function sharedRun(a: readonly Point[], b: readonly Point[]): number {
  let longest = 0;
  for (let i = 1; i < a.length; i += 1) {
    const [a0, a1] = [a[i - 1] as Point, a[i] as Point];
    for (let j = 1; j < b.length; j += 1) {
      const [b0, b1] = [b[j - 1] as Point, b[j] as Point];
      if (Math.abs(a0.y - a1.y) < 1 && Math.abs(b0.y - b1.y) < 1 && Math.abs(a0.y - b0.y) < SAME_LINE) {
        const lo = Math.max(Math.min(a0.x, a1.x), Math.min(b0.x, b1.x));
        const hi = Math.min(Math.max(a0.x, a1.x), Math.max(b0.x, b1.x));
        longest = Math.max(longest, hi - lo);
      } else if (Math.abs(a0.x - a1.x) < 1 && Math.abs(b0.x - b1.x) < 1 && Math.abs(a0.x - b0.x) < SAME_LINE) {
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

/** `edge` as the canvas draws it among `nodes` and `edges` (which must include `edge`). `byId`, when
 *  the caller already has every node keyed by id, saves rebuilding that map — this runs inside
 *  `repairAnchors`'s per-candidate loop, up to `MAX_CHECKS` times per problem connector. */
export function drawnRoute(edge: DraftEdge, nodes: readonly DraftNode[], edges: readonly DraftEdge[], caption?: CaptionSize, byId?: Map<string, DraftNode>): Drawn | null {
  if (isCollapsedCompensation(edge)) return null;
  edges = visibleEdges(edges);
  const nodeMap = byId ?? new Map(nodes.map((n) => [n.id, n]));
  const spine = routingPlan(nodes, edges, 'transient').spineFor(edge.id);
  let route;
  try {
    route = connectorRoutes(edge, { nodes, edges }, 'transient', nodeMap)?.request;
  } catch {
    return null;
  }
  if (!route) return null;
  let chip: Box | null = null;
  const size = caption?.(edge);
  if (size && size.width > 0) {
    const group = labelGroupPlan(nodes, edges, 'transient').groupFor(edge.id);
    if (group) {
      if (group.members[0] === edge.id) chip = labelChipBox(group.side, group.x, group.y, size.width, size.height);
    } else {
      const lane = laneIndex(edges).get(edge.id)?.offset ?? 0;
      const nudge = labelLaneOffset(route.source.side, route.target.side, lane);
      if (edge.label) {
        // The side the renderers draw it on: away from the reply line, when there is one.
        const side = labelChipSide(route.labelSide, responseAwayFor(edge.hasResponse, lane));
        chip = labelChipBox(side, route.labelX + nudge.x, route.labelY + nudge.y, size.width, size.height);
      } else {
        // A relationship caption (no label of its own) is drawn by `captionAnchor`, not as a chip: on a
        // shared trunk's one point when it collapses there, under a horizontal line whichever side a
        // chip would have taken, and off whichever side a request/response pair's reply line takes —
        // which a single connector's reply has too (`responseAwayFor`), so this asks the same helpers.
        const at = route.trunkLabel ?? { x: route.labelX + nudge.x, y: route.labelY + nudge.y };
        const chipSide = route.trunkLabel ? (route.trunkLabelSide ?? route.labelSide) : route.labelSide;
        const side = labelSideAwayFromResponse(chipSide, responseAwayFor(edge.hasResponse, lane));
        if (side === 'left' || side === 'right') chip = labelChipBox(side, at.x, at.y, size.width, size.height);
        else {
          const baseline = side === 'top' ? at.y - CAPTION_DROP : at.y + CAPTION_DROP;
          chip = { x: at.x - size.width / 2, y: baseline - CAPTION_RISE - (size.height - CAPTION_TEXT) / 2, width: size.width, height: size.height };
        }
      }
    }
  }
  const unresolved = route.status === 'blocked' || route.status === 'budget' ? { status: route.status } : {};
  return { points: pathPoints(route.d), chip, ...(chip && edge.label ? { ownChip: true } : {}), ...(spine ? { spine: spine.id } : {}), ...unresolved };
}

/** Two captions that may legitimately share a spot: one label drawn for a group, or one relationship
 *  caption collapsed onto a trunk. Two connectors' *own* labels never may, trunk-mates or not. */
export function captionsTogether(a: Drawn & { id?: string }, b: Other): boolean {
  if (a.id && b.shares?.includes(a.id)) return true;
  return Boolean(a.spine && a.spine === b.spine && !(a.ownChip && b.ownChip));
}

/** Another connector as drawn, for judging this one against it. `shares` names connectors that draw
 *  one caption between them (a label group), whose lines run through it by design. */
export interface Other extends Drawn {
  id: string;
  shares?: readonly string[];
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
export function othersOf(nodes: readonly DraftNode[], edges: readonly DraftEdge[], caption?: CaptionSize, except?: string, byId?: Map<string, DraftNode>): Other[] {
  edges = visibleEdges(edges);
  const groups = labelGroupPlan(nodes, edges, 'transient');
  const nodeMap = byId ?? new Map(nodes.map((n) => [n.id, n]));
  return edges.flatMap((e) => {
    if (e.id === except) return [];
    const drawn = drawnRoute(e, nodes, edges, caption, nodeMap);
    const members = groups.groupFor(e.id)?.members;
    return drawn ? [{ ...drawn, id: e.id, ...(members ? { shares: members } : {}) }] : [];
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
  kind: 'through-node' | 'label-over-node' | 'label-collision' | 'label-crossed' | 'shared-run' | 'through-boundary';
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
  byId?: Map<string, DraftNode>,
): RouteProblem | undefined {
  const nodeMap = byId ?? new Map(nodes.map((n) => [n.id, n]));
  const drawn = drawnRoute(edge, nodes, edges, caption, nodeMap);
  return drawn ? problemOf(edge, drawn, nodes, others, nodeMap) : undefined;
}

/** Judge an already drawn route so whole-view checks do not route it a second time. */
function problemOf(edge: DraftEdge, drawn: Drawn, nodes: readonly DraftNode[], others: readonly Other[] | undefined, nodeMap: Map<string, DraftNode>): RouteProblem | undefined {
  if (drawn.chip) {
    const covered = nodes.find((n) => n.type !== 'group' && overlaps(drawn.chip!, inset(n, CAPTION_INSET)));
    if (covered) return { kind: 'label-over-node', node: covered.id };
    const clash = others?.find((o) => o.id !== edge.id && o.chip && !captionsTogether({ ...drawn, id: edge.id }, o) && overlaps(drawn.chip!, o.chip));
    if (clash) return { kind: 'label-collision', node: clash.id };
  }
  const crossed = others?.find((o) => o.id !== edge.id && crosses({ ...drawn, id: edge.id }, o));
  if (crossed) return { kind: 'label-crossed', node: crossed.id };
  const onTop = others?.find((o) => stacked({ ...drawn, id: edge.id }, o));
  if (onTop) return { kind: 'shared-run', node: onTop.id };
  const ends = endsOf(edge, nodeMap);
  for (const node of nodes) {
    if (ends.has(node.id) || node.type === 'group') continue;
    const box = inset(node, THROUGH_INSET);
    if (box.width <= 0 || box.height <= 0) continue;
    for (let k = 0; k + 1 < drawn.points.length; k += 1) {
      if (segmentHitsBox(drawn.points[k]!, drawn.points[k + 1]!, box)) return { kind: 'through-node', node: node.id };
    }
  }
  // Last, and never an error on its own: a line cutting through a boundary neither end is in (or
  // along its title) reads as belonging to it. Worth another anchoring when one avoids it; often none
  // does, and then the line stays as it is.
  for (const node of nodes) {
    if (ends.has(node.id) || node.type !== 'group') continue;
    const box = inset(node, BOUNDARY_INSET);
    for (let k = 0; k + 1 < drawn.points.length; k += 1) {
      if (segmentHitsBox(drawn.points[k]!, drawn.points[k + 1]!, box)) return { kind: 'through-boundary', node: node.id };
    }
  }
  return undefined;
}

/** How much longer (in `routeCost` terms) a route may get to keep out of a boundary it isn't in. */
const BOUNDARY_DETOUR = 320;

/** A line may run this close inside a boundary's outline before it counts as going through it. */
const BOUNDARY_INSET = 2;

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

function skewed(edge: Pick<DraftEdge, 'sourceAnchor' | 'targetAnchor'>, points: readonly Point[]): boolean {
  const from = edge.sourceAnchor?.side;
  const to = edge.targetAnchor?.side;
  const start = points[0];
  const end = points[points.length - 1];
  if (!start || !end) return false;
  if ((from === 'left' && to === 'right') || (from === 'right' && to === 'left')) return Math.abs(start.y - end.y) > 1;
  if ((from === 'top' && to === 'bottom') || (from === 'bottom' && to === 'top')) return Math.abs(start.x - end.x) > 1;
  return false;
}

interface RouteAssessment {
  problems: Map<string, RouteProblem>;
  unresolved: Set<string>;
  crossings: number;
  crossed: Set<string>;
  detours: Set<string>;
  cost: number;
  obstruction: number;
  overlap: number;
  bundled: number;
}

/** Score the complete view: shared corridors can move connectors that share neither endpoint. */
function assessRoutes(nodes: readonly DraftNode[], edges: readonly DraftEdge[], drawn: readonly Other[], byId: Map<string, DraftNode>): RouteAssessment {
  const problems = new Map<string, RouteProblem>();
  const unresolved = new Set<string>();
  const crossed = new Set<string>();
  const detours = new Set<string>();
  const places = new Set<string>();
  const edgeMap = new Map(edges.map((e) => [e.id, e]));
  const runs = drawn.map((d) => runsOf(d.points));
  let cost = 0;
  let obstruction = 0;
  let overlap = 0;
  let bundled = 0;
  for (let i = 0; i < drawn.length; i += 1) {
    const route = drawn[i]!;
    const edge = edgeMap.get(route.id)!;
    const problem = problemOf(edge, route, nodes, drawn, byId);
    if (problem) {
      problems.set(edge.id, problem);
      if (problem.kind !== 'through-boundary' && problem.kind !== 'shared-run') obstruction += 1;
    }
    if (route.spine) bundled += 1;
    if (route.status) unresolved.add(edge.id);
    const source = byId.get(edge.source);
    const target = byId.get(edge.target);
    if (source && target && isDetour(route.points, source, target)) detours.add(edge.id);
    cost += routeCost(route.points);
    for (let j = 0; j < i; j += 1) {
      const other = drawn[j]!;
      if (together(route, other)) continue;
      overlap += sharedRun(route.points, other.points);
      const pair = [route.spine ?? route.id, other.spine ?? other.id].sort().join('\0');
      for (const p of crossingsBetween(runs[i]!, runs[j]!)) {
        places.add(`${pair}\0${Math.round(p.x)}\0${Math.round(p.y)}`);
        crossed.add(route.id);
        crossed.add(other.id);
      }
    }
  }
  return { problems, unresolved, crossings: places.size, crossed, detours, cost, obstruction, overlap, bundled };
}

/** A repair may never make a previously readable connector unreadable, including outside its scope. */
function preservesReadability(before: RouteAssessment, after: RouteAssessment): boolean {
  for (const id of after.unresolved) if (!before.unresolved.has(id)) return false;
  for (const [id, problem] of after.problems) {
    const old = before.problems.get(id);
    if (!old || (old.kind === 'through-boundary' && problem.kind !== 'through-boundary')) return false;
  }
  if (after.obstruction !== before.obstruction) return after.obstruction < before.obstruction;
  if (after.overlap > before.overlap + 1) return false;
  if (after.overlap < before.overlap - 1) return true;
  return after.crossings <= before.crossings && after.detours.size <= before.detours.size;
}

/**
 * Re-anchors, in place, every edge in `targets` whose drawn route or caption runs over a shape or
 * another caption, judged among `all` edges (fan-out spines and lanes depend on the neighbours).
 *
 * Work is bounded: the whole diagram is drawn once, and a candidate re-draws only the connectors
 * sharing an end with the one being moved as a cheap screen. Surviving candidates are checked
 * against the whole view, including unrelated connectors sharing a corridor. Candidates are
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
  polish = false,
): void {
  targets = targets.filter((e) => !isCollapsedCompensation(e));
  all = visibleEdges(all);
  if (!targets.length || performance.now() > deadline) return;
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const moving = new Map(targets.map((t) => [t.id, t]));
  const current = () => all.map((e) => moving.get(e.id) ?? e);
  let edges = current();
  let drawn = new Map(othersOf(nodes, edges, caption, undefined, byId).map((o) => [o.id, o]));
  let assessment = assessRoutes(nodes, edges, [...drawn.values()], byId);
  // The side an automatic end of a connector this repair isn't moving is drawn on — fixed for it.
  const autoSides = new Map<string, { source?: Side; target?: Side }>();
  for (const e of all) {
    if (moving.has(e.id) || (e.sourceAnchor && e.targetAnchor)) continue;
    const request = connectorRoutes(e, { nodes, edges }, 'transient', byId)?.request;
    if (request) autoSides.set(e.id, { source: request.source.side, target: request.target.side });
  }
  const sideOf = (e: DraftEdge, end: 'source' | 'target') => (end === 'source' ? e.sourceAnchor?.side : e.targetAnchor?.side) ?? autoSides.get(e.id)?.[end];
  /**
   * Re-anchors `mover` until every connector in `clean` is drawn without a problem — the first such
   * anchoring, cheapest first — or puts it back and says it couldn't.
   */
  const tryMove = (mover: DraftEdge, clean: readonly DraftEdge[], why: RouteProblem['kind'] | 'tidiness' | 'crossing' | 'detour' | 'unresolved'): boolean => {
    if (mover.waypoints?.length || mover.routeMode === 'direct') return false;
    const soft = why === 'tidiness' || why === 'crossing' || why === 'detour';
    const before = assessment;
    const original = { sourceAnchor: mover.sourceAnchor, targetAnchor: mover.targetAnchor };
    const occupied = (id: string, side: Side | undefined) => edges.some((e) => e.id !== mover.id && (
      (e.source === id && sideOf(e, 'source') === side) || (e.target === id && sideOf(e, 'target') === side)
    ));
    if (why === 'tidiness' && (occupied(mover.source, original.sourceAnchor?.side) || occupied(mover.target, original.targetAnchor?.side))) return false;
    // Crossing a boundary is the mildest problem: fixing a worse one may leave a line crossing one
    // (the best of those is kept in case nothing clears everything), and neither case is worth a
    // detour much longer than the route it would replace.
    const originalCost = roughCost(mover, nodes, byId) ?? Number.POSITIVE_INFINITY;
    let fallback: { source: DraftEdge['sourceAnchor']; target: DraftEdge['targetAnchor']; next: DraftEdge[]; others: Other[]; assessment: RouteAssessment; cost: number } | undefined;
    const ends = new Set(clean.flatMap((e) => [e.source, e.target]));
    const touching = edges.filter((e) => ends.has(e.source) || ends.has(e.target));
    const neighbours = new Set(touching.map((e) => e.id));
    const hood = new Set(touching.flatMap((e) => [e.source, e.target]));
    const edge = mover;
    const candidates: { source: DraftEdge['sourceAnchor']; target: DraftEdge['targetAnchor']; cost: number }[] = [];
    offsets: for (const [sourceOffset, targetOffset] of OFFSET_PAIRS) {
      for (const source of SIDES) {
        for (const target of SIDES) {
          if (performance.now() > deadline) break offsets;
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
      if (why === 'tidiness' && (occupied(mover.source, candidate.source?.side) || occupied(mover.target, candidate.target?.side))) continue;
      // A readable but skewed connector can often lose an elbow simply by meeting the adjacent
      // side. Keep the current anchors unless the saving is substantial, not a pixel-level tie.
      if (why === 'tidiness' && candidate.cost >= originalCost - BEND_COST / 2) continue;
      if (why === 'through-boundary' && candidate.cost > originalCost + BOUNDARY_DETOUR) continue;
      if (fallback && candidate.cost > fallback.cost + BOUNDARY_DETOUR) break;
      edge.sourceAnchor = candidate.source;
      edge.targetAnchor = candidate.target;
      // A fresh array per arrangement (the routing caches are keyed by it), and planned over the
      // neighbourhood first for a cheap screen. The full-view check below also catches separation
      // changes along shared corridors beyond these two hops.
      const next = current();
      const local = next.filter((e) => hood.has(e.source) || hood.has(e.target));
      const fresh = new Map(othersOf(nodes, local, caption, undefined, byId).filter((o) => neighbours.has(o.id)).map((o) => [o.id, o]));
      const others = [...drawn.values()].map((o) => fresh.get(o.id) ?? o);
      if (why === 'tidiness' && clean.some((e) => {
        const before = drawn.get(e.id);
        const after = fresh.get(e.id);
        if (!before || !after) return true;
        const beforeAnchors = e.id === mover.id ? original : e;
        if (!skewed(beforeAnchors, before.points) && skewed(e, after.points)) return true;
        // Saving an elbow on this connector must not put one on an already-straight neighbour.
        return routeCost(after.points) > routeCost(before.points) - (e.id === mover.id ? BEND_COST / 2 : -1);
      })) continue;
      const problems = clean.map((e) => routeProblem(moving.get(e.id) ?? e, nodes, local, caption, others, byId));
      // Local checks only screen candidates. Separation and endpoint plans depend on the whole
      // view, so accept using fresh full-view geometry, never the neighbourhood approximation.
      if (problems.some((p) => p && p.kind !== 'through-boundary')) continue;
      const full = othersOf(nodes, next, caption, undefined, byId);
      const after = assessRoutes(nodes, next, full, byId);
      if (performance.now() > deadline || !preservesReadability(before, after)) continue;
      if (why === 'unresolved' && after.unresolved.has(mover.id)) continue;
      if (soft) {
        if (after.obstruction > before.obstruction || after.overlap > before.overlap + 1 || after.bundled < before.bundled || after.crossings > before.crossings || after.detours.size > before.detours.size) continue;
        if ([...after.crossed].some((id) => !before.crossed.has(id)) || [...after.detours].some((id) => !before.detours.has(id))) continue;
        const simpler = after.cost < before.cost - BEND_COST / 2;
        const fewerCrossings = after.crossings < before.crossings;
        const fewerDetours = after.detours.size < before.detours.size;
        if (why === 'crossing' ? !fewerCrossings : why === 'detour' ? !fewerDetours && !simpler : !simpler) continue;
        if (after.cost > before.cost + BOUNDARY_DETOUR) continue;
      }
      const finalProblems = clean.map((e) => after.problems.get(e.id));
      if (finalProblems.every((p) => !p)) {
        fixed = true;
        assessment = after;
        edges = next;
        drawn = new Map(full.map((o) => [o.id, o]));
        break;
      }
      if (!fallback && why !== 'through-boundary' && !soft && finalProblems.every((p) => !p || p.kind === 'through-boundary')) {
        fallback = { source: candidate.source, target: candidate.target, next, others: full, assessment: after, cost: candidate.cost };
      }
    }
    if (!fixed && fallback) {
      edge.sourceAnchor = fallback.source;
      edge.targetAnchor = fallback.target;
      assessment = fallback.assessment;
      edges = fallback.next;
      drawn = new Map(fallback.others.map((o) => [o.id, o]));
      fixed = true;
    }
    if (!fixed) Object.assign(edge, original);
    return fixed;
  };

  for (const edge of targets) {
    if (performance.now() > deadline) return;
    if (edge.waypoints?.length || edge.routeMode === 'direct') continue;
    const problem = assessment.problems.get(edge.id);
    if (!problem && assessment.unresolved.has(edge.id)) {
      tryMove(edge, [edge], 'unresolved');
      continue;
    }
    if (!problem) {
      // Hard readability checks do not flag a needless elbow. Tidy only automatic routes, and
      // require the already-readable neighbours to remain readable when their shared routing moves.
      const route = drawn.get(edge.id);
      const why = polish && assessment.crossed.has(edge.id) ? 'crossing' : polish && assessment.detours.has(edge.id) ? 'detour' : 'tidiness';
      if (!route || (why === 'tidiness' && bendsOf(route.points) < 2)) continue;
      const touching = edges.filter((e) => e.source === edge.source || e.target === edge.source || e.source === edge.target || e.target === edge.target);
      const plan = routingPlan(nodes, edges, 'transient');
      if (touching.some((e) => plan.spineFor(e.id))) continue;
      const clean = touching.filter((e) => !routeProblem(e, nodes, edges, caption, [...drawn.values()], byId));
      tryMove(edge, clean, why);
      continue;
    }
    // Trouble between two connectors (a line through the other's caption, the two on top of each
    // other): moving the *other* one first often keeps this one straight — cheaper than sending a
    // straight connector on a detour around its neighbour's line.
    const between = problem.kind === 'label-crossed' || problem.kind === 'label-collision' || problem.kind === 'shared-run';
    const other = between ? moving.get(problem.node) : undefined;
    if (other && other !== edge && tryMove(other, [edge, other], problem.kind)) continue;
    tryMove(edge, [edge], problem.kind);
  }
}

/** A route's cost as `routeCost` would give it, drawn without trunks or lanes (see `repairAnchors`). */
function roughCost(edge: DraftEdge, nodes: readonly DraftNode[], byId: Map<string, DraftNode>): number | undefined {
  // A pair of sides the router wouldn't draw as given (one facing away, the line cutting back
  // through a shape) is no candidate at all: its recorded anchors would describe another route.
  if (!anchorsHold(edge, byId)) return undefined;
  try {
    const route = routeEdge(edge, byId, { obstacles: obstaclesForEdge(nodes, edge.source, edge.target, 'transient') });
    return route ? routeCost(pathPoints(route.d)) : undefined;
  } catch {
    return undefined;
  }
}

/** A pin the layout kept on a connector it drew, for the receipt: the end, and why. */
export interface KeptPin {
  id: string;
  end: 'source' | 'target';
  /** `layout`: an automatic end would draw this line differently, so the layout's choice stays. */
  reason: 'layout';
}

/** How a connector is drawn, as one comparable string: both lines and where the label sits. */
function drawnKey(edge: DraftEdge, doc: { nodes: readonly DraftNode[]; edges: readonly DraftEdge[] }, byId: Map<string, DraftNode>): string {
  const routes = connectorRoutes(edge, doc, 'transient', byId);
  if (!routes) return '';
  return `${routes.request.d}|${routes.request.labelX},${routes.request.labelY}|${routes.response?.d ?? ''}`;
}

/**
 * Lets the ends a layout chose for connectors it drew (`created`, by id) attach automatically wherever
 * that draws the very same picture — so a diagram an agent drew follows its shapes when a person moves
 * them, the way one they drew themselves does (see the pin contract in `edges/routing.ts`).
 *
 * Nothing is guessed about anyone's intent: only connectors this operation drew are touched, and an
 * end the agent placed itself (`requested`, `id:source` or `id:target`) stays pinned. Every connector
 * in `all` is compared as drawn before and after; a created connector whose line would change, or that
 * shares a shape with any connector that would, keeps its layout pins, until nothing changes — and if
 * that can't be shown in time, every layout pin stays. Returns a new edge list (plans are cached by
 * the list, so it is never edited in place) and the ends kept pinned.
 */
export function relaxLayoutAnchors(
  created: ReadonlySet<string>,
  nodes: readonly DraftNode[],
  all: readonly DraftEdge[],
  requested: ReadonlySet<string> = new Set(),
): { edges: DraftEdge[]; kept: KeptPin[] } {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const snapshot = (edges: readonly DraftEdge[]) => new Map(edges.map((e) => [e.id, drawnKey(e, { nodes, edges }, byId)]));
  const mine = all.filter((e) => created.has(e.id));
  // Which ends may go automatic: an end with a layout pin, not one the agent asked for, not a bent line.
  const relaxed = new Map<string, { source: boolean; target: boolean }>();
  for (const edge of mine) {
    if (edge.waypoints?.length) continue;
    const source = Boolean(edge.sourceAnchor) && !requested.has(`${edge.id}:source`);
    const target = Boolean(edge.targetAnchor) && !requested.has(`${edge.id}:target`);
    if (source || target) relaxed.set(edge.id, { source, target });
  }
  const apply = () => all.map((e) => {
    const ends = relaxed.get(e.id);
    if (!ends) return e;
    const next = { ...e };
    if (ends.source) delete next.sourceAnchor;
    if (ends.target) delete next.targetAnchor;
    return next;
  });
  // Only a state checked to draw exactly as before is kept; anything else keeps every layout pin.
  let settled = relaxed.size === 0;
  if (!settled) {
    const before = snapshot(all);
    for (let round = 0; round < 8 && relaxed.size; round += 1) {
      if (pastDeadline()) break;
      const now = snapshot(apply());
      const changed = all.filter((e) => now.get(e.id) !== before.get(e.id));
      if (changed.length === 0) {
        settled = true;
        break;
      }
      let restored = false;
      for (const edge of changed) {
        if (relaxed.delete(edge.id)) {
          restored = true;
          continue;
        }
        // Someone else's line moved: the created connectors sharing a shape with it go back.
        for (const other of mine) {
          const shares = other.source === edge.source || other.source === edge.target || other.target === edge.source || other.target === edge.target;
          if (shares && relaxed.delete(other.id)) restored = true;
        }
      }
      if (!restored) break;
      if (relaxed.size === 0) settled = true;
    }
  }
  if (!settled) relaxed.clear();
  const edges = apply();
  const kept: KeptPin[] = [];
  for (const edge of edges) {
    if (!created.has(edge.id) || edge.waypoints?.length) continue;
    for (const end of ['source', 'target'] as const) {
      const anchor = end === 'source' ? edge.sourceAnchor : edge.targetAnchor;
      if (anchor && !requested.has(`${edge.id}:${end}`)) kept.push({ id: edge.id, end, reason: 'layout' });
    }
  }
  return { edges, kept };
}
