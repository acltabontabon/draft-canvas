import { describe, expect, it } from 'vitest';
import { isLibraryShape } from '../src/document/shape';
import { ARCHITECTURE_STARTERS } from '../src/starters';
import { GLYPH_HEIGHT, GLYPH_WIDTH, MAX_PULSE_DEPTH, edgeDepths, starterShape } from '../src/ui/Library/starterShapes';

/**
 * The home screen's starter tiles are drawn from the starters themselves, never from a second
 * copy — so every starter the catalog gains must produce something worth drawing.
 */
describe('starterShape', () => {
  it.each(ARCHITECTURE_STARTERS.map((starter) => [starter.name, starter] as const))(
    '%s has a drawable topology that fits its tile',
    (_, starter) => {
      const { shape, depths, boxes, bounds } = starterShape(starter);
      expect(isLibraryShape(shape)).toBe(true);
      expect(shape.nodes.length).toBeGreaterThanOrEqual(2);
      expect(shape.edges.length).toBeGreaterThanOrEqual(1);
      expect(depths).toHaveLength(shape.edges.length);
      for (const depth of depths) {
        expect(Number.isInteger(depth)).toBe(true);
        expect(depth).toBeGreaterThanOrEqual(0);
        expect(depth).toBeLessThanOrEqual(MAX_PULSE_DEPTH);
      }
      for (const box of boxes) {
        expect(box.x).toBeGreaterThanOrEqual(0);
        expect(box.y).toBeGreaterThanOrEqual(0);
        expect(box.x + box.w).toBeLessThanOrEqual(GLYPH_WIDTH + 0.01);
        expect(box.y + box.h).toBeLessThanOrEqual(GLYPH_HEIGHT + 0.01);
      }
      // Flush left: every drawing starts on the same edge as the name under it.
      expect(Math.min(...boxes.map((box) => box.x))).toBeCloseTo(bounds.x);
    },
  );

  it('is built once per starter', () => {
    const starter = ARCHITECTURE_STARTERS[0]!;
    expect(starterShape(starter)).toBe(starterShape(starter));
  });
});

describe('edgeDepths', () => {
  const shape = (edges: Array<[number, number]>, count: number) => ({
    v: 1,
    w: 1000,
    h: 1000,
    nodes: Array.from({ length: count }, () => ['service', 0, 0, 10, 10] as ['service', number, number, number, number]),
    edges,
  });

  it('orders a pulse from the source outward: producer → topic → consumers', () => {
    // 0 → 1 → {2, 3}, 3 → 4
    expect(edgeDepths(shape([[0, 1], [1, 2], [1, 3], [3, 4]], 5))).toEqual([0, 1, 1, 2]);
  });

  it('still starts somewhere when every node sits on a cycle', () => {
    expect(edgeDepths(shape([[0, 1], [1, 2], [2, 0]], 3))).toEqual([0, 1, 2]);
  });

  it('caps depth so a long chain still reads as one gesture', () => {
    const chain: Array<[number, number]> = Array.from({ length: 9 }, (_, i) => [i, i + 1]);
    expect(Math.max(...edgeDepths(shape(chain, 10)))).toBe(MAX_PULSE_DEPTH);
  });
});
