import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildScaleDocument, SCALE_SPECS } from '../benchmark/workloads/scale';
import { createEdge, createNode } from '../src/document/factory';
import type { DraftDocument, DraftEdge, DraftNode } from '../src/document/types';
import { routingPlan, TRUNK_OBSTACLE_MARGIN } from '../src/edges/bundles';
import { obstaclesForEdge } from '../src/edges/obstacles';
import { searchAllowed } from '../src/edges/edgeRoutes';
import { endpointPlan, type EndpointPlan } from '../src/edges/endpoints';
import { PLAN_REACH, sameNodeGeometryAround, sameRouteGeometryAround } from '../src/edges/sameGeometry';
import { deserializeDocument } from '../src/export/project';

/**
 * A plan built for one edit is reused for the next when nothing it reads has moved — a drag of a
 * shape that nothing is joined to, far from every connector, used to plan every connector again. The
 * reuse has to be exact: this compares what the canvas hands out after a run of random edits (the
 * path that reuses, and memoises per connector) with the same document planned from nothing (cloned
 * shapes and connectors, so no memo or reuse can apply), edit after edit.
 */

const STARTERS = join(__dirname, 'fixtures', 'starters', 'starters');

function startersUnder(dir: string): string[] {
  const found: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) found.push(...startersUnder(path));
    else if (name.endsWith('.draftcanvas')) found.push(path);
  }
  return found.sort();
}

function load(file: string): DraftDocument {
  const parsed = deserializeDocument(readFileSync(file, 'utf8'));
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.document;
}

/** mulberry32: the same edits on every run, on every machine. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const extent = (nodes: readonly DraftNode[]) => ({
  minX: Math.min(...nodes.map((n) => n.x)),
  minY: Math.min(...nodes.map((n) => n.y)),
  maxX: Math.max(...nodes.map((n) => n.x + n.width)),
  maxY: Math.max(...nodes.map((n) => n.y + n.height)),
});

/** The document with three shapes nothing is joined to: a service, a note and a boundary. */
function withStrays(doc: DraftDocument, random: () => number): DraftDocument {
  const box = extent(doc.nodes);
  const at = () => ({ x: box.minX + random() * (box.maxX - box.minX), y: box.minY + random() * (box.maxY - box.minY) });
  const strays = [
    createNode({ id: 'stray-service', type: 'service', text: 'Stray', ...at() }),
    createNode({ id: 'stray-note', type: 'note', text: 'A thought', ...at() }),
    createNode({ id: 'stray-boundary', type: 'group', text: 'Nothing in it', ...at(), width: 220, height: 140 }),
  ];
  return { ...doc, nodes: [...doc.nodes, ...strays] };
}

/** One edit: one to three shapes moved, a stray one about every other time, near or very far, or
 *  resized in place — and now and then a stray shape dropped just outside, or just inside, the box
 *  a connector's two shapes span, where the reach of what the plans read begins. A new array and new
 *  objects for what changed, as the store makes them. */
function edit(nodes: readonly DraftNode[], edges: readonly DraftEdge[], random: () => number): DraftNode[] {
  const count = 1 + Math.floor(random() * 3);
  const chosen = new Set<number>();
  for (let i = 0; i < count; i += 1) {
    const stray = random() < 0.5;
    const pool = nodes.map((n, index) => [n, index] as const).filter(([n]) => n.id.startsWith('stray-') === stray);
    chosen.add(pool[Math.floor(random() * pool.length)]![1]);
  }
  const kind = random();
  const byId = new Map(nodes.map((node) => [node.id, node]));
  return nodes.map((node, index) => {
    if (!chosen.has(index)) return node;
    if (kind < 0.2) return { ...node, x: node.x + (random() - 0.5) * 12, y: node.y + (random() - 0.5) * 12 };
    if (kind < 0.45) return { ...node, x: node.x + (random() - 0.5) * 900, y: node.y + (random() - 0.5) * 900 };
    if (kind < 0.6) return { ...node, x: node.x + (random() < 0.5 ? -1 : 1) * (3000 + random() * 3000), y: node.y + (random() - 0.5) * 400 };
    if (kind < 0.85) {
      // Around a connector: at a random distance, from inside its span to well past the reach.
      const edge = edges[Math.floor(random() * edges.length)]!;
      const [a, b] = [byId.get(edge.source), byId.get(edge.target)];
      if (!a || !b) return node;
      const box = extent([a, b]);
      const gap = -40 + random() * 340;
      const side = Math.floor(random() * 4);
      const along = random();
      return {
        ...node,
        x: side === 0 ? box.minX - gap - node.width : side === 1 ? box.maxX + gap : box.minX + along * (box.maxX - box.minX),
        y: side === 2 ? box.minY - gap - node.height : side === 3 ? box.maxY + gap : box.minY + along * (box.maxY - box.minY),
      };
    }
    return { ...node, width: Math.max(60, node.width + (random() - 0.5) * 200), height: Math.max(40, node.height + (random() - 0.5) * 120) };
  });
}

