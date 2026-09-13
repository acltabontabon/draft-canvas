/**
 * Where the canvas actually is on screen. It used to be "the window, minus the toolbar"; with Learn
 * docked beside it, the canvas can end well short of the window's right edge — so anything that
 * means "the middle of the canvas" or "stay clear of its right edge" asks here instead of assuming.
 */

/** `FlowPanel`'s fixed 300px width + a 12px gap, while it's open. */
export const FLOW_PANEL_CLEARANCE = 312;

function canvasRect(): DOMRect | null {
  if (typeof document === 'undefined') return null;
  return document.querySelector('.dc-editor-canvas')?.getBoundingClientRect() ?? null;
}

/**
 * The right-edge clearance a floating canvas overlay needs, in window pixels: whatever is docked
 * beside the canvas, plus the Flows panel when it's open (else `margin`).
 */
export function rightClearance(flowPanelOpen: boolean, margin: number): number {
  const rect = canvasRect();
  const docked = rect && typeof window !== 'undefined' ? Math.max(0, window.innerWidth - rect.right) : 0;
  return docked + (flowPanelOpen ? FLOW_PANEL_CLEARANCE : margin);
}

/** The canvas's visual centre in window coordinates — the fallback for "put it in the middle". */
export function canvasCenter(): { x: number; y: number } {
  const rect = canvasRect();
  if (rect && rect.width > 0 && rect.height > 0) return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  return { x: window.innerWidth / 2, y: window.innerHeight / 2 };
}

/** The canvas's right and bottom edges in window coordinates, for "is this on screen?" checks. */
export function canvasBounds(): { right: number; bottom: number } {
  const rect = canvasRect();
  return rect && rect.width > 0 ? { right: rect.right, bottom: rect.bottom } : { right: window.innerWidth, bottom: window.innerHeight };
}
