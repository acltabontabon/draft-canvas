import { describe, expect, it } from 'vitest';
import { dataStoreGlyphBounds, dataStoreScale } from '../src/document/dataStoreGeometry';
import { createNode } from '../src/document/factory';
import { anchorBandOf, bandSpan } from '../src/document/queueGeometry';
import type { DraftEdge, DraftNode } from '../src/document/types';
import { connectorRoutes } from '../src/edges/connectorRoutes';
import { anchorPoint, ANCHOR_OFFSETS, rectOf, snappedAnchorForDrop } from '../src/edges/routing';
import { describeNode, sizingContext } from '../src/nodes/describe';
import type { Shape } from '../src/render/displayList';
import { getMeasurer } from '../src/render/text/measure';

/**
 * A shape drawn as a glyph takes its connectors on the glyph: its twelve connection points sit on
 * what is drawn, at every size of its box, and the glyph grows when its box is made bigger.
 */
const shape = (extra: Partial<DraftNode>, size?: { width: number; height: number }): DraftNode => ({
  ...createNode({ type: 'service', x: 100, y: 100, ...extra } as Parameters<typeof createNode>[0]),
  ...size,
});

describe('where a glyph takes its connectors', () => {
  it('keeps a default box\'s top and bottom anchors exactly where they were: a quarter, a half, three quarters of the box', () => {
    for (const node of [shape({ serviceKind: 'load-balancer' }), shape({ type: 'database' })]) {
      const rect = rectOf(node);
      for (const side of ['top', 'bottom'] as const) {
        ANCHOR_OFFSETS.forEach((offset) => expect(anchorPoint(rect, side, offset).x).toBeCloseTo(node.x + node.width * offset, 6));
      }
    }
  });

  it('keeps them on the glyph when the box is made wider for the words under it', () => {
    // 280 across around a glyph 70 across: the outer two were 70 from the middle, in the air.
    const node = shape({ serviceKind: 'gateway', description: 'Routes each request to the service that owns its path.' }, { width: 280, height: 143 });
    const rect = rectOf(node);
    const band = anchorBandOf(node)!;
    for (const side of ['top', 'bottom'] as const) {
      const xs = ANCHOR_OFFSETS.map((offset) => anchorPoint(rect, side, offset).x);
      for (const x of xs) {
        expect(x).toBeGreaterThanOrEqual(band.left!);
        expect(x).toBeLessThanOrEqual(band.right!);
      }
      // Still three apart, and the same three columns top and bottom.
      expect(xs[1]).toBeCloseTo(node.x + node.width / 2, 5);
      expect(xs[2]! - xs[1]!).toBeCloseTo(xs[1]! - xs[0]!, 5);
      expect(xs[2]! - xs[0]!).toBeGreaterThan((band.right! - band.left!) * 0.8);
    }
    // And an offset past the handles stops at the glyph's corner.
    expect(anchorPoint(rect, 'top', 0).x).toBe(band.left);
    expect(bandSpan(node, band, 'top').length).toBeLessThan(node.width);
  });

  it('puts a narrower glyph\'s side anchors on its own edge, not on the widest glyph\'s', () => {
    const wide = dataStoreGlyphBounds(shape({ serviceKind: 'worker' }));
    for (const node of [shape({ serviceKind: 'scheduler' }), shape({ type: 'component', componentKind: 'port' }), shape({ type: 'component', componentKind: 'module' })]) {
      const bounds = dataStoreGlyphBounds(node);
      expect(bounds.left).toBeGreaterThan(wide.left + 3);
      expect(bounds.right).toBeLessThan(wide.right - 3);
      expect((bounds.left + bounds.right) / 2).toBeCloseTo(node.x + node.width / 2, 5);
    }
  });

  it('leaves a card\'s on its box: Generic and External', () => {
    for (const serviceKind of ['generic', 'external'] as const) expect(anchorBandOf(shape({ serviceKind }))).toBeUndefined();
  });

  it('puts an API\'s three left anchors on the three operations it holds out', () => {
    const api = shape({ serviceKind: 'api', text: 'Orders API' });
    const rect = rectOf(api);
    const drawn = describeNode(api, { ...sizingContext(), measurer: getMeasurer() });
    const balls: { cx: number; cy: number; rx: number }[] = [];
    const visit = (list: readonly Shape[], dx: number, dy: number, k: number) => {
      for (const s of list) {
        if (s.t === 'group') visit(s.children, dx + (s.translate?.x ?? 0) * k, dy + (s.translate?.y ?? 0) * k, k * (s.scale ?? 1));
        else if (s.t === 'ellipse') balls.push({ cx: dx + s.cx * k, cy: dy + s.cy * k, rx: s.rx * k });
      }
    };
    visit(drawn.shapes, 0, 0, 1);
    expect(balls).toHaveLength(3);
    ANCHOR_OFFSETS.forEach((offset) => {
      const at = anchorPoint(rect, 'left', offset);
      const nearest = balls.reduce((a, b) => (Math.abs(b.cy + api.y - at.y) < Math.abs(a.cy + api.y - at.y) ? b : a));
      // On the ball: within its height, at its outer edge.
      expect(Math.abs(nearest.cy + api.y - at.y)).toBeLessThan(nearest.rx);
      expect(Math.abs(nearest.cx - nearest.rx + api.x - at.x)).toBeLessThan(2);
    });
  });
});

