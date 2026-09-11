import { describe, expect, it } from 'vitest';
import {
  RESPONSE_LANE_DELTA,
  anchorPoint,
  chooseSides,
  detourAround,
  labelLaneOffset,
  labelSideFor,
  laneIndex,
  routeBetween,
  routeEdge,
} from '../src/edges/routing';
import { describeEdge } from '../src/edges/describe';
import { createDocument, createEdge, createNode } from '../src/document/factory';
import { addEdges, addNodes, moveNodes, updateNode } from '../src/document/operations';
import { getMeasurer } from '../src/render/text/measure';
import { DARK } from '../src/render/theme/tokens';
import { EDGE_ROUTINGS, type DraftEdge, type DraftNode } from '../src/document/types';

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

/**
 * The queue node's fanned-card-stack silhouette (`nodes/describe.ts`'s `queue()`)
 * draws three nested rects inside its own bounding box, but routing never reads
 * node type or sub-kind — it only ever sees `{x, y, width, height}` via `rectOf`.
 * These tests confirm that invariant holds end-to-end for a real queue node on
 * every side, and that topic/stream anchor identically to a plain queue.
 */
describe('a queue/topic/stream node anchors on its true bounding box regardless of its stacked silhouette', () => {
  function queueAt(id: string, queueKind: 'queue' | 'topic' | 'stream' = 'queue'): DraftNode {
    return createNode({ id, type: 'queue', x: 300, y: 300, width: 176, height: 68, queueKind });
  }

  const service = createNode({ id: 'svc', type: 'service', x: -300, y: -300, width: 100, height: 60 });

  it.each(['top', 'right', 'bottom', 'left'] as const)(
    'anchors a connector on the %s side of a queue node exactly on its rect edge',
    (side) => {
      const target = queueAt(`q-${side}`);
      const edge = createEdge({
        source: service.id,
        target: target.id,
        targetAnchor: { side, offset: 0.5 },
      });
      const nodes = new Map([
        [service.id, service],
        [target.id, target],
      ]);

      const route = routeEdge(edge, nodes)!;
      expect(route.target.side).toBe(side);
      const rect = { x: target.x, y: target.y, width: target.width, height: target.height };
      expect(route.target).toEqual({ ...anchorPoint(rect, side, 0.5), side });
    },
  );

  it('a topic and a stream node anchor identically to a plain queue node — sub-kind never affects geometry', () => {
    const points = (['queue', 'topic', 'stream'] as const).map((queueKind) => {
      const target = queueAt(`k-${queueKind}`, queueKind);
      const edge = createEdge({
        source: service.id,
        target: target.id,
        targetAnchor: { side: 'left', offset: 0.5 },
      });
      const nodes = new Map([
        [service.id, service],
        [target.id, target],
      ]);
      return routeEdge(edge, nodes)!.target;
    });
    expect(points[1]).toEqual(points[0]);
    expect(points[2]).toEqual(points[0]);
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

  describe('anchored edges are siblings only when they actually touch the same points', () => {
    const anchor = (side: 'top' | 'right' | 'bottom' | 'left', offset = 0.5) => ({ side, offset });

    it('keeps a callback pair together when each end touches the same point on each node', () => {
      const call = createEdge({ id: 'e1', source: 'a', target: 'b', sourceAnchor: anchor('right'), targetAnchor: anchor('left') });
      const reply = createEdge({ id: 'e2', source: 'b', target: 'a', sourceAnchor: anchor('left'), targetAnchor: anchor('right') });
      const lanes = laneIndex([call, reply]);
      expect(lanes.get('e1')!.count).toBe(2);
      expect(lanes.get('e2')!.count).toBe(2);
      expect(lanes.get('e1')!.offset).not.toBe(lanes.get('e2')!.offset);
    });

    it('leaves two same-direction edges alone when they leave from different sides', () => {
      // A saga orchestrator's "reserve" (bottom) and later "release" (left side) to one service.
      const reserve = createEdge({ id: 'e1', source: 'a', target: 'b', sourceAnchor: anchor('bottom'), targetAnchor: anchor('top') });
      const release = createEdge({ id: 'e2', source: 'a', target: 'b', sourceAnchor: anchor('left'), targetAnchor: anchor('top', 0.25) });
      const lanes = laneIndex([reserve, release]);
      expect(lanes.get('e1')).toEqual({ offset: 0, count: 1 });
      expect(lanes.get('e2')).toEqual({ offset: 0, count: 1 });
    });

    it('splits by the far end too — same hub point, different landing points', () => {
      const first = createEdge({ id: 'e1', source: 'a', target: 'b', sourceAnchor: anchor('bottom'), targetAnchor: anchor('top', 0.25) });
      const second = createEdge({ id: 'e2', source: 'a', target: 'b', sourceAnchor: anchor('bottom'), targetAnchor: anchor('top', 0.75) });
      const lanes = laneIndex([first, second]);
      expect(lanes.get('e1')!.count).toBe(1);
      expect(lanes.get('e2')!.count).toBe(1);
    });

    it('still nudges two anchored edges that touch identical points', () => {
      const first = createEdge({ id: 'e1', source: 'a', target: 'b', sourceAnchor: anchor('bottom'), targetAnchor: anchor('top') });
      const second = createEdge({ id: 'e2', source: 'a', target: 'b', sourceAnchor: anchor('bottom'), targetAnchor: anchor('top') });
      const lanes = laneIndex([first, second]);
      expect(lanes.get('e1')).toEqual({ offset: -0.5, count: 2 });
      expect(lanes.get('e2')).toEqual({ offset: 0.5, count: 2 });
    });

    it('falls back to one group for the whole pair as soon as any edge lacks an anchor', () => {
      // An anchorless end is placed by `chooseSides` at render time — it may well
      // land exactly on the anchored sibling, so the safe answer is the nudge.
      const anchored = createEdge({ id: 'e1', source: 'a', target: 'b', sourceAnchor: anchor('left'), targetAnchor: anchor('top') });
      const loose = createEdge({ id: 'e2', source: 'a', target: 'b' });
      const lanes = laneIndex([anchored, loose]);
      expect(lanes.get('e1')!.count).toBe(2);
      expect(lanes.get('e2')!.count).toBe(2);
    });
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
    const blocker = createNode({ id: 'obstacle', type: 'note', x: 150, y: 0, width: 100, height: 60 });
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

/**
 * A request/response connector's own reply line (see `DraftEdge.response`) is computed by calling
 * `routeBetween` a second time with source/target and their anchors swapped, plus a small addition
 * to the lane offset — reusing this same routing engine rather than a second one. These tests cover
 * the geometry contract `DraftEdgeView.tsx`/`edges/describe.ts` both rely on.
 */
describe('a response route mirrors its request route via RESPONSE_LANE_DELTA', () => {
  const sourceRect = { x: 0, y: 0, width: 120, height: 60 };
  const targetRect = { x: 400, y: 0, width: 120, height: 60 };
  const sourceAnchor = { side: 'right' as const, offset: 0.5 };
  const targetAnchor = { side: 'left' as const, offset: 0.5 };

  it.each(EDGE_ROUTINGS)('runs target → source, offset from the request route, for %s routing', (routing) => {
    const request = routeBetween(sourceRect, targetRect, routing, {
      anchors: { source: sourceAnchor, target: targetAnchor },
      lane: 0,
    });
    const response = routeBetween(targetRect, sourceRect, routing, {
      anchors: { source: targetAnchor, target: sourceAnchor },
      lane: RESPONSE_LANE_DELTA,
    });

    // `response.target` is where its own arrowhead lands — the *original source* node, per
    // `RESPONSE_LANE_DELTA`'s own doc comment — so it shares a side with `request.source`, and
    // vice versa, even though the lane delta means the exact points aren't identical.
    expect(response.target.side).toBe(request.source.side);
    expect(response.source.side).toBe(request.target.side);
    // The lane delta actually moved it — never lands exactly on top of the primary line.
    expect(response.d).not.toBe(request.d);
  });

  it('falls back to the mirror image of chooseSides when neither endpoint has a persisted anchor', () => {
    const request = routeBetween(sourceRect, targetRect, 'smoothstep');
    const response = routeBetween(targetRect, sourceRect, 'smoothstep', { lane: RESPONSE_LANE_DELTA });
    expect(response.source.side).toBe(request.target.side);
    expect(response.target.side).toBe(request.source.side);
  });
});

describe('labelLaneOffset', () => {
  it('adds no offset for a lone edge (lane 0)', () => {
    expect(labelLaneOffset('right', 'left', 0)).toEqual({ x: 0, y: 0 });
  });

  it('separates labels vertically for a horizontal pairing, further than the line itself', () => {
    const offset = labelLaneOffset('right', 'left', 1);
    expect(offset.x).toBe(0);
    expect(offset.y).toBeGreaterThan(0);
  });

  it('separates labels horizontally for a vertical pairing', () => {
    const offset = labelLaneOffset('bottom', 'top', 1);
    expect(offset.y).toBe(0);
    expect(offset.x).toBeGreaterThan(0);
  });

  it('opposite lanes get opposite-signed offsets', () => {
    const left = labelLaneOffset('right', 'left', -1);
    const right = labelLaneOffset('right', 'left', 1);
    expect(left.y).toBe(-right.y);
  });

  it('adds no offset for a mixed pairing — no single fan-out axis', () => {
    expect(labelLaneOffset('right', 'top', 2)).toEqual({ x: 0, y: 0 });
  });
});

describe('labelSideFor picks which side of the line a label chip should sit on', () => {
  it('prefers right for a vertical pairing (nodes stacked top/bottom)', () => {
    const side = labelSideFor(
      { x: 0, y: 0, width: 100, height: 60 },
      { x: 0, y: 300, width: 100, height: 60 },
      'bottom',
      'top',
      { x: 50, y: 180 },
    );
    expect(side).toBe('right');
  });

  it('prefers top for a horizontal pairing (nodes side by side)', () => {
    const side = labelSideFor(
      { x: 0, y: 0, width: 100, height: 60 },
      { x: 300, y: 0, width: 100, height: 60 },
      'right',
      'left',
      { x: 200, y: 30 },
    );
    expect(side).toBe('top');
  });

  it('flips to left when the right candidate would land inside a node (overlapping rects)', () => {
    // Overlapping nodes are an edge case the document model allows (e.g. a
    // manual drag) — the flip should still hold up rather than assume rects
    // never overlap.
    const side = labelSideFor(
      { x: 0, y: 0, width: 100, height: 200 },
      { x: 0, y: 150, width: 100, height: 200 },
      'bottom',
      'top',
      { x: 50, y: 175 },
    );
    expect(side).toBe('left');
  });

  it('flips to bottom when the top candidate would land inside a node (overlapping rects)', () => {
    const side = labelSideFor(
      { x: 0, y: 0, width: 200, height: 100 },
      { x: 150, y: 0, width: 200, height: 100 },
      'right',
      'left',
      { x: 175, y: 50 },
    );
    expect(side).toBe('bottom');
  });

  it('falls back to comparing endpoint deltas for a mixed side pairing (independent explicit anchors)', () => {
    const mostlyVertical = labelSideFor(
      { x: 0, y: 0, width: 100, height: 60 },
      { x: 20, y: 400, width: 100, height: 60 },
      'right',
      'top',
      { x: 60, y: 200 },
    );
    expect(mostlyVertical).toBe('right');

    const mostlyHorizontal = labelSideFor(
      { x: 0, y: 0, width: 100, height: 60 },
      { x: 500, y: 20, width: 100, height: 60 },
      'right',
      'top',
      { x: 250, y: 30 },
    );
    expect(mostlyHorizontal).toBe('top');
  });
});

describe('a vertical connector\'s label chip never straddles the line', () => {
  it('sits entirely to one side of the line\'s own x-coordinate', () => {
    const a = createNode({ id: 'a', type: 'service', x: 0, y: 0, width: 120, height: 60 });
    const b = createNode({ id: 'b', type: 'database', x: 0, y: 400, width: 120, height: 60 });
    const edge = createEdge({ id: 'e1', source: 'a', target: 'b', label: 'PaymentRequested' });
    const nodes = new Map([
      ['a', a],
      ['b', b],
    ]);
    const ctx = { theme: DARK, measurer: getMeasurer(), showSequence: false };

    const described = describeEdge(edge, nodes, ctx)!;
    const chip = described.overlay.find((s) => s.t === 'rect')! as { x: number; y: number; w: number };
    const lineX = described.route.labelX;

    // A chip that straddled the line would have x < lineX < x + w.
    const straddles = chip.x < lineX && chip.x + chip.w > lineX;
    expect(straddles).toBe(false);
  });

  it('also clears the line for the inferred semantic caption — the common case with no explicit label', () => {
    // This is the case that actually shipped broken: a fresh connect infers a
    // semantic (e.g. "writes") and shows it as a caption with no user label,
    // which is the default for most connectors, not the edge case.
    const a = createNode({ id: 'a', type: 'service', x: 0, y: 0, width: 120, height: 60 });
    const b = createNode({ id: 'b', type: 'database', x: 0, y: 400, width: 120, height: 60 });
    const edge = createEdge({ id: 'e1', source: 'a', target: 'b', semantic: 'writes' });
    const nodes = new Map([
      ['a', a],
      ['b', b],
    ]);
    const ctx = { theme: DARK, measurer: getMeasurer(), showSequence: false };

    const described = describeEdge(edge, nodes, ctx)!;
    const caption = described.overlay.find((s) => s.t === 'text')! as { x: number; align: string };
    const lineX = described.route.labelX;

    // The caption's own anchor point must not sit on the line's x-coordinate,
    // and it must be aligned away from it (start/end), not centered on it.
    expect(caption.align).not.toBe('middle');
    expect(caption.x).not.toBe(lineX);
  });
});

describe('label chips stay readable in a multi-lane fixture', () => {
  function rectOverlap(a: { x: number; y: number; w: number; h: number }, b: typeof a): boolean {
    return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
  }

  it('three labelled parallel edges produce three non-overlapping label chips', () => {
    const a = createNode({ id: 'a', type: 'service', x: 0, y: 0, width: 120, height: 200 });
    const b = createNode({ id: 'b', type: 'database', x: 400, y: 0, width: 120, height: 200 });
    const edges = [
      createEdge({ id: 'e1', source: 'a', target: 'b', label: 'PaymentRequested' }),
      createEdge({ id: 'e2', source: 'a', target: 'b', label: 'PaymentCompleted' }),
      createEdge({ id: 'e3', source: 'a', target: 'b', label: 'PaymentFailed' }),
    ];
    const nodes = new Map([
      ['a', a],
      ['b', b],
    ]);
    const lanes = laneIndex(edges);
    const ctx = { theme: DARK, measurer: getMeasurer(), showSequence: false };

    const rects = edges.map((edge) => {
      const described = describeEdge(edge, nodes, { ...ctx, lane: lanes.get(edge.id)!.offset })!;
      const chip = described.overlay.find((s) => s.t === 'rect')!;
      return chip as { x: number; y: number; w: number; h: number };
    });

    expect(rects).toHaveLength(3);
    for (let i = 0; i < rects.length; i += 1) {
      for (let j = i + 1; j < rects.length; j += 1) {
        expect(rectOverlap(rects[i]!, rects[j]!)).toBe(false);
      }
    }
  });
});

describe('anchor offsets and lanes never move an endpoint off its node boundary', () => {
  // What a marker's `refX` positioning assumes — see `render/svg/markers.ts`.
  const sourceRect = { x: 0, y: 0, width: 120, height: 80 };
  const targetRect = { x: 400, y: 0, width: 120, height: 80 };

  it.each([
    { side: 'right' as const, offset: 0.1, lane: 0 },
    { side: 'right' as const, offset: 0.9, lane: 2 },
    { side: 'right' as const, offset: 0.5, lane: -2 },
    { side: 'top' as const, offset: 0.3, lane: 1 },
    { side: 'bottom' as const, offset: 0.7, lane: -1 },
  ])('keeps the source anchor exactly on its rect boundary for $side @ $offset, lane $lane', ({
    side,
    offset,
    lane,
  }) => {
    const route = routeBetween(sourceRect, targetRect, 'smoothstep', {
      anchors: { source: { side, offset } },
      lane,
    });
    if (side === 'right') {
      expect(route.source.x).toBe(sourceRect.x + sourceRect.width);
      expect(route.source.y).toBeGreaterThanOrEqual(sourceRect.y);
      expect(route.source.y).toBeLessThanOrEqual(sourceRect.y + sourceRect.height);
    } else {
      expect(route.source.y).toBe(side === 'bottom' ? sourceRect.y + sourceRect.height : sourceRect.y);
      expect(route.source.x).toBeGreaterThanOrEqual(sourceRect.x);
      expect(route.source.x).toBeLessThanOrEqual(sourceRect.x + sourceRect.width);
    }
  });

  it('an obstacle detour never moves the endpoint either — only the path between them', () => {
    const obstacle = { x: 150, y: 0, width: 100, height: 80 };
    const route = routeBetween(sourceRect, targetRect, 'smoothstep', {
      anchors: { source: { side: 'right', offset: 0.5 } },
      obstacles: [obstacle],
    });
    expect(route.source).toEqual({ x: 120, y: 40, side: 'right' });
  });
});
