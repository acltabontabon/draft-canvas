import type { DraftEdge, DraftNode } from '../document/types';
import { sequenceAnchorRect } from './sequenceAnchors';
import { rectOf } from './routing';

/**
 * Whether two node arrays put every shape in the same place: same shapes, same kinds, same boxes.
 *
 * The whole-document derivations (`routingPlan`, `crossingPlan`) are memoized on array *identity*,
 * and any edit — a rename, a colour, a note's text — makes a new `nodes` array, so a keystroke in a
 * label re-planned every connector on the canvas for a result that could not have changed. What those
 * plans read of a node is its id, its kind (a boundary is no obstacle, a junction is no bundle
 * member) and its box; when all of that matches, the plan already built is still the answer.
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
  }
  return true;
}

const participantEdges = new WeakMap<readonly DraftEdge[], readonly DraftEdge[]>();

/** Route plans also consume lifeline points, while the obstacle grid only consumes frame boxes. */
export function sameRouteGeometry(a: readonly DraftNode[], b: readonly DraftNode[], edges: readonly DraftEdge[]): boolean {
  if (!sameNodeGeometry(a, b)) return false;
  if (a === b) return true;
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
