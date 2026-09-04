import { Position, getBezierPath, getSmoothStepPath, getStraightPath } from '@xyflow/react';
import {
  SIDES,
  type DraftEdge,
  type DraftNode,
  type EdgeAnchor,
  type EdgeRouting,
  type Side,
} from '../document/types';

/**
 * Edge geometry.
 *
 * This is the only module that calls React Flow's path helpers, and both the
 * live edge component and the SVG exporter call it. Identical inputs therefore
 * produce a byte-identical `d` attribute on screen and in an exported file.
 *
 * Endpoints are computed from the document's node rectangles rather than from
 * React Flow's measured handles: `getEdgePosition` needs an internal node with
 * measured handle bounds, which the exporter cannot have. Deriving anchors
 * ourselves keeps one implementation for both.
 */

export type { Side };

const SIDE_TO_POSITION: Record<Side, Position> = {
  top: Position.Top,
  right: Position.Right,
  bottom: Position.Bottom,
  left: Position.Left,
};

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Anchor {
  x: number;
  y: number;
  side: Side;
}

export function rectOf(node: DraftNode): Rect {
  return { x: node.x, y: node.y, width: node.width, height: node.height };
}

export function centerOf(rect: Rect): { x: number; y: number } {
  return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
}

/**
 * Where a handle sits on a node. Shared by the live handles and the exporter.
 *
 * `offset` is a fraction (0..1) along the side, defaulting to its midpoint —
 * the same point every connector used before anchors existed, so an edge with
 * no persisted anchor (or a caller that doesn't care) sees no change.
 */
export function anchorPoint(rect: Rect, side: Side, offset = 0.5): { x: number; y: number } {
  const t = Math.min(1, Math.max(0, offset));
  switch (side) {
    case 'top':
      return { x: rect.x + rect.width * t, y: rect.y };
    case 'bottom':
      return { x: rect.x + rect.width * t, y: rect.y + rect.height };
    case 'left':
      return { x: rect.x, y: rect.y + rect.height * t };
    case 'right':
      return { x: rect.x + rect.width, y: rect.y + rect.height * t };
  }
}

/**
 * Picks the pair of sides that gives the shortest, least-crossing connection.
 *
 * This is what removes the busywork of choosing connection points by hand, and
 * it re-runs whenever a node moves, so connections reroute themselves.
 */
export function chooseSides(source: Rect, target: Rect): { source: Side; target: Side } {
  const a = centerOf(source);
  const b = centerOf(target);
  const dx = b.x - a.x;
  const dy = b.y - a.y;

  // Compare the gaps rather than the raw deltas, so two nodes that are wide but
  // vertically stacked still connect top-to-bottom.
  const gapX = Math.abs(dx) - (source.width + target.width) / 2;
  const gapY = Math.abs(dy) - (source.height + target.height) / 2;

  if (gapX >= gapY) {
    return dx >= 0 ? { source: 'right', target: 'left' } : { source: 'left', target: 'right' };
  }
  return dy >= 0 ? { source: 'bottom', target: 'top' } : { source: 'top', target: 'bottom' };
}

/**
 * The continuous counterpart to `chooseSides`: which side of `rect` a point
 * is nearest, and where along that side it falls, as an `EdgeAnchor`. Used
 * when a connect/reconnect drop lands on a node's body rather than precisely
 * on a handle (see `Canvas.tsx`), so the connector attaches close to where
 * the user actually dropped it instead of always snapping to a side's
 * midpoint.
 *
 * `point` may be inside or outside `rect` — whichever side it has gone
 * furthest past (or, for a point inside, is nearest to) wins, the same
 * distance-per-side comparison whether the point is within bounds or not.
 */
export function anchorAt(rect: Rect, point: { x: number; y: number }): EdgeAnchor {
  const distanceToSide: Record<Side, number> = {
    top: point.y - rect.y,
    right: rect.x + rect.width - point.x,
    bottom: rect.y + rect.height - point.y,
    left: point.x - rect.x,
  };
  const side = SIDES.reduce((nearest, candidate) =>
    distanceToSide[candidate] < distanceToSide[nearest] ? candidate : nearest,
  );
  const offset =
    side === 'top' || side === 'bottom'
      ? (point.x - rect.x) / rect.width
      : (point.y - rect.y) / rect.height;
  return { side, offset: Math.min(1, Math.max(0, offset)) };
}

