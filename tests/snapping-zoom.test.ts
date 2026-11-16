import type { NodeChange } from '@xyflow/react';
import { afterEach, describe, expect, it } from 'vitest';
import { createNode } from '../src/document/factory';
import type { DraftRfNode } from '../src/canvas/projection';
import { NO_DRAG_SNAP, snapChanges, snapResizeChanges, type DragSnapContext, type NodeLookup } from '../src/canvas/dragSnap';
import { snapResize } from '../src/canvas/resizeSnap';
import { snapBypassed, trackSnapBypass } from '../src/canvas/snapBypass';
import { CONNECTOR_SNAP_THRESHOLD, computeSnap, snapReach, SNAP_THRESHOLD, type SnapLink } from '../src/canvas/snapping';

/**
 * Snapping pulls a shape the same distance on screen at every zoom. The thresholds are screen
 * pixels (`SNAP_THRESHOLD`, `CONNECTOR_SNAP_THRESHOLD`), and what the canvas hands `computeSnap` is
 * `snapReach(zoom)` — left in canvas units, the pull was 24 px at 4x and a barely-there 1.5 px at
 * 0.25x, with nothing to switch it off.
 */

const ZOOMS = [0.25, 1, 4] as const;
const neighbour = { x: 1000, y: 0, width: 100, height: 60 };
/** A shape whose right edge is `gap` canvas units short of the neighbour's left edge. */
const approaching = (gap: number) => ({ x: 1000 - gap - 100, y: 500, width: 100, height: 60 });

describe('snapReach', () => {
  it('is the thresholds in pixels at zoom 1, and the same pixels at any zoom', () => {
    expect(snapReach(1)).toEqual({ threshold: SNAP_THRESHOLD, connectorThreshold: CONNECTOR_SNAP_THRESHOLD });
    for (const zoom of ZOOMS) {
      const reach = snapReach(zoom);
      expect(reach.threshold * zoom).toBeCloseTo(SNAP_THRESHOLD);
      expect(reach.connectorThreshold * zoom).toBeCloseTo(CONNECTOR_SNAP_THRESHOLD);
    }
  });

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])('reads a zoom of %s as 1 rather than dividing by it', (zoom) => {
    const reach = snapReach(zoom);
    expect(Number.isFinite(reach.threshold)).toBe(true);
    expect(reach.threshold).toBeGreaterThan(0);
  });
});

describe('computeSnap at a zoom', () => {
  it.each(ZOOMS)('catches an edge within 6 screen pixels, and not beyond, at zoom %s', (zoom) => {
    const { threshold, connectorThreshold } = snapReach(zoom);
    const inside = computeSnap(approaching(5.5 / zoom), [neighbour], threshold, { connectorThreshold });
    expect(inside.dx).toBeCloseTo(5.5 / zoom);
    const outside = computeSnap(approaching(6.5 / zoom), [neighbour], threshold, { connectorThreshold });
    expect(outside.dx).toBe(0);
  });

  it('pulls a zoomed-in shape a few units, not the 24 pixels it did', () => {
    // 4 canvas units is 16 px on screen at 4x: no longer close enough to be pulled.
    const { threshold } = snapReach(4);
    expect(computeSnap(approaching(4), [neighbour], threshold).dx).toBe(0);
    // And a zoomed-out one reaches for what is 6 pixels away: 24 units at 0.25x.
    const out = snapReach(0.25);
    expect(computeSnap(approaching(20), [neighbour], out.threshold).dx).toBe(20);
  });

  it.each(ZOOMS)('pulls a connector straight from 12 screen pixels, and not beyond, at zoom %s', (zoom) => {
    const { threshold, connectorThreshold } = snapReach(zoom);
    const link = (delta: number): SnapLink => ({ axis: 'y', delta, at: 40, from: 0, to: 300 });
    const moving = { x: 0, y: 0, width: 100, height: 60 };
    expect(computeSnap(moving, [], threshold, { links: [link(11.5 / zoom)], connectorThreshold }).dy).toBeCloseTo(11.5 / zoom);
    expect(computeSnap(moving, [], threshold, { links: [link(12.5 / zoom)], connectorThreshold }).dy).toBe(0);
  });

  it('keeps the connector reach at 12 units when none is given, as before', () => {
    const moving = { x: 0, y: 0, width: 100, height: 60 };
    const link = (delta: number): SnapLink => ({ axis: 'y', delta, at: 40, from: 0, to: 300 });
    expect(computeSnap(moving, [], SNAP_THRESHOLD, { links: [link(11)] }).dy).toBe(11);
    expect(computeSnap(moving, [], SNAP_THRESHOLD, { links: [link(13)] }).dy).toBe(0);
  });
});

describe('snapResize at a zoom', () => {
  const limits = { min: { width: 24, height: 24 }, max: { width: Infinity, height: Infinity } };
  const start = { x: 0, y: 500, width: 700, height: 60 };

  it.each(ZOOMS)('snaps a dragged edge from 6 screen pixels, not further, at zoom %s', (zoom) => {
    const { threshold } = snapReach(zoom);
    const near = { ...start, width: 1000 - 5.5 / zoom };
    expect(snapResize(start, near, [neighbour], limits, threshold).rect.width).toBe(1000);
    const far = { ...start, width: 1000 - 6.5 / zoom };
    expect(snapResize(start, far, [neighbour], limits, threshold).rect.width).toBe(far.width);
  });
});

