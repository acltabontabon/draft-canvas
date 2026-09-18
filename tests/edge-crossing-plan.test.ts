import { describe, expect, it } from 'vitest';
import { createDocument, createEdge, createNode } from '../src/document/factory';
import { addEdges, addNodes } from '../src/document/operations';
import { crossingPlan, withoutMoving } from '../src/edges/crossings';
import { routeEdge } from '../src/edges/routing';
import { renderDocumentSvg } from '../src/render/svg/document';
import type { DraftEdge, DraftNode } from '../src/document/types';

/**
 * Where connectors cross, and who arcs over whom.
 *
 * The invariant underneath every case here is that this is a *drawing* decision. A crossing never
 * becomes a node, a junction or a relationship — `crossingPlan` reads the document and writes
 * nothing back — so the tests assert on what gets drawn over what, never on the graph.
 */

const box = (id: string, x: number, y: number): DraftNode =>
  createNode({ id, type: 'service', x, y, width: 160, height: 80 });

/**
 * The reference shape: A and B level with each other, C hanging below the gap between them, so the
 * A→B connector runs horizontally straight through the vertical run down to C.
 *
 *     A ────────────> B
 *            │
 *            ▼
 *            C
 */
function crossroads(patch: Partial<DraftEdge> = {}): { nodes: DraftNode[]; edges: DraftEdge[] } {
  return {
    nodes: [box('a', 0, 0), box('b', 600, 0), box('c', 260, 400)],
    edges: [
      createEdge({ id: 'ab', source: 'a', target: 'b', ...patch }),
      createEdge({ id: 'top', source: 'a', target: 'c' }),
    ],
  };
}

/** A tall node above and below a long horizontal run, so the vertical connector between them
 *  crosses it squarely in open canvas — the cleanest possible crossing. */
function squareCrossing(patch: Partial<DraftEdge> = {}): { nodes: DraftNode[]; edges: DraftEdge[] } {
  return {
    nodes: [box('left', 0, 300), box('right', 800, 300), box('up', 380, 0), box('down', 380, 620)],
    edges: [
      createEdge({ id: 'across', source: 'left', target: 'right', ...patch }),
      createEdge({ id: 'down', source: 'up', target: 'down', ...patch }),
    ],
  };
}

describe('a connector crossing another', () => {
  it('gives the arc to the horizontal run, not the vertical one', () => {
    const { nodes, edges } = squareCrossing();
    const plan = crossingPlan(nodes, edges);

    expect(plan.crossingsFor('across')).toHaveLength(1);
    expect(plan.crossingsFor('down')).toHaveLength(0);
  });

  it('bows the arc up and away from the line, in world space', () => {
    const { nodes, edges } = squareCrossing();
    const [crossing] = crossingPlan(nodes, edges).crossingsFor('across');

    expect(crossing).toBeDefined();
    expect({ nx: crossing!.nx, ny: crossing!.ny }).toEqual({ nx: 0, ny: -1 });
  });

  it('names the connector it crosses, so a drag can drop the arc when that one moves', () => {
    const { nodes, edges } = squareCrossing();
    const [crossing] = crossingPlan(nodes, edges).crossingsFor('across');

    expect(crossing!.otherSource).toBe('up');
    expect(crossing!.otherTarget).toBe('down');
  });

  it('leaves the document completely untouched', () => {
    const { nodes, edges } = squareCrossing();
    const before = JSON.stringify({ nodes, edges });
    crossingPlan(nodes, edges);

    expect(JSON.stringify({ nodes, edges })).toBe(before);
  });

  it('draws nothing where connectors merely pass near each other', () => {
    const nodes = [box('left', 0, 0), box('right', 800, 0), box('up', 380, 300), box('down', 380, 620)];
    const edges = [
      createEdge({ id: 'across', source: 'left', target: 'right' }),
      createEdge({ id: 'down', source: 'up', target: 'down' }),
    ];
    const plan = crossingPlan(nodes, edges);

    expect(plan.crossingsFor('across')).toHaveLength(0);
    expect(plan.crossingsFor('down')).toHaveLength(0);
  });

  it('draws nothing between two connectors that meet at the same shape', () => {
    const nodes = [box('hub', 0, 300), box('one', 700, 0), box('two', 700, 600)];
    const edges = [
      createEdge({ id: 'e1', source: 'hub', target: 'one' }),
      createEdge({ id: 'e2', source: 'hub', target: 'two' }),
    ];
    const plan = crossingPlan(nodes, edges);

    expect(plan.crossingsFor('e1')).toHaveLength(0);
    expect(plan.crossingsFor('e2')).toHaveLength(0);
  });

  it('draws nothing for a connector against itself', () => {
    const { nodes, edges } = crossroads();
    const plan = crossingPlan(nodes, edges);
    for (const edge of edges) {
      for (const crossing of plan.crossingsFor(edge.id)) {
        expect([crossing.otherSource, crossing.otherTarget]).not.toEqual([edge.source, edge.target]);
      }
    }
  });
});