/**
 * A drop within this fraction of a rect's half-width/half-height from its
 * centre reads as "just this node," not "this specific spot" — see
 * `anchorForDrop`.
 */
const CENTER_DROP_TOLERANCE = 0.35;

/**
 * What a connect/reconnect drop onto a node's body should actually capture.
 *
 * A drop near dead centre carries no real positional intent — the user
 * dropped "on this node," not "on this exact point" — so it stays
 * `undefined` and routing keeps picking the best side dynamically via
 * `chooseSides`, exactly as it always has for a plain body-hit. Only a drop
 * that clearly favours one side captures a specific `anchorAt` point, so an
 * imprecise drop near a wide node's centre (which `anchorAt` alone would
 * still resolve to its nearer top/bottom side, ignoring the other node's
 * actual position) doesn't lock in a worse attachment than dynamic routing
 * would have chosen.
 */
export function anchorForDrop(rect: Rect, point: { x: number; y: number }): EdgeAnchor | undefined {
  const center = centerOf(rect);
  const dx = Math.abs(point.x - center.x) / (rect.width / 2);
  const dy = Math.abs(point.y - center.y) / (rect.height / 2);
  if (Math.max(dx, dy) <= CENTER_DROP_TOLERANCE) return undefined;
  return anchorAt(rect, point);
}

/**
 * The three anchor points offered per side (25% / 50% / 75%) — the fixed grid
 * every rendered handle sits on (see `HANDLE_ANCHORS`). `anchorAt`/
 * `anchorForDrop` above stay fully continuous on purpose (used as-is
 * elsewhere, and covered by their own tests); snapping to this grid only
 * happens where an interactive drag actually captures a point, via
 * `snappedAnchorForDrop` below.
 */
export const ANCHOR_OFFSETS = [0.25, 0.5, 0.75] as const;

function snapOffset(offset: number): number {
  return ANCHOR_OFFSETS.reduce((nearest, candidate) =>
    Math.abs(candidate - offset) < Math.abs(nearest - offset) ? candidate : nearest,
  );
}

/**
 * `anchorForDrop`, snapped to the fixed 3-point grid — what a connect or
 * reconnect drag onto a node's body actually captures, and what a live
 * "nearest anchor" preview during that drag should highlight. Stays
 * `undefined` exactly when `anchorForDrop` does, so a drop dead-centre still
 * keeps routing dynamic rather than locking a specific (snapped) point.
 */
export function snappedAnchorForDrop(rect: Rect, point: { x: number; y: number }): EdgeAnchor | undefined {
  const anchor = anchorForDrop(rect, point);
  return anchor ? { side: anchor.side, offset: snapOffset(anchor.offset) } : undefined;
}

export interface RoutedEdge {
  d: string;
  labelX: number;
  labelY: number;
  /** Which side of the line the label chip should sit on — see `labelSideFor`. */
  labelSide: Side;
  source: Anchor;
  target: Anchor;
}

/** The direction of travel arriving at a side's own anchor — the inward-pointing counterpart to
 *  `edges/describe.ts`'s `OUTWARD` (which instead walks *out* from a source anchor for step
 *  badge placement). Shared here since `endTangent` needs it for both ends. */
const INWARD: Record<Side, { x: number; y: number }> = {
  top: { x: 0, y: 1 },
  bottom: { x: 0, y: -1 },
  left: { x: 1, y: 0 },
  right: { x: -1, y: 0 },
};

/**
 * The unit-vector direction a connector is travelling in as it arrives at one end of an
 * already-routed edge — what a hand-drawn Sketch arrowhead (`render/roughness/roughArrow.ts`)
 * needs to orient itself, computed from routing geometry directly rather than by sampling the
 * drawn path (which would need to account for roughening, bow, and every routing mode's own
 * curve shape).
 *
 * `straight` has no fixed approach direction — it's simply point-to-point, so the tangent is the
 * line's own direction. Every other routing mode (`bezier`/`smoothstep`, including the hand-built
 * detour) approaches its anchor exactly perpendicular to the node's own side — the same fact
 * `orient="auto-start-reverse"` already exploits for the shared `<marker>` — so the tangent there
 * is simply that side's own inward normal, regardless of the path's shape further back.
 */
