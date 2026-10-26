import { describe, expect, it } from 'vitest';
import { legibilityOf } from '../../src/agent/legibility';
import { routingCorpus } from '../fixtures/routing/corpus';
import { measure, noWorse } from '../fixtures/routing/measure';
import { createEdge, createNode } from '../../src/document/factory';
import { bendsOf, drawnRoute, repairAnchors, routeCost, routeProblem } from '../../src/agent/route';

const example = () => {
  const nodes = [
    createNode({ id: 'a', type: 'service', x: 0, y: 0 }),
    createNode({ id: 'b', type: 'service', x: 400, y: 240 }),
  ];
  const edge = createEdge({ id: 'ab', source: 'a', target: 'b', sourceAnchor: { side: 'right', offset: 0.5 }, targetAnchor: { side: 'left', offset: 0.5 } });
  return { nodes, edge };
};

describe('automatic connector tidiness', () => {
  it('removes an unnecessary elbow from a readable connector without moving shapes', () => {
    const { nodes, edge } = example();
    const beforeNodes = structuredClone(nodes);
    const before = drawnRoute(edge, nodes, [edge])!;
    expect(bendsOf(before.points)).toBe(2);
    repairAnchors([edge], nodes);
    const after = drawnRoute(edge, nodes, [edge])!;
    expect(bendsOf(after.points)).toBe(1);
    expect(routeCost(after.points)).toBeLessThan(routeCost(before.points));
    expect(nodes).toEqual(beforeNodes);
  });

  it('keeps a hand-routed connector as authored', () => {
    const { nodes, edge } = example();
    edge.routeMode = 'direct';
    edge.waypoints = [{ x: 260, y: 60 }, { x: 260, y: 300 }];
    const before = structuredClone(edge);
    repairAnchors([edge], nodes);
    expect(edge).toEqual(before);
  });
});


describe('conservative routing repair', () => {
  it('removes an avoidable crossing without moving shapes or rewriting the other connector', () => {
    const nodes = [
      createNode({ id: 'a', type: 'service', x: 800, y: 520, width: 100, height: 70 }),
      createNode({ id: 'b', type: 'service', x: 800, y: 0, width: 100, height: 70 }),
      createNode({ id: 'c', type: 'service', x: 480, y: 260, width: 100, height: 70 }),
      createNode({ id: 'd', type: 'service', x: 800, y: 260, width: 100, height: 70 }),
    ];
    const edges = [createEdge({ id: 'ab', source: 'a', target: 'b' }), createEdge({ id: 'cd', source: 'c', target: 'd' })];
    const before = structuredClone({ nodes, other: edges[1] });
    const quality = measure(nodes, edges).tiers;
    expect(legibilityOf(nodes, edges).crossings).toBe(1);
    repairAnchors([edges[0]!], nodes, undefined, edges, undefined, true);
    expect(legibilityOf(nodes, edges).crossings).toBe(0);
    expect(noWorse(measure(nodes, edges).tiers, quality)).toBe(true);
    expect({ nodes, other: edges[1] }).toEqual(before);
    const once = structuredClone(edges);
    repairAnchors([edges[0]!], nodes, undefined, edges, undefined, true);
    expect(edges).toEqual(once);
  });

  it('shortens a genuine detour while leaving both shapes where they are', () => {
    const nodes = [
      createNode({ id: 'a', type: 'service', x: 0, y: 0, width: 100, height: 200 }),
      createNode({ id: 'b', type: 'service', x: 300, y: 0, width: 100, height: 200 }),
    ];
    const edges = [createEdge({ id: 'ab', source: 'a', target: 'b', sourceAnchor: { side: 'left', offset: 0.5 }, targetAnchor: { side: 'right', offset: 0.5 } })];
    expect(legibilityOf(nodes, edges).detours).toEqual(['ab']);
    const before = structuredClone(nodes);
    repairAnchors(edges, nodes, undefined, edges, undefined, true);
    expect(legibilityOf(nodes, edges)).toMatchObject({ detours: [], unresolved: [], crossings: 0 });
    expect(legibilityOf(nodes, edges).length).toBeLessThan(300);
    expect(nodes).toEqual(before);
  });

  it('repairs an unresolved generated route even when its fallback misses unrelated shapes', () => {
    const nodes = [
      createNode({ id: 'a', type: 'service', x: 0, y: 0, width: 100, height: 600 }),
      createNode({ id: 'b', type: 'service', x: 300, y: 0, width: 100, height: 600 }),
    ];
    const edges = [createEdge({ id: 'ab', source: 'a', target: 'b', sourceAnchor: { side: 'left', offset: 0.5 }, targetAnchor: { side: 'right', offset: 0.5 } })];
    expect(routeProblem(edges[0]!, nodes, edges)).toBeUndefined();
    expect(legibilityOf(nodes, edges).unresolved).toEqual(['ab']);
    repairAnchors(edges, nodes);
    expect(legibilityOf(nodes, edges).unresolved).toEqual([]);
  });

  it('leaves an already clean straight line alone, including its automatic ends', () => {
    const nodes = [createNode({ id: 'a', type: 'service', x: 0, y: 0 }), createNode({ id: 'b', type: 'service', x: 400, y: 0 })];
    const edges = [createEdge({ id: 'ab', source: 'a', target: 'b' })];
    const before = structuredClone(edges);
    repairAnchors(edges, nodes);
    repairAnchors(edges, nodes);
    expect(edges).toEqual(before);
  });

  it('preserves a hand-routed line even when it runs through a shape', () => {
    const nodes = [
      createNode({ id: 'a', type: 'service', x: 0, y: 0 }),
      createNode({ id: 'b', type: 'service', x: 600, y: 0 }),
      createNode({ id: 'wall', type: 'service', x: 300, y: 0 }),
    ];
    const edges = [{ ...createEdge({ id: 'ab', source: 'a', target: 'b' }), waypoints: [{ x: 360, y: 50 }] }];
    expect(routeProblem(edges[0]!, nodes, edges)?.kind).toBe('through-node');
    const before = structuredClone(edges);
    repairAnchors(edges, nodes);
    expect(edges).toEqual(before);
  });

  it('leaves anchors untouched when the request deadline has passed', () => {
    const { nodes, edge } = example();
    const before = structuredClone(edge);
    repairAnchors([edge], nodes, undefined, [edge], 0);
    expect(edge).toEqual(before);
  });

  it('does not worsen the whole drawing when repairing only one connector in the adversarial corpus', () => {
    for (const fixture of routingCorpus().filter((f) => f.id.startsWith('case/') && f.edges.length > 1)) {
      const nodes = structuredClone(fixture.nodes);
      const edges = structuredClone(fixture.edges);
      const before = measure(nodes, edges).tiers;
      const untouched = structuredClone(edges.slice(1));
      repairAnchors([edges[0]!], nodes, undefined, edges, undefined, true);
      expect(noWorse(measure(nodes, edges).tiers, before), fixture.id).toBe(true);
      expect(edges.slice(1), fixture.id).toEqual(untouched);
    }
  });
});
