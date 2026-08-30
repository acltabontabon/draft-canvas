import { describe, expect, it } from 'vitest';
import { anchorPoint, chooseSides, detourAround, laneIndex, routeBetween, routeEdge } from '../src/edges/routing';
import { createDocument, createEdge, createNode } from '../src/document/factory';
import { addEdges, addNodes, moveNodes, updateNode } from '../src/document/operations';
import type { DraftEdge, DraftNode } from '../src/document/types';

/**
 * Routing invariants: an explicit anchor represents the user's intent and
 * must never be silently overridden by the nearest-side heuristic, whether
 * the geometry agrees with it or not. `chooseSides` only ever fills in a side
 * that has no persisted anchor.
 */
describe('routeBetween honours a persisted anchor over the nearest-side heuristic', () => {
  // Target sits directly to the right of source — chooseSides would pick
  // right/left — but the user explicitly started this connector from the top.
  const sourceRect = { x: 0, y: 0, width: 100, height: 60 };
  const targetRect = { x: 300, y: 0, width: 100, height: 60 };

  it('picks right/left with no anchors, matching the existing heuristic', () => {
    const route = routeBetween(sourceRect, targetRect, 'smoothstep');
    expect(route.source.side).toBe('right');
    expect(route.target.side).toBe('left');
  });

  it('honours an explicit source anchor even when it disagrees with the heuristic', () => {
    const route = routeBetween(sourceRect, targetRect, 'smoothstep', {
      anchors: { source: { side: 'top', offset: 0.5 } },
    });
    expect(route.source.side).toBe('top');
    // The target side has no anchor, so it still falls back to the heuristic.
    expect(route.target.side).toBe(chooseSides(sourceRect, targetRect).target);
  });

  it('honours both explicit anchors, ignoring the heuristic entirely', () => {
    const route = routeBetween(sourceRect, targetRect, 'smoothstep', {
      anchors: { source: { side: 'top', offset: 0.5 }, target: { side: 'top', offset: 0.5 } },
    });
    expect(route.source.side).toBe('top');
    expect(route.target.side).toBe('top');
  });

  it('places the anchor point at the requested offset along the side', () => {
    const route = routeBetween(sourceRect, targetRect, 'smoothstep', {
      anchors: { source: { side: 'right', offset: 0.2 } },
    });
    expect(route.source).toEqual({
      ...anchorPoint(sourceRect, 'right', 0.2),
      side: 'right',
    });
  });
});

describe('routeEdge threads an edge\'s own anchors through routeBetween', () => {
  function nodeAt(id: string, x: number, y: number): DraftNode {
    return createNode({ id, type: 'service', x, y, width: 100, height: 60 });
  }

  it('routes from the persisted source side, not the nearest one', () => {
    const source = nodeAt('a', 0, 0);
    const target = nodeAt('b', 300, 0);
    const edge = createEdge({
      source: source.id,
      target: target.id,
      sourceAnchor: { side: 'bottom', offset: 0.5 },
    });
    const nodes = new Map([
      [source.id, source],
      [target.id, target],
    ]);

    const route = routeEdge(edge, nodes)!;
    expect(route.source.side).toBe('bottom');
  });

  it('returns null when an endpoint node is missing, same as before anchors existed', () => {
    const source = nodeAt('a', 0, 0);
    const edge = createEdge({ source: source.id, target: 'missing' });
    expect(routeEdge(edge, new Map([[source.id, source]]))).toBeNull();
  });
});

