import { describe, expect, it } from 'vitest';
import { newFindings, REVIEW_LIMIT, reviewFile, reviewView, statedSemantic, type ReviewOptions } from '../../src/agent/review';
import { createDocument, createEdge, createNode } from '../../src/document/factory';
import type { DraftEdge, DraftNode, EdgeSemantic } from '../../src/document/types';

type NodeInput = Parameters<typeof createNode>[0];
type EdgeInput = Parameters<typeof createEdge>[0];

const at = { x: 0, y: 0 };
const api = (id: string, text: string, extra: Partial<NodeInput> = {}) => createNode({ id, type: 'service', serviceKind: 'api', text, ...at, ...extra });
const worker = (id: string, text: string) => createNode({ id, type: 'service', serviceKind: 'worker', text, ...at });
const queue = (id: string, text: string, extra: Partial<NodeInput> = {}) => createNode({ id, type: 'queue', queueKind: 'queue', text, ...at, ...extra });
const dlq = (id: string, text = 'Orders DLQ') => createNode({ id, type: 'queue', queueKind: 'queue', deliveryRole: 'dead-letter', text, ...at });
const db = (id: string, text: string, extra: Partial<NodeInput> = {}) => createNode({ id, type: 'database', databaseKind: 'sql', text, ...at, ...extra });
const cache = (id: string, text: string) => createNode({ id, type: 'database', databaseKind: 'cache', text, ...at });
/** A connector whose semantic the author chose. */
const said = (id: string, source: string, target: string, semantic: EdgeSemantic, extra: Partial<EdgeInput> = {}) =>
  createEdge({ id, source, target, semantic, semanticsOrigin: 'explicit', ...extra });
/** A connector whose semantic was inferred, as a hand-drawn one's is. */
const inferred = (id: string, source: string, target: string, semantic: EdgeSemantic, extra: Partial<EdgeInput> = {}) =>
  createEdge({ id, source, target, semantic, semanticsOrigin: 'inferred', ...extra });

const review = (nodes: DraftNode[], edges: DraftEdge[], options?: ReviewOptions) => reviewView(nodes, edges, options);
const codes = (nodes: DraftNode[], edges: DraftEdge[], options?: ReviewOptions) => review(nodes, edges, options).map((f) => f.code);

/** Checkout publishes to Orders; Billing consumes it. */
const ordersQueue = () => ({
  nodes: [api('a', 'Checkout API'), queue('q', 'Orders'), worker('w', 'Billing Worker')],
  edges: [said('p', 'a', 'q', 'publishes'), said('c', 'q', 'w', 'consumes')],
});

describe('statedSemantic', () => {
  it('counts a chosen semantic, and an inferred one only when no label speaks over it', () => {
    expect(statedSemantic(said('e', 'a', 'b', 'reads', { label: 'looks up' }))).toBe('reads');
    expect(statedSemantic(inferred('e', 'a', 'b', 'reads'))).toBe('reads');
    expect(statedSemantic(inferred('e', 'a', 'b', 'reads', { label: 'warms on miss' }))).toBeUndefined();
    // Saved before semanticsOrigin existed: a semantic there was picked by hand.
    expect(statedSemantic(createEdge({ id: 'e', source: 'a', target: 'b', semantic: 'writes', label: 'x' }))).toBe('writes');
    expect(statedSemantic(createEdge({ id: 'e', source: 'a', target: 'b' }))).toBeUndefined();
  });
});

