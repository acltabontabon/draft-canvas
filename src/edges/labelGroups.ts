/**
 * One label for connectors that leave together.
 *
 * Two connectors from one shape, both labelled "Pay Credit Card", often run as one line for a while —
 * out of the same side, along the same stretch — before each turns off toward its own target. Each
 * then drew its own copy of the label, stacked on or beside the other, on a run that visibly is one
 * line. This finds those connectors and the stretch they share, and names one place on it for a
 * single label. It is presentation only, like the bundles in `bundles.ts`: every connector keeps its
 * own label, endpoints and everything else in the document, and nothing here is saved.
 *
 * A group is formed only when the answer is unambiguous, and otherwise the connectors simply keep
 * their own labels:
 *
 * - the same source, the same non-empty label, and the same look and meaning (kind, async, semantic,
 *   arrowhead, line style, colour) — so the one label says one true thing about all of them;
 * - a route that is genuinely shared *from the source*, measured along both lines — not the same
 *   side, not a crossing or an overlap further along;
 * - a straight stretch of that shared run long enough for the label, clear of the shape it leaves,
 *   of bends and of where the lines part;
 * - nothing else running there: another connector on the same stretch (unlabelled, or labelled
 *   differently) would seem to carry the label too;
 * - room: the label may not land on a shape or on another connector's label.
 *
 * Built once per document change for the whole diagram and cached on the node and edge arrays, the
 * way `crossingPlan` is, so a connector asks `groupFor(id)` on every render for nothing.
 */
import type { DraftEdge, DraftNode } from '../document/types';
import { routingPlan } from './bundles';
import { LABEL_PADDING_X, LABEL_PADDING_Y, layoutEdgeLabel } from './labelLayout';
import { distanceToPolyline, type Point } from './nearest';
import { obstaclesForEdge } from './obstacles';
import {
  LABEL_BEND_CLEARANCE,
  LABEL_LINE_GAP,
  flattenPath,
  labelLaneOffset,
  laneIndex,
  rectOf,
  routeBetween,
  type Rect,
  type Side,
} from './routing';

export interface LabelGroup {
  /** Stable for as long as the group stands: its source and members. */
  key: string;
  /** The connectors sharing the label, in a fixed order (top to bottom, then left to right, by target). */
  members: readonly string[];
  /** The label's point on the shared line, and which side of the line its chip sits. */
  x: number;
  y: number;
  side: Side;
  /** How far along the shared run, from where the connectors leave their source, that point is. A
   *  connector being dragged reroutes live; it keeps its label this far along its own line. */
  distance: number;
}

export interface LabelGroupPlan {
  groupFor(edgeId: string): LabelGroup | undefined;
}

/** Two routes this close count as the same line. */
const SAME_LINE = 0.75;
/** How finely two routes are compared, along their length. */
const STEP = 2;
/** Another connector this close to where the label goes would look as though it carried it too. */
const CROWDED = 4;
/** How far past its ends' box a connector's route (a detour, a label) may reach. */
const NEARBY = 120;

interface Poly {
  points: Point[];
  /** Cumulative length at each point. */
  at: number[];
  length: number;
}

function polyOf(d: string): Poly | null {
  const points = flattenPath(d).map(({ x, y }) => ({ x, y }));
  if (points.length < 2) return null;
  const at = [0];
  for (let i = 1; i < points.length; i += 1) at.push(at[i - 1]! + Math.hypot(points[i]!.x - points[i - 1]!.x, points[i]!.y - points[i - 1]!.y));
  return { points, at, length: at[at.length - 1]! };
}

function pointAt(poly: Poly, distance: number): Point {
  const { points, at } = poly;
  if (distance <= 0) return points[0]!;
  for (let i = 1; i < points.length; i += 1) {
    if (at[i]! >= distance) {
      const span = at[i]! - at[i - 1]!;
      const t = span === 0 ? 0 : (distance - at[i - 1]!) / span;
      return { x: points[i - 1]!.x + (points[i]!.x - points[i - 1]!.x) * t, y: points[i - 1]!.y + (points[i]!.y - points[i - 1]!.y) * t };
    }
  }
  return points[points.length - 1]!;
}

/** How far two routes from the same point run as one line before they part. */
function sharedLength(a: Poly, b: Poly): number {
  const max = Math.min(a.length, b.length);
  const same = (s: number) => {
    const p = pointAt(a, s);
    const q = pointAt(b, s);
    return Math.hypot(p.x - q.x, p.y - q.y) <= SAME_LINE;
  };
  if (!same(0)) return 0;
  let shared = 0;
  while (shared + STEP <= max && same(shared + STEP)) shared += STEP;
  return shared;
}

