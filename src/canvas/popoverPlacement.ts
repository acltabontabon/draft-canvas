/**
 * Shared collision-aware placement math for a flow-anchored contextual popover — the algorithm
 * `ElementInspectorPopover.tsx` originally had inline, pulled out so a second consumer (an
 * element's attachment popover) doesn't have to reimplement it a third time (`EdgeInspectorPopover`
 * and `InspectorSelect` each already have their own independent, simpler variant of this same idea).
 *
 * Deliberately algorithm-only: each consumer still declares its own clearance constants rather than
 * importing shared numbers, so tuning one popover's fit can never silently regress another's — the
 * same isolation `EdgeInspectorPopover.tsx`'s own clearance comment already establishes as house
 * style for this codebase.
 */
import { clamp } from '../lib/math';

export type Placement = 'above' | 'below' | 'right' | 'left';
const PLACEMENT_ORDER: Placement[] = ['above', 'below', 'right', 'left'];

export interface PlacementRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface PlacementPoint {
  x: number;
  y: number;
}

export interface PlacementSize {
  width: number;
  height: number;
}

/** All distances in screen (CSS pixel) space. */
export interface PlacementClearances {
  gap: number;
  top: number;
  bottom: number;
  left: number;
  right: number;
}

/** The four candidate anchor points on a flow-space rect's own boundary, one per placement. */
export function anchorsForRect(rect: PlacementRect): Record<Placement, PlacementPoint> {
  return {
    above: { x: rect.x + rect.width / 2, y: rect.y },
    below: { x: rect.x + rect.width / 2, y: rect.y + rect.height },
    right: { x: rect.x + rect.width, y: rect.y + rect.height / 2 },
    left: { x: rect.x, y: rect.y + rect.height / 2 },
  };
}

/** Does the popover, at `size`, fit on the given side of the anchor without breaching a clearance? */
function fitsPlacement(
  candidate: Placement,
  anchors: Record<Placement, PlacementPoint>,
  flowToScreenPosition: (point: PlacementPoint) => PlacementPoint,
  size: PlacementSize,
  clearances: PlacementClearances,
): boolean {
  const screenAnchor = flowToScreenPosition(anchors[candidate]);
  const { width, height } = size;
  switch (candidate) {
    case 'above':
      return screenAnchor.y - clearances.gap - height >= clearances.top;
    case 'below':
      return screenAnchor.y + clearances.gap + height <= window.innerHeight - clearances.bottom;
    case 'right':
      return screenAnchor.x + clearances.gap + width <= window.innerWidth - clearances.right;
    case 'left':
      return screenAnchor.x - clearances.gap - width >= clearances.left;
    default:
      return false;
  }
}

/**
 * Stable-by-construction: only searches for a new placement when `current` has genuinely stopped
 * fitting, instead of re-picking the "best" one every call — this is what keeps a popover from
 * flipping back and forth mid-drag or mid-resize. Falls back to `current` itself if nothing in
 * `PLACEMENT_ORDER` fits (a maximally cramped viewport) rather than returning `undefined`.
 */
export function resolvePlacement(
  current: Placement,
  anchors: Record<Placement, PlacementPoint>,
  flowToScreenPosition: (point: PlacementPoint) => PlacementPoint,
  size: PlacementSize,
  clearances: PlacementClearances,
): Placement {
  const fits = (candidate: Placement) => fitsPlacement(candidate, anchors, flowToScreenPosition, size, clearances);
  return fits(current) ? current : (PLACEMENT_ORDER.find(fits) ?? current);
}

/** The CSS `transform` string that positions the popover for a resolved placement, cross-axis
 *  clamped so it never clips off-screen even right at a viewport corner. The result is in the
 *  popover container's own coordinates — `screenToContainer` maps a page point into them (see
 *  `useOverlayPosition`; identity for a popover already positioned against the page). The gap is
 *  in screen pixels, like every clearance, so it never shrinks or grows with zoom. */
export function placementTransform(
  placement: Placement,
  anchors: Record<Placement, PlacementPoint>,
  size: PlacementSize,
  clearances: PlacementClearances,
  flowToScreenPosition: (point: PlacementPoint) => PlacementPoint,
  screenToContainer: (point: PlacementPoint) => PlacementPoint,
): string {
  const screenAnchor = flowToScreenPosition(anchors[placement]);
  if (placement === 'above' || placement === 'below') {
    const halfWidth = size.width / 2;
    const clampedScreenX = clamp(
      screenAnchor.x,
      clearances.left + halfWidth,
      window.innerWidth - clearances.right - halfWidth,
    );
    const at = screenToContainer({ x: clampedScreenX, y: screenAnchor.y });
    return placement === 'above'
      ? `translate(-50%, -100%) translate(${at.x}px, ${at.y - clearances.gap}px)`
      : `translate(-50%, 0) translate(${at.x}px, ${at.y + clearances.gap}px)`;
  }
  const halfHeight = size.height / 2;
  const clampedScreenY = clamp(
    screenAnchor.y,
    clearances.top + halfHeight,
    window.innerHeight - clearances.bottom - halfHeight,
  );
  const at = screenToContainer({ x: screenAnchor.x, y: clampedScreenY });
  return placement === 'right'
    ? `translate(0, -50%) translate(${at.x + clearances.gap}px, ${at.y}px)`
    : `translate(-100%, -50%) translate(${at.x - clearances.gap}px, ${at.y}px)`;
}
