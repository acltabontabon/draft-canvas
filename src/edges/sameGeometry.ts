import type { DraftNode } from '../document/types';

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
