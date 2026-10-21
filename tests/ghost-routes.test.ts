import { describe, expect, it } from 'vitest';
import { createEdge, createNode } from '../src/document/factory';
import { computeEdgeRoutes } from '../src/edges/edgeRoutes';
import { ghostGraph, ghostRouteFor, ghostRouteInputs } from '../src/canvas/ghostRoutes';

function scene() {
  const api = createNode({ type: 'service', x: 0, y: 0, text: 'API' });
  const store = createNode({ type: 'database', x: 500, y: 300, text: 'Store' });
  return { api, store };
}

describe('ghost connector routes', () => {
  it('route through the connector bends, as the canvas draws it', () => {
    const { api, store } = scene();
    const straight = createEdge({ source: api.id, target: store.id });
    const bent = { ...straight, waypoints: [{ x: 250, y: -120 }] };
    const graph = ghostGraph([api, store], [bent]);
    const route = ghostRouteFor(graph, bent)!;
    const inputs = ghostRouteInputs(bent, route);
    expect(inputs.waypoints).toEqual(bent.waypoints);
    const drawn = computeEdgeRoutes(inputs).request.d;
    const unbent = computeEdgeRoutes(ghostRouteInputs(straight, ghostRouteFor(ghostGraph([api, store], [straight]), straight)!)).request.d;
    expect(drawn).not.toBe(unbent);
    expect(drawn).toContain('-120');
  });

  it('give parallel connectors their own lanes, and a request/response connector its reply', () => {
    const { api, store } = scene();
    const one = createEdge({ source: api.id, target: store.id, label: 'reads' });
    const two = { ...createEdge({ source: api.id, target: store.id, label: 'writes' }), hasResponse: true };
    const graph = ghostGraph([api, store], [one, two]);
    const lanes = [one, two].map((edge) => ghostRouteFor(graph, edge)!.lane);
    expect(new Set(lanes).size).toBe(2);
    expect(computeEdgeRoutes(ghostRouteInputs(two, ghostRouteFor(graph, two)!)).response).not.toBeNull();
    expect(computeEdgeRoutes(ghostRouteInputs(one, ghostRouteFor(graph, one)!)).response).toBeNull();
  });

  it('is null for a connector whose endpoint is not in the graph', () => {
    const { api, store } = scene();
    const edge = createEdge({ source: api.id, target: store.id });
    expect(ghostRouteFor(ghostGraph([api], [edge]), edge)).toBeNull();
  });
});
