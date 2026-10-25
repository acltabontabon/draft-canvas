import { describe, expect, it } from 'vitest';
import { MAX_POPS, orthogonalRoute, polylineClear, type Box, type PathRequest } from '../src/edges/pathfinder';
import { flattenPath, routeBetween, type Rect } from '../src/edges/routing';

/**
 * The fallback search for connectors the quick router draws through a shape. Every answer is checked
 * against the shapes themselves, leaves and arrives square to its sides, stays inside the area it was
 * given, and says so when it could not find a clear line.
 */

const box = (x: number, y: number, width = 160, height = 80): Box => ({ x, y, width, height });
const bounds = (...boxes: Box[]): Box => {
  const x = Math.min(...boxes.map((b) => b.x)) - 256;
  const y = Math.min(...boxes.map((b) => b.y)) - 256;
  return { x, y, width: Math.max(...boxes.map((b) => b.x + b.width)) + 256 - x, height: Math.max(...boxes.map((b) => b.y + b.height)) + 256 - y };
};

/** An elbow from A's right side down into B's top, with a wall where the corner would be. */
function blockedElbow(): PathRequest {
  const a = box(0, 0);
  const b = box(480, 320);
  const wall = box(440, 20, 200, 120);
  return {
    from: { x: 160, y: 40 },
    fromSide: 'right',
    to: { x: 560, y: 320 },
    toSide: 'top',
    obstacles: [wall],
    ends: [a, b],
    bounds: bounds(a, b, wall),
  };
}

function leavesSquare(points: readonly { x: number; y: number }[]): boolean {
  const [a, b] = [points[0]!, points[1]!];
  const [y, z] = [points[points.length - 2]!, points[points.length - 1]!];
  return (a.x === b.x || a.y === b.y) && (y.x === z.x || y.y === z.y);
}

describe('orthogonalRoute', () => {
  it('routes an elbow round the shape at its corner, square at both ends', () => {
    const request = blockedElbow();
    const found = orthogonalRoute(request);
    expect(found.status).toBe('clear');
    expect(polylineClear(found.points!, [...request.obstacles, ...request.ends])).toBe(true);
    expect(found.points![0]).toEqual(request.from);
    expect(found.points![found.points!.length - 1]).toEqual(request.to);
    // Out of A's right side, into B's top: the first move runs right, the last runs down.
    expect(found.points![1]!.y).toBe(40);
    expect(found.points![1]!.x).toBeGreaterThan(160);
    expect(found.points![found.points!.length - 2]!.x).toBe(560);
    expect(leavesSquare(found.points!)).toBe(true);
    // Every run is level or plumb.
    for (let i = 1; i < found.points!.length; i += 1) {
      const [p, q] = [found.points![i - 1]!, found.points![i]!];
      expect(p.x === q.x || p.y === q.y).toBe(true);
    }
  });

  it('goes round the back of a shape it has to leave the wrong way from', () => {
    // B sits to A's left, and A's line must leave from A's right side.
    const a = box(400, 0);
    const b = box(0, 0);
    const found = orthogonalRoute({ from: { x: 560, y: 40 }, fromSide: 'right', to: { x: 160, y: 40 }, toSide: 'right', obstacles: [], ends: [a, b], bounds: bounds(a, b) });
    expect(found.status).toBe('clear');
    expect(polylineClear(found.points!, [a, b])).toBe(true);
  });

  it('says blocked, never clear, when the end is walled in', () => {
    const a = box(0, 200);
    const t = box(600, 200);
    const walls = [box(560, 120, 240, 60), box(560, 300, 240, 60), box(540, 120, 40, 240), box(780, 120, 40, 240)];
    const found = orthogonalRoute({ from: { x: 160, y: 240 }, fromSide: 'right', to: { x: 600, y: 240 }, toSide: 'left', obstacles: walls, ends: [a, t], bounds: bounds(a, t, ...walls) });
    expect(found.status).toBe('blocked');
    expect(found.points).toBeNull();
  });

  it('says budget when it runs out of work, and spends no more than it was given', () => {
    const found = orthogonalRoute(blockedElbow(), 3);
    expect(found.status).toBe('budget');
    expect(found.work).toBeLessThanOrEqual(3);
  });

  it('never leaves the area its shapes were collected from', () => {
    const request = blockedElbow();
    const tight: PathRequest = { ...request, bounds: { x: -20, y: -20, width: 700, height: 440 } };
    const found = orthogonalRoute(tight);
    for (const p of found.points ?? []) {
      expect(p.x).toBeGreaterThanOrEqual(tight.bounds.x);
      expect(p.y).toBeGreaterThanOrEqual(tight.bounds.y);
      expect(p.x).toBeLessThanOrEqual(tight.bounds.x + tight.bounds.width);
      expect(p.y).toBeLessThanOrEqual(tight.bounds.y + tight.bounds.height);
    }
  });

  it('draws the same line every time, whatever order its shapes come in', () => {
    const a = box(0, 400);
    const b = box(1600, 0);
    const field: Box[] = [];
    for (let i = 0; i < 70; i += 1) field.push(box(220 + (i % 14) * 100, 60 + Math.floor(i / 14) * 90, 60, 40));
    const request: PathRequest = { from: { x: 160, y: 440 }, fromSide: 'right', to: { x: 1600, y: 40 }, toSide: 'left', obstacles: field, ends: [a, b], bounds: bounds(a, b, ...field) };
    const first = orthogonalRoute(request);
    expect(first.status).toBe('clear');
    expect(orthogonalRoute(request)).toEqual(first);
    expect(orthogonalRoute({ ...request, obstacles: [...field].reverse() }).points).toEqual(first.points);
  });

  it('finishes a crowded area within its budget', () => {
    const a = box(0, 0);
    const b = box(2400, 2400);
    const field: Box[] = [];
    for (let i = 0; i < 400; i += 1) field.push(box(200 + (i % 20) * 110, 200 + Math.floor(i / 20) * 110, 70, 70));
    const found = orthogonalRoute({ from: { x: 160, y: 40 }, fromSide: 'right', to: { x: 2480, y: 2400 }, toSide: 'top', obstacles: field, ends: [a, b], bounds: bounds(a, b, ...field) });
    expect(['clear', 'budget']).toContain(found.status);
    expect(found.work).toBeLessThanOrEqual(MAX_POPS);
    if (found.points) expect(polylineClear(found.points, [...field, a, b])).toBe(true);
  });

  it('takes a couple of milliseconds per searched line', () => {
    // Warmed first, then timed; the median holds the budget, and the tail is allowed what a busy
    // test runner costs it (this runs beside the whole suite).
    for (let i = 0; i < 10; i += 1) orthogonalRoute(blockedElbow());
    const times: number[] = [];
    for (let i = 0; i < 60; i += 1) {
      const t0 = performance.now();
      orthogonalRoute(blockedElbow());
      times.push(performance.now() - t0);
    }
    times.sort((x, y) => x - y);
    expect(times[Math.floor(times.length / 2)]!).toBeLessThan(2);
    expect(times[Math.floor(times.length * 0.95)]!).toBeLessThan(10);
  });
});

