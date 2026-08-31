import { beforeEach, describe, expect, it } from 'vitest';
import { capabilityFor, categoryOf, inferRelationship, isEligibleForReinference } from '../src/document/connectorSemantics';
import { createDocument, createEdge, createNode, type CreateNodeInput } from '../src/document/factory';
import { __resetInteraction, useEditorStore } from '../src/store/editorStore';

describe('categoryOf', () => {
  it('reads actor and queue straight from the node type', () => {
    expect(categoryOf({ type: 'actor' })).toBe('actor');
    expect(categoryOf({ type: 'queue' })).toBe('queue');
  });

  it('reads a plain service as service, and an external one as external', () => {
    expect(categoryOf({ type: 'service' })).toBe('service');
    expect(categoryOf({ type: 'service', serviceKind: 'generic' })).toBe('service');
    expect(categoryOf({ type: 'service', serviceKind: 'api' })).toBe('service');
    expect(categoryOf({ type: 'service', serviceKind: 'external' })).toBe('external');
  });

  it('reads a plain database as database, and a cache one as cache', () => {
    expect(categoryOf({ type: 'database' })).toBe('database');
    expect(categoryOf({ type: 'database', databaseKind: 'sql' })).toBe('database');
    expect(categoryOf({ type: 'database', databaseKind: 'cache' })).toBe('cache');
  });

  it('reads every other node type as generic', () => {
    for (const type of ['card', 'rounded', 'ellipse', 'text', 'note', 'code', 'group'] as const) {
      expect(categoryOf({ type })).toBe('generic');
    }
  });
});

describe('capabilityFor — the capability matrix', () => {
  it('service → database: defaults to writes, offers writes/reads/query/dependsOn, behaviour is not a meaningful choice', () => {
    const cap = capabilityFor('service', 'database')!;
    expect(cap.defaultRelation).toBe('writes');
    expect(cap.relations).toEqual(['writes', 'reads', 'query', 'dependsOn']);
    expect(cap.behaviors).toEqual([]);
    expect(cap.defaultBehavior).toBeUndefined();
  });

  it('database → service: defaults to reads, never offers messaging semantics', () => {
    const cap = capabilityFor('database', 'service')!;
    expect(cap.defaultRelation).toBe('reads');
    expect(cap.relations).toEqual(['reads', 'query', 'dependsOn']);
    expect(cap.relations).not.toContain('publishes');
    expect(cap.relations).not.toContain('consumes');
  });

  it('service → queue: defaults to publishes, implies event behaviour with no picker', () => {
    const cap = capabilityFor('service', 'queue')!;
    expect(cap.defaultRelation).toBe('publishes');
    expect(cap.relations).toEqual(['publishes', 'event', 'dependsOn']);
    expect(cap.behaviors).toEqual([]);
    expect(cap.defaultBehavior).toBe('event');
  });

  it('queue → service: defaults to consumes, implies event behaviour with no picker', () => {
    const cap = capabilityFor('queue', 'service')!;
    expect(cap.defaultRelation).toBe('consumes');
    expect(cap.relations).toEqual(['consumes', 'event', 'dependsOn']);
    expect(cap.defaultBehavior).toBe('event');
  });

  it('queue → queue is ambiguous — no capability at all', () => {
    expect(capabilityFor('queue', 'queue')).toBeUndefined();
  });

  it('service → service: defaults to calls, exposes the full behaviour range minus event', () => {
    const cap = capabilityFor('service', 'service')!;
    expect(cap.defaultRelation).toBe('calls');
    expect(cap.relations).toEqual(['calls', 'http', 'command', 'query', 'event', 'dependsOn']);
    expect(cap.behaviors).toEqual(['sync', 'async', 'callback', 'conditional', 'retry', 'failure', 'fallback']);
    expect(cap.behaviors).not.toContain('event');
  });

  it('actor → service: defaults to calls, a small relation set, no behaviour picker', () => {
    const cap = capabilityFor('actor', 'service')!;
    expect(cap.defaultRelation).toBe('calls');
    expect(cap.relations).toEqual(['calls', 'http', 'command']);
    expect(cap.behaviors).toEqual([]);
  });

  it('service → external: like service-to-service, but relations include event', () => {
    const cap = capabilityFor('service', 'external')!;
    expect(cap.defaultRelation).toBe('calls');
    expect(cap.relations).toContain('event');
    expect(cap.behaviors).toEqual(['sync', 'async', 'callback', 'conditional', 'retry', 'failure', 'fallback']);
  });

  it('external falls back to being treated as a service for every other pairing', () => {
    expect(capabilityFor('external', 'database')).toEqual(capabilityFor('service', 'database'));
    expect(capabilityFor('database', 'external')).toEqual(capabilityFor('database', 'service'));
    expect(capabilityFor('external', 'queue')).toEqual(capabilityFor('service', 'queue'));
    expect(capabilityFor('queue', 'external')).toEqual(capabilityFor('queue', 'service'));
    expect(capabilityFor('actor', 'external')).toEqual(capabilityFor('actor', 'service'));
    expect(capabilityFor('external', 'external')).toEqual(capabilityFor('service', 'service'));
  });

  it('service → cache: defaults to writes, no query option (unlike a plain database)', () => {
    const cap = capabilityFor('service', 'cache')!;
    expect(cap.defaultRelation).toBe('writes');
    expect(cap.relations).toEqual(['writes', 'reads', 'dependsOn']);
    expect(cap.relations).not.toContain('query');
  });

  it('cache → service: defaults to reads, minimal relation set', () => {
    const cap = capabilityFor('cache', 'service')!;
    expect(cap.defaultRelation).toBe('reads');
    expect(cap.relations).toEqual(['reads', 'dependsOn']);
  });

  it('has no opinion about pairs the spec never described', () => {
    expect(capabilityFor('database', 'database')).toBeUndefined();
    expect(capabilityFor('actor', 'database')).toBeUndefined();
    expect(capabilityFor('generic', 'service')).toBeUndefined();
    expect(capabilityFor('service', 'generic')).toBeUndefined();
    expect(capabilityFor('generic', 'generic')).toBeUndefined();
  });
});

