import { categoryOf } from '../document/connectorSemantics';
import { anchorBandOf, bandWords, type AnchorBand } from '../document/queueGeometry';
import type { DraftEdge, DraftNode } from '../document/types';
import { sequenceAnchorRect } from './sequenceAnchors';
import { OBSTACLE_REACH, rectOf } from './routing';

/**
 * Whether two node arrays put every shape in the same place: same shapes, same kinds, same boxes,
 * and the same ends for their connectors (`sameEnds`).
 *
 * The whole-document derivations (`routingPlan`, `crossingPlan`) are memoized on array *identity*,
 * and any edit — a rename, a colour, a note's text — makes a new `nodes` array, so a keystroke in a
 * label re-planned every connector on the canvas for a result that could not have changed. What those
 * plans read of a node is its id, its kind (a boundary is no obstacle, a junction is no bundle
 * member), its box and where on it a connector lands; when all of that matches, the plan already
 * built is still the answer.
 *
 * Positional: a reorder is not "the same", and it is cheap to say so.
 */
export function sameNodeGeometry(a: readonly DraftNode[], b: readonly DraftNode[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    const x = a[i]!;
    const y = b[i]!;
    if (x === y) continue;
    if (x.id !== y.id || x.type !== y.type || x.x !== y.x || x.y !== y.y || x.width !== y.width || x.height !== y.height) {
      return false;
    }
    if (!sameEnds(x, y)) return false;
  }
  return true;
}

/** What of a shape stands its glyph, and so its connectors' ends (`bandWords`), field by field. */
const BAND_FIELDS = Object.keys(bandWords({})) as Array<keyof ReturnType<typeof bandWords>>;

/**
 * Whether a shape that kept its box still gives its connectors the same ends to route between: the
 * band they land on and the category their captions are worded for.
 *
 * A box is not the whole of it. A Service or Component drawn as a glyph, a Data Store and an
 * Artifact are met on the glyph (`anchorBandOf`), which stands where the shape's kind and the words
 * under it leave it room; and a caption is worded, and placed, for the categories of the two shapes
 * it joins (`routedCaption`). Comparing boxes alone kept every plan across a Generic Service turned
 * into a Worker, or a description taken off a grown Data Store: the canvas drew the line on the new
 * glyph, and its line jumps, shared label, spread ends and tracks stayed where the old one was. The
 * band is asked of the shape whole, the way every renderer asks it, so a rename that leaves the glyph
 * where it was (any card, and most names) still keeps the plan.
 */
function sameEnds(x: DraftNode, y: DraftNode): boolean {
  if (categoryOf(x) !== categoryOf(y)) return false;
  if (BAND_FIELDS.every((field) => x[field] === y[field])) return true;
  return sameBand(anchorBandOf(x), anchorBandOf(y));
}

const sameBand = (a: AnchorBand | undefined, b: AnchorBand | undefined) =>
  a === b || (a !== undefined && b !== undefined && a.top === b.top && a.bottom === b.bottom && a.left === b.left && a.right === b.right && a.glyphTop === b.glyphTop);

const participantEdges = new WeakMap<readonly DraftEdge[], readonly DraftEdge[]>();

/** Route plans also consume lifeline points, while the obstacle grid only consumes frame boxes. */
export function sameRouteGeometry(a: readonly DraftNode[], b: readonly DraftNode[], edges: readonly DraftEdge[]): boolean {
  if (!sameNodeGeometry(a, b)) return false;
  if (a === b) return true;
  return sameParticipantFrames(a, b, edges);
}

/** Whether the lifeline points that participant-anchored connectors end on are where they were — the
 *  part of `sameRouteGeometry` that is not about boxes. Positional, like `sameNodeGeometry`. */
function sameParticipantFrames(a: readonly DraftNode[], b: readonly DraftNode[], edges: readonly DraftEdge[]): boolean {
  let anchored = participantEdges.get(edges);
  if (!anchored) {
    anchored = edges.filter((edge) => edge.sourceAnchor?.participantId || edge.targetAnchor?.participantId);
    participantEdges.set(edges, anchored);
  }
  if (anchored.length === 0) return true;
  const changed = new Map<string, number>();
  for (const [index, node] of a.entries()) {
    const next = b[index]!;
    if (node.type === 'sequence' && (node.sequence !== next.sequence || node.text !== next.text)) changed.set(node.id, index);
  }
  const sameEnd = (id: string, anchor: DraftEdge['sourceAnchor']): boolean => {
    const index = changed.get(id);
    if (index === undefined || !anchor?.participantId) return true;
    const before = sequenceAnchorRect(a[index], rectOf(a[index]!), anchor);
    const after = sequenceAnchorRect(b[index], rectOf(b[index]!), anchor);
    return before.x === after.x && before.y === after.y && before.width === after.width && before.height === after.height;
  };
  return anchored.every((edge) => sameEnd(edge.source, edge.sourceAnchor) && sameEnd(edge.target, edge.targetAnchor));
}

/**
 * Who a whole-document plan is for. The plans keep what the canvas last built — to reuse it across an
 * edit that moved nothing, and to hand back unchanged results by identity — in one slot each. An
 * export, the export preview, a render of every room or an agent preview is a different document,
 * and writing that slot made the canvas's next commit re-plan every connector and re-render every
 * crossed one. `'transient'` reads what the canvas left and never writes over it.
 */
export type PlanScope = 'canvas' | 'transient';

/**
 * The widest margin any plan reads around the shapes a connector joins: what it takes of its
 * neighbours (`obstaclesForEdge`, `OBSTACLE_REACH`) or, for a shared trunk, the clearance it keeps
 * from them (`TRUNK_OBSTACLE_MARGIN` in `bundles.ts`, which `tests/plan-reuse.test.ts` holds below
 * this).
 */
