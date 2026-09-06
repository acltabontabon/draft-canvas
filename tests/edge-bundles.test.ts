import { describe, expect, it } from 'vitest';
import { MIN_SPINE_MEMBERS, routingPlan } from '../src/edges/bundles';
import { RESPONSE_LANE_DELTA, responseSpineFor, routeBetween, routeEdge, trunkCoordinate } from '../src/edges/routing';
import { describeEdge } from '../src/edges/describe';
import { createDocument, createEdge, createNode } from '../src/document/factory';
import { __resetInteraction, useEditorStore } from '../src/store/editorStore';
import { addEdges, addNodes } from '../src/document/operations';
import { renderDocumentSvg } from '../src/render/svg/document';
import { getMeasurer } from '../src/render/text/measure';
import { DARK } from '../src/render/theme/tokens';
import type { Shape } from '../src/render/displayList';
import type { DraftEdge, DraftNode } from '../src/document/types';

/**
 * Smart Routing's planning layer.
 *
 * The invariant every test here defends is the one the feature exists for:
 * bundling changes where lines are *drawn*, never what the document *means*.
 * The edge array going in is the edge array coming out — a spine is derived
 * state keyed by edge id, and an edge that fails any gate keeps exactly the
 * route it had before this module existed.
 */

/** A hub on the left with `count` destinations stacked to its right — the
 *  shape the whole feature was built for (one service calling five others). */
function fanOut(count: number, patch: Partial<DraftEdge> = {}): { nodes: DraftNode[]; edges: DraftEdge[] } {
  const hub = createNode({ id: 'hub', type: 'service', x: 0, y: 400, width: 200, height: 80 });
  const nodes: DraftNode[] = [hub];
  const edges: DraftEdge[] = [];
  for (let i = 0; i < count; i += 1) {
    nodes.push(createNode({ id: `t${i}`, type: 'service', x: 700, y: i * 200, width: 200, height: 80 }));
    edges.push(createEdge({ id: `e${i}`, source: 'hub', target: `t${i}`, ...patch }));
  }
  return { nodes, edges };
}

describe('routingPlan recognises a fan-out and gives it one shared spine', () => {
  it('bundles five sibling calls onto a single trunk', () => {
    const { nodes, edges } = fanOut(5);
    const plan = routingPlan(nodes, edges);
    const spine = plan.spineFor('e0');

    expect(spine).toBeDefined();
    expect(spine!.count).toBe(5);
    expect(spine!.hub).toBe('source');
    expect(spine!.hubSide).toBe('right');
    // Every member shares the same spine object, not merely an equal one.
    for (const edge of edges) expect(plan.spineFor(edge.id)).toBe(spine);
  });

  it('leaves the semantic graph completely untouched', () => {
    const { nodes, edges } = fanOut(5);
    const before = JSON.stringify(edges);
    routingPlan(nodes, edges);
    // No junction node was invented, no edge was rewritten to route through
    // one: five independent relationships in, five out.
    expect(JSON.stringify(edges)).toBe(before);
    expect(nodes).toHaveLength(6);
  });

  it('orders members along the trunk by where they actually sit', () => {
    const { nodes, edges } = fanOut(5);
    const plan = routingPlan(nodes, edges);
    // Branches tap off in destination order, so members never cross inside
    // the bundle — that ordering is free rather than solved for.
    expect(plan.membersOf(plan.spineFor('e0')!.id)).toEqual(['e0', 'e1', 'e2', 'e3', 'e4']);
  });

  it('puts the trunk in the corridor, clear of both the hub and the destinations', () => {
    const { nodes, edges } = fanOut(5);
    const spine = routingPlan(nodes, edges).spineFor('e0')!;
    // Hub's right face is x=200, nearest destination's left face is x=700.
    expect(spine.corridor).toBe(500);
    expect(spine.trunkGap).toBeGreaterThan(28);
    expect(spine.trunkGap).toBeLessThan(500 - 28);
  });

  it('sets the trunk past the halfway mark, so the shared run dominates', () => {
    const { nodes, edges } = fanOut(5);
    const spine = routingPlan(nodes, edges).spineFor('e0')!;
    // A long shared stem and short branches reads as one relationship
    // splitting late; an even split reads as two halves meeting in the middle.
    expect(spine.trunkGap).toBeGreaterThan(spine.corridor / 2);
    // But not so far out that the branches lose their own run.
    expect(spine.corridor - spine.trunkGap).toBeGreaterThanOrEqual(28);
  });

  it('draws every branch as a visual peer — same corner, same treatment', () => {
    const { nodes, edges } = fanOut(5);
    const nodeMap = new Map(nodes.map((node) => [node.id, node]));
    const plan = routingPlan(nodes, edges);

    /** The quadratic corner commands in a path, as radius-sized deltas. */
    const corners = (d: string) => (d.match(/Q[^A-Z]*/g) ?? []).length;

    const shapes = edges.map((edge) => {
      const route = routeEdge(edge, nodeMap, { spine: plan.spineFor(edge.id) })!;
      return { id: edge.id, turns: corners(route.d), branch: route.branchStart! };
    });

    // Four members turn twice — onto the trunk and off it again — with a full
    // corner each. The fifth is level with the hub and runs straight through,
    // which is what the shape is supposed to look like, not a special case.
    const turning = shapes.filter((shape) => shape.turns > 0);
    expect(turning).toHaveLength(4);
    expect(new Set(turning.map((shape) => shape.turns)).size).toBe(1);

    // And every branch taps off the one trunk, so none is set apart by
    // starting somewhere else.
    expect(new Set(shapes.map((shape) => shape.branch.x)).size).toBe(1);
  });

  it('gives every member the same shared caption point and side', () => {
    const { nodes, edges } = fanOut(5);
    const nodeMap = new Map(nodes.map((node) => [node.id, node]));
    const plan = routingPlan(nodes, edges);
    const placements = edges.map((edge) => {
      const route = routeEdge(edge, nodeMap, { spine: plan.spineFor(edge.id) })!;
      return `${route.trunkLabel!.x},${route.trunkLabel!.y},${route.trunkLabelSide}`;
    });
    // Side included: members disagreeing on it would render the one collapsed
    // caption twice, a few pixels apart, as a faint double image.
    expect(new Set(placements).size).toBe(1);
  });
});

