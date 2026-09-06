import type { DraftEdge, DraftNode, Side } from '../document/types';
import { type EdgeSpine, type Rect, laneIndex, rectOf, resolveSides } from './routing';

/**
 * Fan-out / fan-in edge bundling — the planning half of Smart Routing.
 *
 * ## Semantic graph vs. visual routing graph
 *
 * This module decides that several connectors should *look* like they share a
 * trunk. It never changes what they mean. Five edges bundled out of one
 * service are still five independent relationships in `DraftDocument.edges`:
 * nothing here is persisted, nothing here is a node, nothing here is
 * selectable, and nothing here participates in validation, semantics, export
 * as an architecture element, or history. A `RoutingPlan` is derived state,
 * recomputed from the document and thrown away.
 *
 * That separation is the whole point. A user who needs five arrows to stop
 * overlapping should not have to insert a Junction — a Junction *looks*
 * deployed, and inserting one for tidiness makes a reader ask whether it's a
 * real gateway. Smart Routing owns the presentation; Junction stays the
 * deliberate, explicit escape hatch for someone who genuinely wants a
 * controllable connection point.
 *
 * ## Why the gates are deliberately strict
 *
 * Bundling only ever helps when the result is unambiguous, so every rule below
 * narrows rather than widens. An edge that isn't obviously part of a fan
 * simply routes exactly as it did before this module existed — that is the
 * safe default, and the common one.
 */

/**
 * How many connectors a fan needs before a shared trunk is worth drawing.
 *
 * Two members already benefit: a simple fork or funnel reads as more deliberate on one shared
 * stem with one collapsed caption than as two independent lines each repeating the same
 * relationship word beside its own branch — the exact "uses / uses" or "calls / calls" column this
 * module exists to remove, regardless of how many branches are doing it.
 */
export const MIN_SPINE_MEMBERS = 2;

/** Shortest run from the hub out to the trunk, and from the trunk in to a far
 *  node. Below these the path reads as a dogleg pressed against a node rather
 *  than a deliberate corridor. */
const MIN_STEM = 28;
const MIN_BRANCH = 28;

/**
 * The trunk sits at a quantized position in the corridor rather than exactly
 * halfway. Rounding to a grid is what stops the trunk sliding a pixel at a
 * time as a node is nudged: a small move usually lands on the same multiple,
 * so the route holds still, and when it does move it moves by a visible step
 * instead of shimmering. This is the routing brief's "stability / hysteresis"
 * requirement, bought with arithmetic instead of with remembered state.
 */
const TRUNK_QUANTUM = 8;

/** How far apart the far ends must be spread, across the trunk, before a fan
 *  is a fan. Destinations all at one height have nothing to fan out. */
const MIN_FAN_SPREAD = 32;

/**
 * Where in the corridor the trunk sits, as a fraction of the distance from the
 * hub to the nearest far node.
 *
 * Past the midpoint on purpose: a long shared stem and short branches is what
 * makes a fan read as *one* relationship splitting late, rather than as two
 * equal halves meeting in the middle. It also leaves the caption a long, empty
 * run to sit on, well clear of both the hub and every branch bend.
 */
const TRUNK_BIAS = 0.62;

/** Clearance kept between the trunk and any node it would otherwise run through. */
const TRUNK_OBSTACLE_MARGIN = 20;

/**
 * Total obstacle-rect checks a single `computePlan` call may spend across every
 * group it considers, counted in `runBlocked`. `planTrunkGap` searches outward
 * from the preferred gap in `TRUNK_QUANTUM` steps, and each step re-tests every
 * obstacle for the hub's stem, the trunk, and every branch — with enough nodes,
 * a wide corridor, and several qualifying fan-out groups in one diagram, that
 * search has no natural upper bound and can block the main thread for a very
 * long time. A budget this generous never engages for an ordinary diagram (it
 * comfortably covers dozens of large fans against a diagram of a few hundred
 * nodes); past it, the remaining groups simply route independently — already
 * the correct, designed fallback for "nothing clears" — rather than the whole
 * canvas hanging.
 */
