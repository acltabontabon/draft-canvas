import { describe, expect, it } from 'vitest';
import { createEdge, createNode } from '../src/document/factory';
import { routeEdge, withoutRepeatedPoints } from '../src/edges/routing';

describe('a stepped line', () => {
  it('writes each point of a straight run once', () => {
    expect(withoutRepeatedPoints('M0 30L20 30L140 30L140 30L260 30L280 30')).toBe('M0 30L20 30L140 30L260 30L280 30');
    // A point that only starts the same way is another point.
    expect(withoutRepeatedPoints('M0 0L140 30L140 300')).toBe('M0 0L140 30L140 300');
    // Curves keep their own points.
    expect(withoutRepeatedPoints('M0 0L20 0L 130,0Q 140,0 140,10L 140,30')).toBe('M0 0L20 0L 130,0Q 140,0 140,10L 140,30');
  });

  it('is drawn without repeated points between two level shapes', () => {
    const a = createNode({ id: 'a', type: 'service', x: 0, y: 0, width: 160, height: 60 });
    const b = createNode({ id: 'b', type: 'service', x: 440, y: 0, width: 160, height: 60 });
    const route = routeEdge({ ...createEdge({ id: 'ab', source: 'a', target: 'b', routing: 'smoothstep' }) }, new Map([a, b].map((n) => [n.id, n])), { obstacles: [] });
    expect(route).toBeTruthy();
    const points = (route!.d.match(/[ML]\s?-?[\d.]+[ ,]-?[\d.]+/g) ?? []).map((p) => p.slice(1).trim());
    expect(points.length).toBeGreaterThan(1);
    expect(new Set(points.map((p, i) => `${i && points[i - 1] === p ? 'dup' : 'ok'}`))).toEqual(new Set(['ok']));
  });
});
