import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { DraftEdge, DraftNode } from '../../src/document/types';
import { parseDocument } from '../../src/document/validate';
import { analyzeTraffic, canTakeDown, lostBy, mayTakeDown, outageOf, type OutageTarget } from '../../src/traffic';
import { outageSummary } from '../../src/traffic/outage';
import { outageFact } from '../../src/traffic/technology';
import { edge, node } from './helpers';

function walk(nodes: readonly DraftNode[], edges: readonly DraftEdge[], target: string | OutageTarget) {
  const outage = outageOf(analyzeTraffic({ nodes, edges }), nodes, edges, typeof target === 'string' ? { id: target } : target);
  if (!outage) throw new Error('cannot be taken down');
  return outage;
}

const parsed = parseDocument(
  readFileSync(join(process.cwd(), 'tests/fixtures/outage/event-driven.draftcanvas'), 'utf8'),
);
if (!parsed.ok) throw new Error(parsed.error);
const starter = parsed.document;

/** Nothing an outage says may claim a rate, a latency or a likelihood: the drawing holds none. */
const INVENTED = /\b\d+(\.\d+)?\s*(%|ms|rps|\/min|\/s|per (second|minute))|\bp9\d\b|\blikely\b|\bprobab/i;

describe('outage walk — the Event-Driven starter', () => {
  it('follows a failing dependency back to the queue, the dead-letter queue and the missing replay', () => {
    const outage = walk(starter.nodes, starter.edges, 'external');

    expect(Object.fromEntries(outage.nodes)).toEqual({
      external: 'down',
      'integration-worker': 'failing',
      'integration-queue': 'retrying',
      'integration-dlq': 'catching',
      producer: 'unaffected',
      topic: 'unaffected',
      'projection-queue': 'unaffected',
      'projection-worker': 'unaffected',
      'read-store': 'unaffected',
    });
    expect(Object.fromEntries(outage.edges)).toEqual({
      'call-external': 'failing',
      'consume-integration': 'failing',
      'dead-letter': 'recovery',
    });
    expect(outage.notes.map((note) => [note.tone, note.note, note.focus])).toEqual([
      ['question', 'calls fail — no fallback drawn', ['integration-worker']],
      ['effect', 'retries, then dead-letters', ['integration-queue']],
      ['question', 'messages stay here — no replay drawn', ['integration-dlq']],
    ]);
    expect(outage.headline).toBe('External System is down. Producer Service, Domain Events and 3 more carry on.');
    expect(outage.notes[0]?.text).toMatch(/outside your system/);
    expect(outage.notes[2]).toMatchObject({
      ask: 'How are messages in the dead-letter queue replayed once External System is back?',
      fix: { kind: 'replay', from: 'integration-dlq', to: 'integration-queue' },
    });
  });

  it('turns the replay question into an answer once the route is drawn', () => {
    const replay = edge('replay', 'integration-dlq', 'integration-queue', { semantic: 'deliversTo', label: 'replays' });
    const outage = walk(starter.nodes, [...starter.edges, replay], 'external');

    expect(outage.notes.map((note) => [note.tone, note.note])).toContainEqual(['shield', "replay from here once it's back"]);
    expect(outage.notes.some((note) => note.id.startsWith('no-replay'))).toBe(false);
  });

  it('lets a queue hold for a consumer that is down, quiets what only it fed, and asks about the single instance', () => {
    const outage = walk(starter.nodes, starter.edges, 'projection-worker');

    expect(outage.nodes.get('projection-queue')).toBe('holding');
    expect(outage.nodes.get('read-store')).toBe('quiet');
    expect(outage.nodes.get('producer')).toBe('unaffected');
    expect(outage.edges.get('consume-projection')).toBe('stopped');
    expect(outage.edges.get('project')).toBe('stopped');
    expect(outage.notes.map((note) => [note.tone, note.note])).toEqual([
      ['shield', "holds messages until it's back"],
      ['effect', 'stops being updated'],
      ['question', 'one instance drawn'],
    ]);
    expect(outage.notes[0]?.text).toMatch(/When it returns the backlog arrives at once, and Read Store takes it with it\./);
    expect(outage.notes[2]?.fix).toEqual({ kind: 'instances', node: 'projection-worker' });
  });

  it('asks rather than guesses when a queue itself is down', () => {
    const outage = walk(starter.nodes, starter.edges, 'integration-queue');

    expect(outage.nodes.get('topic')).toBe('degraded');
    expect(outage.nodes.get('integration-worker')).toBe('quiet');
    expect(outage.notes[0]).toMatchObject({ tone: 'question', focus: ['topic'] });
  });

  it('says nothing it cannot read from the drawing, whatever is taken down', () => {
    for (const target of starter.nodes) {
      const analysis = analyzeTraffic({ nodes: starter.nodes, edges: starter.edges });
      const outage = outageOf(analysis, starter.nodes, starter.edges, { id: target.id, whole: true });
      if (!outage) continue;
      for (const line of outageSummary(outage)) expect(line).not.toMatch(INVENTED);
      // Every question can be kept as an open point on a shape.
      for (const note of outage.notes) {
        expect(note.focus.length).toBeGreaterThan(0);
        expect(note.tone === 'question').toBe(!!note.ask);
      }
    }
  });
});