export function endTangent(route: RoutedEdge, routing: EdgeRouting, end: 'source' | 'target'): { x: number; y: number } {
  const anchor = end === 'target' ? route.target : route.source;
  if (routing === 'straight') {
    const other = end === 'target' ? route.source : route.target;
    const dx = anchor.x - other.x;
    const dy = anchor.y - other.y;
    const len = Math.hypot(dx, dy) || 1;
    return { x: dx / len, y: dy / len };
  }
  return INWARD[anchor.side];
}

/** The seed suffix a request/response connector's reply line roughens with — shared by
 *  `edges/describe.ts` and `DraftEdgeView.tsx` so the two renderers can never silently disagree
 *  on it the way they already once did (the reply line wobbled live but not in exports). */
export const RESPONSE_SEED_SUFFIX = ':response';

/** Gap, in canvas pixels, between the line and a label chip's near edge. Shared by
 *  `DraftEdgeView.tsx` (transform-based) and `edges/describe.ts` (direct rect math) so the two
 *  renderers can't drift the way `CONDITION_OFFSET_Y` already has. */
export const LABEL_LINE_GAP = 8;

export interface LaneAssignment {
  /** This edge's signed slot within its parallel-edge group; `0` for a lone edge. */
  offset: number;
  /** How many edges share this group — `1` for a lone edge. */
  count: number;
}

const LONE_LANE: LaneAssignment = { offset: 0, count: 1 };
const laneIndexCache = new WeakMap<readonly DraftEdge[], Map<string, LaneAssignment>>();

/** Groups edges by their unordered (source, target) pair, so A→B and B→A —
 *  the callback case — share a lane group and fan out together. */
function pairKey(edge: DraftEdge): string {
  return edge.source < edge.target ? `${edge.source}|${edge.target}` : `${edge.target}|${edge.source}`;
}

/**
 * Every edge's parallel-lane slot, indexed once per `edges` array identity
 * and shared by every connector, on screen and in export. A component
 * subscribing through this — e.g. `laneIndex(state.document.edges).get(id)`
 * — should project to a primitive (`.offset`), not the `LaneAssignment`
 * object itself: the whole index rebuilds (fresh objects for every group)
 * whenever any edge anywhere changes, and only a primitive read lets
 * zustand's default equality skip a re-render for edges whose own lane
 * didn't actually move. See `DraftEdgeView.tsx`.
 */
export function laneIndex(edges: readonly DraftEdge[]): Map<string, LaneAssignment> {
  const cached = laneIndexCache.get(edges);
  if (cached) return cached;

  const groups = new Map<string, DraftEdge[]>();
  for (const edge of edges) {
    const key = pairKey(edge);
    const group = groups.get(key);
    if (group) group.push(edge);
    else groups.set(key, [edge]);
  }

  const index = new Map<string, LaneAssignment>();
  for (const group of groups.values()) {
    if (group.length === 1) {
      index.set(group[0]!.id, LONE_LANE);
      continue;
    }
    // Sorted by id, not creation/array order, so a group's fan-out stays
    // stable even if the edges array is ever reordered upstream.
    const sorted = [...group].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    const count = sorted.length;
    sorted.forEach((edge, i) => {
      // Centred and symmetric: count=2 -> [-0.5, 0.5], count=3 -> [-1, 0, 1].
      index.set(edge.id, { offset: i - (count - 1) / 2, count });
    });
  }

  laneIndexCache.set(edges, index);
  return index;
}

export interface RouteAnchors {
  source?: EdgeAnchor;
  target?: EdgeAnchor;
}