describe('no-dead-letter', () => {
  it('names a queue with a consumer and nowhere for a failing message to go', () => {
    const { nodes, edges } = ordersQueue();
    expect(review(nodes, edges)).toEqual([
      {
        code: 'no-dead-letter',
        ids: ['q', 'w'],
        message: 'Queue "Orders" has a consumer ("Billing Worker") but no dead-letter path: a message that keeps failing has nowhere to go.',
      },
    ]);
  });

  it('counts a consumer drawn consuming toward the queue', () => {
    const nodes = [api('a', 'Checkout API'), queue('q', 'Orders'), worker('w', 'Billing Worker')];
    expect(codes(nodes, [said('p', 'a', 'q', 'publishes'), said('c', 'w', 'q', 'consumes')])).toEqual(['no-dead-letter']);
  });

  it("is silent once the queue, or one of its consumers, has a dead-letter path", () => {
    const { nodes, edges } = ordersQueue();
    expect(codes([...nodes, dlq('d')], [...edges, said('x', 'q', 'd', 'deadLetters')])).toEqual([]);
    expect(codes([...nodes, dlq('d')], [...edges, said('x', 'w', 'd', 'deadLetters')])).toEqual([]);
    // A plain queue named as one, fed by a failure route.
    expect(codes([...nodes, queue('d', 'orders-dlq')], [...edges, said('x', 'w', 'd', 'publishes', { kind: 'failure' })])).toEqual([]);
  });

  it('is silent for a topic, a dead-letter or retry queue, and a context view', () => {
    const topic = [api('a', 'Checkout API'), queue('q', 'Orders', { queueKind: 'topic' }), worker('w', 'Billing Worker')];
    expect(codes(topic, [said('p', 'a', 'q', 'publishes'), said('c', 'q', 'w', 'deliversTo')])).toEqual([]);
    const retry = [api('a', 'Checkout API'), queue('q', 'Orders retry'), worker('w', 'Billing Worker')];
    expect(codes(retry, ordersQueue().edges)).toEqual([]);
    const named = [api('a', 'Checkout API'), queue('q', 'Orders DLQ'), worker('w', 'Billing Worker')];
    expect(codes(named, ordersQueue().edges)).toEqual([]);
    const { nodes, edges } = ordersQueue();
    expect(codes(nodes, edges, { level: 'context' })).toEqual([]);
    expect(codes(nodes, edges, { level: 'container' })).toEqual(['no-dead-letter']);
  });

  it("is silent when a junction hides the queue's consumers", () => {
    const nodes = [api('a', 'Checkout API'), queue('q', 'Orders'), createNode({ id: 'j', type: 'ellipse', ...at }), worker('w', 'Billing Worker'), dlq('d')];
    const edges = [said('p', 'a', 'q', 'publishes'), createEdge({ id: 'c', source: 'q', target: 'j' }), createEdge({ id: 'c2', source: 'j', target: 'w' }), said('x', 'w', 'd', 'deadLetters')];
    expect(codes(nodes, edges)).toEqual([]);
  });

  it("names each stream consumer with nowhere to park a record, and none that has one", () => {
    const nodes = [api('a', 'Producer'), queue('s', 'Events', { queueKind: 'stream' }), worker('w1', 'Indexer'), worker('w2', 'Loader'), dlq('d')];
    const edges = [said('p', 'a', 's', 'publishes'), said('c1', 's', 'w1', 'consumes'), said('c2', 's', 'w2', 'consumes'), said('x', 'w2', 'd', 'deadLetters')];
    expect(review(nodes, edges)).toEqual([
      { code: 'no-dead-letter', ids: ['s', 'w1'], message: '"Indexer" reads stream "Events" but has no dead-letter path for a record it can\'t process.' },
    ]);
  });
});

describe('no-consumer and no-producer', () => {
  it('names a queue that receives messages nobody consumes', () => {
    const nodes = [api('a', 'Checkout API'), queue('q', 'Orders')];
    expect(review(nodes, [said('p', 'a', 'q', 'publishes')])).toEqual([
      { code: 'no-consumer', ids: ['q', 'a'], message: 'Queue "Orders" receives messages from "Checkout API", but nothing consumes them.' },
    ]);
  });

  it('names a queue consumed with nothing sending to it, outside inside views', () => {
    const nodes = [queue('q', 'Orders'), worker('w', 'Billing Worker'), dlq('d')];
    const edges = [said('c', 'q', 'w', 'consumes'), said('x', 'q', 'd', 'deadLetters')];
    expect(review(nodes, edges)).toEqual([
      { code: 'no-producer', ids: ['q', 'w'], message: 'Queue "Orders" is consumed by "Billing Worker", but nothing in this view sends messages to it.' },
    ]);
    expect(codes(nodes, edges, { nested: true })).toEqual([]);
  });

  it('leaves a stream or topic that starts the view alone: it is fed from outside the diagram', () => {
    const stream = queue('s', 'Order events', { queueKind: 'stream' });
    const topic = queue('t', 'Order created', { queueKind: 'topic' });
    expect(codes([stream, worker('w', 'Billing Worker')], [said('c', 's', 'w', 'consumes')])).not.toContain('no-producer');
    expect(codes([topic, worker('w', 'Billing Worker')], [said('c', 't', 'w', 'consumes')])).not.toContain('no-producer');
  });

  it("says nothing when a connector at the queue can't be read", () => {
    // Labelled, with only an inferred semantic: "polls" could be either end of the queue.
    const nodes = [api('a', 'Checkout API'), queue('q', 'Orders'), worker('w', 'Billing Worker'), dlq('d')];
    expect(codes(nodes, [said('p', 'a', 'q', 'publishes'), inferred('c', 'w', 'q', 'command', { label: 'polls' }), said('x', 'q', 'd', 'deadLetters')])).toEqual([]);
    expect(codes(nodes, [said('p', 'a', 'q', 'dependsOn'), said('c', 'q', 'w', 'consumes'), said('x', 'q', 'd', 'deadLetters')])).toEqual([]);
    expect(codes(nodes, [said('p', 'a', 'q', 'publishes', { directed: false }), said('c', 'q', 'w', 'consumes'), said('x', 'q', 'd', 'deadLetters')])).toEqual([]);
  });

  it('never asks a dead-letter queue for a consumer', () => {
    const nodes = [queue('q', 'Orders'), worker('w', 'Billing Worker'), dlq('d'), api('a', 'Checkout API')];
    const edges = [said('p', 'a', 'q', 'publishes'), said('c', 'q', 'w', 'consumes'), said('x', 'q', 'd', 'deadLetters')];
    expect(codes(nodes, edges)).toEqual([]);
  });

  it('names an unnamed queue by what it is', () => {
    const nodes = [api('a', 'Checkout API'), queue('q', '')];
    expect(review(nodes, [said('p', 'a', 'q', 'publishes')])[0]!.message).toBe('An unnamed queue receives messages from "Checkout API", but nothing consumes them.');
  });
});