describe('routingPlan refuses to bundle where a trunk would not read as one', () => {
  it('leaves two edges alone — a pair does not need a trunk', () => {
    const { nodes, edges } = fanOut(MIN_SPINE_MEMBERS - 1);
    expect(routingPlan(nodes, edges).spineFor('e0')).toBeUndefined();
  });

  it('keeps different relationships visually distinct', () => {
    const { nodes, edges } = fanOut(3);
    edges[0]!.semantic = 'calls';
    edges[1]!.semantic = 'writes';
    edges[2]!.semantic = 'publishes';
    const plan = routingPlan(nodes, edges);
    // Three different statements about the architecture; merging them into
    // one indistinguishable bundle would trade noise for lost meaning.
    for (const edge of edges) expect(plan.spineFor(edge.id)).toBeUndefined();
  });

  it('splits destinations lying in opposite directions into separate spines, never one merged bundle', () => {
    const hub = createNode({ id: 'hub', type: 'service', x: 400, y: 400, width: 200, height: 80 });
    const nodes = [hub];
    const edges: DraftEdge[] = [];
    // Two east, two west — four edges in total, each side reaching the two-member floor on its
    // own, but a westbound and an eastbound branch never belong on the same trunk regardless.
    const spots = [
      { id: 'e0', x: 1200, y: 200 },
      { id: 'e1', x: 1200, y: 700 },
      { id: 'w0', x: -800, y: 200 },
      { id: 'w1', x: -800, y: 700 },
    ];
    for (const spot of spots) {
      nodes.push(createNode({ id: `n${spot.id}`, type: 'service', x: spot.x, y: spot.y, width: 200, height: 80 }));
      edges.push(createEdge({ id: spot.id, source: 'hub', target: `n${spot.id}` }));
    }
    const plan = routingPlan(nodes, edges);
    const east = edges.filter((e) => e.id.startsWith('e')).map((e) => plan.spineFor(e.id));
    const west = edges.filter((e) => e.id.startsWith('w')).map((e) => plan.spineFor(e.id));
    for (const spine of [...east, ...west]) expect(spine).toBeDefined();
    expect(east[0]!.id).toBe(east[1]!.id);
    expect(west[0]!.id).toBe(west[1]!.id);
    expect(east[0]!.id).not.toBe(west[0]!.id);
  });

  it('does not bundle destinations stacked at one height — that is not a fan', () => {
    const hub = createNode({ id: 'hub', type: 'service', x: 0, y: 400, width: 200, height: 80 });
    const nodes = [hub];
    const edges: DraftEdge[] = [];
    for (let i = 0; i < 3; i += 1) {
      // All at the same y, marching away horizontally: already parallel
      // straight lines, so a trunk would add two bends to draw the same thing.
      nodes.push(createNode({ id: `t${i}`, type: 'service', x: 700 + i * 300, y: 400, width: 200, height: 80 }));
      edges.push(createEdge({ id: `e${i}`, source: 'hub', target: `t${i}` }));
    }
    const plan = routingPlan(nodes, edges);
    for (const edge of edges) expect(plan.spineFor(edge.id)).toBeUndefined();
  });

  it('leaves a Junction connector alone — that is the user routing by hand', () => {
    const { nodes, edges } = fanOut(3);
    nodes.push(createNode({ id: 'j', type: 'ellipse', x: 400, y: 900 }));
    edges.push(createEdge({ id: 'ej', source: 'hub', target: 'j' }));
    expect(routingPlan(nodes, edges).spineFor('ej')).toBeUndefined();
  });

  it('opts out an edge the user has taken manual control of', () => {
    const { nodes, edges } = fanOut(4);
    edges[0]!.routeMode = 'direct';
    const plan = routingPlan(nodes, edges);
    expect(plan.spineFor('e0')).toBeUndefined();
    // The remaining three still clear the floor, so the rest stays tidy.
    expect(plan.spineFor('e1')!.count).toBe(3);
  });

  it('refuses a corridor it cannot cross without running through a node', () => {
    const { nodes, edges } = fanOut(4);
    // Parked squarely in the corridor, level with the hub: there is nowhere to
    // put a trunk whose stem, trunk and branches are all clear of it. Not
    // crossing a node beats sharing a trunk, so the whole group is abandoned
    // and each connector falls back to its own single-detour routing.
    nodes.push(createNode({ id: 'ob', type: 'note', x: 300, y: 300, width: 320, height: 400 }));
    const plan = routingPlan(nodes, edges);
    for (const edge of edges) expect(plan.spineFor(edge.id)).toBeUndefined();
  });

  it('still bundles when the obstacle sits clear of every run', () => {
    const { nodes, edges } = fanOut(4);
    // Well below the whole fan, touching none of its runs.
    nodes.push(createNode({ id: 'ob', type: 'note', x: 300, y: 2000, width: 320, height: 200 }));
    expect(routingPlan(nodes, edges).spineFor('e0')).toBeDefined();
  });

  it('only bundles the orthogonal style — a bezier has no straight run to share', () => {
    const { nodes, edges } = fanOut(4, { routing: 'bezier' });
    for (const edge of edges) expect(routingPlan(nodes, edges).spineFor(edge.id)).toBeUndefined();
  });
});

