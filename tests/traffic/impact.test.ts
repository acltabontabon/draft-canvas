import { describe, expect, it } from 'vitest';
import { analyzeTraffic, impactOf } from '../../src/traffic';
import { edge, node } from './helpers';

describe('traffic impact', () => {
  it('finds nearest transitive waiters, upstream journeys and synchronous/data dependencies', () => {
    const actor = node('actor', 'actor', { text: 'Customer' });
    const api = node('api', 'service', { text: 'API' });
    const bff = node('bff', 'service', { text: 'BFF' });
    const scheduler = node('scheduler', 'service', { serviceKind: 'scheduler', text: 'Scheduler' });
    const writer = node('writer', 'service', { text: 'Writer' });
    const database = node('database', 'database', { databaseKind: 'sql', text: 'PostgreSQL' });
    const analysis = analyzeTraffic({
      nodes: [actor, api, bff, scheduler, writer, database],
      edges: [
        edge('actor-api', actor.id, api.id, { semantic: 'calls' }),
        edge('api-bff', api.id, bff.id, { semantic: 'calls' }),
        edge('bff-db', bff.id, database.id, { semantic: 'reads' }),
        edge('scheduler-writer', scheduler.id, writer.id, { semantic: 'calls' }),
        edge('writer-db', writer.id, database.id, { semantic: 'writes' }),
      ],
    });

    const impact = impactOf(analysis, database.id);

    expect(impact.waiting).toEqual([bff.id, writer.id, api.id, scheduler.id]);
    expect([...impact.journeys].sort()).toEqual([actor.id, scheduler.id].sort());
    expect(impact.dependsOn).toEqual([]);
    expect(impact.waiting).not.toContain(actor.id);
  });

  it('reports downstream work only after publish/deliver hand-offs, excluding queues and topics', () => {
    const producer = node('producer', 'service', { text: 'Producer' });
    const queue = node('queue', 'queue', { queueKind: 'queue', text: 'Jobs' });
    const worker = node('worker', 'service', { serviceKind: 'worker', text: 'Worker' });
    const topic = node('topic', 'queue', { queueKind: 'topic', text: 'Events' });
    const indexer = node('indexer', 'service', { serviceKind: 'worker', text: 'Indexer' });
    const notifier = node('notifier', 'service', { text: 'Notifier' });
    const search = node('search', 'database', { databaseKind: 'search-index', text: 'Search' });
    const analysis = analyzeTraffic({
      nodes: [producer, queue, worker, topic, indexer, notifier, search],
      edges: [
        edge('producer-queue', producer.id, queue.id, { semantic: 'publishes' }),
        edge('queue-worker', queue.id, worker.id, { semantic: 'consumes' }),
        edge('worker-topic', worker.id, topic.id, { semantic: 'publishes' }),
        edge('topic-indexer', topic.id, indexer.id, { semantic: 'consumes' }),
        edge('topic-notifier', topic.id, notifier.id, { semantic: 'consumes' }),
        edge('indexer-search', indexer.id, search.id, { semantic: 'indexes' }),
      ],
    });

    const impact = impactOf(analysis, producer.id);

    expect(impact.waiting).toEqual([]);
    expect(impact.journeys).toEqual([producer.id]);
    expect(impact.dependsOn).toEqual([]);
    expect(impact.decoupled).toEqual([worker.id, indexer.id, notifier.id, search.id]);
    expect(impact.decoupled).not.toContain(queue.id);
    expect(impact.decoupled).not.toContain(topic.id);
  });

  it('does not recurse through a synchronous loop forever or report the loop as a dependency', () => {
    const actor = node('actor', 'actor', { text: 'Customer' });
    const first = node('first', 'service', { text: 'First' });
    const second = node('second', 'service', { text: 'Second' });
    const analysis = analyzeTraffic({
      nodes: [actor, first, second],
      edges: [
        edge('actor-first', actor.id, first.id, { semantic: 'calls' }),
        edge('first-second', first.id, second.id, { semantic: 'calls' }),
        edge('second-first', second.id, first.id, { semantic: 'calls' }),
      ],
    });

    expect(impactOf(analysis, first.id)).toEqual({ waiting: [], journeys: [actor.id], dependsOn: [], mayDependOn: [], decoupled: [] });
    expect(impactOf(analysis, second.id)).toEqual({ waiting: [], journeys: [], dependsOn: [], mayDependOn: [], decoupled: [] });
  });
});
