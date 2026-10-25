/**
 * The routing quality corpus: small diagrams that each isolate one way a connector can go wrong,
 * every starter, the agent layout gallery and the benchmark workloads. `tests/routing-quality.test.ts`
 * measures every view of every entry and holds the result to `quality-baseline.json`.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createEdge, createNode } from '../../../src/document/factory';
import type { DraftDocument, DraftEdge, DraftNode, EdgeAnchor } from '../../../src/document/types';
import { walkGraphs, viewOf } from '../../../src/depth/tree';
import { deserializeDocument } from '../../../src/export/project';
import { compose } from '../../../src/agent/compile';
import { applyUpdate } from '../../../src/agent/patch';
import { ARCHITECTURE_STARTERS, starterDocument } from '../../../src/starters';
import { GALLERY, type GalleryCase } from '../agent/gallery';

export interface RoutingFixture {
  id: string;
  nodes: readonly DraftNode[];
  edges: readonly DraftEdge[];
  /** Where the fixture came from: hand-made cases isolate one problem, the rest are real diagrams. */
  source: 'case' | 'starter' | 'gallery' | 'workload' | 'agent';
}

const box = (id: string, x: number, y: number, width = 160, height = 80): DraftNode =>
  createNode({ id, type: 'service', x, y, width, height });
const pin = (side: EdgeAnchor['side'], offset = 0.5): EdgeAnchor => ({ side, offset });
const edge = (id: string, source: string, target: string, extra: Partial<DraftEdge> = {}): DraftEdge =>
  createEdge({ id, source, target, ...extra });