const MAX_ROUTING_PLAN_OPS = 500_000;

const OPPOSITE: Record<Side, Side> = { top: 'bottom', bottom: 'top', left: 'right', right: 'left' };
const isHorizontalSide = (side: Side) => side === 'left' || side === 'right';

export interface RoutingPlan {
  /** This edge's shared trunk, or `undefined` to route it independently. */
  spineFor(edgeId: string): EdgeSpine | undefined;
  /** Every connector travelling along `spineId`, ordered along the trunk. */
  membersOf(spineId: string): readonly string[];
}

const EMPTY_MEMBERS: readonly string[] = [];
const EMPTY_PLAN: RoutingPlan = { spineFor: () => undefined, membersOf: () => EMPTY_MEMBERS };

/**
 * Everything about an edge that must match for two connectors to share a
 * trunk. Relationship *meaning* is included on purpose: `calls`, `writes` and
 * `publishes` leaving the same service are three different statements about
 * the architecture, and merging them into one indistinguishable bundle would
 * trade visual noise for lost meaning. Line treatment (`kind`, `async`) and
 * colour (`accent`) are here for the same reason — a trunk drawn from members
 * that disagree about how it should look has no correct appearance.
 */
function compatibilityKey(edge: DraftEdge): string {
  return [
    edge.semantic ?? '',
    edge.kind ?? '',
    edge.directed ? 'd' : '',
    edge.async ? 'a' : '',
    edge.hasResponse ? 'r' : '',
    edge.accent ?? '',
    // Folded in because it changes the *caption text*
    // (`relationshipCaptionLabel`), and a bundle collapses its members'
    // captions onto one shared point — members that would render different
    // words there must not share a trunk.
    edge.deliveryAttempts ?? '',
  ].join('|');
}

interface Candidate {
  edge: DraftEdge;
  sourceRect: Rect;
  targetRect: Rect;
  sourceSide: Side;
  targetSide: Side;
}

/** The point a candidate leaves/enters its hub at, as a fraction along the hub
 *  side. An edge with no persisted anchor uses the side's midpoint, exactly as
 *  `anchorPoint` does — so a connector drawn by dropping on a node's body and
 *  one drawn from the centre handle share a stem, as they already visually do. */
function hubOffset(candidate: Candidate, hub: 'source' | 'target'): number {
  const anchor = hub === 'source' ? candidate.edge.sourceAnchor : candidate.edge.targetAnchor;
  return anchor?.offset ?? 0.5;
}

/** Where a far node's anchor sits on the axis the trunk runs along — the
 *  coordinate this member taps off the trunk at. */
function farCross(candidate: Candidate, hub: 'source' | 'target', verticalTrunk: boolean): number {
  const rect = hub === 'source' ? candidate.targetRect : candidate.sourceRect;
  const anchor = hub === 'source' ? candidate.edge.targetAnchor : candidate.edge.sourceAnchor;
  const offset = anchor?.offset ?? 0.5;
  return verticalTrunk ? rect.y + rect.height * offset : rect.x + rect.width * offset;
}

/** The near face of a rect, along the direction the corridor runs in. */
function nearFace(rect: Rect, hubSide: Side): number {
  switch (hubSide) {
    case 'right':
      return rect.x;
    case 'left':
      return rect.x + rect.width;
    case 'bottom':
      return rect.y;
    case 'top':
      return rect.y + rect.height;
  }
}

/** The hub's own outer face, where the corridor to the trunk begins. */
function hubFace(rect: Rect, hubSide: Side): number {
  switch (hubSide) {
    case 'right':
      return rect.x + rect.width;
    case 'left':
      return rect.x;
    case 'bottom':
      return rect.y + rect.height;
    case 'top':
      return rect.y;
  }
}

interface Group {
  key: string;
  hub: 'source' | 'target';
  hubId: string;
  hubSide: Side;
  members: Candidate[];
}