describe('a glyph in a box made bigger', () => {
  const foot = (node: DraftNode) => {
    // From the foot of the glyph to the foot of the box, less the words: what is left under them.
    const band = anchorBandOf(node)!;
    return node.y + node.height - band.bottom;
  };

  it('fills the box, where a Service glyph waited for one 250 by 200', () => {
    const start = shape({ serviceKind: 'load-balancer', text: 'Edge' });
    const base = dataStoreScale(start);
    expect(base).toBeCloseTo(114 / 88, 5);
    const sizes = [{ width: 170, height: 170 }, { width: 210, height: 210 }, { width: 260, height: 250 }];
    const scales = sizes.map((size) => dataStoreScale({ ...start, ...size }));
    expect(scales[0]).toBeGreaterThan(base * 1.5);
    expect(scales[1]).toBeGreaterThan(scales[0]!);
    expect(scales[2]).toBeGreaterThan(scales[1]!);
    // Its connection points go with it.
    const bigger = anchorBandOf({ ...start, ...sizes[1]! })!;
    const was = anchorBandOf(start)!;
    expect(bigger.right! - bigger.left!).toBeGreaterThan(was.right! - was.left!);
  });

  it('leaves under the name what a default box leaves, however tall or narrow the box', () => {
    // What made the bottom connection points hang a hand's width below the name.
    const usual = foot(shape({ serviceKind: 'gateway', text: 'Gateway' }));
    for (const size of [{ width: 210, height: 210 }, { width: 150, height: 260 }, { width: 300, height: 180 }, { width: 400, height: 400 }]) {
      for (const node of [shape({ serviceKind: 'gateway', text: 'Gateway' }, size), shape({ type: 'component', componentKind: 'module', text: 'Module' }, size), shape({ type: 'component', componentKind: 'port', text: 'Port' }, size)]) {
        expect(foot(node), `${node.componentKind ?? node.serviceKind} ${size.width}x${size.height}`).toBeCloseTo(usual, 3);
      }
    }
    // A plain Data Store has no kind under its name: in a bigger box that room closes up too.
    const store = shape({ type: 'database', text: 'Orders DB' }, { width: 170, height: 180 });
    expect(foot(store) - 18.9).toBeLessThan(usual + 6);
  });

  it('stays exactly as it was in a box that is only about as big as its words need', () => {
    const base = 114 / 88;
    // Wider for a long name, taller for a description, or a line to spare: nothing changes.
    for (const node of [
      shape({ serviceKind: 'worker', text: 'Nightly Reconciliation Worker' }, { width: 220, height: 114 }),
      shape({ serviceKind: 'worker', text: 'Worker', description: 'Reads the queue.' }, { width: 200, height: 143 }),
      shape({ serviceKind: 'worker', text: 'Worker', technology: 'Go' }, { width: 176, height: 128 }),
    ]) {
      expect(dataStoreScale(node)).toBeCloseTo(base, 5);
      expect(anchorBandOf(node)!.top - node.y).toBeCloseTo(9 * base, 5);
    }
  });

  it('grows a Data Store past the scale its box alone gave it', () => {
    const store = { ...createNode({ type: 'database', x: 0, y: 0, text: 'Orders' }), width: 180, height: 176 };
    expect(dataStoreScale(store)).toBeGreaterThan(2);
  });
});