describe('outage walk — instances', () => {
  const nodes = [
    node('queue', 'queue', { text: 'Orders' }),
    node('producer', 'service', { text: 'Checkout' }),
    { ...node('worker', 'service', { text: 'Fulfilment', serviceKind: 'worker' }), replicas: 3 },
    node('db', 'database', { text: 'Orders DB' }),
  ];
  const edges = [
    edge('publish', 'producer', 'queue', { semantic: 'publishes' }),
    edge('consume', 'queue', 'worker', { semantic: 'consumes' }),
    edge('write', 'worker', 'db', { semantic: 'writes' }),
  ];

  it('loses one instance before it loses them all', () => {
    const one = walk(nodes, edges, 'worker');

    expect(one.instances).toEqual({ down: 1, of: 3 });
    expect(one.nodes.get('worker')).toBe('degraded');
    expect([...one.nodes.values()].filter((value) => value === 'unaffected')).toHaveLength(3);
    expect(one.edges.size).toBe(0);
    expect(one.notes).toHaveLength(1);
    expect(one.notes[0]).toMatchObject({ tone: 'shield', note: '2 of 3 still running' });
    expect(one.notes[0]?.text).toMatch(/the other 2 keep taking work from Orders — slower, not stopped/);
  });

  it('takes every instance when asked, and never asks for more of something already replicated', () => {
    const all = walk(nodes, edges, { id: 'worker', whole: true });

    expect(all.instances).toBeUndefined();
    expect(all.headline).toMatch(/^All 3 Fulfilment instances are down\./);
    expect(all.nodes.get('queue')).toBe('holding');
    expect(all.notes.some((note) => note.id.startsWith('single:'))).toBe(false);
  });
});

