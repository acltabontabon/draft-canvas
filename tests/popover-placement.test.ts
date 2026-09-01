import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  anchorsForRect,
  placementTransform,
  resolvePlacement,
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
});