export interface RouteOptions {
  anchors?: RouteAnchors;
  /**
   * This edge's slot within the group of edges sharing its (unordered) node
   * pair — `0` for a lone edge (by far the common case), otherwise a small
   * signed integer from this module's `laneIndex`. Nudges both endpoints a
   * few pixels along their own side so parallel connectors fan out instead
   * of drawing on top of one another.
   */
  lane?: number;
  /**
   * Other nodes' rects to route around. Excludes the edge's own source and
   * target by convention — the caller builds this list, not `routeBetween`,
   * since "which nodes count as obstacles" (e.g. group boundaries do not) is
   * a document-level judgement, not a geometry one.
   */
  obstacles?: readonly Rect[];
}

const isHorizontalSide = (side: Side) => side === 'left' || side === 'right';
const isVerticalSide = (side: Side) => side === 'top' || side === 'bottom';

/** Compact and deliberately small — see requirements doc §48 "keep spacing compact". */
const LANE_SPACING = 10;

/**
 * How far a request/response connector's own reply line sits from its
 * request line — reuses the lane fan-out mechanism above (`laneNudge`) that
 * already separates real parallel edges, added on top of this edge's own
 * lane slot rather than a fixed pixel offset, so it still reads correctly
 * when this edge already has parallel siblings. A caller computes the
 * response's lane with `responseLaneFor(laneOffset)` below — see
 * `DraftEdgeView.tsx`/`edges/describe.ts`. `laneIndex` only ever assigns real
 * siblings a (positive or negative) multiple of 0.5, so any delta whose
 * remainder mod 0.5 is non-zero can never land exactly on a real neighbour's
 * lane, regardless of this edge's own offset — 1.8 satisfies that while
 * giving the line (~18px) and its label (~36px) comfortable, "pleasant to the
 * eye" clearance from the request line/label, not merely enough to avoid a
 * smudge. A smaller fractional delta (0.35, then 1.25) technically satisfied
 * the same non-collision invariant but read as too cramped.
 */
export const RESPONSE_LANE_DELTA = 1.8;

/**
 * The response route's own lane slot, given this edge's request-side
 * `laneOffset`. Adds the delta *away from centre* — same side as the
 * request's own offset, just further out — rather than a fixed `+DELTA`
 * regardless of sign: with two real edges between the same node pair (one at
 * a negative `laneIndex` slot, one at a positive one), a sign-blind `+DELTA`
 * can push edge A's response line past centre into edge B's own lane band,
 * interleaving the two pairs (A-request, B-response, A-response, B-request)
 * instead of keeping each connector's own request+response grouped together
 * as one visual unit. `laneOffset === 0` (the common single-edge case) keeps
 * exactly its previous behaviour — treated as the positive side, i.e.
 * `+RESPONSE_LANE_DELTA` — since that case has no sign to preserve.
 */
export function responseLaneFor(laneOffset: number): number {
  return laneOffset + Math.sign(laneOffset || 1) * RESPONSE_LANE_DELTA;
}

/**
 * Shifts an anchor point along its own side by `lane` slots, clamped so a
 * node with many parallel siblings still keeps the whole fan-out comfortably
 * inside its own side rather than sprouting past a corner.
 */
function laneNudge(rect: Rect, side: Side, lane: number): { x: number; y: number } {
  if (!lane) return { x: 0, y: 0 };
  const sideLength = isHorizontalSide(side) ? rect.height : rect.width;
  const span = Math.sign(lane) * Math.min(Math.abs(lane) * LANE_SPACING, sideLength * 0.35);
  return isHorizontalSide(side) ? { x: 0, y: span } : { x: span, y: 0 };
}

/**
 * Keeps an anchor point on its rect's actual boundary after a lane nudge.
 * `laneNudge` alone only bounds its own span relative to the side's length —
 * it doesn't know where the anchor's own offset already sits, so a nudge
 * added to an offset near one end (say 0.9) can walk the point past the
 * corner. This is the final word: whatever the offset and nudge added up
 * to, the point lands back on the side it's actually meant to be on. A
 * marker's `refX` assumes exactly this — see `render/svg/markers.ts`.
 */