describe('outage walk — what a shape is decides how it reads', () => {
  it('carries a failure up a synchronous chain to whoever started it', () => {
    const nodes = [
      node('shopper', 'actor', { text: 'Shopper' }),
      node('store', 'service', { text: 'Storefront' }),
      node('orders', 'service', { text: 'Orders' }),
      node('db', 'database', { text: 'Orders DB' }),
    ];
    const edges = [
      edge('a', 'shopper', 'store', { semantic: 'calls' }),
      edge('b', 'store', 'orders', { semantic: 'calls' }),
      edge('c', 'orders', 'db', { semantic: 'writes' }),
    ];
    const outage = walk(nodes, edges, 'db');

    expect(Object.fromEntries(outage.nodes)).toEqual({ db: 'down', orders: 'failing', store: 'failing', shopper: 'failing' });
    expect(outage.notes.map((note) => note.id)).toEqual(['no-fallback:orders', 'chain:store', 'people:shopper']);
    expect(outage.headline).toBe('Orders DB is down. Nothing drawn carries on without it.');
  });

  it('stops at a drawn fallback', () => {
    const nodes = [
      node('store', 'service', { text: 'Storefront' }),
      node('search', 'service', { text: 'Search' }),
      node('cached', 'database', { text: 'Cached results' }),
    ];
    const edges = [
      edge('a', 'store', 'search', { semantic: 'calls' }),
      edge('b', 'store', 'cached', { semantic: 'reads', kind: 'fallback' }),
    ];
    const outage = walk(nodes, edges, 'search');

    expect(outage.nodes.get('store')).toBe('degraded');
    expect(outage.nodes.get('cached')).toBe('catching');
    expect(outage.edges.get('b')).toBe('recovery');
    expect(outage.notes.map((note) => [note.tone, note.note])).toContainEqual(['shield', 'falls back to Cached results']);
  });

  it('reads a cache as something fallen through, not waited on', () => {
    const nodes = [
      node('shopper', 'actor', { text: 'Shopper' }),
      node('catalog', 'service', { text: 'Catalog' }),
      node('cache', 'database', { text: 'Product cache', databaseKind: 'cache', technology: 'Redis' }),
      node('db', 'database', { text: 'Products', databaseKind: 'sql' }),
    ];
    const edges = [
      edge('a', 'shopper', 'catalog', { semantic: 'calls' }),
      edge('b', 'catalog', 'cache', { semantic: 'reads' }),
      edge('c', 'catalog', 'db', { semantic: 'reads' }),
    ];
    const outage = walk(nodes, edges, 'cache');

    // The caller is degraded, and the failure does not travel on to the person.
    expect(outage.nodes.get('catalog')).toBe('degraded');
    expect(outage.nodes.get('shopper')).toBe('unaffected');
    expect(outage.notes[0]).toMatchObject({
      tone: 'question',
      note: 'every read falls to Products?',
      ask: 'Does Catalog fall through to Products when Product cache is down, and can Products take every read?',
    });
    expect(outage.notes[0]?.text).toMatch(/Redis comes back empty unless persistence is on/);
  });

  it('marks a store stale when what writes it is gone but something still reads it', () => {
    const nodes = [
      node('shopper', 'actor', { text: 'Shopper' }),
      node('api', 'service', { text: 'Catalog API' }),
      node('events', 'queue', { text: 'Catalog events' }),
      node('producer', 'service', { text: 'Catalog admin' }),
      node('projector', 'service', { text: 'Projector', serviceKind: 'worker' }),
      node('read', 'database', { text: 'Read model' }),
    ];
    const edges = [
      edge('a', 'shopper', 'api', { semantic: 'calls' }),
      edge('b', 'api', 'read', { semantic: 'reads' }),
      edge('c', 'producer', 'events', { semantic: 'publishes' }),
      edge('d', 'events', 'projector', { semantic: 'consumes' }),
      edge('e', 'projector', 'read', { semantic: 'writes' }),
    ];
    const outage = walk(nodes, edges, 'projector');

    expect(outage.nodes.get('read')).toBe('stale');
    expect(outage.nodes.get('api')).toBe('unaffected');
    expect(outage.notes.find((note) => note.id === 'stale:read')).toMatchObject({ tone: 'effect', note: 'goes stale' });
  });

  it('lets another consumer keep draining a shared work queue', () => {
    const nodes = [
      node('producer', 'service', { text: 'Checkout' }),
      node('queue', 'queue', { text: 'Orders' }),
      node('one', 'service', { text: 'Packer', serviceKind: 'worker' }),
      node('two', 'service', { text: 'Second packer', serviceKind: 'worker' }),
    ];
    const edges = [
      edge('a', 'producer', 'queue', { semantic: 'publishes' }),
      edge('b', 'queue', 'one', { semantic: 'consumes' }),
      edge('c', 'queue', 'two', { semantic: 'consumes' }),
    ];
    const outage = walk(nodes, edges, 'one');

    expect(outage.nodes.get('queue')).toBe('unaffected');
    expect(outage.notes.map((note) => [note.tone, note.note])).toContainEqual(['shield', 'Second packer keeps draining it']);
  });

  it('keeps or drops a topic’s events according to the product it is drawn as', () => {
    const graph = (technology?: string) => {
      const nodes = [
        node('producer', 'service', { text: 'Checkout' }),
        node('topic', 'queue', { text: 'Order events', queueKind: 'topic', technology }),
        node('mailer', 'service', { text: 'Mailer' }),
      ];
      const edges = [edge('a', 'producer', 'topic', { semantic: 'publishes' }), edge('b', 'topic', 'mailer', { semantic: 'deliversTo' })];
      return walk(nodes, edges, 'mailer');
    };

    expect(graph().notes[0]).toMatchObject({ tone: 'question', note: 'keeps events for it, or drops them?' });
    expect(graph('Amazon SNS').notes[0]).toMatchObject({ tone: 'question', note: 'events are dropped meanwhile' });
    const kafka = graph('Kafka');
    expect(kafka.nodes.get('topic')).toBe('holding');
    expect(kafka.notes[0]?.text).toMatch(/Kafka keeps the log for its retention period/);
  });

  it('offers a dead-letter queue where a failing consumer has none', () => {
    const nodes = [
      node('producer', 'service', { text: 'Checkout' }),
      node('queue', 'queue', { text: 'Payments' }),
      node('worker', 'service', { text: 'Charger', serviceKind: 'worker' }),
      node('bank', 'service', { text: 'Bank', serviceKind: 'external' }),
    ];
    const edges = [
      edge('a', 'producer', 'queue', { semantic: 'publishes' }),
      edge('b', 'queue', 'worker', { semantic: 'consumes' }),
      edge('c', 'worker', 'bank', { semantic: 'calls' }),
      edge('d', 'worker', 'bank', { semantic: 'calls', kind: 'retry' }),
    ];
    const outage = walk(nodes, edges, 'bank');

    expect(outage.nodes.get('queue')).toBe('retrying');
    expect(outage.notes.find((note) => note.id === 'redelivers:queue')).toMatchObject({ tone: 'question', fix: { kind: 'dead-letter', queue: 'queue' } });
    expect(outage.notes.map((note) => note.note)).toContain('retries pile onto it');
  });

  it('says how many attempts a drawn dead-letter route allows', () => {
    const edges = starter.edges.map((item) => (item.id === 'dead-letter' ? { ...item, deliveryAttempts: 3 } : item));

    expect(walk(starter.nodes, edges, 'external').notes[1]?.note).toBe('dead-letters after 3 attempts');
  });

  it('takes everything inside a boundary down with it', () => {
    const nodes = [
      node('zone', 'group', { text: 'Zone A' }),
      node('shopper', 'actor', { text: 'Shopper' }),
      node('api', 'service', { text: 'API', parentId: 'zone' }),
      node('db', 'database', { text: 'Orders DB', parentId: 'zone' }),
      node('other', 'service', { text: 'Status page' }),
    ];
    const edges = [
      edge('a', 'shopper', 'api', { semantic: 'calls' }),
      edge('b', 'api', 'db', { semantic: 'writes' }),
      edge('c', 'shopper', 'other', { semantic: 'calls' }),
    ];
    const outage = walk(nodes, edges, 'zone');

    expect(lostBy(nodes, 'zone')).toEqual(['api', 'db']);
    expect(outage.lost).toEqual(['api', 'db']);
    expect(outage.nodes.get('shopper')).toBe('failing');
    expect(outage.nodes.get('other')).toBe('unaffected');
    expect(outage.headline).toBe('Everything in Zone A is down. Status page carries on.');
  });

  it('only takes down what runs', () => {
    const nodes = [node('shopper', 'actor', { text: 'Shopper' }), node('store', 'service', { text: 'Storefront' }), node('lonely', 'service', { text: 'Unwired' }), node('empty', 'group', { text: 'Empty' })];
    const edges = [edge('a', 'shopper', 'store', { semantic: 'calls' })];
    const analysis = analyzeTraffic({ nodes, edges });

    expect(canTakeDown(analysis, nodes, 'store')).toBe(true);
    expect(mayTakeDown(nodes, 'shopper')).toBe(false);
    expect(mayTakeDown(nodes, 'empty')).toBe(false);
    expect(mayTakeDown(nodes, 'lonely')).toBe(true);
    expect(outageOf(analysis, nodes, edges, { id: 'missing' })).toBeNull();
  });
});