describe('a connector dropped near a glyph', () => {
  // A described Adapter: a box much wider and taller than the glyph at the top of it.
  const adapter = shape({ type: 'component', componentKind: 'adapter', text: 'Adapter', description: 'Speaks SQL to the orders database on behalf of the core.' }, { width: 190, height: 180 });
  const rect = rectOf(adapter);
  const band = anchorBandOf(adapter)!;
  const middle = (band.top + band.bottom) / 2;

  it('takes the side of the glyph it was dropped on, not the nearest side of the box', () => {
    // Just outside the middle of the glyph's left edge: nearer the box's top than the box's left.
    expect(snappedAnchorForDrop(rect, { x: band.left! - 4, y: middle })).toEqual({ side: 'left', offset: 0.5 });
    expect(snappedAnchorForDrop(rect, { x: band.right! + 4, y: middle })).toEqual({ side: 'right', offset: 0.5 });
    expect(snappedAnchorForDrop(rect, { x: band.left! - 4, y: band.top + (band.bottom - band.top) * 0.25 })).toEqual({ side: 'left', offset: 0.25 });
    expect(snappedAnchorForDrop(rect, { x: adapter.x + adapter.width / 2, y: band.top - 4 })).toEqual({ side: 'top', offset: 0.5 });
    expect(snappedAnchorForDrop(rect, { x: adapter.x + adapter.width / 2, y: adapter.y + adapter.height - 3 })).toEqual({ side: 'bottom', offset: 0.5 });
  });

  it('stays automatic for a drop on the middle of the glyph', () => {
    expect(snappedAnchorForDrop(rect, { x: adapter.x + adapter.width / 2, y: middle })).toBeUndefined();
  });
});

describe('a reply beside its request on a glyph', () => {
  // A person a little lower than the API they call: the request is straightened onto the bottom of
  // the glyph's short side, and the reply, stepped below it and clamped back, was drawn on the very
  // same line: one stroke with an arrowhead at each end.
  const person = { ...createNode({ type: 'actor', x: 10, y: 597 } as Parameters<typeof createNode>[0]), id: 'person', width: 120, height: 134 };
  const api = { ...shape({ serviceKind: 'api', text: 'Orders Service', description: 'Takes orders and publishes what happens to them.' }, { width: 180, height: 157 }), id: 'api', x: 310, y: 586 };
  const call: DraftEdge = { id: 'call', source: 'person', target: 'api', directed: true, routing: 'smoothstep', label: 'Places order', hasResponse: true };

  it('is drawn on a line of its own, on the side of the request that has room', () => {
    const routes = connectorRoutes(call, { nodes: [person, api], edges: [call] }, 'transient')!;
    const band = anchorBandOf(api)!;
    const { request, response } = routes;
    expect(response).not.toBeNull();
    // Level, both of them, and a lane apart at both ends.
    expect(request.source.y).toBeCloseTo(request.target.y, 6);
    expect(response!.source.y).toBeCloseTo(response!.target.y, 6);
    expect(Math.abs(response!.source.y - request.target.y)).toBeGreaterThanOrEqual(16);
    // Both still on the glyph.
    for (const y of [request.target.y, response!.source.y]) {
      expect(y).toBeGreaterThanOrEqual(band.top);
      expect(y).toBeLessThanOrEqual(band.bottom);
    }
  });
});
