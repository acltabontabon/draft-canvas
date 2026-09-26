import { describe, expect, it } from 'vitest';
import { isLibraryShape } from '../src/document/shape';
import { ARCHITECTURE_STARTERS } from '../src/starters';
import { GLYPH_HEIGHT, GLYPH_WIDTH, starterShape } from '../src/ui/Library/starterShapes';

/**
 * The home screen's starter tiles are drawn from the starters themselves, never from a second
 * copy — so every starter the catalog gains must produce something worth drawing.
 */
describe('starterShape', () => {
  it.each(ARCHITECTURE_STARTERS.map((starter) => [starter.name, starter] as const))(
    '%s has a drawable topology that fits its tile',
    (_, starter) => {
      const { shape, boxes, bounds } = starterShape(starter);
      expect(isLibraryShape(shape)).toBe(true);
      expect(shape.nodes.length).toBeGreaterThanOrEqual(2);
      expect(shape.edges.length).toBeGreaterThanOrEqual(1);
      for (const box of boxes) {
        expect(box.x).toBeGreaterThanOrEqual(0);
        expect(box.y).toBeGreaterThanOrEqual(0);
        expect(box.x + box.w).toBeLessThanOrEqual(GLYPH_WIDTH + 0.01);
        expect(box.y + box.h).toBeLessThanOrEqual(GLYPH_HEIGHT + 0.01);
      }
      // Centred: every tile carries the same optical footprint whatever the drawing's proportions.
      const left = Math.min(...boxes.map((box) => box.x));
      const right = Math.max(...boxes.map((box) => box.x + box.w));
      expect((left + right) / 2).toBeCloseTo(GLYPH_WIDTH / 2, 0);
      expect(bounds.x).toBeCloseTo(left);
      expect(bounds.width).toBeCloseTo(right - left);
    },
  );

  it('is built once per starter', () => {
    const starter = ARCHITECTURE_STARTERS[0]!;
    expect(starterShape(starter)).toBe(starterShape(starter));
  });
});