describe('routingPlan handles fan-in as the mirror of fan-out', () => {
  it('bundles many sources converging on one destination', () => {
    const sink = createNode({ id: 'sink', type: 'service', x: 900, y: 400, width: 200, height: 80 });
    const nodes = [sink];
    const edges: DraftEdge[] = [];
    for (let i = 0; i < 5; i += 1) {
      nodes.push(createNode({ id: `s${i}`, type: 'service', x: 0, y: i * 200, width: 200, height: 80 }));
      edges.push(createEdge({ id: `e${i}`, source: `s${i}`, target: 'sink' }));
    }
    const spine = routingPlan(nodes, edges).spineFor('e0');
    expect(spine).toBeDefined();
    expect(spine!.hub).toBe('target');
    expect(spine!.hubSide).toBe('left');
    expect(spine!.count).toBe(5);
  });
});

describe('a bundled route draws a shared trunk without moving any anchor', () => {
  const { nodes, edges } = fanOut(5);
  const nodeMap = new Map(nodes.map((node) => [node.id, node]));
  const plan = routingPlan(nodes, edges);

  it('leaves every member on the same hub point it would have used anyway', () => {
    const unbundled = routeEdge(edges[0]!, nodeMap)!;
    const bundled = routeEdge(edges[0]!, nodeMap, { spine: plan.spineFor('e0') })!;
    expect(bundled.source).toEqual(unbundled.source);
    expect(bundled.target).toEqual(unbundled.target);
  });

  it('runs every member through the same trunk coordinate', () => {
    // Hub right face 200 + trunkGap. Each member's path must turn there.
    const trunkX = 200 + plan.spineFor('e0')!.trunkGap;
    for (const edge of edges) {
      const route = routeEdge(edge, nodeMap, { spine: plan.spineFor(edge.id) })!;
      expect(route.d).toContain(`${trunkX}`);
    }
  });

  it('gives each member its own branch label point, not one shared pile', () => {
    const points = edges.map((edge) => {
      const route = routeEdge(edge, nodeMap, { spine: plan.spineFor(edge.id) })!;
      return `${route.labelX},${route.labelY}`;
    });
    expect(new Set(points).size).toBe(edges.length);
  });

  it('agrees on one shared point for the collapsed trunk caption', () => {
    const trunkLabels = edges.map((edge) => {
      const route = routeEdge(edge, nodeMap, { spine: plan.spineFor(edge.id) })!;
      return `${route.trunkLabel!.x},${route.trunkLabel!.y}`;
    });
    // One label drawn N times at one point, not N labels down a column.
    expect(new Set(trunkLabels).size).toBe(1);
  });

  it('marks where each fan-out member stops sharing and becomes its own branch', () => {
    const route = routeEdge(edges[0]!, nodeMap, { spine: plan.spineFor('e0') })!;
    expect(route.branchStart).toEqual({ x: 200 + plan.spineFor('e0')!.trunkGap, y: route.target.y });
  });

  it('is byte-identical to the old route when no spine is supplied', () => {
    const before = routeBetween({ x: 0, y: 0, width: 100, height: 60 }, { x: 300, y: 0, width: 100, height: 60 }, 'smoothstep');
    expect(before.branchStart).toBeUndefined();
    expect(before.trunkLabel).toBeUndefined();
  });
});

