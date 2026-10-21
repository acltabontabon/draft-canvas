import { describe, expect, it } from 'vitest';
import { createEdge, createNode } from '../src/document/factory';
import { routingPlan } from '../src/edges/bundles';
import { crossingPlan } from '../src/edges/crossings';
import { computeEdgeRoutes, edgeRoutes, type EdgeRouteInputs } from '../src/edges/edgeRoutes';
import { obstaclesForEdge } from '../src/edges/obstacles';
import { laneIndex, rectOf } from '../src/edges/routing';
import type { DraftEdge, DraftNode } from '../src/document/types';

/**
 * A connector's routes are worked out once and shared: the crossing plan routes every connector
 * as a diagram opens, and the canvas then draws each from that same answer instead of routing it a
 * second time. Only the canvas files routes; an export or preview reads but never writes.
 */

const box = (id: string, x: number, y: number): DraftNode => createNode({ id, type: 'service', x, y, width: 160, height: 80 });

function inputsFor(nodes: DraftNode[], edges: DraftEdge[], edge: DraftEdge): EdgeRouteInputs {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const lane = laneIndex(edges).get(edge.id)?.offset ?? 0;
  return {
    source: rectOf(byId.get(edge.source)!),
    target: rectOf(byId.get(edge.target)!),
    routing: edge.routing,
    label: edge.label,
    sourceAnchor: edge.sourceAnchor,
    targetAnchor: edge.targetAnchor,
    hasResponse: edge.hasResponse,
    lane,
    spine: routingPlan(nodes, edges).spineFor(edge.id),
    obstacles: obstaclesForEdge(nodes, edge.source, edge.target),
    waypoints: edge.waypoints,
  };
}

describe('shared connector routes', () => {
  it('hands the canvas the routes the crossing plan already worked out', () => {
    const nodes = [box('a', 0, 0), box('b', 600, 40), box('c', 300, 400)];
    const edges = [
      createEdge({ id: 'ab', source: 'a', target: 'b', label: 'calls', hasResponse: true }),
      createEdge({ id: 'ac', source: 'a', target: 'c' }),
    ];
    crossingPlan(nodes, edges);
    const inputs = inputsFor(nodes, edges, edges[0]!);
    const shared = edgeRoutes(inputs);
    // The very object the plan filed, not a fresh routing of the same inputs.
    expect(edgeRoutes({ ...inputs })).toBe(shared);
    expect(shared).toEqual(computeEdgeRoutes(inputs));
    expect(shared.response).not.toBeNull();
  });

  it('never files the routes of a render outside the canvas', () => {
    const nodes = [box('p', 0, 1000), box('q', 700, 1100)];
    const edges = [createEdge({ id: 'pq', source: 'p', target: 'q' })];
    const inputs = inputsFor(nodes, edges, edges[0]!);
    const first = edgeRoutes(inputs, 'transient');
    expect(edgeRoutes(inputs, 'transient')).not.toBe(first);
    const filed = edgeRoutes(inputs);
    expect(edgeRoutes(inputs, 'transient')).toBe(filed);
  });
});