const snapshot = (plan: EndpointPlan, edges: readonly DraftEdge[]) => ({
  crowded: plan.crowded,
  spreads: edges.map((edge) => [edge.id, plan.spreadFor(edge.id) ?? null]),
});

/** The plan from nothing: every shape and connector a new object, so no memo or reuse can apply. */
function fresh(nodes: readonly DraftNode[], edges: readonly DraftEdge[]) {
  const clonedNodes = nodes.map((node) => ({ ...node }));
  const clonedEdges = edges.map((edge) => ({ ...edge }));
  return { nodes: clonedNodes, edges: clonedEdges };
}

interface Tally {
  edits: number;
  reused: number;
  built: number;
}

/** Runs `edits` random edits down a chain and checks every plan the canvas hands out against a fresh one. */
function runChain(document: DraftDocument, seed: number, edits: number, withDenied: boolean): Tally {
  const random = rng(seed);
  const edges = document.edges;
  let nodes = withStrays(document, random).nodes;
  const tally: Tally = { edits: 0, reused: 0, built: 0 };
  endpointPlan(nodes, edges);
  for (let i = 0; i < edits; i += 1) {
    const before = endpointPlan(nodes, edges);
    nodes = edit(nodes, edges, random);
    const got = endpointPlan(nodes, edges);
    const reference = fresh(nodes, edges);
    const expected = endpointPlan(reference.nodes, reference.edges, 'transient');
    expect(snapshot(got, edges), `edit ${i} of seed ${seed}`).toEqual(snapshot(expected, reference.edges));
    if (withDenied) {
      const handed = edges.map((edge) => searchAllowed(edge.id, { nodes, edges }, 'canvas'));
      const wanted = reference.edges.map((edge) => searchAllowed(edge.id, { nodes: reference.nodes, edges: reference.edges }, 'transient'));
      expect(handed, `denied after edit ${i} of seed ${seed}`).toEqual(wanted);
    }
    tally.edits += 1;
    if (got === before) tally.reused += 1;
    else tally.built += 1;
  }
  return tally;
}

