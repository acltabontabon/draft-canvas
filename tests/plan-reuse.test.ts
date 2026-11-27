import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildScaleDocument, SCALE_SPECS } from '../benchmark/workloads/scale';
import { visibleEdges } from '../src/document/compensation';
import { createEdge, createNode } from '../src/document/factory';
import type { DraftDocument, DraftEdge, DraftNode } from '../src/document/types';
import { routingPlan, TRUNK_OBSTACLE_MARGIN } from '../src/edges/bundles';
import { connectorRoutes } from '../src/edges/connectorRoutes';
import { crossingPlan } from '../src/edges/crossings';
import { obstaclesForEdge } from '../src/edges/obstacles';
import { searchAllowed } from '../src/edges/edgeRoutes';
import { endpointPlan, type EndpointPlan } from '../src/edges/endpoints';
import { labelGroupPlan } from '../src/edges/labelGroups';
import { replyLabelPlan } from '../src/edges/replyLabels';
import { rectOf } from '../src/edges/routing';
import { PLAN_REACH, sameNodeGeometry, sameNodeGeometryAround, sameRouteGeometryAround } from '../src/edges/sameGeometry';
import { separationPlan } from '../src/edges/separation';
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
    // About a thousand endpoint plans: 3 s alone, past vitest's 5 s default under a full local run
    // (CI's coverage run allows 30 s, so it never saw this).
  }, 20_000);

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

/**
 * Everything the canvas hands a connector out of the whole-document plans, asked in the order its
 * selectors ask (`DraftEdgeView`): its trunk, whether it may search, its spread ends, its tracks, its
 * line jumps, its shared label, its reply label's shift, and the routes drawn from all of them.
 */
function everyPlan(nodes: readonly DraftNode[], edges: readonly DraftEdge[], scope: 'canvas' | 'transient') {
  const shown = visibleEdges(edges);
  const doc = { nodes, edges: shown };
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const spines = routingPlan(nodes, shown, scope);
  const allowed = shown.map((edge) => searchAllowed(edge.id, doc, scope));
  const endpoints = endpointPlan(nodes, shown, scope);
  const separation = separationPlan(nodes, shown, scope);
  const crossings = crossingPlan(nodes, shown, nodes, scope);
  const groups = labelGroupPlan(nodes, shown, scope);
  const replies = replyLabelPlan(nodes, shown, scope);
  return {
    crowded: endpoints.crowded,
    skipped: separation.skipped,
    connectors: shown.map((edge, index) => ({
      id: edge.id,
      spine: spines.spineFor(edge.id) ?? null,
      searchable: allowed[index],
      spread: endpoints.spreadFor(edge.id) ?? null,
      tracks: separation.tracksFor(edge.id) ?? null,
      crossings: crossings.crossingsFor(edge.id),
      label: groups.groupFor(edge.id) ?? null,
      reply: replies.shiftFor(edge.id) ?? null,
      routes: connectorRoutes(edge, doc, scope, byId),
    })),
  };
}

const GLYPH_TYPES = new Set<DraftNode['type']>(['service', 'component', 'database', 'artifact']);

/** Shapes that can be drawn as a glyph, in boxes with room to spare: the glyph grows into the room its
 *  words leave, so what is written under it decides where its connectors meet it. */
function grownGlyphs(nodes: readonly DraftNode[], random: () => number): DraftNode[] {
  return nodes.map((node) =>
    GLYPH_TYPES.has(node.type) && random() < 0.6
      ? { ...node, width: Math.max(node.width, 260 + Math.round(random() * 80)), height: Math.max(node.height, 220 + Math.round(random() * 80)) }
      : node,
  );
}

/** One edit that keeps every box where it is: a shape's kind, or the words under it — its name, its
 *  technology, its description. A new array and a new object for the shape, as the store makes them. */
function reword(nodes: readonly DraftNode[], random: () => number): DraftNode[] {
  const pool = nodes.map((node, index) => [node, index] as const).filter(([node]) => GLYPH_TYPES.has(node.type));
  if (pool.length === 0) return [...nodes];
  const [node, at] = pool[Math.floor(random() * pool.length)]!;
  const pick = <T,>(values: readonly T[]): T => values[Math.floor(random() * values.length)]!;
  const what = random();
  let next: DraftNode;
  if (what < 0.35 && node.type === 'service') next = { ...node, serviceKind: pick(['generic', 'worker', 'gateway', 'scheduler', 'external'] as const) };
  else if (what < 0.35 && node.type === 'component') next = { ...node, componentKind: pick(['generic', 'module', 'adapter', 'port'] as const) };
  else if (what < 0.35 && node.type === 'database') next = { ...node, databaseKind: pick(['generic', 'cache', 'search-index'] as const) };
  else if (what < 0.6) next = { ...node, description: node.description ? undefined : 'Keeps every order, its lines and its payments, for as long as the law asks.' };
  else if (what < 0.8) next = { ...node, technology: node.technology ? undefined : 'PostgreSQL' };
  else next = { ...node, text: node.text && node.text.length > 30 ? 'Orders' : 'Order history and every refund made against it' };
  return nodes.map((each, index) => (index === at ? next : each));
}