/** Hand-made cases, one problem each. */
function cases(): RoutingFixture[] {
  const out: RoutingFixture[] = [];
  const add = (id: string, nodes: DraftNode[], edges: DraftEdge[]) => out.push({ id: `case/${id}`, nodes, edges, source: 'case' });

  // An elbow whose corner lands on a shape: the fast path never checks mixed side pairs.
  add('blocked-elbow', [box('a', 0, 0), box('b', 480, 320), box('wall', 440, 20, 200, 120)], [
    edge('ab', 'a', 'b', { sourceAnchor: pin('right'), targetAnchor: pin('top') }),
  ]);
  // A shape straight between two level ones: the detour's home ground.
  add('blocked-straight', [box('a', 0, 0), box('b', 640, 0), box('mid', 300, -20, 120, 120)], [edge('ab', 'a', 'b')]);
  // A pinned end that faces away from the other shape after a move (today: swapped to another side).
  add('facing-away-pin', [box('a', 400, 0), box('b', 0, 0)], [
    edge('ab', 'a', 'b', { sourceAnchor: pin('right'), targetAnchor: pin('left') }),
  ]);
  // Mixed auto and pinned ends, sharing sides of one hub.
  add('mixed-pins', [box('hub', 300, 200), box('n', 300, 0), box('e', 640, 200), box('s', 300, 420), box('w', 0, 200)], [
    edge('h-n', 'hub', 'n', { sourceAnchor: pin('top', 0.25) }),
    edge('h-e', 'hub', 'e', { targetAnchor: pin('left') }),
    edge('h-s', 'hub', 's'),
    edge('w-h', 'w', 'hub', { sourceAnchor: pin('right'), targetAnchor: pin('left', 0.75) }),
    edge('n-e', 'n', 'e'),
  ]);
  // Two shapes joined both ways, anchored and not.
  add('reciprocal', [box('a', 0, 0), box('b', 520, 40), box('c', 0, 300), box('d', 520, 300)], [
    edge('ab', 'a', 'b'),
    edge('ba', 'b', 'a'),
    edge('cd', 'c', 'd', { sourceAnchor: pin('right'), targetAnchor: pin('left') }),
    edge('dc', 'd', 'c', { sourceAnchor: pin('left'), targetAnchor: pin('right') }),
  ]);
  // Request/response connectors, one bent round a shape.
  add('request-reply', [box('a', 0, 0), box('b', 560, 0), box('c', 280, 260), box('d', 560, 260)], [
    edge('ab', 'a', 'b', { hasResponse: true, label: 'GET /orders' }),
    edge('ac', 'a', 'c', { hasResponse: true }),
    edge('cd', 'c', 'd', { hasResponse: true, label: 'reserve' }),
  ]);
  // A small queue fed by six producers from one side.
  {
    const nodes = [createNode({ id: 'q', type: 'queue', x: 600, y: 300 })];
    const edges: DraftEdge[] = [];
    for (let i = 0; i < 6; i += 1) {
      nodes.push(box(`p${i}`, 0, i * 110));
      edges.push(edge(`p${i}-q`, `p${i}`, 'q'));
    }
    add('crowded-queue', nodes, edges);
  }
  // A tube's anchor band and a Data Store's glyph, each with several connectors.
  add('anchor-bands', [
    createNode({ id: 'topic', type: 'queue', x: 300, y: 0, text: 'Orders topic' }),
    createNode({ id: 'store', type: 'database', x: 300, y: 300 }),
    box('a', 0, 0), box('b', 640, 0), box('c', 0, 300), box('d', 640, 300),
  ], [
    edge('a-topic', 'a', 'topic'), edge('topic-b', 'topic', 'b'), edge('topic-store', 'topic', 'store'),
    edge('c-store', 'c', 'store'), edge('d-store', 'd', 'store'), edge('a-store', 'a', 'store'),
  ]);
  // A hub with twelve spokes, three to a side.
  {
    const nodes = [box('hub', 600, 600)];
    const edges: DraftEdge[] = [];
    const ring = [[-500, -400], [0, -500], [500, -400], [700, -150], [700, 150], [700, 400], [500, 650], [0, 700], [-500, 650], [-700, 400], [-700, 150], [-700, -150]];
    ring.forEach(([dx, dy], i) => {
      nodes.push(box(`s${i}`, 600 + dx!, 600 + dy!));
      edges.push(i % 2 ? edge(`hub-s${i}`, 'hub', `s${i}`) : edge(`s${i}-hub`, `s${i}`, 'hub'));
    });
    add('hub-12', nodes, edges);
  }
  // Seventy small shapes in one corridor: more than any capped obstacle list holds.
  {
    const nodes = [box('a', 0, 400), box('b', 2400, 0)];
    for (let i = 0; i < 70; i += 1) nodes.push(box(`o${i}`, 220 + (i % 14) * 150, 100 + Math.floor(i / 14) * 110, 60, 40));
    add('corridor-70', nodes, [edge('ab', 'a', 'b'), edge('ab2', 'a', 'b', { label: 'sync' })]);
  }
  // A passage narrower than twice the clearance.
  add('narrow-corridor', [box('a', 0, 200), box('b', 900, 200), box('top', 360, 0, 200, 214), box('bottom', 360, 238, 200, 300)], [edge('ab', 'a', 'b')]);
  // A target walled in on every side: no clear route exists.
  add('impossible', [box('a', 0, 200), box('t', 600, 200), box('wn', 560, 120, 240, 60), box('ws', 560, 300, 240, 60), box('ww', 540, 120, 40, 240), box('we', 780, 120, 40, 240)], [
    edge('at', 'a', 't'),
  ]);
  // Four connectors from a left column to a right column, all through one gap.
  {
    const nodes = [box('l0', 0, 0), box('l1', 0, 120), box('l2', 0, 240), box('l3', 0, 360), box('r0', 900, 400), box('r1', 900, 520), box('r2', 900, 640), box('r3', 900, 760), box('wall', 420, 0, 120, 560)];
    add('shared-corridor', nodes, [edge('a', 'l0', 'r0'), edge('b', 'l1', 'r1'), edge('c', 'l2', 'r2'), edge('d', 'l3', 'r3')]);
  }
  // Four connectors that mean different things leave one side: no trunk can merge them.
  add('side-share', [box('a', 0, 200), box('b1', 500, 0), box('b2', 500, 140), box('b3', 500, 280), box('b4', 500, 420)], [
    edge('calls', 'a', 'b1', { semantic: 'calls' }),
    edge('writes', 'a', 'b2', { semantic: 'writes' }),
    edge('publishes', 'a', 'b3', { semantic: 'publishes' }),
    edge('reads', 'a', 'b4', { semantic: 'reads' }),
  ]);
  // Two shapes in a row both fed from one side of a third, plus a reply: ends that must make room.
  add('side-share-reply', [box('a', 0, 160, 160, 120), box('b', 480, 0), box('c', 480, 160), box('d', 480, 320)], [
    edge('ab', 'a', 'b', { semantic: 'calls', hasResponse: true }),
    edge('ac', 'a', 'c', { semantic: 'writes' }),
    edge('ad', 'a', 'd', { semantic: 'reads', label: 'reads' }),
  ]);
  // Shapes a few pixels out of line, joined from their middle handles.
  add('near-level', [box('a', 0, 0), box('b', 400, 14), box('c', 0, 200), box('d', 400, 214)], [
    edge('ab', 'a', 'b', { sourceAnchor: pin('right'), targetAnchor: pin('left') }),
    edge('cd', 'c', 'd'),
  ]);
  return out;
}