describe('connectors that share a corridor rather than crossing', () => {
  /**
   * Four connectors between two columns, each source wired to a different target. Every stepped
   * route turns at the same midway column, so all four run along one shared vertical corridor and
   * peel off it at different heights.
   *
   * Nothing here is a crossing: where one connector leaves the corridor, its rounded corner sits on
   * top of the others, but a reader sees a line turning, not two lines meeting. Before the corridor
   * was accounted for, this drew four humps decorating four corners — the busiest arrangement in
   * the app getting the most decoration, for the least reason.
   */
  function corridor(): { nodes: DraftNode[]; edges: DraftEdge[] } {
    const nodes: DraftNode[] = [];
    for (let i = 0; i < 4; i += 1) nodes.push(box(`s${i}`, 0, i * 170));
    for (let i = 0; i < 4; i += 1) nodes.push(box(`t${i}`, 620, i * 170));
    const wiring = [
      [0, 2],
      [1, 0],
      [2, 3],
      [3, 1],
    ];
    return {
      nodes,
      edges: wiring.map(([from, to], i) => createEdge({ id: `e${i}`, source: `s${from!}`, target: `t${to!}` })),
    };
  }

  it('draws no humps where connectors only share the corridor', () => {
    const { nodes, edges } = corridor();
    const plan = crossingPlan(nodes, edges);
    for (const edge of edges) expect(plan.crossingsFor(edge.id)).toHaveLength(0);
  });
});

describe('which connector draws the arc', () => {
  it('hands it to the solid connector when the other is dashed', () => {
    const { nodes, edges } = squareCrossing();
    // The horizontal one would normally win; dashed, its arc would render as loose fragments.
    edges[0] = { ...edges[0]!, kind: 'event' };
    const plan = crossingPlan(nodes, edges);

    expect(plan.crossingsFor('across')).toHaveLength(0);
    expect(plan.crossingsFor('down')).toHaveLength(1);
  });

  it('draws nothing at all when both connectors are dashed', () => {
    const { nodes, edges } = squareCrossing({ kind: 'event' });
    const plan = crossingPlan(nodes, edges);

    expect(plan.crossingsFor('across')).toHaveLength(0);
    expect(plan.crossingsFor('down')).toHaveLength(0);
  });

  it('does not change hands when something unrelated moves', () => {
    const { nodes, edges } = squareCrossing();
    const before = crossingPlan(nodes, edges).crossingsFor('across');
    const moved = [...nodes, box('elsewhere', 2000, 2000)];
    const after = crossingPlan(moved, [...edges]).crossingsFor('across');

    expect(after).toHaveLength(before.length);
    expect(after[0]!.x).toBeCloseTo(before[0]!.x, 5);
  });

  it('does not change hands when an unrelated connector is added', () => {
    const { nodes, edges } = squareCrossing();
    const before = crossingPlan(nodes, edges).crossingsFor('across');
    const extra = [...nodes, box('x', 2000, 2000), box('y', 2400, 2000)];
    const plan = crossingPlan(extra, [...edges, createEdge({ id: 'zz', source: 'x', target: 'y' })]);

    expect(plan.crossingsFor('across')).toHaveLength(before.length);
    expect(plan.crossingsFor('down')).toHaveLength(0);
  });
});

