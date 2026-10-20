import { describe, expect, it } from 'vitest';
import { createEdge, createNode } from '../../src/document/factory';
import { bendsOf, drawnRoute, repairAnchors, routeCost } from '../../src/agent/route';

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