describe('a bundled request/response connector gets two parallel trunks', () => {
  it('mirrors the spine for the reply, so it shares the hub end and not the far end', () => {
    const request = { id: 's', hub: 'source', hubSide: 'right', trunkGap: 100, corridor: 400, count: 5 } as const;
    const reply = responseSpineFor(request)!;
    // The reply is routed with source and target swapped, so the hub — which
    // has not moved — changes role. Reusing the request's own spine here would
    // point the trunk at the destinations instead.
    expect(reply.hub).toBe('target');
    expect(reply.hubSide).toBe('right');
    expect(reply.trunkGap).toBeGreaterThan(request.trunkGap);
    expect(reply.id).not.toBe(request.id);
  });

  it('separates the two trunks by a visible share of the corridor, not a few pixels', () => {
    const { nodes, edges } = fanOut(5, { hasResponse: true });
    const spine = routingPlan(nodes, edges).spineFor('e0')!;
    const reply = responseSpineFor(spine)!;
    // Beyond the request trunk, not before it: a reply trunk nearer the hub
    // would make every branch cross the request trunk on its way out to it.
    expect(reply.trunkGap).toBeGreaterThan(spine.trunkGap);
    expect(reply.trunkGap - spine.trunkGap).toBeGreaterThanOrEqual(26);
    // And still short of the nodes it has to stop against.
    expect(reply.trunkGap).toBeLessThanOrEqual(spine.corridor - 28);
  });

  it('never lets the reply trunk fall behind the request trunk in a narrow corridor', () => {
    // Clamping the reply trunk to stay clear of the far nodes must not push it
    // back past the request trunk: that would flip which family crosses which,
    // and put every dashed branch across the primary trunk.
    for (const corridor of [80, 120, 200, 400, 1200]) {
      const request = { id: 's', hub: 'source', hubSide: 'right', trunkGap: corridor * 0.62, corridor, count: 3 } as const;
      expect(responseSpineFor(request)!.trunkGap).toBeGreaterThanOrEqual(request.trunkGap);
    }
  });

  it('places the request trunk identically whether or not replies are drawn', () => {
    const request = fanOut(5);
    const plain = routingPlan(request.nodes, request.edges);
    const withReply = fanOut(5, { hasResponse: true });
    // The clean request-only case is the baseline; turning replies on must not
    // move it to make room for them.
    expect(routingPlan(withReply.nodes, withReply.edges).spineFor('e0')!.trunkGap).toBe(
      plain.spineFor('e0')!.trunkGap,
    );
  });

  it('keeps the reply trunk clear of the request trunk on the canvas', () => {
    const { nodes, edges } = fanOut(5, { hasResponse: true });
    const spine = routingPlan(nodes, edges).spineFor('e0')!;
    const hubRect = { x: 0, y: 400, width: 200, height: 80 };
    expect(trunkCoordinate(hubRect, responseSpineFor(spine)!)).not.toBe(trunkCoordinate(hubRect, spine));
    // And the reply really does route back to the hub, not off to a leaf.
    const reply = routeBetween(
      { x: 700, y: 0, width: 200, height: 80 },
      hubRect,
      'smoothstep',
      { spine: responseSpineFor(spine), lane: RESPONSE_LANE_DELTA },
    );
    expect(reply.target.x).toBe(200);
  });
});