function clampToBoundary(
  point: { x: number; y: number },
  rect: Rect,
  side: Side,
): { x: number; y: number } {
  if (isHorizontalSide(side)) {
    return { x: point.x, y: Math.max(rect.y, Math.min(rect.y + rect.height, point.y)) };
  }
  return { x: Math.max(rect.x, Math.min(rect.x + rect.width, point.x)), y: point.y };
}

/**
 * A label chip is far taller than the ~10px between two lanes' lines, so
 * riding along with the line's own nudge isn't enough to keep parallel
 * labels from stacking — this is the extra separation applied on top, for
 * whichever axis the lanes actually fan out on. Not clamped to a node's own
 * side, unlike `laneNudge`: a label lives in open canvas space between the
 * nodes, not on either node's boundary.
 */
const LABEL_LANE_SPACING = 20;

export function labelLaneOffset(sourceSide: Side, targetSide: Side, lane: number): { x: number; y: number } {
  if (!lane) return { x: 0, y: 0 };
  if (isHorizontalSide(sourceSide) && isHorizontalSide(targetSide)) return { x: 0, y: lane * LABEL_LANE_SPACING };
  if (isVerticalSide(sourceSide) && isVerticalSide(targetSide)) return { x: lane * LABEL_LANE_SPACING, y: 0 };
  // A mixed pairing has no single well-defined fan-out axis for labels —
  // the line itself already separates via `laneNudge`, which is enough.
  return { x: 0, y: 0 };
}

const OBSTACLE_MARGIN = 16;
/** How far an obstacle's edge may sit from the direct run and still count as
 *  blocking it — a full node height/width would false-positive on anything
 *  merely nearby; this stays close to the corridor the route would actually take. */
const OBSTACLE_BAND = 10;

export interface Detour {
  /** The horizontal run's midpoint should bend to clear obstacles at this y. */
  detourY?: number;
  /** The vertical run's midpoint should bend to clear obstacles at this x. */
  detourX?: number;
}

/**
 * A single-detour heuristic, not a pathfinder: if the direct run between
 * `from` and `to` would cut straight through another node, picks a y (for a
 * horizontal run) or x (for a vertical one) that clears whichever side of the
 * obstacle is the shorter detour — `routeBetween` then bends the path's
 * middle segment through it. Endpoints never move; only what happens between
 * them does.
 *
 * Only handles the classic "same row/column, something sits directly in
 * between" case the routing brief calls out — a diagonal pairing, or an
 * obstacle outside the direct corridor, is left alone.
 */
export function detourAround(
  from: { x: number; y: number },
  to: { x: number; y: number },
  sourceSide: Side,
  targetSide: Side,
  obstacles: readonly Rect[],
): Detour | null {
  if (obstacles.length === 0) return null;

  if (isHorizontalSide(sourceSide) && isHorizontalSide(targetSide)) {
    const minX = Math.min(from.x, to.x);
    const maxX = Math.max(from.x, to.x);
    const y = (from.y + to.y) / 2;
    const blocking = obstacles.filter(
      (o) => o.x < maxX && o.x + o.width > minX && o.y < y + OBSTACLE_BAND && o.y + o.height > y - OBSTACLE_BAND,
    );
    if (blocking.length === 0) return null;
    const top = Math.min(...blocking.map((o) => o.y)) - OBSTACLE_MARGIN;
    const bottom = Math.max(...blocking.map((o) => o.y + o.height)) + OBSTACLE_MARGIN;
    return { detourY: Math.abs(top - y) <= Math.abs(bottom - y) ? top : bottom };
  }

  if (isVerticalSide(sourceSide) && isVerticalSide(targetSide)) {
    const minY = Math.min(from.y, to.y);
    const maxY = Math.max(from.y, to.y);
    const x = (from.x + to.x) / 2;
    const blocking = obstacles.filter(
      (o) => o.y < maxY && o.y + o.height > minY && o.x < x + OBSTACLE_BAND && o.x + o.width > x - OBSTACLE_BAND,
    );
    if (blocking.length === 0) return null;
    const left = Math.min(...blocking.map((o) => o.x)) - OBSTACLE_MARGIN;
    const right = Math.max(...blocking.map((o) => o.x + o.width)) + OBSTACLE_MARGIN;
    return { detourX: Math.abs(left - x) <= Math.abs(right - x) ? left : right };
  }

  return null;
}

