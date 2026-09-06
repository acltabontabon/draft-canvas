import { describe, expect, it } from 'vitest';
import { clampPopoverCenterX, type ScreenRect } from '../src/canvas/edgeGeometry';

describe('clampPopoverCenterX', () => {
  const popoverTop = 100;
  const popoverBottom = 200;

  it('leaves the desired center alone when nothing is in the way', () => {
    expect(clampPopoverCenterX(500, 80, 12, popoverTop, popoverBottom, [])).toBe(500);
  });

  it('leaves the desired center alone when an obstacle exists but does not vertically overlap the popover', () => {
    const farAbove: ScreenRect = { left: 400, right: 600, top: -100, bottom: 0 };
    expect(clampPopoverCenterX(500, 80, 12, popoverTop, popoverBottom, [farAbove])).toBe(500);
  });

  it('the reported regression: a node just left of the desired center pushes the popover right', () => {
    // A short connector between two nodes 96px apart, popover centred on the midpoint (48) with a
    // half-width (160) far exceeding the gap — exactly Hexagonal's fork case.
    const sourceNode: ScreenRect = { left: -200, right: 0, top: 100, bottom: 200 };
    const desiredCenter = 48;
    const clamped = clampPopoverCenterX(desiredCenter, 160, 12, popoverTop, popoverBottom, [sourceNode]);
    expect(clamped).toBeGreaterThan(desiredCenter);
    expect(clamped).toBe(0 + 12 + 160);
  });

  it('a node to the right pushes the popover left', () => {
    const targetNode: ScreenRect = { left: 200, right: 400, top: 100, bottom: 200 };
    const clamped = clampPopoverCenterX(150, 80, 12, popoverTop, popoverBottom, [targetNode]);
    expect(clamped).toBeLessThan(150);
    expect(clamped).toBe(200 - 12 - 80);
  });

  it('clears both a left and a right obstacle at once, staying between them', () => {
    const left: ScreenRect = { left: -100, right: 0, top: 100, bottom: 200 };
    const right: ScreenRect = { left: 100, right: 300, top: 100, bottom: 200 };
    // 100px of open space between the two; a desired center left of the valid [35, 65] window
    // gets pulled in just enough to clear the left obstacle, without overshooting into the right.
    const clamped = clampPopoverCenterX(20, 30, 5, popoverTop, popoverBottom, [left, right]);
    expect(clamped).toBe(0 + 5 + 30);
    expect(clamped).toBeLessThanOrEqual(100 - 5 - 30);
  });

  it('falls back to the desired center when the gap between obstacles is narrower than the popover', () => {
    const left: ScreenRect = { left: -100, right: 0, top: 100, bottom: 200 };
    const right: ScreenRect = { left: 10, right: 200, top: 100, bottom: 200 };
    // Only 10px of open space, but the popover needs 2*40 + 2*5 = 90px — no position clears both.
    const clamped = clampPopoverCenterX(5, 40, 5, popoverTop, popoverBottom, [left, right]);
    expect(clamped).toBe(5);
  });
});
