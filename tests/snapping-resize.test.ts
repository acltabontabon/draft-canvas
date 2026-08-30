import { describe, expect, it } from 'vitest';
import { computeSnap, SNAP_THRESHOLD } from '../src/canvas/snapping';

/**
 * Resize snapping reuses `computeSnap` unmodified — see `snapResizeChanges`
 * in `src/canvas/Canvas.tsx`, which feeds it the in-progress resized rect
 * instead of a moved one. These tests exercise that same math directly
 * against a resize-shaped scenario, since `computeSnap` itself has no idea
 * whether the rect it was given came from a drag or a resize.
 */
describe('resize snapping', () => {
  const neighbour = { x: 300, y: 100, width: 176, height: 68 };

  it('snaps and produces a guide when the resized edge lands within threshold', () => {
    // A node being resized from its bottom-right handle — width has grown so
    // its right edge sits just inside SNAP_THRESHOLD of the neighbour's left edge.
    const resizing = { x: 0, y: 100, width: 300 - (SNAP_THRESHOLD - 2), height: 68 };
    const snap = computeSnap(resizing, [neighbour]);

    expect(snap.dx).not.toBe(0);
    expect(snap.guides.some((guide) => guide.axis === 'x')).toBe(true);
    // The corrected right edge lands exactly on the neighbour's left edge.
    expect(resizing.x + resizing.width + snap.dx).toBe(neighbour.x);
  });

  it('does not snap once the gap exceeds the threshold', () => {
    // Offset vertically too, so no other axis coincidentally aligns.
    const resizing = { x: 0, y: 250, width: 300 - (SNAP_THRESHOLD + 10), height: 68 };
    const snap = computeSnap(resizing, [neighbour]);

    expect(snap.dx).toBe(0);
    expect(snap.dy).toBe(0);
    expect(snap.guides).toHaveLength(0);
  });

  it('also snaps vertically, independently of the horizontal axis', () => {
    const resizing = { x: 0, y: 100 - (SNAP_THRESHOLD - 1), width: 300, height: 68 };
    const snap = computeSnap(resizing, [neighbour]);

    expect(snap.dy).not.toBe(0);
    expect(resizing.y + snap.dy).toBe(neighbour.y);
  });
});