/**
 * A hand-built rounded orthogonal path through explicit waypoints, for the
 * one case React Flow's own `getSmoothStepPath` can't produce: a genuine
 * detour when source and target already share a y (or x) — its point
 * generation never introduces a middle segment for an already-aligned pair,
 * so there is no bend to steer via its `centerX`/`centerY` params.
 *
 * The corner-rounding technique (a short straight run into a quadratic curve
 * before each turn) matches `getSmoothStepPath`'s own, so a detoured
 * connector reads as the same routing style, not a different one.
 */
function roundedStepPath(points: readonly { x: number; y: number }[], radius: number): string {
  let d = `M${points[0]!.x} ${points[0]!.y}`;
  for (let i = 1; i < points.length - 1; i += 1) {
    d += stepCorner(points[i - 1]!, points[i]!, points[i + 1]!, radius);
  }
  const last = points[points.length - 1]!;
  return `${d}L${last.x} ${last.y}`;
}

function stepCorner(
  a: { x: number; y: number },
  b: { x: number; y: number },
  c: { x: number; y: number },
  size: number,
): string {
  const bendSize = Math.min(Math.hypot(a.x - b.x, a.y - b.y) / 2, Math.hypot(b.x - c.x, b.y - c.y) / 2, size);
  const { x, y } = b;
  if ((a.x === x && x === c.x) || (a.y === y && y === c.y)) return `L${x} ${y}`;
  if (a.y === y) {
    const xDir = a.x < c.x ? -1 : 1;
    const yDir = a.y < c.y ? 1 : -1;
    return `L${x + bendSize * xDir} ${y}Q${x} ${y} ${x} ${y + bendSize * yDir}`;
  }
  const xDir = a.x < c.x ? 1 : -1;
  const yDir = a.y < c.y ? -1 : 1;
  return `L${x} ${y + bendSize * yDir}Q${x} ${y} ${x + bendSize * xDir} ${y}`;
}

/** How far a detoured path travels straight out from an endpoint before its
 *  first turn — matches `getSmoothStepPath`'s own default `offset`. */
const DETOUR_LEG = 20;

const sideDirX = (side: Side) => (side === 'right' ? 1 : side === 'left' ? -1 : 0);
const sideDirY = (side: Side) => (side === 'bottom' ? 1 : side === 'top' ? -1 : 0);

/** Builds the detour waypoints and the resulting path/label position. */
function buildDetourPath(
  from: { x: number; y: number },
  to: { x: number; y: number },
  sourceSide: Side,
  targetSide: Side,
  detour: Detour,
): { d: string; labelX: number; labelY: number } {
  let points: { x: number; y: number }[];
  let labelX: number;
  let labelY: number;

  if (detour.detourY !== undefined) {
    const x1 = from.x + DETOUR_LEG * sideDirX(sourceSide);
    const x2 = to.x + DETOUR_LEG * sideDirX(targetSide);
    const y = detour.detourY;
    points = [from, { x: x1, y: from.y }, { x: x1, y }, { x: x2, y }, { x: x2, y: to.y }, to];
    labelX = (x1 + x2) / 2;
    labelY = y;
  } else {
    const y1 = from.y + DETOUR_LEG * sideDirY(sourceSide);
    const y2 = to.y + DETOUR_LEG * sideDirY(targetSide);
    const x = detour.detourX!;
    points = [from, { x: from.x, y: y1 }, { x, y: y1 }, { x, y: y2 }, { x: to.x, y: y2 }, to];
    labelX = x;
    labelY = (y1 + y2) / 2;
  }

  return { d: roundedStepPath(points, 10), labelX, labelY };
}

/**
 * Which side of the line a label chip should sit on, so it never straddles the stroke. Kept
 * deliberately simple and deterministic — no obstacle scan beyond the two endpoints' own nodes,
 * no solver — per the same "smart but not clever" preference `chooseSides` already follows.
 *
 * Orientation comes from the side pairing (both vertical -> left/right candidates, both
 * horizontal -> top/bottom candidates); a mixed pairing falls back to comparing the endpoints'
 * own delta, since `chooseSides` never itself returns a mixed pair — only two independently
 * persisted anchors can produce one. The default candidate (`right` / `top`) flips to its
 * opposite only if it would land inside the source or target node's own rect — both already at
 * hand here, so no new obstacle lookup is needed.
 */