describe('every plan the canvas hands a connector equals one built from nothing', () => {
  const files = startersUnder(STARTERS);

  /** `edits` edits down a chain, each made by `change`, every plan checked against a fresh one after each. */
  function chain(
    nodes: DraftNode[],
    edges: readonly DraftEdge[],
    seed: number,
    edits: number,
    change: (nodes: readonly DraftNode[], random: () => number) => DraftNode[],
  ): void {
    const random = rng(seed);
    everyPlan(nodes, edges, 'canvas');
    for (let i = 0; i < edits; i += 1) {
      nodes = change(nodes, random);
      const got = everyPlan(nodes, edges, 'canvas');
      const reference = fresh(nodes, edges);
      expect(got, `edit ${i} of seed ${seed}`).toEqual(everyPlan(reference.nodes, reference.edges, 'transient'));
    }
  }

  // A kind or a word changed moves no box, so it was taken for an edit that moved nothing, and every
  // plan was kept for glyphs that now stood somewhere else.
  it.each(files.map((file) => [file.split('/').pop()!, file] as const))('over kind and word edits of %s', (_name, file) => {
    const document = load(file);
    chain(grownGlyphs(document.nodes, rng(31)), document.edges, 31, 10, reword);
  });
});

describe('a shape that keeps its box but not where its connectors meet it', () => {
  const service = (id: string, x: number, y: number, size: { width: number; height: number } = { width: 160, height: 110 }) =>
    createNode({ id, type: 'service', x, y, ...size, text: id });
  /** A level connector between `a` and `b`, crossed by an upright one between two small Services. */
  const crossed = (a: DraftNode, b: DraftNode) => ({
    nodes: [a, b, service('up', 340, -60, { width: 120, height: 80 }), service('down', 340, 520, { width: 120, height: 80 })],
    edges: [createEdge({ id: 'level', source: a.id, target: b.id }), createEdge({ id: 'upright', source: 'up', target: 'down' })],
  });
  const jumps = (plan: ReturnType<typeof crossingPlan>) => [...plan.crossingsFor('level'), ...plan.crossingsFor('upright')];

  it('plans again when a Service is turned into a kind drawn as a glyph', () => {
    const { nodes, edges } = crossed(service('a', 0, 200), service('b', 640, 200));
    const before = crossingPlan(nodes, edges);
    expect(jumps(before)).toHaveLength(1);
    // A Worker is met on its glyph, which stands higher in the box than a card's middle.
    const turned = nodes.map((node) => (node.id === 'a' || node.id === 'b' ? { ...node, serviceKind: 'worker' as const } : node));
    expect(rectOf(turned[0]!).anchorBand).toBeDefined();
    expect(sameNodeGeometry(nodes, turned)).toBe(false);
    const after = crossingPlan(turned, edges);
    const reference = fresh(turned, edges);
    const wanted = jumps(crossingPlan(reference.nodes, reference.edges, reference.nodes, 'transient'));
    expect(jumps(after)).toEqual(wanted);
    // The jump moved up with the line, off where the card's line crossed.
    expect(wanted[0]!.y).toBeLessThan(jumps(before)[0]!.y);
    expect(everyPlan(turned, edges, 'canvas')).toEqual(everyPlan(reference.nodes, reference.edges, 'transient'));
  });

  it('plans again when the words under a grown glyph move it', () => {
    const store = createNode({ id: 'db', type: 'database', x: 0, y: 0, width: 200, height: 170, text: 'Ledger', description: 'Double-entry book of every payment and refund' });
    const { nodes, edges } = crossed(store, service('b', 640, 40));
    everyPlan(nodes, edges, 'canvas');
    const bare = nodes.map((node) => (node.id === 'db' ? { ...node, description: undefined } : node));
    // Without its description the glyph grows into the room the words left.
    expect(rectOf(bare[0]!).anchorBand).not.toEqual(rectOf(store).anchorBand);
    expect(sameNodeGeometry(nodes, bare)).toBe(false);
    const reference = fresh(bare, edges);
    expect(everyPlan(bare, edges, 'canvas')).toEqual(everyPlan(reference.nodes, reference.edges, 'transient'));
  });

  it('plans again when a shape a connector is joined to changes its glyph while a stray shape moves', () => {
    const { nodes, edges } = crossed(service('a', 0, 200), service('b', 640, 200));
    const before = [...nodes, createNode({ id: 'stray', type: 'note', x: 6000, y: 6000, text: 'x' })];
    const after = before.map((node) => (node.id === 'a' ? { ...node, serviceKind: 'gateway' as const } : node.id === 'stray' ? { ...node, x: 6200 } : node));
    expect(sameNodeGeometryAround(before, after, edges)).toBe(false);
    expect(sameRouteGeometryAround(before, after, edges)).toBe(false);
  });

  it('keeps every plan for a rename that leaves each glyph where it stood', () => {
    const store = createNode({ id: 'db', type: 'database', x: 0, y: 0, width: 200, height: 170, text: 'Ledger' });
    const { nodes, edges } = crossed(store, service('b', 640, 40));
    const before = crossingPlan(nodes, edges);
    // A card has no glyph at all, and a short name leaves a Data Store's glyph where it stood.
    const renamed = nodes.map((node) => (node.id === 'b' ? { ...node, text: 'Payments' } : node.id === 'db' ? { ...node, text: 'Book' } : node));
    expect(rectOf(renamed[0]!).anchorBand).toEqual(rectOf(store).anchorBand);
    expect(sameNodeGeometry(nodes, renamed)).toBe(true);
    expect(crossingPlan(renamed, edges)).toBe(before);
  });
});
