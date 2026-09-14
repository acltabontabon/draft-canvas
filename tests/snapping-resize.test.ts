import { describe, expect, it } from 'vitest';
import { computeSnap, SNAP_THRESHOLD } from '../src/canvas/snapping';
import { snapResize } from '../src/canvas/resizeSnap';

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

describe('snapResize — only the edges being dragged snap', () => {
  const limits = { min: { width: 24, height: 24 }, max: { width: Infinity, height: Infinity } };
  const start = { x: 0, y: 200, width: 176, height: 68 };
  const neighbour = { x: 300, y: 100, width: 176, height: 68 };

  it('a top-right handle snaps the right edge and leaves the left edge where it was', () => {
    // Right edge dragged to 297 (3 short of the neighbour's left edge), top edge dragged up a little.
    const rect = { x: 0, y: 190, width: 297, height: 78 };
    const { rect: snapped, guides } = snapResize(start, rect, [neighbour], limits);
    expect(snapped.x).toBe(0);
    expect(snapped.x + snapped.width).toBe(300);
    expect(guides.some((guide) => guide.axis === 'x' && guide.at === 300)).toBe(true);
  });

  it('a left handle snaps the left edge and keeps the right edge fixed', () => {
    const wide = { x: 250, y: 200, width: 400, height: 68 };
    const dragged = { x: 303, y: 200, width: wide.x + wide.width - 303, height: 68 };
    const { rect: snapped } = snapResize(wide, dragged, [neighbour], limits);
    expect(snapped.x).toBe(300);
    expect(snapped.x + snapped.width).toBe(wide.x + wide.width);
  });

  it('a bottom-left handle snaps the bottom edge without moving the top', () => {
    const tall = { x: 600, y: 0, width: 176, height: 160 };
    const dragged = { x: 590, y: 0, width: 186, height: 166 };
    const { rect: snapped } = snapResize(tall, dragged, [neighbour], limits);
    expect(snapped.y).toBe(0);
    expect(snapped.y + snapped.height).toBe(neighbour.y + neighbour.height);
  });

  it('drops a snap that would break the size limits instead of clamping short of the guide', () => {
    const tiny = { x: 280, y: 400, width: 24, height: 24 };
    const dragged = { x: 280, y: 400, width: 22, height: 24 };
    const { rect: snapped, guides } = snapResize(tiny, dragged, [{ x: 300, y: 0, width: 10, height: 10 }], limits);
    expect(snapped).toEqual(dragged);
    expect(guides).toHaveLength(0);
  });
});
