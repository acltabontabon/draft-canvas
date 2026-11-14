/**
 * Room between the reply labels of neighbouring connectors.
 *
 * A reply's words are placed from its own connector alone (`responseLabelAnchor`): on the reply's run,
 * beside the request's label. Two replies that come home along the same corridor — a coordinator's
 * "reserved / failed" and "scheduled / failed" — were each placed without the other in view, and on a
 * short corridor one was written over the end of the next.
 *
 * This plan looks at every reply label in the view at once and, where two overlap, slides each along
 * its own run, away from the other, only as far as it takes and never past the run's corners. A label
 * with nowhere to go stays put and its neighbour takes the whole step. Nothing else moves: not the
 * lines, not the request's words.
 *
 * Presentation only, like trunks and line jumps: nothing is saved. Memoized on the (nodes, edges)
 * pair, so a connector asks for its own shift on every render for nothing, and the shift it gets back
 * is the same object until it really changes.
 */

import type { DraftEdge, DraftNode } from '../document/types';
import { connectorRoutes } from './connectorRoutes';
import { LABEL_PADDING_X, LABEL_PADDING_Y, layoutEdgeResponse } from './labelLayout';
import { LABEL_BEND_CLEARANCE, LABEL_LINE_GAP, flattenPath } from './routing';
import type { PlanScope } from './sameGeometry';

export interface ReplyShift {
  x: number;
  y: number;
}

export interface ReplyLabelPlan {
  /** How far this connector's reply label moves from its anchor; `undefined` for most. */
  shiftFor(edgeId: string): ReplyShift | undefined;
}

/** Between two reply labels once they have been moved apart. */
const GAP = 6;
/** Passes over the pairs: a label pushed clear of one neighbour can land on the next. */
const PASSES = 3;
/** Past this many reply labels the pairwise look is not worth its cost; they stay as placed. */
const MAX_LABELS = 400;

const NONE: ReplyLabelPlan = { shiftFor: () => undefined };

interface Placed {
  id: string;
  /** The label's box at its anchor. */
  x: number;
  y: number;
  width: number;
  height: number;
  /** Whether its run is level, so it slides along x; otherwise along y. */
  level: boolean;
  /** How far it may slide back and forward along its run. */
  back: number;
  forward: number;
  /** How far it has slid. */
  moved: number;
}

function place(edge: DraftEdge, doc: { nodes: readonly DraftNode[]; edges: readonly DraftEdge[] }, byId: ReadonlyMap<string, DraftNode>, scope: PlanScope): Placed | null {
  const text = edge.response?.trim();
  if (!text || !edge.hasResponse) return null;
  const routes = connectorRoutes(edge, doc, scope, byId);
  const at = routes?.responseLabel;
  if (!routes?.response || !at) return null;
  const layout = layoutEdgeResponse(text);
  const width = layout.width + LABEL_PADDING_X * 2;
  const height = layout.height + LABEL_PADDING_Y * 2;
  // `labelChipRect`'s geometry: a chip over or under a level run, or beside an upright one.
  const level = at.side === 'top' || at.side === 'bottom';
  const x = at.side === 'right' ? at.x + LABEL_LINE_GAP - LABEL_PADDING_X : at.side === 'left' ? at.x - LABEL_LINE_GAP + LABEL_PADDING_X - width : at.x - width / 2;
  const y = at.side === 'bottom' ? at.y + LABEL_LINE_GAP - LABEL_PADDING_Y : at.side === 'top' ? at.y - LABEL_LINE_GAP + LABEL_PADDING_Y - height : at.y - height / 2;

  // The stretch of the reply the anchor sits on, and how much of it is left either way.
  let back = 0;
  let forward = 0;
  const vertices = flattenPath(routes.response.d);
  for (let i = 1; i < vertices.length; i += 1) {
    const a = vertices[i - 1]!;
    const b = vertices[i]!;
    const along = level ? Math.abs(b.y - a.y) < 0.5 && Math.abs(at.y - a.y) < 0.5 : Math.abs(b.x - a.x) < 0.5 && Math.abs(at.x - a.x) < 0.5;
    if (!along) continue;
    const [from, to, here] = level ? [Math.min(a.x, b.x), Math.max(a.x, b.x), at.x] : [Math.min(a.y, b.y), Math.max(a.y, b.y), at.y];
    if (here < from - 0.5 || here > to + 0.5) continue;
    back = Math.max(0, here - from - LABEL_BEND_CLEARANCE);
    forward = Math.max(0, to - here - LABEL_BEND_CLEARANCE);
    break;
  }
  return { id: edge.id, x, y, width, height, level, back, forward, moved: 0 };
}

/**
 * How `a` and `b` would come `need` apart along one axis: only the labels whose run lies along it
 * move, the one that comes first going back and the other forward, each within what its run has
 * left. Two movers share the step; one that runs out leaves the rest to the other.
 */
