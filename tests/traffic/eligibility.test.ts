import { describe, expect, it } from 'vitest';
import { EDGE_SEMANTICS } from '../../src/document/types';
import type { DraftNode } from '../../src/document/types';
import { classifyConnector } from '../../src/traffic/classify';
import { analyzeTraffic, trafficGroupOf, trafficRoleOf, type TrafficGroup, type TrafficRole } from '../../src/traffic';
import { edge, interaction, node } from './helpers';

const eligibilityCases: Array<[string, DraftNode, TrafficRole, TrafficGroup | undefined]> = [
  ['generic service', node('service-generic', 'service', { serviceKind: 'generic' }), 'compute', 'services'],
  ['API service', node('service-api', 'service', { serviceKind: 'api' }), 'compute', 'services'],
  ['gateway service', node('service-gateway', 'service', { serviceKind: 'gateway' }), 'compute', 'services'],
  ['worker service', node('service-worker', 'service', { serviceKind: 'worker' }), 'compute', 'services'],
  ['scheduler service', node('service-scheduler', 'service', { serviceKind: 'scheduler' }), 'compute', 'services'],
  ['external service', node('service-external', 'service', { serviceKind: 'external' }), 'compute', 'services'],
  ['generic database', node('database-generic', 'database', { databaseKind: 'generic' }), 'data', 'data'],
  ['SQL database', node('database-sql', 'database', { databaseKind: 'sql' }), 'data', 'data'],
  ['NoSQL database', node('database-nosql', 'database', { databaseKind: 'nosql' }), 'data', 'data'],
  ['cache database', node('database-cache', 'database', { databaseKind: 'cache' }), 'data', 'data'],
  ['object storage', node('database-object', 'database', { databaseKind: 'object-storage' }), 'data', 'data'],
  ['file system', node('database-file', 'database', { databaseKind: 'file-system' }), 'data', 'data'],
  ['search index', node('database-search', 'database', { databaseKind: 'search-index' }), 'data', 'data'],
  ['logical table', node('database-table', 'database', { databaseKind: 'table' }), 'excluded', undefined],
  ['queue', node('queue', 'queue', { queueKind: 'queue' }), 'messaging', 'messaging'],
  ['topic', node('topic', 'queue', { queueKind: 'topic' }), 'messaging', 'messaging'],
  ['stream', node('stream', 'queue', { queueKind: 'stream' }), 'messaging', 'messaging'],
  ['dead-letter queue', node('dlq', 'queue', { deliveryRole: 'dead-letter' }), 'messaging', 'messaging'],
  ...(['human', 'system', 'device', 'group', 'thirdParty', 'agent'] as const).map((actorKind) => [
    `actor ${actorKind}`,
    node(`actor-${actorKind}`, 'actor', { actorKind }),
    'origin',
    undefined,
  ] as [string, DraftNode, TrafficRole, TrafficGroup | undefined]),
  ['ellipse Junction', node('junction', 'ellipse'), 'junction', undefined],
  ['generic Component', node('component-generic', 'component', { componentKind: 'generic' }), 'excluded', undefined],
  ['port Component', node('component-port', 'component', { componentKind: 'port' }), 'excluded', undefined],
  ['adapter Component', node('component-adapter', 'component', { componentKind: 'adapter' }), 'excluded', undefined],
  ['module Component', node('component-module', 'component', { componentKind: 'module' }), 'excluded', undefined],
  ['note', node('note', 'note'), 'excluded', undefined],
  ['text', node('text', 'text'), 'excluded', undefined],
  ['code', node('code', 'code'), 'excluded', undefined],
  ['group', node('group', 'group'), 'excluded', undefined],
];

describe('traffic eligibility', () => {
  it.each(eligibilityCases)('%s has its contract role and group', (_label, value, role, group) => {
    expect(trafficRoleOf(value)).toBe(role);
    expect(trafficGroupOf(value)).toBe(group);
  });
});