describe('the router checks every stepped line', () => {
  const a: Rect = { x: 0, y: 0, width: 160, height: 80 };
  const b: Rect = { x: 480, y: 320, width: 160, height: 80 };
  const wall: Rect = { x: 440, y: 20, width: 200, height: 120 };
  const anchors = { source: { side: 'right' as const, offset: 0.5 }, target: { side: 'top' as const, offset: 0.5 } };

  it('routes a blocked elbow clear and says so', () => {
    const route = routeBetween(a, b, 'smoothstep', { anchors, obstacles: [wall] });
    expect(route.status).toBe('clear');
    expect(polylineClear(flattenPath(route.d), [wall])).toBe(true);
    expect(route.work).toBeGreaterThan(0);
  });

  it('marks a clear quick line clear without searching', () => {
    const route = routeBetween(a, b, 'smoothstep', { anchors, obstacles: [] });
    expect(route.status).toBe('clear');
    expect(route.work).toBe(0);
  });

  it('never searches a gesture frame', () => {
    const route = routeBetween(a, b, 'smoothstep', { anchors, obstacles: [wall], mode: 'gesture' });
    expect(route.status).toBe('unchecked');
    expect(route.work).toBe(0);
  });

  it('draws the quick line and says budget once the diagram has none left to search with', () => {
    const route = routeBetween(a, b, 'smoothstep', { anchors, obstacles: [wall], fallback: false });
    expect(route.status).toBe('budget');
    expect(route.d).toBe(routeBetween(a, b, 'smoothstep', { anchors, obstacles: [wall], mode: 'gesture' }).d);
  });

  it('leaves straight, curved and hand-bent lines unchecked', () => {
    expect(routeBetween(a, b, 'straight', { anchors, obstacles: [wall] }).status).toBe('unchecked');
    expect(routeBetween(a, b, 'bezier', { anchors, obstacles: [wall] }).status).toBe('unchecked');
    expect(routeBetween(a, b, 'smoothstep', { anchors, obstacles: [wall], waypoints: [{ x: 300, y: 200 }] }).status).toBe('unchecked');
  });
});
