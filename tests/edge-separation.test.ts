import { describe, expect, it } from 'vitest';
import { createEdge, createNode } from '../src/document/factory';
import type { DraftEdge, DraftNode } from '../src/document/types';
import { connectorRoutes } from '../src/edges/connectorRoutes';
import { crossingPlan } from '../src/edges/crossings';
import { edgeRoutes, rawRouteInputs } from '../src/edges/edgeRoutes';
import { separationPlan } from '../src/edges/separation';
import { stepPolyline } from '../src/edges/waypoints';

/**
 * Connectors that would run on top of each other through one corridor get parallel tracks — only
 * inner runs move, every moved line is checked whole, and lines drawn as one on purpose stay together.
 */

const box = (id: string, x: number, y: number, width = 160, height = 80): DraftNode => createNode({ id, type: 'service', x, y, width, height });
const edge = (id: string, source: string, target: string, extra: Partial<DraftEdge> = {}): DraftEdge => createEdge({ id, source, target, ...extra });

const right = { side: 'right' as const, offset: 0.5 };
const left = { side: 'left' as const, offset: 0.5 };

/** Two connectors from a left column to a right column, both stepping down through the same midline. */
function corridor(extra: Partial<DraftEdge> = {}) {
  const nodes = [box('l0', 0, 0), box('l1', 0, 100), box('r0', 600, 200), box('r1', 600, 600)];
  const pins = { sourceAnchor: right, targetAnchor: left };
  const edges = [edge('a', 'l0', 'r0', { semantic: 'calls', ...pins, ...extra }), edge('b', 'l1', 'r1', { semantic: 'writes', ...pins, ...extra })];
  return { nodes, edges };
}

/** Each connector's corners as drawn, and before separation. */
function lines(nodes: readonly DraftNode[], edges: readonly DraftEdge[]) {
  return edges.map((e) => {
    const drawn = stepPolyline(connectorRoutes(e, { nodes, edges }, 'transient')!.request.d);
    const raw = stepPolyline(edgeRoutes(rawRouteInputs(e, { nodes, edges }, 'transient')!, 'transient').request.d);
    return { drawn, raw };
  });
}

describe('separating connectors that share a corridor', () => {
  it('moves the shared run of each onto its own track, ten units apart', () => {
    const { nodes, edges } = corridor();
    const [a, b] = lines(nodes, edges);
    // Before: both vertical runs on one x.
    expect(a!.raw[1]!.x).toBe(b!.raw[1]!.x);
    expect(Math.abs(a!.drawn[1]!.x - b!.drawn[1]!.x)).toBeCloseTo(10);
  });

  it('never moves where a line leaves or meets its shapes', () => {
    const { nodes, edges } = corridor();
    for (const { drawn, raw } of lines(nodes, edges)) {
      expect(drawn[0]).toEqual(raw[0]);
      expect(drawn[drawn.length - 1]).toEqual(raw[raw.length - 1]);
    }
  });

  it('adds no crossing', () => {
    const { nodes, edges } = corridor();
    const separated = crossingPlan(nodes, edges, nodes, 'transient');
    const count = edges.reduce((sum, e) => sum + separated.crossingsFor(e.id).length, 0);
    expect(count).toBe(0);
  });

  it('leaves bent, straight and curved lines exactly as they were', () => {
    for (const routing of ['straight', 'bezier'] as const) {
      const { nodes, edges } = corridor({ routing });
      expect(separationPlan(nodes, edges, 'transient').tracksFor('a')).toBeUndefined();
      expect(separationPlan(nodes, edges, 'transient').tracksFor('b')).toBeUndefined();
    }
    const { nodes, edges } = corridor();
    const bent = edges.map((e) => (e.id === 'a' ? { ...e, waypoints: [{ x: 380, y: 40 }, { x: 380, y: 640 }] } : e));
    expect(separationPlan(nodes, bent, 'transient').tracksFor('a')).toBeUndefined();
    const before = edgeRoutes(rawRouteInputs(bent[0]!, { nodes, edges: bent }, 'transient')!, 'transient').request.d;
    expect(connectorRoutes(bent[0]!, { nodes, edges: bent }, 'transient')!.request.d).toBe(before);
  });

  it('keeps a trunk\'s members together', () => {
    const nodes = [box('hub', 0, 300), box('t0', 600, 0), box('t1', 600, 300), box('t2', 600, 600)];
    const edges = ['t0', 't1', 't2'].map((t) => edge(`hub-${t}`, 'hub', t, { semantic: 'calls' }));
    const plan = separationPlan(nodes, edges, 'transient');
    for (const e of edges) expect(plan.tracksFor(e.id)).toBeUndefined();
  });

  it('records a corridor it could not separate rather than forcing it', () => {
    // Shapes so close that each shared run sits between two 20-unit legs: neither can move.
    const nodes = [box('l0', 0, 0), box('l1', 0, 100), box('r0', 200, 300), box('r1', 200, 700)];
    const pins = { sourceAnchor: right, targetAnchor: left };
    const edges = [edge('a', 'l0', 'r0', { semantic: 'calls', ...pins }), edge('b', 'l1', 'r1', { semantic: 'writes', ...pins })];
    const plan = separationPlan(nodes, edges, 'transient');
    expect(plan.tracksFor('a')).toBeUndefined();
    expect(plan.tracksFor('b')).toBeUndefined();
    expect(plan.skipped).toBeGreaterThan(0);
  });

  it('hands back the same tracks object while nothing it depends on changes', () => {
    const { nodes, edges } = corridor();
    const first = separationPlan(nodes, edges).tracksFor('a');
    expect(first).toBeDefined();
    const renamed = nodes.map((n) => (n.id === 'r0' ? { ...n, text: 'Renamed' } : n));
    expect(separationPlan(renamed, edges).tracksFor('a')).toBe(first);
  });
});