describe('connector classification', () => {
  const service = node('service', 'service', { serviceKind: 'generic' });
  const otherService = node('other-service', 'service', { serviceKind: 'generic' });
  const store = node('store', 'database', { databaseKind: 'sql' });
  const queue = node('queue', 'queue', { queueKind: 'queue' });
  const topic = node('topic', 'queue', { queueKind: 'topic' });
  const dlq = node('dlq', 'queue', { deliveryRole: 'dead-letter' });

  it.each([
    ['http', service, otherService, 'request'],
    ['grpc', service, otherService, 'request'],
    ['event', service, otherService, 'request'],
    ['command', service, otherService, 'request'],
    ['query', service, store, 'data'],
    ['reads', service, store, 'data'],
    ['writes', service, store, 'data'],
    ['readsWrites', service, store, 'data'],
    ['publishes', service, queue, 'publish'],
    ['consumes', queue, service, 'deliver'],
    ['calls', service, otherService, 'request'],
    ['dependsOn', service, otherService, 'structural'],
    ['uses', service, otherService, 'structural'],
    ['fansOut', topic, service, 'deliver'],
    ['deliversTo', queue, service, 'deliver'],
    ['ingests', topic, store, 'data'],
    ['replicates', store, otherService, 'background'],
    ['cdc', store, otherService, 'background'],
    ['syncs', service, otherService, 'background'],
    ['deadLetters', queue, dlq, 'failure'],
    ['invalidates', service, store, 'data'],
    ['watches', service, store, 'data'],
    ['searches', service, store, 'data'],
    ['indexes', service, store, 'data'],
    ['routes', service, otherService, 'request'],
    ['triggers', service, otherService, 'request'],
    ['implementedBy', service, otherService, 'structural'],
    ['implements', service, otherService, 'structural'],
    ['compensates', service, otherService, 'failure'],
    ['transforms', service, otherService, 'background'],
    ['asks', service, otherService, 'participant'],
    ['delegates', service, otherService, 'participant'],
    ['escalates', service, otherService, 'participant'],
    ['notifies', service, otherService, 'participant'],
  ] as const)('%s has a defined contract class', (semantic, source, target, expected) => {
    const classified = classifyConnector(edge(`class-${semantic}`, source.id, target.id, { semantic }), source, target);
    expect(classified.class).toBe(expected);
  });

  it('sweeps every EDGE_SEMANTICS value without an unclassified semantic', () => {
    for (const semantic of EDGE_SEMANTICS) {
      const classified = classifyConnector(edge(`sweep-${semantic}`, service.id, otherService.id, { semantic }), service, otherService);
      expect(classified.class, semantic).toBeDefined();
    }
  });

  it('reverses passive drawings to the work direction', () => {
    const databaseToService = classifyConnector(edge('passive-read', store.id, service.id, { semantic: 'reads' }), store, service);
    expect(databaseToService).toMatchObject({ from: service.id, to: store.id, class: 'data' });

    const queueToWorker = classifyConnector(edge('passive-consume', queue.id, service.id, { semantic: 'consumes' }), queue, service);
    expect(queueToWorker).toMatchObject({ from: queue.id, to: service.id, class: 'deliver' });

    const workerToQueue = classifyConnector(edge('reverse-consume', service.id, queue.id, { semantic: 'consumes' }), service, queue);
    expect(workerToQueue).toMatchObject({ from: queue.id, to: service.id, class: 'deliver' });
  });

  it('uses a capability default when semantic is missing and marks it inferred', () => {
    const classified = classifyConnector(edge('inferred', service.id, store.id), service, store);
    expect(classified).toMatchObject({ from: service.id, to: store.id, class: 'data', inferred: true });
  });

  it('makes undirected runtime lines associations rather than paths', () => {
    const result = analyzeTraffic({ nodes: [service, otherService], edges: [edge('undirected', service.id, otherService.id, { directed: false, semantic: 'calls' })] });
    expect(result.interactions).toEqual(expect.arrayContaining([expect.objectContaining({ class: 'association' })]));
    expect(result.status).toBe('nothing-to-analyze');
    expect(result.insights.some((value) => value.kind === 'undirected')).toBe(true);
  });

  it('keeps a conditional semantic class but makes its traffic possible', () => {
    const conditional = classifyConnector(edge('conditional', service.id, otherService.id, { semantic: 'calls', kind: 'conditional', condition: 'approved' }), service, otherService);
    expect(conditional).toMatchObject({ class: 'request', certainty: 'possible', uncertainty: 'conditional', sync: false });
    const result = analyzeTraffic({ nodes: [service, otherService], edges: [edge('condition-chip', service.id, otherService.id, { semantic: 'calls', condition: 'approved' })] });
    expect(result.insights.find((value) => value.kind === 'conditional')?.text).toMatch(/approved/);
  });

  it('only lets retry, failure, fallback and callback override a baseline class', () => {
    for (const kind of ['retry', 'failure', 'fallback', 'callback'] as const) {
      const classified = classifyConnector(edge(`nonbaseline-${kind}`, service.id, otherService.id, { semantic: 'dependsOn', kind }), service, otherService);
      expect(classified.class, kind).toBe('structural');
    }
    const result = analyzeTraffic({ nodes: [service, otherService], edges: [edge('structural-retry', service.id, otherService.id, { semantic: 'dependsOn', kind: 'retry' })] });
    expect(result.insights.some((value) => value.kind === 'retry-amplification')).toBe(false);
  });

  it('treats async as the only reason a request route is not synchronous', () => {
    const sync = classifyConnector(edge('sync', service.id, otherService.id, { semantic: 'calls' }), service, otherService);
    const asyncRoute = classifyConnector(edge('async', service.id, otherService.id, { semantic: 'calls', async: true }), service, otherService);
    expect(sync.sync).toBe(true);
    expect(asyncRoute.sync).toBe(false);
  });

  it('recognizes an object-storage publish as a possible inferred trigger', () => {
    const objectStorage = node('object-storage', 'database', { databaseKind: 'object-storage' });
    const classified = classifyConnector(edge('object-publish', objectStorage.id, topic.id, { semantic: 'publishes' }), objectStorage, topic);
    expect(classified).toMatchObject({ class: 'publish', certainty: 'possible', uncertainty: 'inferred-trigger' });
  });
});

describe('topic-to-queue delivery', () => {
  it.each(['fansOut', 'deliversTo'] as const)('treats topic -> queue %s as delivery and carries traffic to the worker', (semantic) => {
    const producer = node('producer', 'service', { text: 'Producer' });
    const topic = node('topic', 'queue', { queueKind: 'topic', text: 'Topic' });
    const queue = node('queue', 'queue', { queueKind: 'queue', text: 'Queue' });
    const worker = node('worker', 'service', { serviceKind: 'worker', text: 'Worker' });
    const result = analyzeTraffic({
      nodes: [producer, topic, queue, worker],
      edges: [
        edge('publish', producer.id, topic.id, { semantic: 'publishes' }),
        edge('topic-queue', topic.id, queue.id, { semantic }),
        edge('queue-worker', queue.id, worker.id, { semantic: 'consumes' }),
      ],
    });
    expect(interaction(result, topic.id, queue.id, 'deliver')).toMatchObject({ class: 'deliver', from: topic.id, to: queue.id });
    expect(result.nodes.get(worker.id)?.paths).toEqual({ definite: 1, possible: 1 });
  });
});