export const PLAN_REACH = OBSTACLE_REACH;

interface Box {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/**
 * Where a shape that is not joined to anything could change what the connector plans work out: for
 * every connected shape, the box around it and everything it is joined to, grown by `PLAN_REACH`.
 *
 * A plan reads a connector's two shapes, the shapes near them (the obstacle list: those within
 * `PLAN_REACH` of the box the two span) and, for a trunk, the shapes between a hub and the shapes it
 * fans out to — all of which lie inside these boxes. A shape outside every one of them is read by
 * nothing: no connector's obstacle list holds it, so no connector is routed any differently for it.
 */
function dependenceBoxes(nodes: readonly DraftNode[], edges: readonly DraftEdge[]): Box[] {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const around = new Map<string, Box>();
  const grow = (id: string, node: DraftNode) => {
    const box = around.get(id);
    if (!box) {
      around.set(id, { left: node.x, top: node.y, right: node.x + node.width, bottom: node.y + node.height });
      return;
    }
    box.left = Math.min(box.left, node.x);
    box.top = Math.min(box.top, node.y);
    box.right = Math.max(box.right, node.x + node.width);
    box.bottom = Math.max(box.bottom, node.y + node.height);
  };
  for (const edge of edges) {
    const source = byId.get(edge.source);
    const target = byId.get(edge.target);
    if (!source || !target) continue;
    grow(source.id, source);
    grow(source.id, target);
    grow(target.id, target);
    grow(target.id, source);
  }
  return [...around.values()].map((box) => ({
    left: box.left - PLAN_REACH,
    top: box.top - PLAN_REACH,
    right: box.right + PLAN_REACH,
    bottom: box.bottom + PLAN_REACH,
  }));
}

/** Touching counts: a box is only ever too big, never too small. */
const meets = (node: DraftNode, box: Box) =>
  node.x <= box.right && node.x + node.width >= box.left && node.y <= box.bottom && node.y + node.height >= box.top;

interface StrayVerdict {
  previous: readonly DraftNode[];
  edges: readonly DraftEdge[];
  holds: boolean;
}
/** The last answer per `nodes` array: every plan asks the same question of the same pair of arrays. */
const strayVerdicts = new WeakMap<readonly DraftNode[], StrayVerdict>();

/**
 * Whether `next` differs from `previous` only in where (or how big) shapes are that nothing is
 * joined to and no connector's plan reads — a stray note or text, a shape just dropped on open
 * canvas, a boundary with no connectors of its own.
 *
 * Every plan built for `previous` is then the plan for `next`, exactly: each is a function of the
 * connectors' own shapes, their order, and the obstacle lists the shapes near them make, and none of
 * those moved. It is what a drag of an unconnected shape in a large diagram used to pay a full plan
 * of every connector for. Anything else — a connected shape, a shape that is or was within reach of
 * a connector, a shape added, removed or changed in kind — is "no", and the plan is built again.
 */
function onlyStrayShapesMoved(previous: readonly DraftNode[], next: readonly DraftNode[], edges: readonly DraftEdge[]): boolean {
  const known = strayVerdicts.get(next);
  if (known && known.previous === previous && known.edges === edges) return known.holds;
  const holds = judgeStrayMoves(previous, next, edges);
  strayVerdicts.set(next, { previous, edges, holds });
  return holds;
}

function judgeStrayMoves(previous: readonly DraftNode[], next: readonly DraftNode[], edges: readonly DraftEdge[]): boolean {
  if (previous.length !== next.length) return false;
  const moved: number[] = [];
  for (let i = 0; i < previous.length; i += 1) {
    const x = previous[i]!;
    const y = next[i]!;
    if (x === y) continue;
    if (x.id !== y.id || x.type !== y.type) return false;
    // A shape whose glyph or caption category changed in place has moved its connectors' ends.
    if (x.x !== y.x || x.y !== y.y || x.width !== y.width || x.height !== y.height || !sameEnds(x, y)) moved.push(i);
  }
  // Nothing moved at all: the caller's own "same geometry" test already said what it had to.
  if (moved.length === 0) return false;
  const joined = new Set<string>();
  for (const edge of edges) {
    joined.add(edge.source);
    joined.add(edge.target);
  }
  // A boundary is read by no plan except as an end of a connector.
  const shapes = moved.filter((i) => next[i]!.type !== 'group');
  for (const i of moved) if (joined.has(next[i]!.id)) return false;
  if (shapes.length === 0) return true;
  const boxes = dependenceBoxes(next, edges);
  return shapes.every((i) => !boxes.some((box) => meets(previous[i]!, box) || meets(next[i]!, box)));
}

/** `sameNodeGeometry`, or a difference in nothing but stray shapes — see `onlyStrayShapesMoved`. For
 *  the plans that read nothing of a participant's lifeline. */
export function sameNodeGeometryAround(previous: readonly DraftNode[], next: readonly DraftNode[], edges: readonly DraftEdge[]): boolean {
  return sameNodeGeometry(previous, next) || onlyStrayShapesMoved(previous, next, edges);
}

/** `sameRouteGeometry`, or a difference in nothing but stray shapes — see `onlyStrayShapesMoved`. */
export function sameRouteGeometryAround(previous: readonly DraftNode[], next: readonly DraftNode[], edges: readonly DraftEdge[]): boolean {
  return sameRouteGeometry(previous, next, edges) || (onlyStrayShapesMoved(previous, next, edges) && sameParticipantFrames(previous, next, edges));
}