function groupsFrom(candidates: readonly Candidate[]): Group[] {
  const groups = new Map<string, Group>();

  const consider = (candidate: Candidate, hub: 'source' | 'target') => {
    const hubSide = hub === 'source' ? candidate.sourceSide : candidate.targetSide;
    const farSide = hub === 'source' ? candidate.targetSide : candidate.sourceSide;
    // The routing brief's port rule: a clean fan has every branch arriving on
    // the face pointing back at the hub. A member whose far end resolves to
    // some other side is doing something else, and shouldn't be dragged into
    // this shape.
    if (farSide !== OPPOSITE[hubSide]) return;
    const hubId = hub === 'source' ? candidate.edge.source : candidate.edge.target;
    // Hub side *and* along-side position are both in the key, so every member
    // of a group provably leaves from one shared point — no anchor is ever
    // moved to make a bundle possible.
    const key = [
      hub,
      hubId,
      hubSide,
      hubOffset(candidate, hub).toFixed(3),
      compatibilityKey(candidate.edge),
    ].join(' ');
    const existing = groups.get(key);
    if (existing) existing.members.push(candidate);
    else groups.set(key, { key, hub, hubId, hubSide, members: [candidate] });
  };

  for (const candidate of candidates) {
    consider(candidate, 'source');
    consider(candidate, 'target');
  }

  return [...groups.values()].filter((group) => group.members.length >= MIN_SPINE_MEMBERS);
}

/**
 * Does an axis-aligned run from `(x1,y1)` to `(x2,y2)` pass through any
 * obstacle, allowing for the clearance a line should keep from a node it
 * merely passes near?
 */
function runBlocked(
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  obstacles: readonly Rect[],
  budget: { remaining: number },
): boolean {
  budget.remaining -= obstacles.length;
  const loX = Math.min(x1, x2) - TRUNK_OBSTACLE_MARGIN;
  const hiX = Math.max(x1, x2) + TRUNK_OBSTACLE_MARGIN;
  const loY = Math.min(y1, y2) - TRUNK_OBSTACLE_MARGIN;
  const hiY = Math.max(y1, y2) + TRUNK_OBSTACLE_MARGIN;
  return obstacles.some(
    (rect) => rect.x <= hiX && rect.x + rect.width >= loX && rect.y <= hiY && rect.y + rect.height >= loY,
  );
}

/**
 * Picks the trunk's distance from the hub, or `null` if no position works.
 * Prefers the middle of the available space — "where a developer would have
 * put it by hand" — then steps aside if a node is sitting there.
 *
 * Every run the bundle would draw is checked, not just the trunk: the stem out
 * of the hub, the trunk itself, and each member's branch. Checking only the
 * trunk is how the first version of this managed to dodge a node with the
 * trunk and then drive the stem — and the bundle's shared caption — straight
 * through it. When nothing clears, the honest answer is not to bundle at all:
 * each connector then routes independently and the existing single-detour
 * heuristic (`detourAround`) gets its usual crack at the obstacle. Not
 * crossing a node beats sharing a trunk.
 */