/** A React Flow node as the lookups see it mid-gesture. */
function live(position: { x: number; y: number }, size: { width: number; height: number }): ReturnType<NodeLookup> {
  return { position, width: size.width, height: size.height, measured: size };
}

describe('the frame-by-frame snapping the canvas runs', () => {
  const context: DragSnapContext = {
    ...NO_DRAG_SNAP,
    statics: [neighbour],
    spacing: [neighbour],
    origin: new Map([['moving', { x: 0, y: 500 }]]),
  };
  const lookup: NodeLookup = () => live({ x: 0, y: 500 }, { width: 100, height: 60 });
  const frameAt = (gap: number): NodeChange<DraftRfNode>[] => [
    { type: 'position', id: 'moving', position: { x: 1000 - gap - 100, y: 500 }, dragging: true },
  ];
  const movedTo = (result: { changes: NodeChange<DraftRfNode>[] }) => {
    const change = result.changes[0]!;
    return change.type === 'position' ? change.position!.x : Number.NaN;
  };

  it.each(ZOOMS)('draws a shape to the neighbour from 5 pixels away, and leaves it 7 away, at zoom %s', (zoom) => {
    expect(movedTo(snapChanges(frameAt(5 / zoom), lookup, context, { zoom, bypass: false }))).toBeCloseTo(900);
    expect(movedTo(snapChanges(frameAt(7 / zoom), lookup, context, { zoom, bypass: false }))).toBeCloseTo(900 - 7 / zoom);
  });

  it.each(ZOOMS)('takes no snap at all while the bypass is held, at zoom %s', (zoom) => {
    const result = snapChanges(frameAt(2 / zoom), lookup, context, { zoom, bypass: true });
    expect(movedTo(result)).toBeCloseTo(900 - 2 / zoom);
    expect(result.guides).toEqual([]);
  });

  describe('a resize', () => {
    const node = createNode({ id: 'resizing', type: 'service', x: 0, y: 500, width: 700, height: 60, text: 'A' });
    const byId = new Map([[node.id, node]]);
    const rfLookup: NodeLookup = () => live({ x: 0, y: 500 }, { width: 700, height: 60 });
    const growTo = (width: number): NodeChange<DraftRfNode>[] => [
      { type: 'dimensions', id: 'resizing', dimensions: { width, height: 60 }, resizing: true },
    ];
    const widthOf = (result: { changes: NodeChange<DraftRfNode>[] }) => {
      const change = result.changes[0]!;
      return change.type === 'dimensions' ? change.dimensions!.width : Number.NaN;
    };

    it.each(ZOOMS)('snaps to the neighbour within 6 pixels at zoom %s', (zoom) => {
      expect(widthOf(snapResizeChanges(growTo(1000 - 5 / zoom), rfLookup, [neighbour], byId, { zoom, bypass: false }))).toBe(1000);
      expect(widthOf(snapResizeChanges(growTo(1000 - 7 / zoom), rfLookup, [neighbour], byId, { zoom, bypass: false }))).toBeCloseTo(1000 - 7 / zoom);
    });

    it('takes no snap while the bypass is held, and shows no guide', () => {
      const result = snapResizeChanges(growTo(997), rfLookup, [neighbour], byId, { zoom: 1, bypass: true });
      expect(widthOf(result)).toBe(997);
      expect(result.guides).toEqual([]);
    });

    it('still commits the rect its last live frame showed, with the bypass held', () => {
      const finish: NodeChange<DraftRfNode>[] = [{ type: 'dimensions', id: 'resizing', dimensions: { width: 1234, height: 60 }, resizing: false }];
      const result = snapResizeChanges(finish, rfLookup, [neighbour], byId, { zoom: 1, bypass: true });
      expect(widthOf(result)).toBe(700);
    });
  });
});

describe('holding Alt', () => {
  let stop: () => void = () => {};
  afterEach(() => stop());

  const press = (type: 'keydown' | 'keyup' | 'pointermove', init: KeyboardEventInit & MouseEventInit = {}) => {
    const event = type === 'pointermove' ? new MouseEvent('pointermove', init) : new KeyboardEvent(type, { key: 'Alt', ...init });
    window.dispatchEvent(event);
  };

  it('bypasses snapping from the key going down until it comes up', () => {
    stop = trackSnapBypass();
    expect(snapBypassed()).toBe(false);
    press('keydown', { altKey: true });
    expect(snapBypassed()).toBe(true);
    press('keyup', { altKey: false });
    expect(snapBypassed()).toBe(false);
  });

  it('reads the pointer\'s own modifier, which a gesture started with Alt already down has', () => {
    stop = trackSnapBypass();
    press('pointermove', { altKey: true });
    expect(snapBypassed()).toBe(true);
    press('pointermove', { altKey: false });
    expect(snapBypassed()).toBe(false);
  });

  it('forgets it when the window loses focus: a key released elsewhere never arrives', () => {
    stop = trackSnapBypass();
    press('keydown', { altKey: true });
    window.dispatchEvent(new Event('blur'));
    expect(snapBypassed()).toBe(false);
  });

  it('stops following, and lets go, when the canvas goes away', () => {
    stop = trackSnapBypass();
    press('keydown', { altKey: true });
    stop();
    expect(snapBypassed()).toBe(false);
    press('keydown', { altKey: true });
    expect(snapBypassed()).toBe(false);
  });
});
