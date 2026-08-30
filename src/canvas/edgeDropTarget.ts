/**
 * Finds the connector (if any) underneath a screen point during a note/code drag.
 *
 * Reuses the exact same hit corridor a click already uses — `BaseEdge`'s invisible
 * `interactionWidth` path — rather than re-deriving routing geometry from `RoutedEdge`, so this
 * stays correct for any connector shape (straight, bezier, or a bent smoothstep with a detour)
 * with no duplicated path math, and never drifts out of sync with what a user can actually click.
 * React Flow already tags each edge's own wrapper with `data-id` (the same attribute its own
 * internals use for DOM lookups — see its `querySelector('.react-flow__node[data-id="..."]')`
 * calls), so no extra attribute needs adding to `DraftEdgeView.tsx` for this to work.
 *
 * `elementsFromPoint` (not `elementFromPoint`) is what makes this work while the dragged node
 * itself is rendered on top of the point being tested: it returns every element at that point in
 * paint order, so the dragged node's own DOM subtree can be skipped rather than shadowing
 * whatever connector sits underneath it.
 */
export function findEdgeDropCandidate(clientX: number, clientY: number, draggedNodeId: string): string | null {
  const draggedEl = document.querySelector(`.react-flow__node[data-id="${CSS.escape(draggedNodeId)}"]`);
  const stack = document.elementsFromPoint(clientX, clientY);
  for (const el of stack) {
    if (draggedEl?.contains(el)) continue;
    const match = el.closest('.react-flow__edge[data-id]');
    if (match) return match.getAttribute('data-id');
  }
  return null;
}