function planTrunkGap(
  hubRect: Rect,
  hubSide: Side,
  hubCross: number,
  members: readonly Candidate[],
  hub: 'source' | 'target',
  obstacles: readonly Rect[],
  budget: { remaining: number },
): { gap: number; corridor: number } | null {
  const outward = hubSide === 'right' || hubSide === 'bottom' ? 1 : -1;
  const start = hubFace(hubRect, hubSide);
  const verticalTrunk = isHorizontalSide(hubSide);

  // Where each branch leaves the trunk, and the face it runs in to.
  const branches = members.map((member) => ({
    cross: farCross(member, hub, verticalTrunk),
    face: nearFace(hub === 'source' ? member.targetRect : member.sourceRect, hubSide),
  }));
  // The nearest far node bounds the corridor: the trunk has to leave every
  // branch room to run in, so the closest destination is the one that decides.
  const nearest = Math.min(...branches.map((branch) => (branch.face - start) * outward));
  if (!Number.isFinite(nearest)) return null;
  const usable = nearest - MIN_BRANCH;
  if (usable < MIN_STEM) return null;

  const crossFrom = Math.min(hubCross, ...branches.map((branch) => branch.cross));
  const crossTo = Math.max(hubCross, ...branches.map((branch) => branch.cross));

  /** A point on the trunk axis, at `gap` from the hub, as real coordinates. */
  const at = (gap: number, cross: number) => {
    const coord = start + outward * gap;
    return verticalTrunk ? { x: coord, y: cross } : { x: cross, y: coord };
  };

  const blocked = (gap: number) => {
    const enter = at(gap, hubCross);
    const hubPoint = verticalTrunk ? { x: start, y: hubCross } : { x: hubCross, y: start };
    // The shared stem out of the hub.
    if (runBlocked(hubPoint.x, hubPoint.y, enter.x, enter.y, obstacles, budget)) return true;
    // The trunk itself, across the whole range its branches tap off over.
    const trunkLo = at(gap, crossFrom);
    const trunkHi = at(gap, crossTo);
    if (runBlocked(trunkLo.x, trunkLo.y, trunkHi.x, trunkHi.y, obstacles, budget)) return true;
    // And every branch's own run in to its far node.
    return branches.some((branch) => {
      const tap = at(gap, branch.cross);
      const end = verticalTrunk ? { x: branch.face, y: branch.cross } : { x: branch.cross, y: branch.face };
      return runBlocked(tap.x, tap.y, end.x, end.y, obstacles, budget);
    });
  };

  const first = Math.min(usable, Math.max(MIN_STEM, Math.round((nearest * TRUNK_BIAS) / TRUNK_QUANTUM) * TRUNK_QUANTUM));
  if (!blocked(first)) return { gap: first, corridor: nearest };
  // Walk outward and inward together, so the trunk lands on the nearest clear
  // position on either side rather than always drifting one way.
  for (let step = TRUNK_QUANTUM; step <= usable; step += TRUNK_QUANTUM) {
    if (budget.remaining <= 0) return null;
    for (const gap of [first + step, first - step]) {
      if (gap < MIN_STEM || gap > usable) continue;
      if (!blocked(gap)) return { gap, corridor: nearest };
    }
  }
  return null;
}

const planCache = new WeakMap<readonly DraftNode[], WeakMap<readonly DraftEdge[], RoutingPlan>>();

/**
 * Groups an edge set into shared routing trunks.
 *
 * Memoized on the `(nodes, edges)` array pair, the same way `laneIndex` is
 * memoized on `edges` alone — but with node identity in the key too, because
 * unlike a lane, a trunk's position depends on where the nodes actually are. A
 * node drag therefore re-plans once on commit rather than per frame, which is
 * exactly the intended cost model: the document isn't written during a drag.
 */
export function routingPlan(nodes: readonly DraftNode[], edges: readonly DraftEdge[]): RoutingPlan {
  const byNodes = planCache.get(nodes);
  const cached = byNodes?.get(edges);
  if (cached) return cached;

  const plan = computePlan(nodes, edges);
  if (byNodes) byNodes.set(edges, plan);
  else planCache.set(nodes, new WeakMap([[edges, plan]]));
  return plan;
}