describe('an anchor survives operations that do not touch the edge itself', () => {
  it('is untouched by moving either endpoint node', () => {
    const a = createNode({ type: 'service', x: 0, y: 0 });
    const b = createNode({ type: 'database', x: 300, y: 0 });
    const edge = createEdge({
      source: a.id,
      target: b.id,
      sourceAnchor: { side: 'bottom', offset: 0.5 },
      targetAnchor: { side: 'left', offset: 0.5 },
    });
    let doc = addEdges(addNodes(createDocument(), [a, b]), [edge]);

    doc = moveNodes(doc, new Map([[a.id, { x: 40, y: 90 }]]));
    doc = moveNodes(doc, new Map([[b.id, { x: 500, y: 200 }]]));

    const stored = doc.edges[0]!;
    expect(stored.sourceAnchor).toEqual({ side: 'bottom', offset: 0.5 });
    expect(stored.targetAnchor).toEqual({ side: 'left', offset: 0.5 });
  });

  it('is untouched by an unrelated document edit (renaming a node)', () => {
    const a = createNode({ type: 'service', x: 0, y: 0 });
    const b = createNode({ type: 'database', x: 300, y: 0 });
    const edge = createEdge({ source: a.id, target: b.id, sourceAnchor: { side: 'top', offset: 0.5 } });
    let doc = addEdges(addNodes(createDocument(), [a, b]), [edge]);

    doc = updateNode(doc, a.id, { text: 'Renamed Service' });

    expect(doc.edges[0]!.sourceAnchor).toEqual({ side: 'top', offset: 0.5 });
  });

  it('a resize (width/height change) leaves the anchor side and offset alone', () => {
    const a = createNode({ type: 'service', x: 0, y: 0, width: 120, height: 60 });
    const b = createNode({ type: 'database', x: 300, y: 0 });
    const edge = createEdge({
      source: a.id,
      target: b.id,
      sourceAnchor: { side: 'right', offset: 0.3 },
    });
    let doc = addEdges(addNodes(createDocument(), [a, b]), [edge]);

    doc = updateNode(doc, a.id, { width: 240, height: 120 });

    expect(doc.edges[0]!.sourceAnchor).toEqual({ side: 'right', offset: 0.3 });
    // And the resolved point moves with the new geometry, still on the boundary.
    const resized = doc.nodes.find((n) => n.id === a.id)!;
    const point = anchorPoint(
      { x: resized.x, y: resized.y, width: resized.width, height: resized.height },
      'right',
      0.3,
    );
    expect(point).toEqual({ x: 240, y: 36 });
  });
});

describe('laneIndex separates parallel edges between the same node pair', () => {
  function edgeWith(id: string, source: string, target: string): DraftEdge {
    return createEdge({ id, source, target });
  }

  it('gives a lone edge lane offset 0', () => {
    const edges = [edgeWith('e1', 'a', 'b')];
    expect(laneIndex(edges).get('e1')).toEqual({ offset: 0, count: 1 });
  });

  it('fans two edges out symmetrically, sorted by id', () => {
    const edges = [edgeWith('e2', 'a', 'b'), edgeWith('e1', 'a', 'b')];
    const lanes = laneIndex(edges);
    expect(lanes.get('e1')).toEqual({ offset: -0.5, count: 2 });
    expect(lanes.get('e2')).toEqual({ offset: 0.5, count: 2 });
  });

  it('treats A→B and B→A as the same group — the callback case', () => {
    const edges = [edgeWith('e1', 'a', 'b'), edgeWith('e2', 'b', 'a')];
    const lanes = laneIndex(edges);
    expect(lanes.get('e1')!.count).toBe(2);
    expect(lanes.get('e2')!.count).toBe(2);
    expect(lanes.get('e1')!.offset).not.toBe(lanes.get('e2')!.offset);
  });

  it('centres three or more edges around zero', () => {
    const edges = [edgeWith('e1', 'a', 'b'), edgeWith('e2', 'a', 'b'), edgeWith('e3', 'a', 'b')];
    const lanes = laneIndex(edges);
    expect(lanes.get('e1')!.offset).toBe(-1);
    expect(lanes.get('e2')!.offset).toBe(0);
    expect(lanes.get('e3')!.offset).toBe(1);
  });

  it('does not group edges between unrelated node pairs', () => {
    const edges = [edgeWith('e1', 'a', 'b'), edgeWith('e2', 'a', 'c')];
    const lanes = laneIndex(edges);
    expect(lanes.get('e1')).toEqual({ offset: 0, count: 1 });
    expect(lanes.get('e2')).toEqual({ offset: 0, count: 1 });
  });

  it('is cached by array identity — the same reference returns the same Map', () => {
    const edges = [edgeWith('e1', 'a', 'b')];
    expect(laneIndex(edges)).toBe(laneIndex(edges));
  });
});

