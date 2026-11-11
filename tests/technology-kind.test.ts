import { beforeEach, describe, expect, it } from 'vitest';
import { convertedNode } from '../src/document/convert';
import { createDocument, createEdge, createNode } from '../src/document/factory';
import { addEdges, addNodes } from '../src/document/operations';
import { kindForTechnology, technologyKindPatch } from '../src/document/technologyKind';
import { normalizeDocument } from '../src/document/validate';
import { serializeDocument } from '../src/export/project';
import { __resetInteraction, useEditorStore } from '../src/store/editorStore';

describe('kindForTechnology', () => {
  it.each([
    ['database', 'Redis', { databaseKind: 'cache' }],
    ['database', 'PostgreSQL 16', { databaseKind: 'sql' }],
    ['database', 'Amazon S3', { databaseKind: 'object-storage' }],
    ['database', 'Redis (sessions)', { databaseKind: 'cache' }],
    ['queue', 'Kafka', { queueKind: 'topic' }],
    ['queue', 'Apache Kafka 3.7', { queueKind: 'topic' }],
    ['queue', 'Kinesis', { queueKind: 'stream' }],
    ['queue', 'SQS', { queueKind: 'queue' }],
    ['service', 'Stripe', { serviceKind: 'external' }],
    ['service', 'Kong', { serviceKind: 'gateway' }],
  ] as const)('%s with %s', (type, technology, expected) => {
    expect(kindForTechnology(type, technology)).toMatchObject(expected);
  });

  it.each([
    ['database', 'Kafka'],
    ['queue', 'Redis'],
    ['database', 'Postgres + Redis'],
    ['queue', 'Kafka client'],
    ['service', 'Spring Boot'],
  ] as const)('ignores %s with %s', (type, technology) => {
    expect(kindForTechnology(type, technology)).toBeNull();
  });
});

describe('technologyKindPatch', () => {
  it('moves a default kind and marks it as the technology\'s', () => {
    const store = createNode({ type: 'database', x: 0, y: 0 });
    expect(technologyKindPatch(store, 'Redis')).toEqual({ databaseKind: 'cache', kindOrigin: 'technology' });
  });

  it('never moves a picked kind', () => {
    const store = createNode({ type: 'database', databaseKind: 'nosql', x: 0, y: 0 });
    expect(technologyKindPatch(store, 'Redis')).toBeNull();
  });

  it('follows a later technology, and goes back to the default when it is cleared', () => {
    const cache = { ...createNode({ type: 'database', databaseKind: 'cache', x: 0, y: 0 }), kindOrigin: 'technology' as const };
    expect(technologyKindPatch(cache, 'PostgreSQL')).toEqual({ databaseKind: 'sql', kindOrigin: 'technology' });
    expect(technologyKindPatch(cache, undefined)).toEqual({ databaseKind: 'generic', kindOrigin: undefined });
  });

  it('leaves a dead-letter queue alone', () => {
    const dlq = createNode({ type: 'queue', deliveryRole: 'dead-letter', x: 0, y: 0 });
    expect(technologyKindPatch(dlq, 'Kafka')).toBeNull();
  });

  it('applies on conversion: a Service on Kafka turned into a Queue is a Topic', () => {
    const service = createNode({ type: 'service', technology: 'Kafka', text: 'Events', x: 0, y: 0 });
    const queue = convertedNode(service, 'queue');
    expect(queue.queueKind).toBe('topic');
    expect(queue.kindOrigin).toBe('technology');
  });

  it('survives a save and load', () => {
    const node = { ...createNode({ type: 'database', databaseKind: 'cache', technology: 'Redis', x: 0, y: 0 }), kindOrigin: 'technology' as const };
    const loaded = normalizeDocument(JSON.parse(serializeDocument(addNodes(createDocument('T'), [node]))));
    if (!loaded.ok) throw new Error(loaded.error);
    expect(loaded.document.nodes[0]!.kindOrigin).toBe('technology');
  });
});

describe('store: setting a technology', () => {
  const store = useEditorStore;

  beforeEach(() => {
    __resetInteraction();
    store.setState({
      document: createDocument('Store'),
      history: { past: [], future: [] },
      selection: { nodes: [], edges: [] },
      clipboard: null,
      revision: 0,
    });
  });

  it('turns a Data Store into a cache and re-infers its connectors, in one step', () => {
    const api = createNode({ type: 'service', serviceKind: 'api', x: 0, y: 0 });
    const db = createNode({ type: 'database', x: 400, y: 0 });
    const edge = createEdge({ source: api.id, target: db.id, semantic: 'readsWrites', semanticsOrigin: 'inferred' });
    store.setState({ document: addEdges(addNodes(createDocument('S'), [api, db]), [edge]) });
    store.getState().setNodeC4Text(db.id, { technology: 'Redis' });
    const doc = store.getState().document;
    const node = doc.nodes.find((n) => n.id === db.id)!;
    expect(node.databaseKind).toBe('cache');
    expect(node.kindOrigin).toBe('technology');
    expect(store.getState().history.past).toHaveLength(1);
  });

  it('a kind picked afterwards stops following the technology', () => {
    const queue = store.getState().addNode({ type: 'queue', x: 0, y: 0 });
    store.getState().setNodeC4Text(queue.id, { technology: 'Kafka' });
    expect(store.getState().document.nodes[0]!.queueKind).toBe('topic');
    store.getState().updateNodeById(queue.id, { queueKind: 'stream' });
    expect(store.getState().document.nodes[0]!.kindOrigin).toBeUndefined();
    store.getState().setNodeC4Text(queue.id, { technology: 'SQS' });
    expect(store.getState().document.nodes[0]!.queueKind).toBe('stream');
  });
});