describe('cache-not-written', () => {
  it('names a cache that is read and never written, refreshed or invalidated', () => {
    const nodes = [api('a', 'Catalog API'), cache('c', 'Product Cache')];
    expect(review(nodes, [said('r', 'a', 'c', 'reads')])).toEqual([
      { code: 'cache-not-written', ids: ['c', 'a'], message: 'Cache "Product Cache" is read by "Catalog API", but nothing writes to, refreshes or invalidates it.' },
    ]);
    // An unlabelled hand-drawn connector shows its inferred "reads" on the canvas.
    expect(codes(nodes, [inferred('r', 'a', 'c', 'reads')])).toEqual(['cache-not-written']);
  });

  it('is silent once anything fills it, or when it cannot tell', () => {
    const nodes = [api('a', 'Catalog API'), api('b', 'Admin API'), cache('c', 'Product Cache'), db('d', 'Catalog DB')];
    expect(codes(nodes, [said('r', 'a', 'c', 'reads'), said('i', 'b', 'c', 'invalidates')])).not.toContain('cache-not-written');
    expect(codes(nodes, [said('r', 'a', 'c', 'readsWrites')])).not.toContain('cache-not-written');
    // A store beside it may be what refreshes it.
    expect(codes(nodes, [said('r', 'a', 'c', 'reads'), createEdge({ id: 's', source: 'd', target: 'c' })])).not.toContain('cache-not-written');
    // A label over an inferred semantic says something this check can't read.
    expect(codes(nodes, [inferred('r', 'a', 'c', 'reads', { label: 'warms on miss' })])).not.toContain('cache-not-written');
  });
});

describe('shared-database', () => {
  it('names a database two services write', () => {
    const nodes = [api('a', 'Orders API'), worker('w', 'Billing Worker'), db('d', 'Orders DB')];
    expect(review(nodes, [said('x', 'a', 'd', 'readsWrites'), said('y', 'w', 'd', 'writes')])).toEqual([
      { code: 'shared-database', ids: ['d', 'a', 'w'], message: 'Database "Orders DB" has no single owner: "Orders API" and "Billing Worker" both write to it.' },
    ]);
  });

  it('is silent for a reader, for components sharing a process, and for a connector it cannot read', () => {
    const nodes = [api('a', 'Orders API'), worker('w', 'Reporting'), db('d', 'Orders DB')];
    expect(codes(nodes, [said('x', 'a', 'd', 'readsWrites'), said('y', 'w', 'd', 'reads')])).toEqual([]);
    expect(codes(nodes, [said('x', 'a', 'd', 'readsWrites'), inferred('y', 'w', 'd', 'readsWrites', { label: 'reads reports' })])).toEqual([]);
    const components = [createNode({ id: 'r1', type: 'component', text: 'Order Repo', ...at }), createNode({ id: 'r2', type: 'component', text: 'Audit Repo', ...at }), db('d', 'Orders DB')];
    expect(codes(components, [said('x', 'r1', 'd', 'writes'), said('y', 'r2', 'd', 'writes')])).toEqual([]);
    // A cache is not "a database" for this check.
    expect(codes([api('a', 'A'), api('b', 'B'), cache('c', 'Sessions')], [said('x', 'a', 'c', 'writes'), said('y', 'b', 'c', 'writes')])).toEqual([]);
  });
});