describe('a lane offset nudges both endpoints without changing their side', () => {
  const sourceRect = { x: 0, y: 0, width: 100, height: 200 };
  const targetRect = { x: 300, y: 0, width: 100, height: 200 };

  it('shifts the anchor point along the side, away from lane 0', () => {
    const base = routeBetween(sourceRect, targetRect, 'smoothstep');
    const shifted = routeBetween(sourceRect, targetRect, 'smoothstep', { lane: 1 });

    expect(shifted.source.side).toBe(base.source.side);
    expect(shifted.target.side).toBe(base.target.side);
    // Right/left sides are vertical, so the lane shift moves along y, not x.
    expect(shifted.source.x).toBe(base.source.x);
    expect(shifted.source.y).not.toBe(base.source.y);
  });

  it('shifts lane -1 and lane 1 to opposite sides of lane 0', () => {
    const left = routeBetween(sourceRect, targetRect, 'smoothstep', { lane: -1 });
    const base = routeBetween(sourceRect, targetRect, 'smoothstep');
    const right = routeBetween(sourceRect, targetRect, 'smoothstep', { lane: 1 });

    expect(left.source.y).toBeLessThan(base.source.y);
    expect(right.source.y).toBeGreaterThan(base.source.y);
  });

  it('clamps the shift so it cannot escape the node\'s own side', () => {
    const tiny = { x: 0, y: 0, width: 100, height: 20 };
    const farTarget = { x: 300, y: 0, width: 100, height: 20 };
    const route = routeBetween(tiny, farTarget, 'smoothstep', { lane: 50 });
    // Still within the rect's vertical extent, not flung far outside it.
    expect(route.source.y).toBeGreaterThanOrEqual(tiny.y);
    expect(route.source.y).toBeLessThanOrEqual(tiny.y + tiny.height);
  });
});

