import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { continuationsFor, materialize } from '../src/continuation';
import { inferRelationship } from '../src/document/connectorSemantics';
import { createDocument, createEdge, createNode } from '../src/document/factory';
import { addEdges, addNodes } from '../src/document/operations';
import type { DraftDocument } from '../src/document/types';
import { connectorRoutes } from '../src/edges/connectorRoutes';
import { computeEdgeRoutes, edgeRoutes } from '../src/edges/edgeRoutes';
import { deserializeDocument } from '../src/export/project';
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

/**
 * A ghost is a promise: what it draws is what accepting it gets. Its connector is routed from the
 * graph it will be drawn in, with every input the canvas gives the real one — and where it left two
 * of them out (where the ends were spread on a shared side, the tracks parallel runs were moved
 * onto), the connector moved when the offer was accepted.
 */
describe('a ghost connector is routed as the accepted one will be', () => {
  /** The line the offer's first connector draws as a ghost, and the one it draws once accepted. */
  function bothWays(doc: DraftDocument, anchor: string, ruleId: string) {
    const candidate = continuationsFor(doc, anchor, 'invoke').find((c) => c.ruleId === ruleId)!;
    const offer = materialize(doc, candidate)!;
    const edge = offer.edges[0]!;
    const graph = ghostGraph([...doc.nodes, ...offer.nodes], [...doc.edges, ...offer.edges]);
    const route = ghostRouteFor(graph, edge)!;
    const ghost = edgeRoutes(ghostRouteInputs(edge, route), 'transient');
    const accepted = addEdges(addNodes(doc, offer.nodes), offer.edges);
    const real = connectorRoutes(accepted.edges.find((e) => e.id === edge.id)!, accepted, 'transient')!;
    return { ghost, real, route };
  }

  it('shares a side with the connector already arriving there: its end is spread, as the real one’s will be', () => {
    // A request comes in on the right of the service, pinned there — and the suggestion leaves from the
    // right as well. The plan spreads the two ends along that side; a ghost that skipped it started
    // its line at the middle of the side, on top of the one arriving.
    const service = createNode({ id: 'a', type: 'service', x: 0, y: 200 });
    const caller = createNode({ id: 'up', type: 'actor', x: 700, y: -250 });
    const below = createNode({ id: 'down', type: 'service', x: -20, y: 460 });
    const doc = addEdges(addNodes(createDocument('Crowded side'), [service, caller, below]), [
      createEdge({ source: 'up', target: 'a', ...inferRelationship(caller, service), semanticsOrigin: 'inferred', targetAnchor: { side: 'right', offset: 0.5 } }),
      createEdge({ source: 'a', target: 'down', ...inferRelationship(service, below), semanticsOrigin: 'inferred', sourceAnchor: { side: 'bottom', offset: 0.5 }, targetAnchor: { side: 'top', offset: 0.5 } }),
    ]);
    const { ghost, real, route } = bothWays(doc, 'a', 'service-data-store');
    expect(route.spread, 'the end is spread by the plan').toBeDefined();
    expect(ghost.request.d).toBe(real.request.d);
    // …which is not the line the old inputs gave.
    const unplanned = edgeRoutes(ghostRouteInputs(materialize(doc, continuationsFor(doc, 'a', 'invoke')[0]!)!.edges[0]!, { ...route, spread: undefined, tracks: undefined }), 'transient');
    expect(unplanned.request.d).not.toBe(real.request.d);
  });

  // The vendored starters are the diagrams a first suggestion lands in: every offer, from every
  // shape of every one of them, must preview the line it will draw. They include the corridors that
  // get tracks and the sides that get spread, which no small fixture reproduces by luck.
  it('previews the line it will draw, for every offer from every shape of every starter', () => {
    const root = resolve(__dirname, 'fixtures', 'starters');
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) walk(path);
        else if (name.endsWith('.draftcanvas')) files.push(path);
      }
    };
    walk(root);
    expect(files.length).toBeGreaterThan(0);

    let compared = 0;
    let spread = 0;
    let tracked = 0;
    const differing: string[] = [];
    for (const file of files) {
      const parsed = deserializeDocument(readFileSync(file, 'utf8'));
      if (!parsed.ok) continue;
      const doc = parsed.document;
      for (const node of doc.nodes) {
        for (const candidate of continuationsFor(doc, node.id, 'invoke')) {
          const offer = materialize(doc, candidate);
          if (!offer) continue;
          const graph = ghostGraph([...doc.nodes, ...offer.nodes], [...doc.edges, ...offer.edges]);
          const accepted = addEdges(addNodes(doc, offer.nodes), offer.edges);
          for (const edge of offer.edges) {
            const route = ghostRouteFor(graph, edge);
            const real = connectorRoutes(accepted.edges.find((e) => e.id === edge.id)!, accepted, 'transient');
            if (!route || !real) continue;
            compared += 1;
            if (route.spread) spread += 1;
            if (route.tracks) tracked += 1;
            const ghost = edgeRoutes(ghostRouteInputs(edge, route), 'transient');
            if (ghost.request.d !== real.request.d || ghost.request.labelRoom !== real.request.labelRoom) differing.push(`${file.split('/').pop()}: ${node.text} → ${candidate.id}`);
          }
        }
      }
    }
    expect(differing).toEqual([]);
    // The corpus really does exercise both plans, or this would pass for the wrong reason.
    expect(compared).toBeGreaterThan(100);
    expect(spread).toBeGreaterThan(0);
    expect(tracked).toBeGreaterThan(0);
  });
});