/** The straight runs of a route that lie within its first `limit` units: where a label can sit. */
function straightRuns(poly: Poly, limit: number): { from: number; to: number; horizontal: boolean }[] {
  const runs: { from: number; to: number; dx: number; dy: number }[] = [];
  for (let i = 1; i < poly.points.length && poly.at[i - 1]! < limit; i += 1) {
    const dx = poly.points[i]!.x - poly.points[i - 1]!.x;
    const dy = poly.points[i]!.y - poly.points[i - 1]!.y;
    const length = Math.hypot(dx, dy);
    if (length === 0) continue;
    const last = runs[runs.length - 1];
    const lastLength = last ? Math.hypot(last.dx, last.dy) : 0;
    if (last && last.to === poly.at[i - 1] && (last.dx * dx + last.dy * dy) / (lastLength * length) > 0.9995) {
      last.to = poly.at[i]!;
      last.dx += dx;
      last.dy += dy;
    } else {
      runs.push({ from: poly.at[i - 1]!, to: poly.at[i]!, dx, dy });
    }
  }
  return runs.map((run) => ({ from: run.from, to: Math.min(run.to, limit), horizontal: Math.abs(run.dx) >= Math.abs(run.dy) }));
}

/** The label chip's box, anchored the way `DraftEdgeView`'s `labelChipTransform` and the exporter's
 *  `labelChipRect` anchor it. */
export function labelChipBox(side: Side, x: number, y: number, w: number, h: number): Rect {
  switch (side) {
    case 'right':
      return { x: x + LABEL_LINE_GAP - LABEL_PADDING_X, y: y - h / 2, width: w, height: h };
    case 'left':
      return { x: x - LABEL_LINE_GAP + LABEL_PADDING_X - w, y: y - h / 2, width: w, height: h };
    case 'top':
      return { x: x - w / 2, y: y - LABEL_LINE_GAP + LABEL_PADDING_Y - h, width: w, height: h };
    case 'bottom':
      return { x: x - w / 2, y: y + LABEL_LINE_GAP - LABEL_PADDING_Y, width: w, height: h };
  }
}

function regionOf(poly: Poly): Rect {
  const xs = poly.points.map((point) => point.x);
  const ys = poly.points.map((point) => point.y);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y };
}

function overlaps(a: Rect, b: Rect, margin = 0): boolean {
  return a.x < b.x + b.width + margin && b.x < a.x + a.width + margin && a.y < b.y + b.height + margin && b.y < a.y + a.height + margin;
}

/** Everything that has to match for one label to speak for several connectors. */
function lookOf(edge: DraftEdge): string {
  return JSON.stringify([edge.label!.trim(), edge.kind ?? null, Boolean(edge.async), edge.semantic ?? null, edge.directed, edge.routing, edge.accent ?? null]);
}

/**
 * Only a connector whose label is its only chip: a condition, a reply label, attachments, a request/
 * response pair all hang off the label's point too, and moving the label would strand them.
 */
function eligible(edge: DraftEdge): boolean {
  return Boolean(edge.label?.trim()) && !edge.condition && !edge.hasResponse && !edge.response && !edge.attachments?.length;
}

interface Routed {
  edge: DraftEdge;
  poly: Poly;
  /** Its own label's chip, where it would draw it alone — for the room check. */
  chip?: Rect;
}