/** Every view of a document, the root and each inside view, as fixtures. */
function views(id: string, doc: DraftDocument, source: RoutingFixture['source']): RoutingFixture[] {
  const out: RoutingFixture[] = [];
  walkGraphs(doc, (_graph, path) => {
    const view = path.length ? viewOf(doc, path) : doc;
    if (!view || view.edges.length === 0) return;
    out.push({ id: path.length ? `${id}/${path.join('/')}` : id, nodes: view.nodes, edges: view.edges, source });
  });
  return out;
}

/**
 * `fn` with ids drawn from a fixed sequence. A starter gets fresh random ids every time it is built,
 * and lanes and trunks break ties by id, so without this the same starter could route differently
 * from one run to the next.
 */
function withFixedIds<T>(seed: number, fn: () => T): T {
  const original = crypto.getRandomValues.bind(crypto);
  let state = seed;
  crypto.getRandomValues = (<A extends ArrayBufferView | null>(array: A): A => {
    const bytes = array as unknown as Uint8Array;
    for (let i = 0; i < bytes.length; i += 1) {
      state = (state * 1103515245 + 12345) >>> 0;
      bytes[i] = state >>> 24;
    }
    return array;
  }) as typeof crypto.getRandomValues;
  try {
    return fn();
  } finally {
    crypto.getRandomValues = original;
  }
}

function galleryDoc(entry: GalleryCase): DraftDocument {
  const create = (request: Record<string, unknown>) => {
    const parsed = deserializeDocument(compose({ requestId: 'g', ...request }, 'd_gallery00001').text);
    if (!parsed.ok) throw new Error(parsed.error);
    return parsed.document;
  };
  if (entry.kind === 'create') return create(entry.request);
  let base = create(entry.base);
  if (entry.arrange) base = { ...base, nodes: base.nodes.map((node) => (entry.arrange?.[node.id] ? { ...node, ...entry.arrange[node.id] } : node)) };
  return applyUpdate(base, [], entry.update.ops, undefined).file;
}

let frozen: Record<string, unknown> | null = null;

/**
 * A gallery diagram as the agent laid it out before this routing work, kept in
 * `gallery-documents.json`. The agent's layout reads the router, so a gallery composed afresh changes
 * with every routing change; measuring routing needs the shapes held still. `agentCorpus` composes
 * them afresh, to measure the agent's layout itself.
 */
function frozenGallery(id: string): DraftDocument {
  frozen ??= JSON.parse(readFileSync(resolve(process.cwd(), 'tests/fixtures/routing/gallery-documents.json'), 'utf8')) as Record<string, unknown>;
  const parsed = deserializeDocument(JSON.stringify(frozen[id]));
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.document;
}

/** Every gallery request composed afresh by the current agent. */
export function agentCorpus(): RoutingFixture[] {
  return GALLERY.flatMap((entry) => views(`agent/${entry.id}`, galleryDoc(entry), 'agent'));
}

function workload(name: string): DraftDocument {
  const text = readFileSync(resolve(process.cwd(), `benchmark/workloads/fixtures/${name}.draftcanvas.json`), 'utf8');
  const parsed = deserializeDocument(text);
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.document;
}

export function routingCorpus(): RoutingFixture[] {
  return [
    ...cases(),
    ...ARCHITECTURE_STARTERS.flatMap((starter, i) => views(`starter/${starter.id}`, withFixedIds(i + 1, () => starterDocument(starter)), 'starter')),
    ...GALLERY.flatMap((entry) => views(`gallery/${entry.id}`, frozenGallery(entry.id), 'gallery')),
    ...['typical', 'stress'].flatMap((name) => views(`workload/${name}`, workload(name), 'workload')),
  ];
}
