import { describe, expect, it } from 'vitest';
import { CONNECTOR_SNAP_THRESHOLD, computeSnap, SNAP_THRESHOLD, type SnapLink } from '../src/canvas/snapping';
import { createNode } from '../src/document/factory';
import { anchorBandOf } from '../src/document/queueGeometry';
import { rectOf } from '../src/edges/routing';
import { straightOffset } from '../src/edges/straight';

describe('straightOffset', () => {
  it('levels a queue on the middle of its tube, not of its box', () => {
    const api = createNode({ type: 'service', x: 0, y: 0, text: 'API' });
    const queue = createNode({ type: 'queue', x: 300, y: 0, text: 'orders' });
    const offset = straightOffset({}, rectOf(api), rectOf(queue))!;
    const band = anchorBandOf(queue)!;
    expect(offset.axis).toBe('y');
    // Moving the queue by `delta` puts its tube's middle on the API's middle.
    expect((band.top + band.bottom) / 2 + offset.delta).toBeCloseTo(api.y + api.height / 2, 6);
    // Its box's middle is somewhere else entirely, which is the point.
    expect(queue.y + queue.height / 2 + offset.delta).not.toBeCloseTo(api.y + api.height / 2, 0);
  });

  it('levels a Data Store on its glyph', () => {
    const worker = createNode({ type: 'service', x: 0, y: 0, text: 'Worker' });
    const db = createNode({ type: 'database', x: 320, y: 0, text: 'DB' });
    const offset = straightOffset({}, rectOf(worker), rectOf(db))!;
    const band = anchorBandOf(db)!;
    expect((band.top + band.bottom) / 2 + offset.delta).toBeCloseTo(worker.height / 2, 6);
  });

  it('straightens an upright connector on x and keeps a pinned offset', () => {
    const top = createNode({ type: 'service', x: 0, y: 0, width: 200, height: 60, text: 'A' });
    const below = createNode({ type: 'service', x: 30, y: 200, width: 100, height: 60, text: 'B' });
    const offset = straightOffset({ sourceAnchor: { side: 'bottom', offset: 0.25 } }, rectOf(top), rectOf(below))!;
    expect(offset.axis).toBe('x');
    expect(offset.delta).toBeCloseTo(50 - 80, 6);
  });

  it('has none for a hand-bent connector or ends that do not face', () => {
    const a = createNode({ type: 'service', x: 0, y: 0, text: 'A' });
    const b = createNode({ type: 'service', x: 400, y: 10, text: 'B' });
    expect(straightOffset({ waypoints: [{ x: 300, y: 300 }] }, rectOf(a), rectOf(b))).toBeNull();
    expect(straightOffset({ targetAnchor: { side: 'top', offset: 0.5 } }, rectOf(a), rectOf(b))).toBeNull();
  });
});

describe('computeSnap: connectors', () => {
  const moving = { x: 300, y: 9, width: 100, height: 60 };
  const neighbour = { x: 0, y: 0, width: 100, height: 60 };
  const link = (delta: number): SnapLink => ({ axis: 'y', delta, at: 30, from: 100, to: 300 });

  it('catches from further away than an edge does', () => {
    expect(computeSnap(moving, [neighbour]).dy).toBe(0);
    expect(computeSnap(moving, [neighbour], SNAP_THRESHOLD, { links: [link(-9)] }).dy).toBe(-9);
    expect(computeSnap(moving, [], SNAP_THRESHOLD, { links: [link(CONNECTOR_SNAP_THRESHOLD + 1)] }).dy).toBe(0);
  });

  it('beats a nearer edge alignment on the same axis', () => {
    // The tops are 2 apart, the connector 10 from straight: the connector wins.
    const snap = computeSnap({ ...moving, y: 2 }, [neighbour], SNAP_THRESHOLD, { links: [link(10)] });
    expect(snap.dy).toBe(10);
    expect(snap.guides).toEqual([{ axis: 'y', at: 30, from: 100, to: 300, kind: 'connector' }]);
  });

  it('leaves the other axis to edge alignment', () => {
    const snap = computeSnap({ ...moving, x: 3 }, [{ x: 0, y: 200, width: 100, height: 60 }], SNAP_THRESHOLD, { links: [link(4)] });
    expect(snap).toMatchObject({ dx: -3, dy: 4 });
    expect(snap.guides.map((g) => g.kind)).toEqual([undefined, 'connector']);
  });

  it('marks every connector the same move straightens', () => {
    const snap = computeSnap(moving, [], SNAP_THRESHOLD, { links: [link(5), { ...link(5), at: 50 }, link(8)] });
    expect(snap.guides.map((g) => g.at)).toEqual([30, 50]);
  });
});

describe('computeSnap: equal spacing', () => {
  // A row: a | 80 | b, and the moving shape to the right of b.
  const a = { x: 0, y: 0, width: 100, height: 60 };
  const b = { x: 180, y: 0, width: 100, height: 60 };

  it('repeats a gap already in the row, and marks both', () => {
    const snap = computeSnap({ x: 364, y: 0, width: 100, height: 60 }, [a, b], SNAP_THRESHOLD, { spacing: [a, b] });
    expect(snap.dx).toBe(-4);
    const gaps = snap.guides.filter((g) => g.kind === 'gap');
    expect(gaps).toHaveLength(2);
    expect(gaps.every((g) => g.label === '80' && g.axis === 'y' && g.to - g.from === 80)).toBe(true);
  });

  it('repeats it before the row too', () => {
    const snap = computeSnap({ x: -183, y: 0, width: 100, height: 60 }, [a, b], SNAP_THRESHOLD, { spacing: [a, b] });
    expect(snap.dx).toBe(3);
  });

  it('centres between two neighbours', () => {
    const left = { x: 0, y: 0, width: 100, height: 60 };
    const right = { x: 400, y: 0, width: 100, height: 60 };
    const snap = computeSnap({ x: 203, y: 10, width: 100, height: 40 }, [left, right], SNAP_THRESHOLD, { spacing: [left, right] });
    expect(snap.dx).toBe(-3);
    expect(snap.guides.filter((g) => g.kind === 'gap').map((g) => g.label)).toEqual(['100', '100']);
  });

  it('works in a column', () => {
    const top = { x: 0, y: 0, width: 100, height: 60 };
    const middle = { x: 0, y: 100, width: 100, height: 60 };
    const snap = computeSnap({ x: 0, y: 205, width: 100, height: 60 }, [top, middle], 0, { spacing: [top, middle] });
    expect(snap.dy).toBe(0);
    const near = computeSnap({ x: 0, y: 205, width: 100, height: 60 }, [top, middle], SNAP_THRESHOLD, { spacing: [top, middle] });
    expect(near.dy).toBe(-5);
    expect(near.guides.filter((g) => g.kind === 'gap').every((g) => g.axis === 'x' && g.label === '40')).toBe(true);
  });

  it('ignores shapes outside the row', () => {
    const far = { x: 180, y: 400, width: 100, height: 60 };
    const snap = computeSnap({ x: 364, y: 0, width: 100, height: 60 }, [a, far], SNAP_THRESHOLD, { spacing: [a, far] });
    expect(snap.guides.some((g) => g.kind === 'gap')).toBe(false);
  });

  it('is off unless asked for, as a resize asks', () => {
    const snap = computeSnap({ x: 364, y: 0, width: 100, height: 60 }, [a, b]);
    expect(snap.guides.some((g) => g.kind === 'gap')).toBe(false);
  });
});