function compute(nodes: readonly DraftNode[], edges: readonly DraftEdge[]): Map<string, LabelGroup> {
  const found = new Map<string, LabelGroup>();
  const buckets = new Map<string, DraftEdge[]>();
  for (const edge of edges) {
    if (!eligible(edge)) continue;
    const key = `${edge.source} ${lookOf(edge)}`;
    const bucket = buckets.get(key);
    if (bucket) bucket.push(edge);
    else buckets.set(key, [edge]);
  }
  const candidates = [...buckets.values()].filter((bucket) => bucket.length >= 2);
  if (candidates.length === 0) return found;

  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const lanes = laneIndex(edges);
  const plan = routingPlan(nodes, edges);
  const routed = new Map<string, Routed | null>();
  // Routed exactly as both renderers route it, and only when something asks.
  const route = (edge: DraftEdge): Routed | null => {
    if (routed.has(edge.id)) return routed.get(edge.id)!;
    const source = nodeById.get(edge.source);
    const target = nodeById.get(edge.target);
    let result: Routed | null = null;
    if (source && target) {
      const lane = lanes.get(edge.id)?.offset ?? 0;
      const drawn = routeBetween(rectOf(source), rectOf(target), edge.routing, {
        anchors: { source: edge.sourceAnchor, target: edge.targetAnchor },
        lane,
        obstacles: obstaclesForEdge(nodes, edge.source, edge.target),
        spine: plan.spineFor(edge.id),
      });
      const poly = polyOf(drawn.d);
      if (poly) {
        let chip: Rect | undefined;
        if (edge.label?.trim()) {
          const layout = layoutEdgeLabel(edge.label);
          const nudge = labelLaneOffset(drawn.source.side, drawn.target.side, lane);
          chip = labelChipBox(drawn.labelSide, drawn.labelX + nudge.x, drawn.labelY + nudge.y, layout.width + LABEL_PADDING_X * 2, layout.height + LABEL_PADDING_Y * 2);
        }
        result = { edge, poly, chip };
      }
    }
    routed.set(edge.id, result);
    return result;
  };
  const shapes = nodes.filter((node) => node.type !== 'group').map(rectOf);

  for (const bucket of candidates) {
    const members = bucket.map(route).filter((entry): entry is Routed => entry !== null);
    // Grown greedily from the pair that shares the most: a third connector joins only if it shares
    // enough with every member already in, so the run the label sits on is common to all of them.
    const pending = new Set(members);
    while (pending.size >= 2) {
      const list = [...pending];
      let best: { a: Routed; b: Routed; shared: number } | null = null;
      for (let i = 0; i < list.length; i += 1) {
        for (let j = i + 1; j < list.length; j += 1) {
          const shared = sharedLength(list[i]!.poly, list[j]!.poly);
          if (!best || shared > best.shared) best = { a: list[i]!, b: list[j]!, shared };
        }
      }
      if (!best || best.shared <= 0) break;
      const group = [best.a, best.b];
      let shared = best.shared;
      for (const other of list) {
        if (group.includes(other)) continue;
        const common = Math.min(...group.map((member) => sharedLength(member.poly, other.poly)));
        const placed = common > 0 && place(group[0]!, Math.min(shared, common), others(group.concat(other)));
        if (placed) {
          group.push(other);
          shared = Math.min(shared, common);
        }
      }
      for (const member of group) pending.delete(member);
      const at = place(group[0]!, shared, others(group));
      if (!at) continue;
      const ordered = group
        .map((member) => ({ id: member.edge.id, target: nodeById.get(member.edge.target)! }))
        .sort((a, b) => a.target.y - b.target.y || a.target.x - b.target.x || (a.id < b.id ? -1 : 1))
        .map((member) => member.id);
      const labelGroup: LabelGroup = { key: `${group[0]!.edge.source}:${ordered.join(',')}`, members: ordered, ...at };
      for (const id of ordered) found.set(id, labelGroup);
    }
  }
  return found;

  /**
   * The connectors not in `group` that could come near its shared run: what the label must not seem
   * to belong to, or land on. Only those whose two shapes lie near the run are routed at all — a
   * connector's route stays close to the box around its ends — so a large diagram isn't routed
   * whole for a label that sits in one corner of it.
   */
  function others(group: Routed[]): Routed[] {
    const ids = new Set(group.map((member) => member.edge.id));
    const near = regionOf(group[0]!.poly);
    return edges
      .filter((edge) => {
        if (ids.has(edge.id)) return false;
        const source = nodeById.get(edge.source);
        const target = nodeById.get(edge.target);
        if (!source || !target) return false;
        const x = Math.min(source.x, target.x);
        const y = Math.min(source.y, target.y);
        const box = { x, y, width: Math.max(source.x + source.width, target.x + target.width) - x, height: Math.max(source.y + source.height, target.y + target.height) - y };
        return overlaps(box, near, NEARBY);
      })
      .map(route)
      .filter((entry): entry is Routed => entry !== null);
  }

  /** Where on the first `shared` units of `lead`'s route one label fits, or `null` when nowhere does. */
  function place(lead: Routed, shared: number, rest: Routed[]): Omit<LabelGroup, 'key' | 'members'> | null {
    const layout = layoutEdgeLabel(lead.edge.label!);
    const w = layout.width + LABEL_PADDING_X * 2;
    const h = layout.height + LABEL_PADDING_Y * 2;
    const spots = straightRuns(lead.poly, shared)
      .map((run) => {
        // The chip spans its width along a horizontal run, its height along a vertical one, and keeps
        // clear of the shape the run leaves, of the bend or parting at its far end, and of its near end.
        const extent = run.horizontal ? w : h;
        const from = run.from + LABEL_BEND_CLEARANCE;
        const to = run.to - LABEL_BEND_CLEARANCE;
        return { run, extent, from, to, room: to - from - extent };
      })
      .filter((spot) => spot.room >= 0)
      .sort((a, b) => b.room - a.room);
    for (const spot of spots) {
      const distance = (spot.from + spot.to) / 2;
      const point = pointAt(lead.poly, distance);
      // Anyone else on this stretch of line would seem to carry the label as well.
      const crowded = rest.some((other) => {
        for (let s = distance - spot.extent / 2; s <= distance + spot.extent / 2; s += STEP * 2) {
          const probe = pointAt(lead.poly, s);
          if ((distanceToPolyline(probe, other.poly.points) ?? Infinity) <= CROWDED) return true;
        }
        return false;
      });
      if (crowded) continue;
      const sides: Side[] = spot.run.horizontal ? ['top', 'bottom'] : ['right', 'left'];
      for (const side of sides) {
        const chip = labelChipBox(side, point.x, point.y, w, h);
        if (shapes.some((shape) => overlaps(chip, shape, 2))) continue;
        if (rest.some((other) => other.chip && overlaps(chip, other.chip, 2))) continue;
        return { x: point.x, y: point.y, side, distance };
      }
    }
    return null;
  }
}