describe('a reused plan equals a plan built from nothing', () => {
  const files = startersUnder(STARTERS);

  it('finds starters to check', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it.each(files.map((file) => [file.split('/').pop()!, file] as const))('over random edits of %s', (_name, file) => {
    const tally = runChain(load(file), 11, 40, false);
    expect(tally.edits).toBe(40);
  });

  it('reuses the plan for some edits and builds it for others, over all the starters', () => {
    let reused = 0;
    let built = 0;
    for (const [index, file] of files.entries()) {
      const tally = runChain(load(file), 100 + index, 30, false);
      reused += tally.reused;
      built += tally.built;
    }
    // Both paths ran — an edit that moves only a far-off stray shape reuses, any other builds.
    expect(reused).toBeGreaterThan(20);
    expect(built).toBeGreaterThan(20);
  });

  it('holds on a larger diagram, connectors budgeted too', () => {
    const { document } = buildScaleDocument(SCALE_SPECS.small);
    expect(document.edges.length).toBeGreaterThan(50);
    const tally = runChain(document, 7, 14, true);
    expect(tally.edits).toBe(14);
  });
});

describe('which edits keep a plan', () => {
  const service = (id: string, x: number, y: number) => createNode({ id, type: 'service', x, y, text: id });
  const joined = [service('a', 0, 0), service('b', 600, 0), service('c', 0, 400), service('d', 600, 400)];
  const edges = [createEdge({ id: 'ab', source: 'a', target: 'b' }), createEdge({ id: 'cd', source: 'c', target: 'd' })];

  const withStray = (x: number, y: number, type: DraftNode['type'] = 'note') => [...joined, createNode({ id: 'stray', type, x, y, text: 'x' })];
  const moved = (nodes: DraftNode[], id: string, x: number, y: number) => nodes.map((n) => (n.id === id ? { ...n, x, y } : n));

  it('keeps it for a shape far from every connector, before and after', () => {
    const before = withStray(5000, 5000);
    expect(sameNodeGeometryAround(before, moved(before, 'stray', 5200, 5100), edges)).toBe(true);
    expect(sameRouteGeometryAround(before, moved(before, 'stray', 5200, 5100), edges)).toBe(true);
  });

  it('does not keep it for a shape that comes within reach of a connector', () => {
    const before = withStray(5000, 5000);
    expect(sameNodeGeometryAround(before, moved(before, 'stray', 300, 200), edges)).toBe(false);
  });

  it('does not keep it for a shape that leaves the reach of one — it was an obstacle', () => {
    const before = withStray(300, 200);
    expect(sameNodeGeometryAround(before, moved(before, 'stray', 5000, 5000), edges)).toBe(false);
  });

  it('does not keep it for a shape a connector is joined to', () => {
    const before = withStray(5000, 5000);
    expect(sameNodeGeometryAround(before, moved(before, 'a', 5, 5), edges)).toBe(false);
  });

  it('keeps it for a boundary nothing is joined to, which no plan reads', () => {
    const before = withStray(300, 200, 'group');
    expect(sameNodeGeometryAround(before, moved(before, 'stray', 330, 220), edges)).toBe(true);
  });

  it('does not keep it for a shape added, removed or changed in kind', () => {
    const before = withStray(5000, 5000);
    expect(sameNodeGeometryAround(before, [...before, service('new', 9000, 9000)], edges)).toBe(false);
    expect(sameNodeGeometryAround(before, before.slice(0, -1), edges)).toBe(false);
    expect(sameNodeGeometryAround(before, before.map((n) => (n.id === 'stray' ? { ...n, type: 'service' as const, x: 5100 } : n)), edges)).toBe(false);
  });

  it('reaches at least as far as any plan reads', () => {
    expect(PLAN_REACH).toBeGreaterThanOrEqual(TRUNK_OBSTACLE_MARGIN);
  });
});

/**
 * What the reuse rests on, checked against the code it is about rather than through a plan's output
 * (which a lone shape in a small diagram rarely changes): wherever a stray shape would change what
 * a connector is routed around, or where a shared trunk can run, the edit is not "stray only".
 */
describe('the region a stray shape can matter in', () => {
  const service = (id: string, x: number, y: number) => createNode({ id, type: 'service', x, y, text: id });
  // A fan: one hub, three destinations spread across a column — a shared trunk — and an unrelated pair.
  const base = [
    service('hub', 0, 300),
    service('t1', 700, 0),
    service('t2', 700, 300),
    service('t3', 700, 600),
    service('p', -900, -900),
    service('q', -300, -900),
  ];
  const edges = [
    createEdge({ id: 'e1', source: 'hub', target: 't1' }),
    createEdge({ id: 'e2', source: 'hub', target: 't2' }),
    createEdge({ id: 'e3', source: 'hub', target: 't3' }),
    createEdge({ id: 'e4', source: 'p', target: 'q' }),
  ];
  const far = createNode({ id: 'stray', type: 'note', x: 9000, y: 9000, width: 120, height: 60, text: 'x' });
  const away = [...base, far];

  const placed = (x: number, y: number) => [...base, { ...far, x, y }];
  const holds = (x: number, y: number) => sameNodeGeometryAround(away, placed(x, y), edges);
  const positions: Array<[number, number]> = [];
  for (let x = -1300; x <= 1100; x += 70) for (let y = -1300; y <= 1000; y += 70) positions.push([x, y]);

  it('covers every connector whose obstacles it would join', () => {
    let obstacles = 0;
    for (const [x, y] of positions) {
      const nodes = placed(x, y);
      const isObstacle = edges.some((edge) => obstaclesForEdge(nodes, edge.source, edge.target, 'transient').some((rect) => rect.x === x && rect.y === y && rect.width === 120));
      if (!isObstacle) continue;
      obstacles += 1;
      expect(holds(x, y), `a shape at ${x},${y} is an obstacle`).toBe(false);
    }
    expect(obstacles).toBeGreaterThan(50);
  });

  it('covers every place that changes a shared trunk', () => {
    const plain = routingPlan(away, edges, 'transient');
    const trunks = ['e1', 'e2', 'e3'].map((id) => plain.spineFor(id));
    expect(trunks.every((spine) => spine !== undefined), 'the fan is bundled on its own').toBe(true);
    let changed = 0;
    for (const [x, y] of positions) {
      const plan = routingPlan(placed(x, y), edges, 'transient');
      const differs = ['e1', 'e2', 'e3'].some((id, index) => {
        const spine = plan.spineFor(id);
        return spine?.trunkGap !== trunks[index]?.trunkGap || spine?.count !== trunks[index]?.count;
      });
      if (!differs) continue;
      changed += 1;
      expect(holds(x, y), `a shape at ${x},${y} moves the trunk`).toBe(false);
    }
    // Without a position that does, this would pass for any reach at all.
    expect(changed).toBeGreaterThan(5);
  });

  it('leaves most of the canvas to strays that no plan reads', () => {
    expect(positions.filter(([x, y]) => holds(x, y)).length).toBeGreaterThan(positions.length / 4);
  });
});
