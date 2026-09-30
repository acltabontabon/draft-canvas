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
  avoid: readonly PlacementRect[] = [],
): Placement {
  const fits = (candidate: Placement) => fitsPlacement(candidate, anchors, flowToScreenPosition, size, clearances);
  if (avoid.length === 0) return fits(current) ? current : (PLACEMENT_ORDER.find(fits) ?? current);
  // `avoid`: flow-space rects the popover shouldn't sit on — the shapes the element is connected
  // to. Above is the first choice, and in a top-down diagram above is exactly where the shape
  // feeding this one sits, so the popover covered the very relationship being looked at. Still
  // stable: the current side stays while it fits and covers nothing.
  const screenAvoid = avoid.map((rect) => {
    const topLeft = flowToScreenPosition({ x: rect.x, y: rect.y });
    const bottomRight = flowToScreenPosition({ x: rect.x + rect.width, y: rect.y + rect.height });
    return { left: topLeft.x, top: topLeft.y, right: bottomRight.x, bottom: bottomRight.y };
  });
  const covers = (candidate: Placement) => {
    const box = popoverBox(candidate, anchors, flowToScreenPosition, size, clearances);
    return screenAvoid.some((rect) => box.left < rect.right && box.right > rect.left && box.top < rect.bottom && box.bottom > rect.top);
  };
  if (fits(current) && !covers(current)) return current;
  const clean = PLACEMENT_ORDER.find((candidate) => fits(candidate) && !covers(candidate));
  if (clean) return clean;
  return fits(current) ? current : (PLACEMENT_ORDER.find(fits) ?? current);
}

/** Where the popover would be on screen, on a side — the same geometry `placementTransform` uses. */
function popoverBox(
  placement: Placement,
  anchors: Record<Placement, PlacementPoint>,
  flowToScreenPosition: (point: PlacementPoint) => PlacementPoint,
  size: PlacementSize,
  clearances: PlacementClearances,
): { left: number; top: number; right: number; bottom: number } {
  const anchor = flowToScreenPosition(anchors[placement]);
  const { width, height } = size;
  switch (placement) {
    case 'above':
    case 'below': {
      const centerX = clampCenterX(anchor.x, width / 2, clearances.left, clearances.right);
      const top = placement === 'above' ? anchor.y - clearances.gap - height : anchor.y + clearances.gap;
      return { left: centerX - width / 2, top, right: centerX + width / 2, bottom: top + height };
    }
    case 'right':
      return { left: anchor.x + clearances.gap, top: anchor.y - height / 2, right: anchor.x + clearances.gap + width, bottom: anchor.y + height / 2 };
    case 'left':
      return { left: anchor.x - clearances.gap - width, top: anchor.y - height / 2, right: anchor.x - clearances.gap, bottom: anchor.y + height / 2 };
  }
}

/**
 * A horizontally centred popover's centre x, held so the whole panel stays within the window minus
 * `left`/`right` clearances. One wider than that room keeps its left edge (its title and first
 * controls) on screen. Shared with `EdgeInspectorPopover`, which places itself but must agree on this.
 */
export function clampCenterX(centerX: number, halfWidth: number, left: number, right: number): number {
  return clamp(centerX, left + halfWidth, window.innerWidth - right - halfWidth);
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
    const clampedScreenX = clampCenterX(screenAnchor.x, size.width / 2, clearances.left, clearances.right);
    // The popover's near edge, held on screen the way its centre already is across. Where a side
    // fits (the only case `resolvePlacement` chooses one on) this changes nothing; where none does —
    // a shape zoomed until it fills the window — the anchor is off screen, and following it there
    // would leave the popover, and every control in it, unreachable.
    const edgeY =
      placement === 'above'
        ? clamp(screenAnchor.y - clearances.gap, clearances.top + size.height, window.innerHeight - clearances.bottom)
        : clamp(screenAnchor.y + clearances.gap, clearances.top, window.innerHeight - clearances.bottom - size.height);
    const at = screenToContainer({ x: clampedScreenX, y: edgeY });
    return placement === 'above'
      ? `translate(-50%, -100%) translate(${at.x}px, ${at.y}px)`
      : `translate(-50%, 0) translate(${at.x}px, ${at.y}px)`;
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