function separation(a: Placed, b: Placed, level: boolean, need: number, aFirst: boolean): { need: number; reach: number; steps: [Placed, number][] } {
  const [first, second] = aFirst ? [a, b] : [b, a];
  const roomFirst = first.level === level ? first.back + first.moved : 0;
  const roomSecond = second.level === level ? second.forward - second.moved : 0;
  let stepFirst = Math.min(roomFirst > 0 && roomSecond > 0 ? need / 2 : need, roomFirst);
  const stepSecond = Math.min(need - stepFirst, roomSecond);
  stepFirst = Math.min(need - stepSecond, roomFirst);
  const steps: [Placed, number][] = [];
  if (stepFirst > 0) steps.push([first, -stepFirst]);
  if (stepSecond > 0) steps.push([second, stepSecond]);
  return { need, reach: stepFirst + stepSecond, steps };
}

const boxOf = (p: Placed) => ({ x: p.x + (p.level ? p.moved : 0), y: p.y + (p.level ? 0 : p.moved), width: p.width, height: p.height });

function compute(nodes: readonly DraftNode[], edges: readonly DraftEdge[], scope: PlanScope): Map<string, ReplyShift> {
  const shifts = new Map<string, ReplyShift>();
  if (!edges.some((edge) => edge.hasResponse && edge.response)) return shifts;
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const doc = { nodes, edges };
  const placed: Placed[] = [];
  for (const edge of edges) {
    const label = place(edge, doc, byId, scope);
    if (label) placed.push(label);
    if (placed.length > MAX_LABELS) return shifts;
  }
  if (placed.length < 2) return shifts;

  for (let pass = 0; pass < PASSES; pass += 1) {
    let changed = false;
    for (let i = 0; i < placed.length; i += 1) {
      for (let j = i + 1; j < placed.length; j += 1) {
        const [a, b] = [placed[i]!, placed[j]!];
        const [boxA, boxB] = [boxOf(a), boxOf(b)];
        const overlapX = Math.min(boxA.x + boxA.width, boxB.x + boxB.width) - Math.max(boxA.x, boxB.x);
        const overlapY = Math.min(boxA.y + boxA.height, boxB.y + boxB.height) - Math.max(boxA.y, boxB.y);
        if (overlapX <= 0 || overlapY <= 0) continue;
        // Apart across (the level ones slide) or apart up and down (the upright ones do): whichever
        // has the room, and the shorter move when both have.
        const across = separation(a, b, true, overlapX + GAP, boxA.x + boxA.width / 2 <= boxB.x + boxB.width / 2);
        const upright = separation(a, b, false, overlapY + GAP, boxA.y + boxA.height / 2 <= boxB.y + boxB.height / 2);
        const chosen = [across, upright]
          .filter((option) => option.reach > 0)
          .sort((one, other) => Number(other.reach >= other.need) - Number(one.reach >= one.need) || one.need - other.need)[0];
        if (!chosen) continue;
        for (const [label, step] of chosen.steps) label.moved += step;
        changed = true;
      }
    }
    if (!changed) break;
  }
  for (const label of placed) {
    if (Math.abs(label.moved) < 0.5) continue;
    const moved = Math.round(label.moved);
    shifts.set(label.id, label.level ? { x: moved, y: 0 } : { x: 0, y: moved });
  }
  return shifts;
}

/** Built at module level so the returned plan holds only its shifts, never the planner's scratch
 *  data (the rule `planOf` in `crossings.ts` records). */
function planOf(shifts: ReadonlyMap<string, ReplyShift>): ReplyLabelPlan {
  return shifts.size === 0 ? NONE : { shiftFor: (edgeId) => shifts.get(edgeId) };
}

const cache = new WeakMap<readonly DraftNode[], WeakMap<readonly DraftEdge[], ReplyLabelPlan>>();
let lastShifts: ReadonlyMap<string, ReplyShift> = new Map();

/** Where each reply label in the view moves so none is written over another. */
export function replyLabelPlan(nodes: readonly DraftNode[], edges: readonly DraftEdge[], scope: PlanScope = 'canvas'): ReplyLabelPlan {
  const byNodes = cache.get(nodes);
  const cached = byNodes?.get(edges);
  if (cached) return cached;
  const shifts = compute(nodes, edges, scope);
  // The same shift as last time is handed back as the same object: a connector subscribes to it, and
  // a drag elsewhere in the diagram must not re-render every shifted reply label on each frame.
  if (scope === 'canvas') {
    for (const [id, shift] of shifts) {
      const was = lastShifts.get(id);
      if (was && was.x === shift.x && was.y === shift.y) shifts.set(id, was);
    }
    lastShifts = shifts;
  }
  const plan = planOf(shifts);
  if (byNodes) byNodes.set(edges, plan);
  else cache.set(nodes, new WeakMap([[edges, plan]]));
  return plan;
}
