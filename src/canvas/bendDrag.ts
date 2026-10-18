/**
 * The click a browser sends after a drag ends lands on the bend handle, which counts as the line
 * (`edgePick.ts`) — without this, every bend would also open the connector's panel. Kept out of
 * `EdgeBendHandles.tsx` so that file exports only its component.
 */
let dragEndedAt = Number.NEGATIVE_INFINITY;
const DRAG_CLICK_WINDOW_MS = 400;

export function markBendDragEnded(): void {
  dragEndedAt = performance.now();
}

/** Whether a click now is the tail of a bend drag rather than a click of its own. */
export function endsBendDrag(): boolean {
  return performance.now() - dragEndedAt < DRAG_CLICK_WINDOW_MS;
}