export function labelSideFor(
  sourceRect: Rect,
  targetRect: Rect,
  sourceSide: Side,
  targetSide: Side,
  point: { x: number; y: number },
): Side {
  const vertical = isVerticalSide(sourceSide) && isVerticalSide(targetSide);
  const horizontal = isHorizontalSide(sourceSide) && isHorizontalSide(targetSide);
  const preferVertical = vertical || (!horizontal && Math.abs(targetRect.x - sourceRect.x) < Math.abs(targetRect.y - sourceRect.y));

  const insideRect = (rect: Rect, x: number, y: number) =>
    x > rect.x && x < rect.x + rect.width && y > rect.y && y < rect.y + rect.height;

  if (preferVertical) {
    const rightPoint = { x: point.x + LABEL_LINE_GAP, y: point.y };
    const collides = insideRect(sourceRect, rightPoint.x, rightPoint.y) || insideRect(targetRect, rightPoint.x, rightPoint.y);
    return collides ? 'left' : 'right';
  }
  const topPoint = { x: point.x, y: point.y - LABEL_LINE_GAP };
  const collides = insideRect(sourceRect, topPoint.x, topPoint.y) || insideRect(targetRect, topPoint.x, topPoint.y);
  return collides ? 'bottom' : 'top';
}

/**
 * Routes between two node rectangles, honouring a persisted anchor for
 * whichever endpoint has one and falling back to `chooseSides`'s nearest-side
 * heuristic for whichever doesn't. An anchor represents the user's explicit
 * choice of where a connector starts or lands — see `EdgeAnchor` in
 * `document/types.ts` — so once set, it is never overridden here; only an
 * explicit reconnect changes it.
 */
export function routeBetween(
  sourceRect: Rect,
  targetRect: Rect,
  routing: EdgeRouting,
  options?: RouteOptions,
): RoutedEdge {
  const anchors = options?.anchors;
  // Cheap, and only needed for whichever side has no persisted anchor.
  const fallback = !anchors?.source || !anchors?.target ? chooseSides(sourceRect, targetRect) : null;
  const sourceSide = anchors?.source?.side ?? fallback!.source;
  const targetSide = anchors?.target?.side ?? fallback!.target;

  const sourcePoint = anchorPoint(sourceRect, sourceSide, anchors?.source?.offset);
  const targetPoint = anchorPoint(targetRect, targetSide, anchors?.target?.offset);
  const sourceNudge = laneNudge(sourceRect, sourceSide, options?.lane ?? 0);
  const targetNudge = laneNudge(targetRect, targetSide, options?.lane ?? 0);
  const from = clampToBoundary(
    { x: sourcePoint.x + sourceNudge.x, y: sourcePoint.y + sourceNudge.y },
    sourceRect,
    sourceSide,
  );
  const to = clampToBoundary(
    { x: targetPoint.x + targetNudge.x, y: targetPoint.y + targetNudge.y },
    targetRect,
    targetSide,
  );

  const params = {
    sourceX: from.x,
    sourceY: from.y,
    sourcePosition: SIDE_TO_POSITION[sourceSide],
    targetX: to.x,
    targetY: to.y,
    targetPosition: SIDE_TO_POSITION[targetSide],
  };

  let path: string;
  let labelX: number;
  let labelY: number;

  switch (routing) {
    case 'straight': {
      const [d, lx, ly] = getStraightPath({
        sourceX: params.sourceX,
        sourceY: params.sourceY,
        targetX: params.targetX,
        targetY: params.targetY,
      });
      path = d;
      labelX = lx;
      labelY = ly;
      break;
    }
    case 'bezier': {
      const [d, lx, ly] = getBezierPath(params);
      path = d;
      labelX = lx;
      labelY = ly;
      break;
    }
    case 'smoothstep':
    default: {
      // Obstacle avoidance only applies to the orthogonal style — a forced
      // straight or bezier line has no "bend" to route around anything with.
      const detour = detourAround(from, to, sourceSide, targetSide, options?.obstacles ?? []);
      if (detour) {
        const built = buildDetourPath(from, to, sourceSide, targetSide, detour);
        path = built.d;
        labelX = built.labelX;
        labelY = built.labelY;
      } else {
        const [d, lx, ly] = getSmoothStepPath({ ...params, borderRadius: 10 });
        path = d;
        labelX = lx;
        labelY = ly;
      }
      break;
    }
  }

  return {
    d: path,
    labelX,
    labelY,
    labelSide: labelSideFor(sourceRect, targetRect, sourceSide, targetSide, { x: labelX, y: labelY }),
    source: { ...from, side: sourceSide },
    target: { ...to, side: targetSide },
  };
}

