import { describe, expect, it, beforeEach } from 'vitest';
import { clearPathCache, distanceToPath, distanceToPolyline, distanceToSegment } from '../src/edges/nearest';

describe('distanceToSegment', () => {
  it('measures to the segment, not to the infinite line through it', () => {
    // Perpendicular foot falls beyond the segment's end, so the endpoint is the answer.
    expect(distanceToSegment({ x: 20, y: 0 }, { x: 0, y: 0 }, { x: 10, y: 0 })).toBe(10);
    // ...and inside it, the perpendicular distance is.
    expect(distanceToSegment({ x: 5, y: 3 }, { x: 0, y: 0 }, { x: 10, y: 0 })).toBe(3);
  });

  it('treats a zero-length segment as its own endpoint', () => {
    expect(distanceToSegment({ x: 3, y: 4 }, { x: 0, y: 0 }, { x: 0, y: 0 })).toBe(5);
  });
});

describe('distanceToPolyline', () => {
  it('finds the nearest of several segments, including across a bend', () => {
    // An elbow: right along the top, then down the right-hand side.
    const elbow = [
      { x: 0, y: 0 },
      { x: 100, y: 0 },
      { x: 100, y: 100 },
    ];
    // Nearest to the vertical leg, not to the horizontal one it started on.
    expect(distanceToPolyline({ x: 108, y: 80 }, elbow)).toBe(8);
    expect(distanceToPolyline({ x: 40, y: -5 }, elbow)).toBe(5);
  });

  it('answers null for nothing to measure against, so a caller keeps its fallback', () => {
    expect(distanceToPolyline({ x: 0, y: 0 }, [])).toBeNull();
  });

  it('measures to the point itself when a path has only one vertex', () => {
    expect(distanceToPolyline({ x: 3, y: 4 }, [{ x: 0, y: 0 }])).toBe(5);
  });
});

describe('distanceToPath', () => {
  beforeEach(clearPathCache);

  it('reads a route `d` string in the same space the aim point is in', () => {
    expect(distanceToPath({ x: 50, y: 10 }, 'M 0,0 L 100,0')).toBe(10);
  });

  it('separates two parallel routes by distance rather than by order', () => {
    const near = distanceToPath({ x: 50, y: 58 }, 'M 0,60 L 100,60')!;
    const far = distanceToPath({ x: 50, y: 58 }, 'M 0,0 L 100,0')!;
    expect(near).toBeLessThan(far);
  });

  it('answers null for a path it cannot read, rather than pretending it is far away', () => {
    // Arcs are outside what `flattenPath` parses; the caller falls back to paint order.
    expect(distanceToPath({ x: 0, y: 0 }, 'M 0,0 A 10 10 0 0 1 20,20')).toBeNull();
  });

  it('caches by the `d` string, and forgets it when a gesture ends', () => {
    const d = 'M 0,0 L 100,0';
    expect(distanceToPath({ x: 50, y: 4 }, d)).toBe(4);
    clearPathCache();
    // Same answer after the cache is dropped — the cache is an optimisation, never the source.
    expect(distanceToPath({ x: 50, y: 4 }, d)).toBe(4);
  });
});