describe('an exported image', () => {
  function documentWith(nodes: DraftNode[], edges: DraftEdge[]) {
    return addEdges(addNodes(createDocument('Crossing'), nodes), edges);
  }

  it('draws the same humps the canvas does', () => {
    const { nodes, edges } = squareCrossing();
    const svg = renderDocumentSvg(documentWith(nodes, edges)).svg;
    const humped = [...svg.matchAll(/<path d="([^"]+)"/g)].map((match) => match[1]!).filter((d) => d.includes('C'));

    expect(humped).toHaveLength(1);
    // Two cubics per hump: one easing up to the apex, one easing back down.
    expect(humped[0]!.match(/C/g)).toHaveLength(2);
  });

  it('draws none when no connectors cross', () => {
    const nodes = [box('a', 0, 0), box('b', 600, 0), box('c', 0, 400), box('d', 600, 400)];
    const edges = [
      createEdge({ id: 'top', source: 'a', target: 'b' }),
      createEdge({ id: 'bottom', source: 'c', target: 'd' }),
    ];
    const svg = renderDocumentSvg(documentWith(nodes, edges)).svg;

    expect(svg).not.toContain('C');
  });

  it('leaves the connector path a screen reader and a sequence export see untouched', () => {
    const { nodes, edges } = squareCrossing();
    const nodeMap = new Map(nodes.map((node) => [node.id, node]));

    // The canonical route is what hit testing, labels, attachment chips, step badges and every
    // semantic export read. A hump lives only in the drawn path, never in here.
    for (const edge of edges) expect(routeEdge(edge, nodeMap)!.d).not.toContain('C');
  });
});

describe('moving a shape', () => {
  it('takes the hump away when the crossing goes, and brings it back when it returns', () => {
    const { nodes, edges } = squareCrossing();
    expect(crossingPlan(nodes, edges).crossingsFor('across')).toHaveLength(1);

    // Slide the vertical pair off to the side: nothing crosses any more.
    const apart = nodes.map((node) => (node.id === 'up' || node.id === 'down' ? { ...node, x: 1600 } : node));
    expect(crossingPlan(apart, [...edges]).crossingsFor('across')).toHaveLength(0);

    // And back.
    const returned = apart.map((node) => (node.id === 'up' || node.id === 'down' ? { ...node, x: 380 } : node));
    expect(crossingPlan(returned, [...edges]).crossingsFor('across')).toHaveLength(1);
  });

  it('keeps the humps of connectors a gesture has not disturbed', () => {
    const { nodes, edges } = squareCrossing();
    const crossings = crossingPlan(nodes, edges).crossingsFor('across');

    expect(withoutMoving(crossings, new Set())).toBe(crossings);
    expect(withoutMoving(crossings, new Set(['somewhere-else']))).toBe(crossings);
    // The crossed connector is on the move, so its crossing is no longer where the plan thinks.
    expect(withoutMoving(crossings, new Set(['up']))).toHaveLength(0);
  });
});

describe('the plan itself', () => {
  it('hands back the identical result for an unchanged document', () => {
    const { nodes, edges } = squareCrossing();
    expect(crossingPlan(nodes, edges)).toBe(crossingPlan(nodes, edges));
  });

  it('hands back the identical empty list for every connector that crosses nothing', () => {
    const nodes = [box('a', 0, 0), box('b', 600, 0), box('c', 0, 400), box('d', 600, 400)];
    const edges = [
      createEdge({ id: 'top', source: 'a', target: 'b' }),
      createEdge({ id: 'bottom', source: 'c', target: 'd' }),
    ];
    const plan = crossingPlan(nodes, edges);

    expect(plan.crossingsFor('top')).toBe(plan.crossingsFor('bottom'));
    expect(plan.crossingsFor('top')).toHaveLength(0);
  });

  it('holds no crossings for a document with a single connector', () => {
    const nodes = [box('a', 0, 0), box('b', 600, 0)];
    const plan = crossingPlan(nodes, [createEdge({ id: 'only', source: 'a', target: 'b' })]);

    expect(plan.crossingsFor('only')).toHaveLength(0);
  });
});
