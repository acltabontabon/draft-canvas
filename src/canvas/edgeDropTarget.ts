/**
 * Finds the connector (if any) underneath a screen point during a note/code drag.
 *
 * Reuses the exact same hit corridor a click already uses — the invisible, wide
 * `.dc-edge-hit` interaction path `DraftEdgeView.tsx` draws along each route — rather than
 * re-deriving routing geometry from `RoutedEdge`, so this stays correct for any connector shape
 * (straight, bezier, or a bent smoothstep with a detour) with no duplicated path math, and never
 * drifts out of sync with what a user can actually click. React Flow already tags each edge's own
 * wrapper with `data-id` (the same attribute its own internals use for DOM lookups — see its
 * `querySelector('.react-flow__node[data-id="..."]')` calls), so no extra attribute needs adding
 * to `DraftEdgeView.tsx` for this to work.
 *
 * `elementsFromPoint` (not `elementFromPoint`) is what makes this work while the dragged node
 * itself is rendered on top of the point being tested: it returns every element at that point in
 * paint order, so the dragged node's own DOM subtree can be skipped rather than shadowing
 * whatever connector sits underneath it.
 *
 * Every hit is collected, not just the first. While a note/code drag is in flight that corridor is
 * widened (see `.dc-canvas[data-attach-drag]` in `canvas.css`) so a thin line is actually
 * reachable — and on a crowded canvas that means several corridors overlap at once. Paint order
 * decides which one the DOM names first, and paint order has nothing to do with which line the
 * user is aiming at, so the *nearest* route wins instead (`edges/nearest.ts`). Ties and
 * unreadable paths fall back to paint order, which is what this used to do for every case.
 */
import { distanceToPath, type Point } from '../edges/nearest';

export function findEdgeDropCandidate(
  clientX: number,
  clientY: number,
  draggedNodeId: string,
  /** The same point in flow coordinates — the space a route's `d` is written in. */
  aim: Point,
): string | null {
  const draggedEl = document.querySelector(`.react-flow__node[data-id="${CSS.escape(draggedNodeId)}"]`);
  const stack = document.elementsFromPoint(clientX, clientY);
  let fallback: string | null = null;
  let bestId: string | null = null;
  let bestDistance = Infinity;
  const seen = new Set<string>();

  for (const el of stack) {
    if (draggedEl?.contains(el)) continue;
    const match = el.closest('.react-flow__edge[data-id]');
    if (!match) continue;
    const id = match.getAttribute('data-id');
    // A single edge contributes several elements to the stack (its hit path, its line, its
    // group); only the first mention of each one needs measuring.
    if (!id || seen.has(id)) continue;
    seen.add(id);
    if (fallback === null) fallback = id;

    const d = match.querySelector('.dc-edge-hit')?.getAttribute('d');
    const distance = d ? distanceToPath(aim, d) : null;
    if (distance !== null && distance < bestDistance) {
      bestDistance = distance;
      bestId = id;
    }
  }

  return bestId ?? fallback;
}