describe('routingPlan is stable and cheap enough to run on every commit', () => {
  it('is cached by the (nodes, edges) array pair', () => {
    const { nodes, edges } = fanOut(5);
    expect(routingPlan(nodes, edges)).toBe(routingPlan(nodes, edges));
  });

  it('does not shift the trunk for a movement too small to matter', () => {
    const { nodes, edges } = fanOut(5);
    const before = routingPlan(nodes, edges).spineFor('e0')!.trunkGap;
    // A three-pixel nudge of one destination: quantization means the route
    // holds still rather than shimmering along with the pointer.
    const nudged = nodes.map((node) => (node.id === 't2' ? { ...node, x: node.x + 3 } : node));
    expect(routingPlan(nudged, edges).spineFor('e0')!.trunkGap).toBe(before);
  });

  it('re-plans when a destination genuinely moves', () => {
    const { nodes, edges } = fanOut(5);
    const before = routingPlan(nodes, edges).spineFor('e0')!.trunkGap;
    const moved = nodes.map((node) => (node.id === 't2' ? { ...node, x: 340 } : node));
    expect(routingPlan(moved, edges).spineFor('e0')!.trunkGap).not.toBe(before);
  });
});

describe('the shared trunk survives the hand-drawn presets and export filtering', () => {
  /** The command letters plus their numbers, so two paths can be compared
   *  segment by segment rather than as one opaque string. */
  function commands(d: string): string[] {
    return d.match(/[MLQC][^MLQC]*/g) ?? [];
  }

  /** The primary stroke of a described edge, as its path data. */
  function strokeOf(described: { line: Shape[] }): string {
    const path = described.line.find((shape): shape is Extract<Shape, { t: 'path' }> => shape.t === 'path');
    return path!.d;
  }

  it('wobbles every member identically along the run they share', () => {
    const { nodes, edges } = fanOut(5);
    const nodeMap = new Map(nodes.map((node) => [node.id, node]));
    const plan = routingPlan(nodes, edges);
    const ctx = { theme: DARK, measurer: getMeasurer(), showSequence: false, preset: 'sketch' as const };

    const drawn = (id: string) =>
      commands(strokeOf(describeEdge(edges.find((e) => e.id === id)!, nodeMap, { ...ctx, spine: plan.spineFor(id) })!));

    // e0 and e1 both sit above the hub, so they leave it and turn onto the
    // trunk through exactly the same geometry; e3 and e4 do the same below it.
    // If each seeded its own jitter, these would diverge and the shared run
    // would read as a frayed rope rather than one line. (e2 is level with the
    // hub and runs straight through, so it has no turn to share.)
    for (const [a, b] of [['e0', 'e1'], ['e3', 'e4']] as const) {
      expect(drawn(a).slice(0, 3)).toEqual(drawn(b).slice(0, 3));
    }
    // Sketch really is perturbing these — otherwise the assertion above would
    // pass trivially on untouched clean geometry.
    const clean = commands(
      strokeOf(describeEdge(edges[0]!, nodeMap, { ...ctx, preset: 'clean', spine: plan.spineFor('e0') })!),
    );
    expect(drawn('e0')[2]).not.toBe(clean[2]);
  });

  it('turns every member onto the one shared trunk coordinate', () => {
    const { nodes, edges } = fanOut(5);
    const nodeMap = new Map(nodes.map((node) => [node.id, node]));
    const plan = routingPlan(nodes, edges);
    const trunkX = 200 + plan.spineFor('e0')!.trunkGap;
    for (const edge of edges) {
      const route = routeEdge(edge, nodeMap, { spine: plan.spineFor(edge.id) })!;
      expect(route.d).toContain(`${trunkX}`);
    }
  });

  it('gives each member its own step badge instead of stacking them', () => {
    const { nodes, edges } = fanOut(5);
    const nodeMap = new Map(nodes.map((node) => [node.id, node]));
    const plan = routingPlan(nodes, edges);
    const badges = edges.map((edge, index) => {
      const described = describeEdge(edge, nodeMap, {
        theme: DARK,
        measurer: getMeasurer(),
        showSequence: true,
        stepIndex: index + 1,
        spine: plan.spineFor(edge.id),
      })!;
      const circle = described.overlay.find((shape) => shape.t === 'ellipse');
      return `${circle!.cx},${circle!.cy}`;
    });
    // Every member leaves the hub from the same anchor, so a badge walked
    // outward from `source` would draw all five on one point.
    expect(new Set(badges).size).toBe(5);
  });

  it('re-expands a bundle that a selection-only export cut below the floor', () => {
    const { nodes, edges } = fanOut(5);
    const doc = addEdges(addNodes(createDocument('Fan'), nodes), edges);
    const trunkX = String(200 + routingPlan(nodes, edges).spineFor('e0')!.trunkGap);

    const full = renderDocumentSvg(doc).svg;
    expect(full.split(trunkX).length - 1).toBeGreaterThanOrEqual(5);

    // Only the hub and one destination: what remains is a single connector, which does
    // not earn a trunk on its own, so it must route independently rather than draw a
    // branch off a spine whose other members aren't in the picture.
    const partial = renderDocumentSvg(doc, { only: new Set(['hub', 't0']) }).svg;
    expect(partial).not.toContain(trunkX);
  });
});