describe('inferRelationship — a thin wrapper over capabilityFor\'s default', () => {
  it('mirrors the matrix default for every documented pairing', () => {
    expect(inferRelationship({ type: 'service' }, { type: 'database' })).toEqual({ semantic: 'writes', kind: undefined });
    expect(inferRelationship({ type: 'database' }, { type: 'service' })).toEqual({ semantic: 'reads', kind: undefined });
    expect(inferRelationship({ type: 'service' }, { type: 'queue' })).toEqual({ semantic: 'publishes', kind: 'event' });
    expect(inferRelationship({ type: 'queue' }, { type: 'service' })).toEqual({ semantic: 'consumes', kind: 'event' });
    expect(inferRelationship({ type: 'service' }, { type: 'service' })).toEqual({ semantic: 'calls', kind: undefined });
    expect(inferRelationship({ type: 'actor' }, { type: 'service' })).toEqual({ semantic: 'calls', kind: undefined });
    expect(
      inferRelationship({ type: 'service' }, { type: 'service', serviceKind: 'external' }),
    ).toEqual({ semantic: 'calls', kind: undefined });
    expect(
      inferRelationship({ type: 'service' }, { type: 'database', databaseKind: 'cache' }),
    ).toEqual({ semantic: 'writes', kind: undefined });
    expect(
      inferRelationship({ type: 'database', databaseKind: 'cache' }, { type: 'service' }),
    ).toEqual({ semantic: 'reads', kind: undefined });
  });

  it('stays neutral for undocumented pairs and for queue → queue', () => {
    expect(inferRelationship({ type: 'queue' }, { type: 'queue' })).toBeUndefined();
    expect(inferRelationship({ type: 'actor' }, { type: 'note' })).toBeUndefined();
    expect(inferRelationship({ type: 'card' }, { type: 'card' })).toBeUndefined();
  });

  it('a topic and a stream infer exactly like a plain queue — Draft Canvas doesn\'t over-differentiate messaging kinds', () => {
    const service = createNode({ type: 'service', x: 0, y: 0 });
    const plainQueue = createNode({ type: 'queue', x: 0, y: 0 });
    const plain = inferRelationship(service, plainQueue);
    const reverse = inferRelationship(plainQueue, service);
    for (const queueKind of ['topic', 'stream'] as const) {
      const node = createNode({ type: 'queue', x: 0, y: 0, queueKind });
      expect(inferRelationship(service, node)).toEqual(plain);
      expect(inferRelationship(node, service)).toEqual(reverse);
    }
  });
});

describe('isEligibleForReinference', () => {
  it('is eligible for a genuinely untouched edge', () => {
    const edge = createEdge({ source: 'a', target: 'b' });
    expect(isEligibleForReinference(edge)).toBe(true);
  });

  it('is eligible for an edge explicitly marked inferred', () => {
    const edge = { ...createEdge({ source: 'a', target: 'b' }), semantic: 'publishes' as const, kind: 'event' as const, semanticsOrigin: 'inferred' as const };
    expect(isEligibleForReinference(edge)).toBe(true);
  });

  it('is not eligible once explicitly marked explicit', () => {
    const edge = { ...createEdge({ source: 'a', target: 'b' }), semantic: 'calls' as const, semanticsOrigin: 'explicit' as const };
    expect(isEligibleForReinference(edge)).toBe(false);
  });

  it('treats a legacy edge — a semantic with no origin marker — as explicit', () => {
    const edge = { ...createEdge({ source: 'a', target: 'b' }), semantic: 'writes' as const };
    expect(isEligibleForReinference(edge)).toBe(false);
  });

  it('treats a legacy edge with only a kind set the same way', () => {
    const edge = { ...createEdge({ source: 'a', target: 'b' }), kind: 'retry' as const };
    expect(isEligibleForReinference(edge)).toBe(false);
  });
});

