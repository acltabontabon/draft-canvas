import { describe, expect, it } from 'vitest';
import { analyzeTraffic, mayHaveTraffic } from '../../src/traffic';
import { edge, insight, node } from './helpers';

describe('traffic graph propagation', () => {
  it('keeps multiple independent entries and their paths separate', () => {
    const first = node('first', 'service');
    const second = node('second', 'actor', { actorKind: 'human' });
    const target = node('target', 'service');
    const result = analyzeTraffic({ nodes: [first, second, target], edges: [edge('first-target', first.id, target.id, { semantic: 'calls' }), edge('second-target', second.id, target.id, { semantic: 'calls' })] });
    expect(result.entries).toEqual([first.id, second.id].sort());
    expect(result.nodes.get(target.id)?.paths).toEqual({ definite: 2, possible: 2 });
    expect(result.nodes.get(target.id)?.entries).toEqual([first.id, second.id].sort());
    expect(result.nodes.get(target.id)?.entryCount).toBe(2);
  });

  it('ranks a shared database from three independent services', () => {
    const services = ['one', 'two', 'three'].map((id) => node(id, 'service', { text: id }));
    const database = node('postgres', 'database', { databaseKind: 'sql', text: 'Postgres' });
    const result = analyzeTraffic({ nodes: [...services, database], edges: services.map((value) => edge(`${value.id}-postgres`, value.id, database.id, { semantic: 'writes' })) });
    expect(result.nodes.get(database.id)).toMatchObject({ paths: { definite: 3, possible: 3 }, sources: services.map((value) => value.id).sort(), tier: 'top' });
    expect(result.hotspots).toContain(database.id);
    expect(insight(result, 'shared-dependency').text).toMatch(/3 services coupled through one store/);
  });

  it('models a service to queue to worker as an async buffer', () => {
    const producer = node('producer', 'service');
    const queue = node('queue', 'queue', { queueKind: 'queue' });
    const worker = node('worker', 'service', { serviceKind: 'worker' });
    const result = analyzeTraffic({ nodes: [producer, queue, worker], edges: [edge('publish', producer.id, queue.id, { semantic: 'publishes', async: true }), edge('consume', queue.id, worker.id, { semantic: 'consumes', async: true })] });
    expect(result.nodes.get(worker.id)?.paths).toEqual({ definite: 1, possible: 1 });
    expect(insight(result, 'async-buffer').text).toMatch(/fall behind or fail without slowing/);
  });

  it('delivers a topic message definitely to all three subscribers', () => {
    const producer = node('producer', 'service');
    const topic = node('topic', 'queue', { queueKind: 'topic' });
    const subscribers = ['a', 'b', 'c'].map((id) => node(id, 'service', { serviceKind: 'worker' }));
    const result = analyzeTraffic({ nodes: [producer, topic, ...subscribers], edges: [
      edge('publish', producer.id, topic.id, { semantic: 'publishes' }),
      ...subscribers.map((value) => edge(`consume-${value.id}`, topic.id, value.id, { semantic: 'consumes' })),
    ] });
    expect(subscribers.map((value) => result.nodes.get(value.id)?.paths)).toEqual(subscribers.map(() => ({ definite: 1, possible: 1 })));
    expect(insight(result, 'message-distribution').text).toMatch(/handled 3 times/);
  });

  it('marks two queue consumers possible and reports competing consumers', () => {
    const producer = node('producer', 'service');
    const queue = node('queue', 'queue', { queueKind: 'queue' });
    const workers = ['a', 'b'].map((id) => node(id, 'service', { serviceKind: 'worker' }));
    const result = analyzeTraffic({ nodes: [producer, queue, ...workers], edges: [edge('publish', producer.id, queue.id, { semantic: 'publishes' }), ...workers.map((value) => edge(`consume-${value.id}`, queue.id, value.id, { semantic: 'consumes' }))] });
    expect(workers.map((value) => result.nodes.get(value.id)?.paths)).toEqual(workers.map(() => ({ definite: 0, possible: 1 })));
    expect(insight(result, 'competing-consumers').text).toMatch(/take turns on/);
  });

  it('handles file, object and search storage operations as data workload', () => {
    const service = node('service', 'service');
    const file = node('file', 'database', { databaseKind: 'file-system' });
    const object = node('object', 'database', { databaseKind: 'object-storage' });
    const search = node('search', 'database', { databaseKind: 'search-index' });
    const result = analyzeTraffic({ nodes: [service, file, object, search], edges: [edge('file', service.id, file.id, { semantic: 'reads' }), edge('object', service.id, object.id, { semantic: 'writes' }), edge('search', service.id, search.id, { semantic: 'searches' })] });
    expect(result.interactions.every((value) => value.class === 'data')).toBe(true);
    expect(result.nodes.get(file.id)?.workloads).toEqual(['data']);
    expect(result.nodes.get(object.id)?.workloads).toEqual(['data']);
    expect(result.nodes.get(search.id)?.workloads).toEqual(['data']);
  });

  it('does not turn a structural dependency into a path', () => {
    const a = node('a', 'service');
    const b = node('b', 'service');
    const result = analyzeTraffic({ nodes: [a, b], edges: [edge('depends', a.id, b.id, { semantic: 'dependsOn' })] });
    expect(result.status).toBe('nothing-to-analyze');
    expect(result.interactions[0]).toMatchObject({ class: 'structural', paths: { definite: 0, possible: 0 } });
  });

  it('reports an excluded component hop instead of inferring a service-to-database path', () => {
    const service = node('service', 'service', { text: 'Order Service' });
    const component = node('component', 'component', { componentKind: 'module', text: 'Order Logic' });
    const database = node('database', 'database', { databaseKind: 'sql', text: 'PostgreSQL' });
    const result = analyzeTraffic({ nodes: [service, component, database], edges: [edge('service-component', service.id, component.id, { semantic: 'calls' }), edge('component-database', component.id, database.id, { semantic: 'reads' })] });
    expect(result.interactions.some((value) => value.from === service.id && value.to === database.id)).toBe(false);
    expect(result.nodes.has(component.id)).toBe(true);
    expect(insight(result, 'unsupported-hop').text).toMatch(/Order Logic/);
  });

  it('uses a scheduler as an entry and explains the schedule', () => {
    const scheduler = node('scheduler', 'service', { serviceKind: 'scheduler', text: 'Nightly Job' });
    const worker = node('worker', 'service', { serviceKind: 'worker' });
    const result = analyzeTraffic({ nodes: [scheduler, worker], edges: [edge('run', scheduler.id, worker.id, { semantic: 'triggers' })] });
    expect(result.entries).toEqual([scheduler.id]);
    expect(insight(result, 'scheduler').text).toMatch(/on its own schedule/);
  });

  it('keeps nodes present with zero paths when they are not reached', () => {
    const source = node('source', 'service');
    const target = node('target', 'service');
    const isolated = node('isolated', 'database', { databaseKind: 'sql' });
    const result = analyzeTraffic({ nodes: [source, target, isolated], edges: [edge('source-target', source.id, target.id, { semantic: 'calls' })] });
    expect(result.nodes.get(isolated.id)?.paths).toEqual({ definite: 0, possible: 0 });
  });
});

describe('traffic entry hint', () => {
  it('is true for a baseline Service-to-Database connector', () => {
    const service = node('service', 'service');
    const database = node('database', 'database', { databaseKind: 'sql' });
    expect(mayHaveTraffic(new Map([[service.id, service], [database.id, database]]), [edge('read', service.id, database.id, { semantic: 'reads' })])).toBe(true);
  });

  it('is false for notes-only, component-only and structural-only drawings', () => {
    const note = node('note', 'note');
    const component = node('component', 'component');
    const service = node('service', 'service');
    const other = node('other', 'service');
    expect(mayHaveTraffic(new Map([[note.id, note]]), [edge('note-line', note.id, note.id, { semantic: 'calls' })])).toBe(false);
    expect(mayHaveTraffic(new Map([[component.id, component]]), [edge('component-line', component.id, component.id, { semantic: 'dependsOn' })])).toBe(false);
    expect(mayHaveTraffic(new Map([[service.id, service], [other.id, other]]), [edge('structural', service.id, other.id, { semantic: 'dependsOn' })])).toBe(false);
  });
});
