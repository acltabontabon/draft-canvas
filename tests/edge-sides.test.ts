import { describe, expect, it } from 'vitest';
import { createEdge, createNode } from '../src/document/factory';
import type { DraftEdge, DraftNode } from '../src/document/types';
import { endpointPlan } from '../src/edges/endpoints';
import { anchorPoint, rectOf, resolveSides } from '../src/edges/routing';
import { chooseEdgeSides } from '../src/edges/sides';
import { routingCorpus } from './fixtures/routing/corpus';
import { drawnConnectors } from './fixtures/routing/drawn';
import { measure } from './fixtures/routing/measure';
import { scatter } from './fixtures/routing/scatter';

const box = (id: string, x: number, y: number, width = 100, height = 70): DraftNode => createNode({ id, type: 'service', x, y, width, height });

/** The sides the plan moves ends to, judged on the lines as the shapes alone place them. */
const chosen = (nodes: readonly DraftNode[], edges: readonly DraftEdge[]) => chooseEdgeSides(nodes, edges, 'transient', () => undefined);
const drawn = (nodes: readonly DraftNode[], edges: readonly DraftEdge[]) => Object.fromEntries(drawnConnectors(nodes, edges).map((c) => [c.edge.id, c.request]));

/**
 * `a` below `b` with `d` between them, and `c` joined to `d` from the left. The shapes alone send
 * a→b top to bottom, round `d` on the side `c`'s line comes in on, and across it.
 */
function aroundTheMiddle(ab: Partial<DraftEdge> = {}) {
  const nodes = [box('a', 800, 520), box('b', 800, 0), box('c', 480, 260), box('d', 800, 260)];
  const edges: DraftEdge[] = [{ ...createEdge({ id: 'ab', source: 'a', target: 'b' }), ...ab }, createEdge({ id: 'cd', source: 'c', target: 'd' })];
  return { nodes, edges };
}

describe('side plan', () => {
  it('leaves connectors with nothing wrong exactly as the shapes alone draw them', () => {
    const nodes = [box('a', 0, 0), box('b', 300, 0), box('c', 0, 200), box('d', 300, 200)];
    const edges = [createEdge({ id: 'ab', source: 'a', target: 'b' }), createEdge({ id: 'cd', source: 'c', target: 'd' }), createEdge({ id: 'ac', source: 'a', target: 'c' })];
    expect(chosen(nodes, edges).size).toBe(0);
    expect(endpointPlan(nodes, edges, 'transient').spreadFor('ab')).toBeUndefined();
  });

  it('moves no line of the starters or the gallery: they were laid out to be read', () => {
    for (const fixture of routingCorpus().filter((f) => f.source === 'starter' || f.source === 'gallery')) {
      expect(chosen(fixture.nodes, fixture.edges).size, fixture.id).toBe(0);
    }
  });

  it('takes a connector off the side that crosses another onto one that does not', () => {
    const { nodes, edges } = aroundTheMiddle();
    const sides = chosen(nodes, edges).get('ab');
    expect(sides).toBeDefined();
    expect(chosen(nodes, edges).has('cd')).toBe(false);
    const quality = measure(nodes, edges);
    expect(quality.tiers).toMatchObject({ obstruction: 0, overlap: 0, crossings: 0 });
    expect(quality.violations).toEqual({ endpoint: 0, continuity: 0, bends: 0, pins: 0 });
    const ab = drawn(nodes, edges).ab!;
    expect(ab.status).toBe('clear');
    expect({ source: ab.source.side, target: ab.target.side }).toEqual({ source: sides!.source ?? 'top', target: sides!.target ?? 'bottom' });
  });

  it('never moves a pinned end, and leaves a connector pinned at both ends alone', () => {
    const pinned = aroundTheMiddle({ sourceAnchor: { side: 'top', offset: 0.5 }, targetAnchor: { side: 'bottom', offset: 0.5 } });
    expect(chosen(pinned.nodes, pinned.edges).has('ab')).toBe(false);
    const both = drawn(pinned.nodes, pinned.edges).ab!;
    expect([both.source.side, both.target.side]).toEqual(['top', 'bottom']);

    const half = aroundTheMiddle({ sourceAnchor: { side: 'top', offset: 0.25 } });
    expect(chosen(half.nodes, half.edges).get('ab')?.source).toBeUndefined();
    const one = drawn(half.nodes, half.edges).ab!;
    const pin = anchorPoint(rectOf(half.nodes[0]!), 'top', 0.25);
    expect(one.source.side).toBe('top');
    expect(one.source.x).toBeCloseTo(pin.x, 5);
    expect(one.source.y).toBeCloseTo(pin.y, 5);
    expect(measure(half.nodes, half.edges).violations.pins).toBe(0);
  });

  it('leaves hand-bent, straight and curved connectors as they are', () => {
    for (const fixed of [{ waypoints: [{ x: 760, y: 480 }, { x: 760, y: 110 }] }, { routing: 'straight' as const }, { routing: 'bezier' as const }]) {
      const { nodes, edges } = aroundTheMiddle(fixed);
      expect(chosen(nodes, edges).has('ab')).toBe(false);
    }
  });

  it('settles the same way whatever order the connectors are listed in, and however often it is asked', () => {
    const { nodes, edges } = scatter(25);
    const paths = (list: readonly DraftEdge[]) => Object.fromEntries(Object.entries(drawn(nodes, list)).map(([id, line]) => [id, line.d]));
    const first = paths(edges);
    expect(paths(edges)).toEqual(first);
    // Fresh connector objects: nothing remembered from the first time.
    expect(paths(structuredClone(edges))).toEqual(first);
    expect(paths([...structuredClone(edges)].reverse())).toEqual(first);
  });

  it('reaches the drawn lines, within every hard rule', () => {
    for (const seed of [14, 23, 25, 47, 52]) {
      const { nodes, edges } = scatter(seed);
      const byId = new Map(nodes.map((node) => [node.id, node]));
      const lines = drawn(nodes, edges);
      // Ends drawn on another side than the two shapes alone would choose: the plan at work.
      const moved = edges.filter((edge) => {
        const home = resolveSides(rectOf(byId.get(edge.source)!), rectOf(byId.get(edge.target)!));
        return lines[edge.id]!.source.side !== home.source || lines[edge.id]!.target.side !== home.target;
      });
      expect(moved.length, `seed ${seed}`).toBeGreaterThan(0);
      const quality = measure(nodes, edges);
      expect(quality.violations, `seed ${seed}`).toEqual({ endpoint: 0, continuity: 0, bends: 0, pins: 0 });
      expect(quality.unresolved.blocked + quality.unresolved.budget, `seed ${seed}`).toBe(0);
    }
  });
});