describe('call-cycle', () => {
  const pair = () => [api('a', 'Orders API'), api('b', 'Payments API')];

  it('names two services calling each other, with both connectors', () => {
    expect(review(pair(), [said('ab', 'a', 'b', 'calls'), inferred('ba', 'b', 'a', 'calls')])).toEqual([
      { code: 'call-cycle', ids: ['a', 'b', 'ab', 'ba'], message: '"Orders API" and "Payments API" call each other: a call cycle, so neither can change or fail on its own.' },
    ]);
  });

  it('is silent for a callback, an event or an async reply', () => {
    expect(codes(pair(), [said('ab', 'a', 'b', 'calls'), said('ba', 'b', 'a', 'calls', { kind: 'callback' })])).toEqual([]);
    expect(codes(pair(), [said('ab', 'a', 'b', 'calls'), said('ba', 'b', 'a', 'event')])).toEqual([]);
    expect(codes(pair(), [said('ab', 'a', 'b', 'calls'), said('ba', 'b', 'a', 'calls', { async: true })])).toEqual([]);
    // A labelled return drawn by hand: its inferred "calls" isn't what it says.
    expect(codes(pair(), [said('ab', 'a', 'b', 'calls'), inferred('ba', 'b', 'a', 'calls', { label: 'returns receipt' })])).toEqual([]);
  });
});

describe('unconnected', () => {
  it('names the shapes connected to nothing in a view that has connections', () => {
    const nodes = [api('a', 'Orders API'), db('d', 'Orders DB'), api('x', 'Legacy Admin'), createNode({ id: 'n', type: 'note', text: 'A note', ...at })];
    expect(review(nodes, [said('e', 'a', 'd', 'readsWrites')])).toEqual([
      { code: 'unconnected', ids: ['x'], message: '"Legacy Admin" has no connections in this view.' },
    ]);
  });

  it('is silent with no connections at all, inside a view, or when its boundary is connected', () => {
    expect(codes([api('a', 'A'), api('b', 'B')], [])).toEqual([]);
    const nodes = [api('a', 'Orders API'), db('d', 'Orders DB'), api('x', 'Legacy Admin')];
    expect(codes(nodes, [said('e', 'a', 'd', 'readsWrites')], { nested: true })).toEqual([]);
    const boxed = [createNode({ id: 'g', type: 'group', text: 'Payments', ...at }), api('a', 'Orders API'), api('x', 'Ledger', { parentId: 'g' })];
    expect(codes(boxed, [said('e', 'a', 'g', 'calls')])).toEqual([]);
  });
});

describe('ordering, cap and comparison', () => {
  it('lists the most important first and stops at the limit', () => {
    const nodes = [api('a', 'A'), api('b', 'B'), ...Array.from({ length: 9 }, (_, i) => queue(`q${i}`, `Q${i}`))];
    const edges = [...Array.from({ length: 9 }, (_, i) => said(`p${i}`, 'a', `q${i}`, 'publishes')), said('ab', 'a', 'b', 'calls'), said('ba', 'b', 'a', 'calls')];
    const found = review(nodes, edges);
    expect(found).toHaveLength(REVIEW_LIMIT);
    expect(found[0]!.code).toBe('call-cycle');
    expect(found.slice(1).every((f) => f.code === 'no-consumer')).toBe(true);
    expect(review(nodes, edges, { limit: 2 })).toHaveLength(2);
    // Deterministic: the same view, the same answer.
    expect(review(nodes, edges)).toEqual(found);
  });

  it('keeps a finding only when it names a part it did not name before', () => {
    const { nodes, edges } = ordersQueue();
    const before = review(nodes, edges);
    expect(newFindings(before, review(nodes, edges))).toEqual([]);
    const more = review([...nodes, worker('w2', 'Fraud Worker')], [...edges, said('c2', 'q', 'w2', 'consumes')]);
    expect(newFindings(before, more).map((f) => f.ids)).toEqual([['q', 'w', 'w2']]);
  });

  it('reviews every view of a file and says which inside view a finding is in', () => {
    const file = createDocument('T');
    const { nodes, edges } = ordersQueue();
    const owner: DraftNode = { ...api('o', 'Orders'), inside: { nodes, edges, flows: [], viewport: { x: 0, y: 0, zoom: 1 } } };
    const lone = { ...file, nodes: [owner] };
    expect(reviewFile(lone)).toEqual([{ ...review(nodes, edges, { nested: true })[0]!, view: ['o'] }]);
  });
});
