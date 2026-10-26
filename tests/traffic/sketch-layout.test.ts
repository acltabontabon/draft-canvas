import { describe, expect, it } from 'vitest';
import { placeSketches, type Rect, type SketchRequest } from '../../src/traffic/sketchLayout';

function rect(x: number, y: number, width: number, height: number): Rect {
  return { x, y, width, height };
}

function overlapArea(a: Rect, b: Rect): number {
  return Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x))
    * Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));
}

function request(id: string, target: Rect, priority = 0, label = 'Finding'): SketchRequest {
  return { id, targets: [target], label: { width: label.length * 8.4 + 8, height: 27, lines: [label] }, priority };
}

describe('traffic sketch layout', () => {
  it('returns no sketches for empty input', () => {
    expect(placeSketches([], [])).toEqual([]);
  });

  it('drops requests without targets', () => {
    expect(placeSketches([
      { id: 'empty', targets: [], label: { width: 80, height: 27, lines: ['No target'] }, priority: 0 },
      request('kept', rect(0, 0, 100, 50)),
    ], [])).toHaveLength(1);
  });

  it('preserves measured multiline geometry for placement and arrows', () => {
    const label = { width: 178, height: 69, lines: ['one two three', 'four five six', 'seven eight nine'] };
    const [sketch] = placeSketches([
      { ...request('wrap', rect(0, 0, 100, 50)), label },
    ], []);
    expect(sketch?.label).toMatchObject(label);
    expect(sketch?.arrow.from.y).toBeLessThanOrEqual(sketch!.label.y + label.height);
  });

  it('places a lone note NE of its shape', () => {
    const [sketch] = placeSketches([request('alone', rect(0, 0, 100, 50))], []);
    expect(sketch?.label.x).toBe(146);
    expect(sketch?.label.y).toBeLessThan(-12);
  });

  it('moves away from a neighbour occupying the preferred NE position', () => {
    const target = rect(0, 0, 100, 50);
    const neighbour = rect(146, -80, 80, 40);
    const [sketch] = placeSketches([request('neighbour', target)], [neighbour]);
    expect(sketch).toBeDefined();
    expect(overlapArea(sketch!.label, rect(neighbour.x - 6, neighbour.y - 6, neighbour.width + 12, neighbour.height + 12))).toBe(0);
  });

  it('keeps dense findings apart and uses farther tiers to avoid shapes', () => {
    const shapes: Rect[] = [];
    for (let row = 0; row < 5; row += 1) {
      for (let column = 0; column < 6; column += 1) {
        shapes.push(rect(column * 200, row * 104, 160, 64));
      }
    }
    const requests = shapes.slice(0, 6).map((target, index) => request(`shape-${index}`, target, index, `Finding ${index}`));
    const sketches = placeSketches(requests, shapes);
    expect(sketches).toHaveLength(6);
    for (let index = 0; index < sketches.length; index += 1) {
      const current = sketches[index]!.label;
      for (let other = index + 1; other < sketches.length; other += 1) {
        expect(overlapArea(current, sketches[other]!.label)).toBe(0);
      }
    }
    const obstacleFree = sketches.filter((sketch) => shapes.every((shape) => overlapArea(sketch.label, rect(shape.x - 6, shape.y - 6, shape.width + 12, shape.height + 12)) === 0));
    expect(obstacleFree.length).toBeGreaterThanOrEqual(5);
  });

  it('lands the arrow on the ellipse and starts it on the label border', () => {
    const [sketch] = placeSketches([request('geometry', rect(20, 30, 120, 60))], []);
    expect(sketch).toBeDefined();
    const ring = sketch!.rings[0]!;
    const centre = { x: ring.x + ring.width / 2, y: ring.y + ring.height / 2 };
    const dx = sketch!.arrow.to.x - centre.x;
    const dy = sketch!.arrow.to.y - centre.y;
    expect((dx / (ring.width / 2)) ** 2 + (dy / (ring.height / 2)) ** 2).toBeCloseTo(1, 6);
    const from = sketch!.arrow.from;
    const onVerticalBorder = Math.abs(from.x - sketch!.label.x) < 1e-9 || Math.abs(from.x - (sketch!.label.x + sketch!.label.width)) < 1e-9;
    const onHorizontalBorder = Math.abs(from.y - sketch!.label.y) < 1e-9 || Math.abs(from.y - (sketch!.label.y + sketch!.label.height)) < 1e-9;
    expect(onVerticalBorder || onHorizontalBorder).toBe(true);
  });

  it('is deterministic and follows priority before request order', () => {
    const requests = [
      request('late', rect(0, 0, 80, 40), 2),
      request('early', rect(200, 0, 80, 40), 1),
      request('last', rect(400, 0, 80, 40), 3),
    ];
    const first = placeSketches(requests, []);
    const second = placeSketches(requests, []);
    const shuffled = placeSketches([requests[2]!, requests[0]!, requests[1]!], []);
    expect(first).toEqual(second);
    expect(shuffled).toEqual(first);
    expect(first.map((sketch) => sketch.id)).toEqual(['early', 'late', 'last']);
  });

  it('handles 5,000 obstacles and eight requests quickly', () => {
    const obstacles = Array.from({ length: 5000 }, (_, index) => rect((index % 100) * 80, Math.floor(index / 100) * 80, 40, 30));
    const requests = Array.from({ length: 8 }, (_, index) => request(`request-${index}`, rect(index * 160, 0, 100, 50), index));
    const started = performance.now();
    const sketches = placeSketches(requests, obstacles);
    expect(sketches).toHaveLength(8);
    expect(performance.now() - started).toBeLessThan(50);
  });
});