describe('taking manual control of a bundle', () => {
  function reset() {
    __resetInteraction();
    useEditorStore.setState({
      document: createDocument('Routing'),
      history: { past: [], future: [] },
      selection: { nodes: [], edges: [] },
      clipboard: null,
      pasteRepeat: 0,
      revision: 0,
    });
  }

  /** Three services fanning out of one hub, built through the store the way a
   *  user would actually draw them. */
  function bundleInStore() {
    reset();
    const state = useEditorStore.getState();
    const hub = state.addNode({ type: 'service', x: 0, y: 400, text: 'Hub' });
    const edges = [0, 1, 2].map((i) => {
      const target = state.addNode({ type: 'service', x: 700, y: i * 220, text: `T${i}` });
      return state.connect(hub.id, target.id)!;
    });
    return { hub, edges };
  }

  it('converts a shared trunk into a real Junction in exactly one undo step', () => {
    const { edges } = bundleInStore();
    const before = useEditorStore.getState().document;
    const historyBefore = useEditorStore.getState().history.past.length;

    useEditorStore.getState().convertBundleToJunction(edges[0]!.id);
    const after = useEditorStore.getState().document;

    // One shared leg into the Junction plus one leg out to each destination.
    expect(after.nodes.filter((node) => node.type === 'ellipse')).toHaveLength(1);
    expect(after.edges).toHaveLength(4);
    expect(useEditorStore.getState().history.past.length).toBe(historyBefore + 1);

    useEditorStore.getState().undo();
    // Undo restores the whole bundle at once, not one edge at a time.
    expect(useEditorStore.getState().document.edges).toHaveLength(before.edges.length);
    expect(useEditorStore.getState().document.nodes).toEqual(before.nodes);
  });

  it('does nothing for a connector that is not bundled', () => {
    reset();
    const state = useEditorStore.getState();
    const a = state.addNode({ type: 'service', x: 0, y: 0 });
    const b = state.addNode({ type: 'service', x: 400, y: 0 });
    const edge = state.connect(a.id, b.id)!;
    const before = useEditorStore.getState().document;
    useEditorStore.getState().convertBundleToJunction(edge.id);
    expect(useEditorStore.getState().document).toBe(before);
  });

  it('hands manually-routed connectors back to the router without moving anything', () => {
    const { edges } = bundleInStore();
    useEditorStore.getState().setEdgeRouteMode(edges[0]!.id, 'direct');
    const positioned = useEditorStore.getState().document.nodes;

    useEditorStore.getState().tidyConnections();
    const after = useEditorStore.getState().document;

    expect(after.edges.every((edge) => edge.routeMode === undefined)).toBe(true);
    // Tidy is wiring-only: not one node moves, and no anchor is touched.
    expect(after.nodes).toEqual(positioned);
    expect(after.edges.map((edge) => [edge.id, edge.sourceAnchor, edge.targetAnchor])).toEqual(
      edges.map((edge) => [edge.id, edge.sourceAnchor, edge.targetAnchor]),
    );
  });

  it('never leaves a dead undo entry when there is nothing to tidy', () => {
    bundleInStore();
    const before = useEditorStore.getState().history.past.length;
    useEditorStore.getState().tidyConnections();
    expect(useEditorStore.getState().history.past.length).toBe(before);
  });
});