describe('connect() — inference on a fresh connection, across the real node vocabulary', () => {
  const store = useEditorStore;

  beforeEach(() => {
    __resetInteraction();
    store.setState({
      document: createDocument('Semantics'),
      history: { past: [], future: [] },
      selection: { nodes: [], edges: [] },
      clipboard: null,
      revision: 0,
    });
  });

  function connect(sourceInput: Omit<CreateNodeInput, 'x' | 'y'>, targetInput: Omit<CreateNodeInput, 'x' | 'y'>) {
    const a = store.getState().addNode({ x: 0, y: 0, ...sourceInput });
    const b = store.getState().addNode({ x: 300, y: 0, ...targetInput });
    return store.getState().connect(a.id, b.id)!;
  }

  it('service → database infers writes', () => {
    const edge = connect({ type: 'service' }, { type: 'database' });
    expect(edge.semantic).toBe('writes');
    expect(edge.semanticsOrigin).toBe('inferred');
  });

  it('database → service infers reads', () => {
    const edge = connect({ type: 'database' }, { type: 'service' });
    expect(edge.semantic).toBe('reads');
  });

  it('service → queue infers publishes with event behaviour', () => {
    const edge = connect({ type: 'service' }, { type: 'queue' });
    expect(edge.semantic).toBe('publishes');
    expect(edge.kind).toBe('event');
  });

  it('queue → service infers consumes with event behaviour', () => {
    const edge = connect({ type: 'queue' }, { type: 'service' });
    expect(edge.semantic).toBe('consumes');
    expect(edge.kind).toBe('event');
  });

  it('service → service infers calls', () => {
    const edge = connect({ type: 'service' }, { type: 'service' });
    expect(edge.semantic).toBe('calls');
    expect(edge.kind).toBeUndefined();
  });

  it('actor → service infers calls', () => {
    const edge = connect({ type: 'actor' }, { type: 'service' });
    expect(edge.semantic).toBe('calls');
  });

  it('service → external service infers calls', () => {
    const edge = connect({ type: 'service' }, { type: 'service', serviceKind: 'external' });
    expect(edge.semantic).toBe('calls');
  });

  it('service → cache infers writes', () => {
    const edge = connect({ type: 'service' }, { type: 'database', databaseKind: 'cache' });
    expect(edge.semantic).toBe('writes');
  });

  it('cache → service infers reads', () => {
    const edge = connect({ type: 'database', databaseKind: 'cache' }, { type: 'service' });
    expect(edge.semantic).toBe('reads');
  });

  it('stays neutral for a pair the matrix has no opinion on', () => {
    const edge = connect({ type: 'actor' }, { type: 'note' });
    expect(edge.semantic).toBeUndefined();
    expect(edge.semanticsOrigin).toBeUndefined();
  });

  it('is one undo step, inference included', () => {
    const a = store.getState().addNode({ type: 'service', x: 0, y: 0 });
    const b = store.getState().addNode({ type: 'queue', x: 300, y: 0 });
    const before = store.getState().history.past.length;
    store.getState().connect(a.id, b.id);
    expect(store.getState().history.past).toHaveLength(before + 1);
  });
});