function computePlan(nodes: readonly DraftNode[], edges: readonly DraftEdge[]): RoutingPlan {
  if (edges.length < MIN_SPINE_MEMBERS) return EMPTY_PLAN;

  const nodeMap = new Map(nodes.map((node) => [node.id, node]));
  const lanes = laneIndex(edges);
  const candidates: Candidate[] = [];

  for (const edge of edges) {
    // A connector the user has taken manual control of is left exactly alone —
    // "auto until touched".
    if (edge.routeMode === 'direct') continue;
    // Only the orthogonal style has a straight shared run to share.
    if (edge.routing !== 'smoothstep') continue;
    // A parallel sibling already nudges this edge's hub anchor off the shared
    // point (`laneNudge`), so it can't honestly claim to share a stem.
    if ((lanes.get(edge.id)?.offset ?? 0) !== 0) continue;
    const source = nodeMap.get(edge.source);
    const target = nodeMap.get(edge.target);
    if (!source || !target) continue;
    // A Junction is the user's own explicit routing point; bundling through
    // one would be second-guessing that. A boundary isn't a connection
    // endpoint in this sense either.
    if (source.type === 'ellipse' || target.type === 'ellipse') continue;
    if (source.type === 'group' || target.type === 'group') continue;
    const sourceRect = rectOf(source);
    const targetRect = rectOf(target);
    const sides = resolveSides(sourceRect, targetRect, {
      source: edge.sourceAnchor,
      target: edge.targetAnchor,
    });
    candidates.push({ edge, sourceRect, targetRect, sourceSide: sides.source, targetSide: sides.target });
  }

  if (candidates.length < MIN_SPINE_MEMBERS) return EMPTY_PLAN;

  // Boundaries are big translucent containers, not something a trunk should
  // detour around — the same rule both edge renderers already use for
  // per-edge obstacle avoidance.
  const obstacles = nodes
    .filter((node) => node.type !== 'group')
    .map((node) => ({ id: node.id, rect: rectOf(node) }));

  const members = new Map<string, readonly string[]>();
  const assigned = new Map<string, EdgeSpine>();

  // An edge can look like a fan-out member *and* a fan-in member. Larger
  // groups win, so the bundle that tidies more of the diagram is the one that
  // gets drawn; the key breaks ties, so the result never depends on iteration
  // order.
  const ordered = groupsFrom(candidates).sort(
    (a, b) => b.members.length - a.members.length || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0),
  );

  // Shared across every group this call considers — see `MAX_ROUTING_PLAN_OPS`.
  // Groups are sorted largest-first, so a budget cutoff mid-diagram still
  // bundles the fans that tidy the most lines before falling back.
  const budget = { remaining: MAX_ROUTING_PLAN_OPS };

  for (const group of ordered) {
    if (budget.remaining <= 0) break;
    const free = group.members.filter((candidate) => !assigned.has(candidate.edge.id));
    if (free.length < MIN_SPINE_MEMBERS) continue;

    const hubNode = nodeMap.get(group.hubId);
    if (!hubNode) continue;
    const hubRect = rectOf(hubNode);
    const verticalTrunk = isHorizontalSide(group.hubSide);

    const crosses = free.map((candidate) => farCross(candidate, group.hub, verticalTrunk));
    const crossFrom = Math.min(...crosses);
    const crossTo = Math.max(...crosses);
    // All at one height is a stack, not a fan — a trunk would add a corridor
    // and two bends to redraw what are already parallel straight lines.
    if (crossTo - crossFrom < MIN_FAN_SPREAD) continue;

    // Every member leaves the hub from the same point — that's what the group
    // key guarantees — so the stem's own cross-axis coordinate is just that
    // shared anchor's.
    const hubCross = verticalTrunk
      ? hubRect.y + hubRect.height * hubOffset(free[0]!, group.hub)
      : hubRect.x + hubRect.width * hubOffset(free[0]!, group.hub);

    // A member's own far node is where its branch terminates, not something to
    // route around; the hub likewise.
    const endpoints = new Set<string>([group.hubId]);
    for (const candidate of free) {
      endpoints.add(group.hub === 'source' ? candidate.edge.target : candidate.edge.source);
    }

    const placed = planTrunkGap(
      hubRect,
      group.hubSide,
      hubCross,
      free,
      group.hub,
      obstacles.filter((entry) => !endpoints.has(entry.id)).map((entry) => entry.rect),
      budget,
    );
    if (placed === null) continue;

    const spine: EdgeSpine = {
      id: group.key,
      hub: group.hub,
      hubSide: group.hubSide,
      trunkGap: placed.gap,
      corridor: placed.corridor,
      count: free.length,
    };
    members.set(
      spine.id,
      free
        .slice()
        .sort((a, b) => farCross(a, group.hub, verticalTrunk) - farCross(b, group.hub, verticalTrunk))
        .map((candidate) => candidate.edge.id),
    );
    for (const candidate of free) assigned.set(candidate.edge.id, spine);
  }

  if (assigned.size === 0) return EMPTY_PLAN;
  return {
    spineFor: (edgeId) => assigned.get(edgeId),
    membersOf: (spineId) => members.get(spineId) ?? EMPTY_MEMBERS,
  };
}