describe('product facts', () => {
  it('matches only an assigned product name, with an optional version', () => {
    expect(outageFact({ type: 'queue', technology: 'Kafka 3.7' })?.name).toBe('Kafka');
    expect(outageFact({ type: 'queue', technology: 'aws sqs' })?.retains).toBe(true);
    expect(outageFact({ type: 'queue', technology: 'Kafka client' })).toBeNull();
    expect(outageFact({ type: 'service', technology: 'Kafka' })).toBeNull();
    expect(outageFact({ type: 'database', technology: undefined })).toBeNull();
    // The same rule a technology's kind follows: a parenthetical is about the product, a stack is not one.
    expect(outageFact({ type: 'queue', technology: 'Kafka (orders)' })?.name).toBe('Kafka');
    expect(outageFact({ type: 'queue', technology: 'Kafka + Redis' })).toBeNull();
  });

  it('knows which brokers keep what a subscriber missed, and which drop it', () => {
    for (const technology of ['Amazon MSK', 'Redpanda', 'Google Pub/Sub', 'Azure Service Bus', 'Apache Pulsar', 'Amazon Kinesis']) {
      expect(outageFact({ type: 'queue', technology })?.retains, technology).toBe(true);
    }
    for (const technology of ['Amazon EventBridge', 'Azure Event Grid', 'NATS', 'Mosquitto', 'Redis Pub/Sub']) {
      expect(outageFact({ type: 'queue', technology })?.retains, technology).toBe(false);
    }
    expect(outageFact({ type: 'database', technology: 'Valkey' })?.down).toMatch(/comes back empty/);
  });
});