describe('reconnectEdge() — reclassifying an eligible connector when the topology changes', () => {
  const store = useEditorStore;

  beforeEach(() => {
    __resetInteraction();
    store.setState({
      document: createDocument('Semantics'),
      history: { past: [], future: [] },
      selection: { nodes: [], edges: [] },
      clipboard: null,
      revision: 0,
    });
  });

  it('a Service A → Service B call becomes a Service → Database write when retargeted', () => {
    const serviceA = store.getState().addNode({ type: 'service', x: 0, y: 0 });
    const serviceB = store.getState().addNode({ type: 'service', x: 300, y: 0 });
    const database = store.getState().addNode({ type: 'database', x: 600, y: 0 });
    const edge = store.getState().connect(serviceA.id, serviceB.id)!;
    expect(edge.semantic).toBe('calls');

    store.getState().reconnectEdge(edge.id, 'target', database.id, undefined);
    const stored = store.getState().document.edges[0]!;
    expect(stored.target).toBe(database.id);
    expect(stored.semantic).toBe('writes');
    expect(stored.kind).toBeUndefined();
    expect(stored.semanticsOrigin).toBe('inferred');
  });

  it('re-infers when reconnecting an inferred edge onto a new node type', () => {
    const service = store.getState().addNode({ type: 'service', x: 0, y: 0 });
    const queue = store.getState().addNode({ type: 'queue', x: 300, y: 0 });
    const otherService = store.getState().addNode({ type: 'service', x: 600, y: 0 });
    const edge = store.getState().connect(service.id, queue.id)!;
    expect(edge.semantic).toBe('publishes');

    store.getState().reconnectEdge(edge.id, 'target', otherService.id, undefined);
    const stored = store.getState().document.edges[0]!;
    expect(stored.target).toBe(otherService.id);
    expect(stored.semantic).toBe('calls');
    expect(stored.kind).toBeUndefined();
    expect(stored.semanticsOrigin).toBe('inferred');
  });

  it('clears a stale inferred semantic when the new pair has no inference', () => {
    const service = store.getState().addNode({ type: 'service', x: 0, y: 0 });
    const queue = store.getState().addNode({ type: 'queue', x: 300, y: 0 });
    const note = store.getState().addNode({ type: 'note', x: 600, y: 0 });
    const edge = store.getState().connect(service.id, queue.id)!;

    store.getState().reconnectEdge(edge.id, 'target', note.id, undefined);
    const stored = store.getState().document.edges[0]!;
    expect(stored.semantic).toBeUndefined();
    expect(stored.kind).toBeUndefined();
    expect(stored.semanticsOrigin).toBeUndefined();
  });

  it('never touches an explicitly-chosen semantic on reconnect — deliberate intent survives topology changes', () => {
    const service = store.getState().addNode({ type: 'service', x: 0, y: 0 });
    const queue = store.getState().addNode({ type: 'queue', x: 300, y: 0 });
    const database = store.getState().addNode({ type: 'database', x: 600, y: 0 });
    const edge = store.getState().connect(service.id, queue.id)!;
    store.getState().setEdgeSemantic(edge.id, 'http');
    expect(store.getState().document.edges[0]!.semanticsOrigin).toBe('explicit');

    store.getState().reconnectEdge(edge.id, 'target', database.id, undefined);
    const stored = store.getState().document.edges[0]!;
    expect(stored.semantic).toBe('http');
    expect(stored.semanticsOrigin).toBe('explicit');
  });

  it('never touches a legacy edge — semantic set with no origin marker — on reconnect', () => {
    const service = store.getState().addNode({ type: 'service', x: 0, y: 0 });
    const queue = store.getState().addNode({ type: 'queue', x: 300, y: 0 });
    const otherService = store.getState().addNode({ type: 'service', x: 600, y: 0 });
    const edge = store.getState().connect(service.id, queue.id)!;
    // Simulate a file saved before `semanticsOrigin` existed: a manually
    // picked semantic with no origin marker at all.
    store.setState({
      document: {
        ...store.getState().document,
        edges: store.getState().document.edges.map((e) =>
          e.id === edge.id ? { ...e, semantic: 'dependsOn' as const, kind: undefined, semanticsOrigin: undefined } : e,
        ),
      },
    });

    store.getState().reconnectEdge(edge.id, 'target', otherService.id, undefined);
    const stored = store.getState().document.edges[0]!;
    expect(stored.semantic).toBe('dependsOn');
    expect(stored.semanticsOrigin).toBeUndefined();
  });

  it('is one undo step, reclassification included', () => {
    const service = store.getState().addNode({ type: 'service', x: 0, y: 0 });
    const queue = store.getState().addNode({ type: 'queue', x: 300, y: 0 });
    const otherService = store.getState().addNode({ type: 'service', x: 600, y: 0 });
    const edge = store.getState().connect(service.id, queue.id)!;
    const before = store.getState().history.past.length;

    store.getState().reconnectEdge(edge.id, 'target', otherService.id, undefined);
    expect(store.getState().history.past).toHaveLength(before + 1);

    store.getState().undo();
    const reverted = store.getState().document.edges[0]!;
    expect(reverted.target).toBe(queue.id);
    expect(reverted.semantic).toBe('publishes');
  });
});

describe('persistence and legacy compatibility', () => {
  it('an edge with an uncommon combination round-trips through the document model untouched', () => {
    // A Database → Service edge with `publishes`/`event` — not a combination
    // the capability matrix would ever suggest, but a legacy or deliberately
    // unusual diagram may still contain it, and loading must never rewrite it.
    const edge = createEdge({
      source: 'a',
      target: 'b',
      semantic: 'publishes',
      kind: 'event',
      semanticsOrigin: 'explicit',
    });
    expect(edge.semantic).toBe('publishes');
    expect(edge.kind).toBe('event');
    expect(isEligibleForReinference(edge)).toBe(false);
  });
});
