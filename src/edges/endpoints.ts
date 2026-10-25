/**
 * Where the automatic ends of connectors sharing a side of a shape attach: spread apart instead of
 * stacked on one point.
 *
 * Every automatic end lands on its side's midpoint, so a shape with four connectors leaving its right
 * side drew four lines out of one point, overlapping until they parted. This plan gives each its own
 * point on the side, in the order their far ends lie along it — so they leave without crossing — and
 * keeps clear of what is fixed there: a pinned end, a trunk's shared stem, or a label shared by
 * several connectors leaving together (`labelGroups.ts`), which leave as one.
 *
 * - Ends sit `SPACING` apart where the side has room, closer (never under `MIN_SPACING`) where it
 *   hasn't, and never nearer a corner than `CORNER_CLEAR`. A reply line takes room beside its request.
 * - A side that still can't hold them hands its outermost ends to the neighbouring side facing their
 *   far ends, when that side faces them; what is left shares points, and the side is `crowded`.
 * - A side with one automatic end is left to the router, exactly as before: its midpoint, its lane,
 *   and straightened onto a line it obviously meant (`routing.ts`'s `levelOnto`).
 * - Straightening a spread end happens here, where its neighbours are known: only while it keeps its
 *   order and `MIN_SPACING` from them.
 *
 * Presentation, like trunks and line jumps: nothing here is saved, and a pin is never moved (the pin
 * contract in `routing.ts`). Built once per document change, memoized like `routingPlan`.
 */

import type { DraftEdge, DraftNode, EdgeAnchor, Side } from '../document/types';
import { routingPlan } from './bundles';
import { obstaclesForEdge } from './obstacles';
import { anchorPoint, flattenPath, laneIndex, rectOf, resolveSides, responseLaneFor, routeBetween, sideSpan, type Rect } from './routing';
import { stepPolyline } from './waypoints';
import { sameNodeGeometry, type PlanScope } from './sameGeometry';

/** Where a connector's automatic ends are drawn when the plan spread them; an end it left alone is absent. */
export interface EdgeSpread {
  source?: EdgeAnchor;
  target?: EdgeAnchor;
}

export interface EndpointPlan {
  spreadFor(edgeId: string): EdgeSpread | undefined;
  /** Node sides that could not give every end its own point: `nodeId:side`. */
  crowded: readonly string[];
}

/** How far apart spread ends sit, ideally — and the least they may. */
const SPACING = 16;
const SHRINK = [16, 12, 8] as const;
const MIN_SPACING = 8;
/** How near a corner an end may sit. */
const CORNER_CLEAR = 12;
/** How far a reply line sits beside its request, in pixels (`responseLaneFor`'s step × `LANE_SPACING`). */
const REPLY_ROOM = (responseLaneFor(0) - 0) * 10;
/** How far out of line a spread end is straightened onto its partner — `routing.ts`'s `NEAR_LEVEL`. */
const NEAR_LEVEL = 24;

const OPPOSITE: Record<Side, Side> = { top: 'bottom', bottom: 'top', left: 'right', right: 'left' };
const along = (side: Side) => (side === 'left' || side === 'right' ? 'y' : 'x');

interface End {
  edge: DraftEdge;
  role: 'source' | 'target';
  nodeId: string;
  rect: Rect;
  side: Side;
  /** The side it resolved to, before any overflow moved it to a neighbouring one. */
  home: Side;
  /** Where the far end is, on this side's axis: what orders ends along it. */
  far: number;
  /** A pinned end: its fixed point on the axis. */
  fixed?: number;
  /** Whether a reply line runs beside this end. */
  reply: boolean;
  /** Ends drawn as one (a trunk's stem, a shared label's start) share this key. */
  key: string;
  /** The far end's centre, to decide whether a neighbouring side faces it. */
  farCentre: { x: number; y: number };
  /** What routing the line the quick way needs, for the few ends where how it leaves matters. */
  line: { sourceRect: Rect; targetRect: Rect; obstacles: () => readonly Rect[]; lane: number };
}