const EMPTY: Map<string, LabelGroup> = new Map();
const cache = new WeakMap<readonly DraftNode[], WeakMap<readonly DraftEdge[], LabelGroupPlan>>();
/** The groups of the last plan built, so a group that came out the same keeps its identity — a
 *  connector subscribed to its group then doesn't re-render for an edit that changed nothing about it. */
let lastGroups: Map<string, LabelGroup> = EMPTY;

function intern(groups: Map<string, LabelGroup>): Map<string, LabelGroup> {
  if (groups.size === 0) return EMPTY;
  const byKey = new Map<string, LabelGroup>();
  for (const group of lastGroups.values()) byKey.set(group.key, group);
  const out = new Map<string, LabelGroup>();
  const kept = new Map<LabelGroup, LabelGroup>();
  for (const [id, group] of groups) {
    let chosen = kept.get(group);
    if (!chosen) {
      const previous = byKey.get(group.key);
      chosen =
        previous && previous.x === group.x && previous.y === group.y && previous.side === group.side && previous.distance === group.distance
          ? previous
          : group;
      kept.set(group, chosen);
    }
    out.set(id, chosen);
  }
  return out;
}

function planOf(groups: Map<string, LabelGroup>): LabelGroupPlan {
  return { groupFor: (edgeId) => groups.get(edgeId) };
}

/** Which connectors share one label, for the whole document (or an export's subset of it). */
export function labelGroupPlan(nodes: readonly DraftNode[], edges: readonly DraftEdge[]): LabelGroupPlan {
  const byNodes = cache.get(nodes);
  const cached = byNodes?.get(edges);
  if (cached) return cached;
  const groups = intern(compute(nodes, edges));
  lastGroups = groups;
  const plan = planOf(groups);
  if (byNodes) byNodes.set(edges, plan);
  else cache.set(nodes, new WeakMap([[edges, plan]]));
  return plan;
}

/**
 * Which member draws the shared label right now: the one the person is working with, so the label
 * they click, edit or watch is that connector's. A selected member first; then, in Presentation, the
 * step being explained (or one already shown); otherwise the first member.
 */
export function labelLeader(
  group: LabelGroup,
  { selectedEdges, tierOf }: { selectedEdges: readonly string[]; tierOf?: (id: string) => 'active' | 'shown' | 'hidden' | undefined },
): string {
  if (selectedEdges.length > 0) {
    const selected = group.members.find((id) => selectedEdges.includes(id));
    if (selected) return selected;
  }
  if (tierOf) {
    const active = group.members.find((id) => tierOf(id) === 'active') ?? group.members.find((id) => tierOf(id) === 'shown');
    if (active) return active;
  }
  return group.members[0]!;
}

/** A point `distance` along a route's `d` — where a group's label sits on a member's live line. */
export function pointAlong(d: string, distance: number): Point | null {
  const poly = polyOf(d);
  return poly ? pointAt(poly, distance) : null;
}
