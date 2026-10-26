import { describe, expect, it } from 'vitest';
import { createEdge, createNode } from '../src/document/factory';
import type { DraftEdge, DraftNode } from '../src/document/types';
import { othersOf } from '../src/agent/route';
import { legibilityOf } from '../src/agent/legibility';
import { routingPlan } from '../src/edges/bundles';
import { describeEdge } from '../src/edges/describe';
import { connectorRoutes } from '../src/edges/connectorRoutes';
import { endpointPlan } from '../src/edges/endpoints';
import { separationPlan } from '../src/edges/separation';
import { obstaclesForEdge } from '../src/edges/obstacles';
import { laneIndex } from '../src/edges/routing';
import { DARK } from '../src/render/theme/tokens';
import { StaticTextMeasurer } from '../src/render/text/measure';
import { routingCorpus } from './fixtures/routing/corpus';

/**
 * One way to route a connector. The canvas, the export and the agent's checks all read a connector's
 * routes through `connectorRoutes` (or the inputs behind it), so what an agent is told about a line is
 * the line a person sees and exports.
 */

const measurer = new StaticTextMeasurer();

describe('the shared route accessor', () => {
  it('draws exactly what the exporter describes, request and reply, across the routing corpus', () => {
    let compared = 0;
    for (const fixture of routingCorpus().filter((f) => f.source !== 'workload')) {
      const byId = new Map(fixture.nodes.map((n) => [n.id, n]));
      const lanes = laneIndex(fixture.edges);
      const plan = routingPlan(fixture.nodes, fixture.edges, 'transient');
      for (const edge of fixture.edges) {
        const routes = connectorRoutes(edge, fixture, 'transient', byId);
        // Described from the context alone, as a caller without the routes would: the same answer.
        const described = describeEdge(edge, byId, {
          theme: DARK,
          measurer,
          showSequence: false,
          lane: lanes.get(edge.id)?.offset ?? 0,
          spine: plan.spineFor(edge.id),
          obstacles: obstaclesForEdge(fixture.nodes, edge.source, edge.target, 'transient'),
          spread: endpointPlan(fixture.nodes, fixture.edges, 'transient').spreadFor(edge.id),
          tracks: separationPlan(fixture.nodes, fixture.edges, 'transient').tracksFor(edge.id),
        });
        expect(Boolean(described), `${fixture.id}:${edge.id}`).toBe(Boolean(routes));
        if (!routes || !described) continue;
        expect(described.line[0]!.t === 'path' && described.line[0]!.d, `${fixture.id}:${edge.id}`).toBe(routes.request.d);
        const reply = described.responseLine?.[0];
        expect(reply && reply.t === 'path' ? reply.d : null, `${fixture.id}:${edge.id} reply`).toBe(routes.response?.d ?? null);
        compared += 1;
      }
    }
    expect(compared).toBeGreaterThan(200);
  });

  it('excludes folded compensations from endpoint spreading, lanes and agent checks', () => {
    const nodes = [
      createNode({ id: 'a', type: 'service', x: 0, y: 0 }),
      createNode({ id: 'b', type: 'service', x: 400, y: 0 }),
    ];
    const call = createEdge({ id: 'call', source: 'a', target: 'b' });
    const folded = createEdge({ id: 'undo', source: 'a', target: 'b', semantic: 'compensates', compensationFor: 'call', compensationVisible: false });
    const baseline = connectorRoutes(call, { nodes, edges: [call] }, 'transient');
    const edges = [call, folded];
    expect(connectorRoutes(call, { nodes, edges }, 'transient')).toEqual(baseline);
    expect(othersOf(nodes, edges).map((e) => e.id)).toEqual(['call']);
    expect(legibilityOf(nodes, edges)).toEqual(legibilityOf(nodes, [call]));
  });

  it('hands back the same routes object while nothing it depends on changes', () => {
    const nodes: DraftNode[] = [
      createNode({ id: 'a', type: 'service', x: 0, y: 0 }),
      createNode({ id: 'b', type: 'service', x: 400, y: 0 }),
      createNode({ id: 'far', type: 'service', x: 0, y: 900 }),
    ];
    const edges: DraftEdge[] = [createEdge({ id: 'ab', source: 'a', target: 'b', label: 'calls' })];
    const first = connectorRoutes(edges[0]!, { nodes, edges }, 'canvas');
    expect(connectorRoutes(edges[0]!, { nodes, edges }, 'canvas')).toBe(first);
    // A rename elsewhere is a new nodes array with every shape where it was.
    const renamed = nodes.map((n) => (n.id === 'far' ? { ...n, text: 'Renamed' } : n));
    expect(connectorRoutes(edges[0]!, { nodes: renamed, edges }, 'canvas')).toBe(first);
    // Moving a shape the connector routes between is a new answer.
    const moved = nodes.map((n) => (n.id === 'b' ? { ...n, y: 40 } : n));
    expect(connectorRoutes(edges[0]!, { nodes: moved, edges }, 'canvas')).not.toBe(first);
  });

  it('never files a transient answer where the canvas would find it', () => {
    const nodes: DraftNode[] = [
      createNode({ id: 'a', type: 'service', x: 10_000, y: 0 }),
      createNode({ id: 'b', type: 'service', x: 10_480, y: 120 }),
    ];
    const edges: DraftEdge[] = [createEdge({ id: 'ab', source: 'a', target: 'b' })];
    const transient = connectorRoutes(edges[0]!, { nodes, edges }, 'transient');
    const canvas = connectorRoutes(edges[0]!, { nodes, edges }, 'canvas');
    expect(canvas).toEqual(transient);
    expect(canvas).not.toBe(transient);
    // Once the canvas has it, a transient reader is handed the canvas's own answer.
    expect(connectorRoutes(edges[0]!, { nodes, edges }, 'transient')).toBe(canvas);
  });
});