export function routeEdge(
  edge: DraftEdge,
  nodes: Map<string, DraftNode>,
  options?: Omit<RouteOptions, 'anchors'>,
): RoutedEdge | null {
  const source = nodes.get(edge.source);
  const target = nodes.get(edge.target);
  if (!source || !target) return null;
  return routeBetween(rectOf(source), rectOf(target), edge.routing, {
    ...options,
    anchors: { source: edge.sourceAnchor, target: edge.targetAnchor },
  });
}

/** Type guard for a handle id / stored value that should be one of the four sides. */
export function isSide(value: unknown): value is Side {
  return typeof value === 'string' && (SIDES as readonly string[]).includes(value);
}

export interface HandleAnchor {
  /** Parseable id encoding both side and offset index — see `parseAnchorId`. */
  id: string;
  side: Side;
  offset: number;
  position: Position;
}

/**
 * Which `ANCHOR_OFFSETS` index to emit first, second, third, for each side —
 * `1` (the midpoint, `0.5`) leads so this array's first four entries are
 * exactly the one-per-side, centre-only handles that existed before this
 * grid, in the same `SIDES` order (top, right, bottom, left) they always
 * rendered in. Nothing reads `HANDLE_ANCHORS` by position — this is purely so
 * `.dc-handle`'s DOM order doesn't shift under existing positional lookups
 * (e.g. an e2e spec's `.nth(1)` for "the source's right-side handle").
 */
const OFFSET_INDEX_ORDER = [1, 0, 2] as const;

/** Every real, renderable connection point on a node: 3 per side (`ANCHOR_OFFSETS`), 12 total. */
export const HANDLE_ANCHORS: readonly HandleAnchor[] = OFFSET_INDEX_ORDER.flatMap((offsetIndex) =>
  SIDES.map((side) => ({
    id: `${side}@${offsetIndex}`,
    side,
    offset: ANCHOR_OFFSETS[offsetIndex],
    position: SIDE_TO_POSITION[side],
  })),
);

/** Decodes a `HANDLE_ANCHORS` id (e.g. `"top@1"`) back into the `EdgeAnchor` it represents. */
export function parseAnchorId(value: unknown): EdgeAnchor | undefined {
  if (typeof value !== 'string') return undefined;
  const [side, indexPart] = value.split('@');
  if (!isSide(side)) return undefined;
  const offset = ANCHOR_OFFSETS[Number(indexPart)];
  return offset === undefined ? undefined : { side, offset };
}

/** The inverse of `parseAnchorId` — an `EdgeAnchor` back into the `HANDLE_ANCHORS` id it names,
 *  snapping to the nearest of the three offsets a stored anchor doesn't land exactly on. `undefined`
 *  in, `undefined` out: an edge with no explicit anchor has no specific handle to point React Flow
 *  at either, and should keep resolving dynamically. */
export function handleIdForAnchor(anchor: EdgeAnchor | undefined): string | undefined {
  if (!anchor) return undefined;
  const index = ANCHOR_OFFSETS.reduce(
    (best, candidate, i) => (Math.abs(candidate - anchor.offset) < Math.abs(ANCHOR_OFFSETS[best]! - anchor.offset) ? i : best),
    0,
  );
  return `${anchor.side}@${index}`;
}