/** One point on a side: one end, or several drawn as one. */
interface Occupant {
  key: string;
  ends: End[];
  fixed?: number;
  far: number;
  reply: boolean;
  farCentre: { x: number; y: number };
  /** The lane order, for ends whose far ends tie (parallel connectors between the same two shapes). */
  tie: string;
}

const EMPTY: EndpointPlan = { spreadFor: () => undefined, crowded: [] };
const cache = new WeakMap<readonly DraftNode[], WeakMap<readonly DraftEdge[], EndpointPlan>>();
const transientCache = new WeakMap<readonly DraftNode[], WeakMap<readonly DraftEdge[], EndpointPlan>>();
let last: { nodes: readonly DraftNode[]; edges: readonly DraftEdge[]; plan: EndpointPlan } | null = null;
/** The spread last handed out per edge, so an unchanged one keeps its identity across edits. */
const interned = new Map<string, EdgeSpread>();
const MAX_INTERNED = 8192;

export function endpointPlan(nodes: readonly DraftNode[], edges: readonly DraftEdge[], scope: PlanScope = 'canvas'): EndpointPlan {
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

function intern(edgeId: string, spread: EdgeSpread, scope: PlanScope): EdgeSpread {
  if (scope !== 'canvas') return spread;
  const before = interned.get(edgeId);
  const same = (a?: EdgeAnchor, b?: EdgeAnchor) => a?.side === b?.side && a?.offset === b?.offset;
  if (before && same(before.source, spread.source) && same(before.target, spread.target)) return before;
  if (interned.size >= MAX_INTERNED) interned.clear();
  interned.set(edgeId, spread);
  return spread;
}

/** Everything that has to match for connectors leaving one shape to share one label — `labelGroups.ts`'s rule. */
export function labelLook(edge: DraftEdge): string | null {
  if (!edge.label?.trim() || edge.condition || edge.hasResponse || edge.response || edge.attachments?.length) return null;
  return JSON.stringify([edge.label.trim(), edge.kind ?? null, Boolean(edge.async), edge.semantic ?? null, edge.directed, edge.routing, edge.accent ?? null]);
}

function compute(nodes: readonly DraftNode[], edges: readonly DraftEdge[], scope: PlanScope): EndpointPlan {
  if (edges.length < 2) return EMPTY;
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const spines = routingPlan(nodes, edges, scope);
  const lanes = laneIndex(edges);
  const sides = new Map<string, End[]>();
  const add = (end: End) => {
    const at = `${end.nodeId}:${end.side}`;
    const list = sides.get(at);
    if (list) list.push(end);
    else sides.set(at, [end]);
  };
  for (const edge of edges) {
    // Bent connectors face their bends and stay as drawn.
    if (edge.waypoints?.length) continue;
    const source = byId.get(edge.source);
    const target = byId.get(edge.target);
    if (!source || !target || source.type === 'group' || target.type === 'group') continue;
    const sourceRect = rectOf(source);
    const targetRect = rectOf(target);
    const resolved = resolveSides(sourceRect, targetRect, { source: edge.sourceAnchor, target: edge.targetAnchor });
    const spine = spines.spineFor(edge.id);
    const look = labelLook(edge);
    const obstaclesOf = () => obstaclesForEdge(nodes, edge.source, edge.target, scope);
    for (const role of ['source', 'target'] as const) {
      const [rect, otherRect, side, anchor, nodeId] = role === 'source'
        ? [sourceRect, targetRect, resolved.source, edge.sourceAnchor, edge.source]
        : [targetRect, sourceRect, resolved.target, edge.targetAnchor, edge.target];
      const axis = along(side);
      const farCentre = { x: otherRect.x + otherRect.width / 2, y: otherRect.y + otherRect.height / 2 };

      const hub = spine && spine.hub === role;
      const key = hub ? `spine:${spine.id}` : role === 'source' && look ? `label:${edge.source}:${side}:${look}` : `edge:${edge.id}:${role}`;
      add({
        edge,
        role,
        nodeId,
        rect,
        side,
        home: side,
        far: farCentre[axis],
        // A trunk's automatic stem moves like any automatic end — all its connectors with it, as one.
        fixed: anchor ? anchorPoint(rect, side, anchor.offset)[axis] : undefined,
        reply: Boolean(edge.hasResponse),
        key,
        farCentre,
        line: { sourceRect, targetRect, obstacles: obstaclesOf, lane: lanes.get(edge.id)?.offset ?? 0 },
      });
    }
  }

  // What is placed where: an end's side (it may move to a neighbouring one) and its point on it.
  const placed = new Map<End, { side: Side; at: number }>();
  const crowded: string[] = [];
  const groups = [...sides.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const overflowed = new Map<string, End[]>();

  // First pass: hand a full side's outermost ends to a neighbouring side that faces their far ends.
  for (const [, ends] of groups) {
    const occupants = occupantsOf(ends);
    const movers = occupants.filter((o) => o.fixed === undefined);
    if (movers.length < 2) continue;
    const first = ends[0]!;
    const span = bandOf(first.rect, first.side);
    const room = Math.floor(Math.max(0, span.length) / MIN_SPACING) + 1 - occupants.filter((o) => o.fixed !== undefined).length;
    let excess = movers.length - Math.max(1, room);
    if (excess <= 0) continue;
    const ordered = [...movers].sort(byOrder);
    const [low, high] = first.side === 'left' || first.side === 'right' ? (['top', 'bottom'] as const) : (['left', 'right'] as const);
    while (excess > 0 && ordered.length > 1) {
      // Alternate ends: the first (lowest far end) to the low side, the last to the high one.
      const takeLow = excess % 2 === 1;
      const mover = takeLow ? ordered[0]! : ordered[ordered.length - 1]!;
      const to = takeLow ? low : high;
      if (!faces(first.rect, to, mover.farCentre)) break;
      (takeLow ? ordered.shift() : ordered.pop());
      for (const end of mover.ends) {
        const moved = { ...end, side: to, far: end.farCentre[along(to)] };
        const key = `${end.nodeId}:${to}`;
        const list = overflowed.get(key);
        if (list) list.push(moved);
        else overflowed.set(key, [moved]);
        // The original end no longer sits on this side.
        ends.splice(ends.indexOf(end), 1);
      }
      excess -= 1;
    }
  }
  for (const [key, moved] of overflowed) {
    const list = sides.get(key);
    if (list) list.push(...moved);
    else sides.set(key, moved);
  }

  // Second pass: place every side's occupants.
  for (const [at, ends] of [...sides.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    if (ends.length === 0) continue;
    const occupants = occupantsOf(ends);
    sharePins(occupants, ends[0]!, placed);
    const movers = occupants.filter((o) => o.fixed === undefined);
    // One automatic end, nothing to keep clear of: the router places it as it always has.
    const sideMoved = ends.some((end) => end.side !== end.home);
    if (movers.length === 0 || (occupants.length === 1 && !sideMoved)) continue;
    const first = ends[0]!;
    const band = bandOf(first.rect, first.side);
    const result = placeOnSide(occupants, band);
    if (result.crowded) crowded.push(at);
    for (const [occupant, position] of result.positions) {
      for (const end of occupant.ends) placed.set(end, { side: end.side, at: position });
    }
  }

  straighten(placed, sides);

  const spreads = new Map<string, EdgeSpread>();
  for (const [end, { side, at }] of placed) {
    // A pin is reported only when it shares its point with others and has been spread within its band.
    if (end.fixed !== undefined && Math.abs(at - end.fixed) < 0.01) continue;
    const span = sideSpan(end.rect, side);
    const offset = span.length ? (at - span.start) / span.length : 0.5;
    const spread = spreads.get(end.edge.id) ?? {};
    spread[end.role] = { side, offset: Math.min(1, Math.max(0, offset)) };
    spreads.set(end.edge.id, spread);
  }
  if (spreads.size === 0 && crowded.length === 0) return EMPTY;
  const handed = new Map<string, EdgeSpread>();
  for (const [id, spread] of spreads) handed.set(id, intern(id, spread, scope));
  return planOf(handed, crowded);
}

/** Built outside `compute`, so the plan keeps the answers and none of the working state. */
function planOf(spreads: ReadonlyMap<string, EdgeSpread>, crowded: readonly string[]): EndpointPlan {
  return { spreadFor: (edgeId) => spreads.get(edgeId), crowded };
}

const byOrder = (a: Occupant, b: Occupant) => a.far - b.far || (a.tie < b.tie ? -1 : a.tie > b.tie ? 1 : 0);

function occupantsOf(ends: readonly End[]): Occupant[] {
  const byKey = new Map<string, Occupant>();
  for (const end of ends) {
    const existing = byKey.get(end.key);
    if (existing) {
      existing.ends.push(end);
      existing.far = (existing.far * (existing.ends.length - 1) + end.far) / existing.ends.length;
      existing.reply ||= end.reply;
      continue;
    }
    byKey.set(end.key, { key: end.key, ends: [end], fixed: end.fixed, far: end.far, reply: end.reply, farCentre: end.farCentre, tie: `${end.edge.id}:${end.role}` });
  }
  return [...byKey.values()];
}

/** How far a pin may be spread from its point when others share it: ⅜ of the gap between two
 *  handles — the pin contract in `routing.ts` (`PIN_SPREAD`). */
const PIN_SHARE = 0.375 * 0.25;

/**
 * Pins several connectors placed on the very same point, spread around it in far-end order so they
 * don't draw one line — never further than `PIN_SHARE` of the side from it.
 */
function sharePins(occupants: readonly Occupant[], first: End, placed: Map<End, { side: Side; at: number }>): void {
  const byPoint = new Map<number, Occupant[]>();
  for (const o of occupants) {
    if (o.fixed === undefined) continue;
    const at = Math.round(o.fixed * 2) / 2;
    const list = byPoint.get(at);
    if (list) list.push(o);
    else byPoint.set(at, [o]);
  }
  const limit = sideSpan(first.rect, first.side).length * PIN_SHARE;
  for (const [at, all] of byPoint) {
    if (all.length < 2) continue;
    // How each line actually leaves — its quick route, before any spreading: how far it runs out of
    // the point and which way it first turns. Lines that part straight after the stub don't read as
    // one, and only those running on together are spread.
    const leaving = all.map((o) => ({ o, ...leavingOf(o.ends[0]!) }));
    const shared = leaving.filter((l) => l.leg > SHARED_RUN);
    if (shared.length < 2) continue;
    // Which way each turns first, then nested: of two turning the same way, the one that turns
    // sooner goes on the outside of that turn, so neither crosses the other.
    const ordered = shared
      .sort((a, b) => a.turn - b.turn || (a.turn < 0 ? a.leg - b.leg : b.leg - a.leg) || byOrder(a.o, b.o))
      .map((l) => l.o);
    // A line that runs straight out of the point and on to its far end keeps the point — moving it
    // would put a step in a straight line; the rest spread round it. Otherwise they centre on it.
    const straight = ordered.findIndex((o) => leaving.find((l) => l.o === o)!.turn === 0);
    const pivot = straight >= 0 ? straight : (ordered.length - 1) / 2;
    const reach = Math.max(pivot, ordered.length - 1 - pivot);
    const step = Math.min(SPACING, reach > 0 ? limit / reach : SPACING);
    ordered.forEach((o, i) => {
      const position = at + (i - pivot) * step;
      for (const end of o.ends) placed.set(end, { side: end.side, at: position });
    });
  }
}

/** Two lines leaving one point read as one past this — the agent's `SHARED_RUN`. */
const SHARED_RUN = 30;

/** How an end's line leaves it, drawn the quick way: how far it runs straight out, and which way
 *  (−1, 0, +1 along the side) it first turns. */
function leavingOf(end: End): { leg: number; turn: number } {
  const { edge, line } = end;
  const route = routeBetween(line.sourceRect, line.targetRect, edge.routing, {
    anchors: { source: edge.sourceAnchor, target: edge.targetAnchor },
    lane: line.lane,
    obstacles: line.obstacles(),
    mode: 'gesture',
  });
  const corners = edge.routing === 'smoothstep' ? stepPolyline(route.d) : flattenPath(route.d);
  const out = end.role === 'source' ? corners : [...corners].reverse();
  if (out.length < 2) return { leg: 0, turn: 0 };
  const [a, b] = [out[0]!, out[1]!];
  const leg = Math.hypot(b.x - a.x, b.y - a.y);
  const next = out[2];
  const axis = along(end.side);
  return { leg, turn: next ? Math.sign(next[axis] - b[axis]) : 0 };
}

/** Where on a side ends may sit: its anchor span, kept `CORNER_CLEAR` from each corner. */
function bandOf(rect: Rect, side: Side): { start: number; length: number; centre: number } {
  const span = sideSpan(rect, side);
  const centre = span.start + span.length / 2;
  if (span.length < 2 * CORNER_CLEAR) return { start: centre, length: 0, centre };
  return { start: span.start + CORNER_CLEAR, length: span.length - 2 * CORNER_CLEAR, centre };
}

/** Whether `side` of `rect` looks towards `point`. */
function faces(rect: Rect, side: Side, point: { x: number; y: number }): boolean {
  switch (side) {
    case 'right': return point.x > rect.x + rect.width;
    case 'left': return point.x < rect.x;
    case 'top': return point.y < rect.y;
    case 'bottom': return point.y > rect.y + rect.height;
  }
}

/**
 * Points for every occupant of one side. Fixed ones stay; the rest, in far-end order, are packed into
 * the gaps between them — each run centred on the side's middle where its gap holds it — at the widest
 * spacing that fits every gap.
 */
function placeOnSide(occupants: readonly Occupant[], band: { start: number; length: number; centre: number }): { positions: Map<Occupant, number>; crowded: boolean } {
  const positions = new Map<Occupant, number>();
  const fixed = occupants.filter((o) => o.fixed !== undefined).sort((a, b) => a.fixed! - b.fixed!);
  for (const o of fixed) positions.set(o, o.fixed!);
  const movers = occupants.filter((o) => o.fixed === undefined).sort(byOrder);
  // Each mover goes into the gap after the last fixed occupant whose far end lies before its own.
  const runs: Occupant[][] = Array.from({ length: fixed.length + 1 }, () => []);
  for (const mover of movers) {
    let gap = 0;
    while (gap < fixed.length && fixed[gap]!.far <= mover.far) gap += 1;
    runs[gap]!.push(mover);
  }
  const lo = band.start;
  const hi = band.start + band.length;
  const gaps = runs.map((_, i) => ({
    from: i === 0 ? lo : fixed[i - 1]!.fixed! + (fixed[i - 1]!.reply ? REPLY_ROOM : 0),
    to: i === fixed.length ? hi : fixed[i]!.fixed!,
    // A run beside a fixed occupant keeps a spacing from it, not just from its neighbours.
    openFrom: i > 0,
    openTo: i < fixed.length,
  }));
  const spanOf = (run: readonly Occupant[], spacing: number) => run.reduce((sum, _o, i) => sum + (i ? spacing : 0) + (i && run[i - 1]!.reply ? REPLY_ROOM : 0), 0) + (run.at(-1)?.reply ? REPLY_ROOM : 0);
  const fits = (spacing: number) => runs.every((run, i) => {
    if (run.length === 0) return true;
    const g = gaps[i]!;
    const room = g.to - g.from - (g.openFrom ? spacing : 0) - (g.openTo ? spacing : 0);
    return spanOf(run, spacing) <= room + 1e-9;
  });
  const spacing = SHRINK.find(fits);
  for (let i = 0; i < runs.length; i += 1) {
    const run = runs[i]!;
    if (run.length === 0) continue;
    const g = gaps[i]!;
    const step = spacing ?? MIN_SPACING;
    const from = g.from + (g.openFrom ? step : 0);
    const to = g.to - (g.openTo ? step : 0);
    const width = spanOf(run, step);
    // Centred on the side's middle when the gap allows it, else on the gap's.
    const middle = from <= band.centre && band.centre <= to ? band.centre : (from + to) / 2;
    let at = Math.max(from, Math.min(middle - width / 2, to - width));
    if (to - from < width) at = from + (to - from - width) / 2;
    for (let k = 0; k < run.length; k += 1) {
      if (k) at += step + (run[k - 1]!.reply ? REPLY_ROOM : 0);
      positions.set(run[k]!, Math.max(lo, Math.min(hi, at)));
    }
  }
  return { positions, crowded: spacing === undefined };
}

/**
 * Straightens a spread end onto its partner when the two are nearly level across facing sides —
 * `routing.ts`'s `levelOnto`, with the neighbours in view: only while the end stays in its band, in
 * its order, and `MIN_SPACING` from every other end on the side.
 */
function straighten(placed: Map<End, { side: Side; at: number }>, sides: ReadonlyMap<string, End[]>): void {
  const partnerOf = new Map<string, Map<'source' | 'target', End>>();
  for (const end of placed.keys()) {
    const pair = partnerOf.get(end.edge.id) ?? new Map();
    pair.set(end.role, end);
    partnerOf.set(end.edge.id, pair);
  }
  const pointOf = (end: End, side: Side) => {
    const known = placed.get(end);
    if (known) return known.at;
    const anchor = end.role === 'source' ? end.edge.sourceAnchor : end.edge.targetAnchor;
    return anchorPoint(end.rect, side, anchor?.offset ?? 0.5)[along(side)];
  };
  const ordered = [...placed.keys()].sort((a, b) => (a.edge.id < b.edge.id ? -1 : a.edge.id > b.edge.id ? 1 : a.role < b.role ? -1 : 1));
  for (const end of ordered) {
    if (end.fixed !== undefined || end.reply) continue;
    const mine = placed.get(end)!;
    // The target moves when it can; the source only when the target can't.
    const pair = partnerOf.get(end.edge.id);
    if (end.role === 'source' && pair?.get('target') && pair.get('target')!.fixed === undefined) continue;
    const partnerRole = end.role === 'source' ? 'target' : 'source';
    const partner = pair?.get(partnerRole) ?? findEnd(sides, end.edge, partnerRole);
    if (!partner) continue;
    const partnerSide = placed.get(partner)?.side ?? partner.side;
    if (partnerSide !== OPPOSITE[mine.side]) continue;
    const goal = pointOf(partner, partnerSide);
    if (Math.abs(goal - mine.at) > NEAR_LEVEL || Math.abs(goal - mine.at) < 0.01) continue;
    const band = bandOf(end.rect, mine.side);
    if (goal < band.start || goal > band.start + band.length) continue;
    const neighbours = [...placed.entries()].filter(([other, where]) => other !== end && other.nodeId === end.nodeId && where.side === mine.side && other.key !== end.key);
    const keepsOrder = neighbours.every(([, where]) => Math.sign(where.at - mine.at) === Math.sign(where.at - goal) || where.at === mine.at);
    const keepsRoom = neighbours.every(([, where]) => Math.abs(where.at - goal) >= MIN_SPACING);
    if (keepsOrder && keepsRoom) placed.set(end, { side: mine.side, at: goal });
  }
}

function findEnd(sides: ReadonlyMap<string, End[]>, edge: DraftEdge, role: 'source' | 'target'): End | undefined {
  for (const ends of sides.values()) {
    const found = ends.find((end) => end.edge === edge && end.role === role);
    if (found) return found;
  }
  return undefined;
}

export { SPACING as ENDPOINT_SPACING, MIN_SPACING as ENDPOINT_MIN_SPACING };
