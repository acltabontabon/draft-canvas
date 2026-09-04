import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  anchorsForRect,
  placementTransform,
  resolvePlacement,
  type Placement,
  type PlacementClearances,
  type PlacementPoint,
} from '../src/canvas/popoverPlacement';

const identity = (point: PlacementPoint) => point;

const clearances: PlacementClearances = { gap: 6, top: 56, bottom: 44, left: 12, right: 12 };

const originalInnerWidth = window.innerWidth;
const originalInnerHeight = window.innerHeight;

function setViewport(width: number, height: number) {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: width });
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: height });
}

afterEach(() => {
  setViewport(originalInnerWidth, originalInnerHeight);
});

/**
 * `QuickConnectMenu` reuses this algorithm with an identity flow-to-screen conversion (its anchor
 * is already screen-fixed) — this is the first direct test coverage for the shared placement math
 * itself, previously only exercised indirectly through the flow-anchored popovers.
 */
describe('popoverPlacement with a screen-fixed (identity) anchor', () => {
  beforeEach(() => setViewport(1200, 800));

  it('resolves "below" for a point with plenty of room on every side', () => {
    const anchors = anchorsForRect({ x: 600, y: 400, width: 0, height: 0 });
    const placement = resolvePlacement('below', anchors, identity, { width: 140, height: 90 }, clearances);
    expect(placement).toBe('below');
  });

  it('falls back off "below" when the anchor sits near the bottom edge', () => {
    const anchors = anchorsForRect({ x: 600, y: 780, width: 0, height: 0 });
    const placement = resolvePlacement('below', anchors, identity, { width: 140, height: 90 }, clearances);
    expect(placement).not.toBe('below');
  });

  it('clamps the cross-axis so a corner anchor never pushes the popover off-screen', () => {
    // Top-left corner: an unclamped "below" placement centered under this anchor would put
    // roughly half the popover's width off the left edge of the viewport.
    const anchors = anchorsForRect({ x: 5, y: 5, width: 0, height: 0 });
    const size = { width: 140, height: 90 };
    const placement = resolvePlacement('below', anchors, identity, size, clearances);
    const transform = placementTransform(placement, anchors, size, clearances, identity, identity);

    // translate(-50%, 0) translate(<x>px, <y>px) — the clamped literal x must keep the popover's
    // left edge (x - halfWidth) at or past the left clearance.
    const match = transform.match(/translate\((-?\d+(?:\.\d+)?)px, (-?\d+(?:\.\d+)?)px\)$/);
    expect(match).not.toBeNull();
    const x = Number(match![1]);
    expect(x - size.width / 2).toBeGreaterThanOrEqual(clearances.left - 0.01);
  });

  it('clamps a bottom-right corner anchor so the popover stays within the right edge too', () => {
    const anchors = anchorsForRect({ x: 1195, y: 795, width: 0, height: 0 });
    const size = { width: 140, height: 90 };
    const placement = resolvePlacement('below', anchors, identity, size, clearances);
    const transform = placementTransform(placement, anchors, size, clearances, identity, identity);

    const match = transform.match(/translate\((-?\d+(?:\.\d+)?)px, (-?\d+(?:\.\d+)?)px\)$/);
    expect(match).not.toBeNull();
    const x = Number(match![1]);
    expect(x + size.width / 2).toBeLessThanOrEqual(1200 - clearances.right + 0.01);
  });

  /**
   * Regression coverage for the canvas crash where drawing/resizing a Boundary (or dragging any
   * node) near the point where a popover's preferred side stops fitting threw React's "Maximum
   * update depth exceeded" and took the whole canvas down (caught by `ErrorBoundary`, forcing a
   * "Restore last-known-good"). `resolvePlacement`'s own doc comment calls it "stable by
   * construction" because it only searches for a new placement once `current` genuinely stops
   * fitting — but that guarantee only holds for a single call. `ElementInspectorPopover` calls it
   * again on every render, feeding its own prior result back in as `current`; while a node is
   * being dragged, `rect` (from React Flow's live internal node position) moves every animation
   * frame, and right at this exact boundary that motion can flip which side fits from one frame
   * to the next, with each flip's `setPlacement` triggering the next render — a real, non-settling
   * oscillation, not the sub-pixel measurement noise `measuredSize` rounds away elsewhere in the
   * same component.
   *
   * This test reproduces that at the math level: an anchor that alternates, call to call, between
   * one pixel short of and one pixel past `below`'s fit threshold — exactly what a jittering live
   * drag position produces — never lets `resolvePlacement` converge on its own. That is precisely
   * why the fix does not live here: `ElementInspectorPopover` must stop calling `resolvePlacement`
   * at all while `interactionActive` is true (the same `uiStore` field `DraftEdgeView` already
   * skips obstacle avoidance for), freezing the popover on its last-good side for the duration of
   * the gesture and resolving once more, against the finally-still `rect`, only after it ends.
   */
  it('does not converge on its own when re-resolved every frame against a rect straddling the fits boundary', () => {
    const size = { width: 140, height: 90 };
    // The exact y below which 'below' stops fitting, given this clearance/size/gap.
    const boundaryY = 800 - clearances.bottom - clearances.gap - size.height;

    let placement: Placement = 'below';
    const seen = new Set<Placement>();
    for (let frame = 0; frame < 200; frame += 1) {
      // Alternates one pixel either side of the boundary, the way a live drag's sub-pixel-to-pixel
      // jitter does mid-gesture.
      const y = boundaryY + (frame % 2 === 0 ? -1 : 1);
      const anchors = anchorsForRect({ x: 600, y, width: 0, height: 0 });
      placement = resolvePlacement(placement, anchors, identity, size, clearances);
      seen.add(placement);
    }

    // Left unguarded, this keeps flipping for all 200 frames — proving `resolvePlacement` cannot
    // be trusted to settle mid-drag, which is why the component must stop calling it while
    // `interactionActive` is true instead of relying on this function alone.
    expect(seen.size).toBeGreaterThan(1);
  });
});