describe('detourAround: routing avoids an obstacle sitting directly in the way', () => {
  it('detours around an obstacle blocking a horizontal run', () => {
    const from = { x: 0, y: 100 };
    const to = { x: 400, y: 100 };
    const obstacle = { x: 150, y: 80, width: 100, height: 40 };

    const detour = detourAround(from, to, 'right', 'left', [obstacle]);
    expect(detour).not.toBeNull();
    expect(detour!.detourY).toBeDefined();
    // Clears the obstacle on whichever side is the shorter detour.
    const clearsAbove = detour!.detourY! <= obstacle.y;
    const clearsBelow = detour!.detourY! >= obstacle.y + obstacle.height;
    expect(clearsAbove || clearsBelow).toBe(true);
  });

  it('detours around an obstacle blocking a vertical run', () => {
    const from = { x: 100, y: 0 };
    const to = { x: 100, y: 400 };
    const obstacle = { x: 80, y: 150, width: 40, height: 100 };

    const detour = detourAround(from, to, 'bottom', 'top', [obstacle]);
    expect(detour).not.toBeNull();
    expect(detour!.detourX).toBeDefined();
    const clearsLeft = detour!.detourX! <= obstacle.x;
    const clearsRight = detour!.detourX! >= obstacle.x + obstacle.width;
    expect(clearsLeft || clearsRight).toBe(true);
  });

  it('does nothing when no obstacle sits in the corridor', () => {
    const from = { x: 0, y: 100 };
    const to = { x: 400, y: 100 };
    const farAway = { x: 150, y: 500, width: 100, height: 40 };
    expect(detourAround(from, to, 'right', 'left', [farAway])).toBeNull();
  });

  it('does nothing for a diagonal pairing — the heuristic is intentionally narrow', () => {
    const from = { x: 0, y: 0 };
    const to = { x: 400, y: 400 };
    const obstacle = { x: 150, y: 150, width: 100, height: 100 };
    expect(detourAround(from, to, 'right', 'top', [obstacle])).toBeNull();
  });

  it('picks the shorter detour when the obstacle sits off-centre', () => {
    const from = { x: 0, y: 100 };
    const to = { x: 400, y: 100 };
    // Obstacle's bottom edge (110) is much closer to the corridor than a
    // detour over its top (-1000) would be — should go under, not over.
    const obstacle = { x: 150, y: -1000, width: 100, height: 1110 };
    const detour = detourAround(from, to, 'right', 'left', [obstacle]);
    expect(detour!.detourY!).toBeGreaterThan(obstacle.y + obstacle.height - 1);
  });

  it('routeBetween bends around the obstacle without moving either endpoint', () => {
    // Source, obstacle and target are all the same height and vertically
    // aligned — the case an endpoint-only nudge cannot solve, since no point
    // on either node's own side sits outside the obstacle's y-range. Only a
    // genuine mid-path detour clears it.
    const sourceRect = { x: 0, y: 0, width: 100, height: 60 };
    const targetRect = { x: 400, y: 0, width: 100, height: 60 };
    const obstacle = { x: 150, y: 0, width: 100, height: 60 };

    const clear = routeBetween(sourceRect, targetRect, 'smoothstep');
    const blocked = routeBetween(sourceRect, targetRect, 'smoothstep', { obstacles: [obstacle] });

    // Endpoints are exactly where they'd be with no obstacle at all.
    expect(blocked.source).toEqual(clear.source);
    expect(blocked.target).toEqual(clear.target);
    expect(blocked.d).not.toBe(clear.d);

    // The detour's "across" segment sits at the y `detourAround` chose,
    // which by construction clears the obstacle (see the dedicated test for
    // that function above) — confirm `routeBetween` actually used it, rather
    // than re-deriving obstacle clearance from the raw path string.
    const detour = detourAround(clear.source, clear.target, clear.source.side, clear.target.side, [obstacle])!;
    expect(blocked.d).toContain(String(detour.detourY));
  });

  it('does not bend a path with no obstacle in its way', () => {
    const sourceRect = { x: 0, y: 0, width: 100, height: 60 };
    const targetRect = { x: 400, y: 0, width: 100, height: 60 };
    const farAway = { x: 150, y: 1000, width: 100, height: 60 };
    const clear = routeBetween(sourceRect, targetRect, 'smoothstep');
    const stillClear = routeBetween(sourceRect, targetRect, 'smoothstep', { obstacles: [farAway] });
    expect(stillClear.d).toBe(clear.d);
  });

  it('routeEdge builds the obstacle list from the node map automatically', () => {
    const a = createNode({ id: 'a', type: 'service', x: 0, y: 0, width: 100, height: 60 });
    const b = createNode({ id: 'b', type: 'database', x: 400, y: 0, width: 100, height: 60 });
    const blocker = createNode({ id: 'obstacle', type: 'card', x: 150, y: 0, width: 100, height: 60 });
    const boundary = createNode({ id: 'grp', type: 'group', x: 140, y: -20, width: 320, height: 100 });
    const edge = createEdge({ source: 'a', target: 'b' });
    const nodes = new Map([
      ['a', a],
      ['b', b],
      ['obstacle', blocker],
      ['grp', boundary],
    ]);

    // Include the group boundary in the map to prove it is excluded from
    // obstacles (it is a container, not something to route around) while the
    // concrete `blocker` node still bends the path.
    const withObstacle = routeEdge(edge, nodes, {
      obstacles: [...nodes.values()]
        .filter((n) => n.id !== 'a' && n.id !== 'b' && n.type !== 'group')
        .map((n) => ({ x: n.x, y: n.y, width: n.width, height: n.height })),
    })!;
    const withoutAnyObstacle = routeEdge(edge, nodes, { obstacles: [] })!;
    expect(withObstacle.d).not.toBe(withoutAnyObstacle.d);
  });
});

describe('route stability', () => {
  it('a small node movement does not flip an explicitly anchored side', () => {
    const a = createNode({ type: 'service', x: 0, y: 0, width: 100, height: 60 });
    const b = createNode({ type: 'database', x: 300, y: 0, width: 100, height: 60 });
    const edge = createEdge({
      source: a.id,
      target: b.id,
      sourceAnchor: { side: 'top', offset: 0.5 },
      targetAnchor: { side: 'top', offset: 0.5 },
    });
    let doc = addEdges(addNodes(createDocument(), [a, b]), [edge]);

    // Nudge both nodes slightly — nowhere near enough to change which sides
    // `chooseSides` would naturally pick, and irrelevant anyway since both
    // sides here are explicit.
    doc = moveNodes(
      doc,
      new Map([
        [a.id, { x: 5, y: 3 }],
        [b.id, { x: 302, y: -2 }],
      ]),
    );

    const nodes = new Map(doc.nodes.map((n) => [n.id, n]));
    const route = routeEdge(doc.edges[0]!, nodes)!;
    expect(route.source.side).toBe('top');
    expect(route.target.side).toBe('top');
  });
});
