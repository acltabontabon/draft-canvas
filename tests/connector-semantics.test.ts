import { beforeEach, describe, expect, it } from 'vitest';
import {
  capabilityFor,
  categoryOf,
  defaultsToResponse,
  inferredJunctionSemantic,
  inferRelationship,
  isEligibleForReinference,
  isSyncPairing,
  quickFixesFor,
  resolveTransparentCategory,
} from '../src/document/connectorSemantics';
import { createDocument, createEdge, createNode, type CreateNodeInput } from '../src/document/factory';
import { addEdges, addNodes } from '../src/document/operations';
import { deserializeDocument, serializeDocument } from '../src/export/project';
import { __resetInteraction, useEditorStore } from '../src/store/editorStore';

describe('categoryOf', () => {
  it('reads actor and queue straight from the node type', () => {
    expect(categoryOf({ type: 'actor' })).toBe('actor');
    expect(categoryOf({ type: 'queue' })).toBe('queue');
  });

  it('reads a topic queue as its own category, and a stream queue as plain queue', () => {
    expect(categoryOf({ type: 'queue', queueKind: 'topic' })).toBe('topic');
    expect(categoryOf({ type: 'queue', queueKind: 'stream' })).toBe('queue');
    expect(categoryOf({ type: 'queue', queueKind: 'queue' })).toBe('queue');
  });

  it('reads a plain service as service, an external one as external, and a worker as its own category', () => {
    expect(categoryOf({ type: 'service' })).toBe('service');
    expect(categoryOf({ type: 'service', serviceKind: 'generic' })).toBe('service');
    expect(categoryOf({ type: 'service', serviceKind: 'api' })).toBe('service');
    expect(categoryOf({ type: 'service', serviceKind: 'external' })).toBe('external');
    expect(categoryOf({ type: 'service', serviceKind: 'worker' })).toBe('worker');
  });

  it('reads Scheduler and Gateway as their own categories', () => {
    expect(categoryOf({ type: 'service', serviceKind: 'scheduler' })).toBe('scheduler');
    expect(categoryOf({ type: 'service', serviceKind: 'gateway' })).toBe('gateway');
  });

  it('reads a plain database as database, and a cache one as cache', () => {
    expect(categoryOf({ type: 'database' })).toBe('database');
    expect(categoryOf({ type: 'database', databaseKind: 'sql' })).toBe('database');
    expect(categoryOf({ type: 'database', databaseKind: 'nosql' })).toBe('database');
    expect(categoryOf({ type: 'database', databaseKind: 'cache' })).toBe('cache');
  });

  it('reads each new Data Store sub-kind as its own category', () => {
    expect(categoryOf({ type: 'database', databaseKind: 'file-system' })).toBe('fileSystem');
    expect(categoryOf({ type: 'database', databaseKind: 'object-storage' })).toBe('objectStorage');
    expect(categoryOf({ type: 'database', databaseKind: 'search-index' })).toBe('searchIndex');
  });

  it('reads ellipse (Junction) as its own category, not generic', () => {
    expect(categoryOf({ type: 'ellipse' })).toBe('junction');
  });

  it('reads every other node type as generic', () => {
    for (const type of ['text', 'note', 'code', 'group'] as const) {
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

  it('service → queue: defaults to publishes, offers command as a sharper alternative, implies event behaviour with no picker', () => {
    const cap = capabilityFor('service', 'queue')!;
    expect(cap.defaultRelation).toBe('publishes');
    expect(cap.relations).toEqual(['publishes', 'command', 'event', 'dependsOn']);
    expect(cap.behaviors).toEqual([]);
    expect(cap.defaultBehavior).toBe('event');
  });

  it('queue → service: defaults to consumes, offers deliversTo as an alternative, implies event behaviour with no picker', () => {
    const cap = capabilityFor('queue', 'service')!;
    expect(cap.defaultRelation).toBe('consumes');
    expect(cap.relations).toEqual(['consumes', 'deliversTo', 'event', 'dependsOn']);
    expect(cap.defaultBehavior).toBe('event');
  });

  it('queue → queue is ambiguous — no capability at all', () => {
    expect(capabilityFor('queue', 'queue')).toBeUndefined();
  });

  it('service → topic: defaults to publishes, same shape as service → queue', () => {
    const cap = capabilityFor('service', 'topic')!;
    expect(cap.defaultRelation).toBe('publishes');
    expect(cap.relations).toEqual(['publishes', 'event', 'dependsOn']);
    expect(cap.defaultBehavior).toBe('event');
    expect(cap.status).toBeUndefined();
  });

  it('topic → service: defaults to deliversTo, not consumes — a topic fans out rather than being pulled from', () => {
    const cap = capabilityFor('topic', 'service')!;
    expect(cap.defaultRelation).toBe('deliversTo');
    expect(cap.relations).toEqual(['deliversTo', 'consumes', 'dependsOn']);
    expect(cap.status).toBeUndefined();
  });

  it('topic → queue: defaults to fans out, a valid and common pub-sub shape', () => {
    const cap = capabilityFor('topic', 'queue')!;
    expect(cap.defaultRelation).toBe('fansOut');
    expect(cap.relations).toEqual(['fansOut', 'deliversTo', 'dependsOn']);
    expect(cap.status).toBeUndefined();
  });

  it('queue → topic: unusual, no default, offers a guidance message and an Insert Worker quick fix', () => {
    const cap = capabilityFor('queue', 'topic')!;
    expect(cap.defaultRelation).toBeUndefined();
    expect(cap.status).toBe('unusual');
    expect(cap.guidance).toMatch(/consumes it and forwards/);
    expect(cap.quickFix).toEqual({ id: 'insert-worker', label: 'Insert Worker' });
    // Not simply the inverse of topic → queue's relation list.
    expect(cap.relations).not.toContain('fansOut');
  });

  it('database → database: defaults to ingests, offers data-movement intents, no request/response shape', () => {
    const cap = capabilityFor('database', 'database')!;
    expect(cap.defaultRelation).toBe('ingests');
    expect(cap.relations).toEqual(['ingests', 'replicates', 'cdc', 'syncs', 'dependsOn']);
    expect(cap.status).toBeUndefined();
  });

  it('service → service: defaults to calls, exposes the full behaviour range minus event', () => {
    const cap = capabilityFor('service', 'service')!;
    expect(cap.defaultRelation).toBe('calls');
    expect(cap.relations).toEqual(['calls', 'http', 'grpc', 'command', 'query', 'event', 'dependsOn']);
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

  it('worker falls back to being treated as a service for every pairing without its own override', () => {
    expect(capabilityFor('worker', 'database')).toEqual(capabilityFor('service', 'database'));
    expect(capabilityFor('database', 'worker')).toEqual(capabilityFor('database', 'service'));
    expect(capabilityFor('queue', 'worker')).toEqual(capabilityFor('queue', 'service'));
    expect(capabilityFor('worker', 'queue')).toEqual(capabilityFor('service', 'queue'));
    expect(capabilityFor('actor', 'worker')).toEqual(capabilityFor('actor', 'service'));
    expect(capabilityFor('worker', 'worker')).toEqual(capabilityFor('service', 'service'));
  });

  it('scheduler → service/worker: defaults to triggers, distinct from a plain service call', () => {
    const toService = capabilityFor('scheduler', 'service')!;
    expect(toService.defaultRelation).toBe('triggers');
    expect(toService.relations).toEqual(['triggers', 'calls', 'dependsOn']);

    const toWorker = capabilityFor('scheduler', 'worker')!;
    expect(toWorker.defaultRelation).toBe('triggers');
    expect(toWorker.relations).toEqual(['triggers', 'calls', 'dependsOn']);
    // Worker also resolves away to `service` — without its own key, `scheduler>worker` would
    // otherwise collapse straight to `service>service`'s plain "calls" default.
    expect(toWorker.defaultRelation).not.toBe(capabilityFor('service', 'service')!.defaultRelation);
  });

  it('scheduler → queue/topic needs no matrix entry — it already falls through to the ordinary publish default', () => {
    expect(capabilityFor('scheduler', 'queue')).toEqual(capabilityFor('service', 'queue'));
    expect(capabilityFor('scheduler', 'topic')).toEqual(capabilityFor('service', 'topic'));
  });

  it('scheduler falls back to being treated as a service for every pairing without its own override', () => {
    expect(capabilityFor('scheduler', 'database')).toEqual(capabilityFor('service', 'database'));
    expect(capabilityFor('database', 'scheduler')).toEqual(capabilityFor('database', 'service'));
    expect(capabilityFor('actor', 'scheduler')).toEqual(capabilityFor('actor', 'service'));
  });

  it('gateway → service/gateway: defaults to routes, distinct from a plain service call', () => {
    const toService = capabilityFor('gateway', 'service')!;
    expect(toService.defaultRelation).toBe('routes');
    expect(toService.relations).toEqual(['routes', 'calls', 'dependsOn']);

    const toGateway = capabilityFor('gateway', 'gateway')!;
    expect(toGateway.defaultRelation).toBe('routes');
    expect(toGateway.relations).toEqual(['routes', 'calls', 'dependsOn']);
  });

  it('gateway routing to any storage kind is flagged unusual with guidance, and gets no default relation', () => {
    for (const target of ['database', 'cache', 'fileSystem', 'objectStorage', 'searchIndex'] as const) {
      const cap = capabilityFor('gateway', target)!;
      expect(cap.status).toBe('unusual');
      expect(cap.guidance).toBeTruthy();
      expect(cap.defaultRelation).toBeUndefined();
    }
  });

  it('gateway falls back to being treated as a service for every pairing without its own override', () => {
    expect(capabilityFor('actor', 'gateway')).toEqual(capabilityFor('actor', 'service'));
    expect(capabilityFor('gateway', 'queue')).toEqual(capabilityFor('service', 'queue'));
    expect(capabilityFor('queue', 'gateway')).toEqual(capabilityFor('queue', 'service'));
  });

  it('worker → search index is the one pairing where a Worker gets its own default: indexes, not searches', () => {
    const cap = capabilityFor('worker', 'searchIndex')!;
    expect(cap.defaultRelation).toBe('indexes');
    expect(cap.relations).toEqual(['searches', 'indexes', 'dependsOn']);
  });

  it('service → cache: defaults to writes, no query option (unlike a plain database), gains "invalidates"', () => {
    const cap = capabilityFor('service', 'cache')!;
    expect(cap.defaultRelation).toBe('writes');
    expect(cap.relations).toEqual(['writes', 'reads', 'invalidates', 'dependsOn']);
    expect(cap.relations).not.toContain('query');
  });

  it('cache → service: defaults to reads, minimal relation set', () => {
    const cap = capabilityFor('cache', 'service')!;
    expect(cap.defaultRelation).toBe('reads');
    expect(cap.relations).toEqual(['reads', 'dependsOn']);
  });

  it('service → file system: reads/writes/watches, no database-specific query', () => {
    const cap = capabilityFor('service', 'fileSystem')!;
    expect(cap.defaultRelation).toBe('writes');
    expect(cap.relations).toEqual(['reads', 'writes', 'watches', 'dependsOn']);
    expect(cap.relations).not.toContain('query');
  });

  it('file system → service: reads only, never behaves like an ordinary service call', () => {
    const cap = capabilityFor('fileSystem', 'service')!;
    expect(cap.defaultRelation).toBe('reads');
    expect(cap.relations).toEqual(['reads', 'dependsOn']);
    expect(cap.relations).not.toContain('calls');
  });

  it('service → object storage: reads/writes, the same vocabulary as the rest of the storage family', () => {
    const cap = capabilityFor('service', 'objectStorage')!;
    expect(cap.defaultRelation).toBe('writes');
    expect(cap.relations).toEqual(['reads', 'writes', 'dependsOn']);
  });

  it('object storage → service: reads only', () => {
    const cap = capabilityFor('objectStorage', 'service')!;
    expect(cap.defaultRelation).toBe('reads');
    expect(cap.relations).toEqual(['reads', 'dependsOn']);
  });

  it('object storage may notify a Queue or Topic — the one storage kind with a documented event exception', () => {
    for (const target of ['queue', 'topic'] as const) {
      const cap = capabilityFor('objectStorage', target)!;
      expect(cap.defaultRelation).toBe('publishes');
      expect(cap.defaultBehavior).toBe('event');
      expect(cap.relations).toEqual(['publishes', 'event', 'dependsOn']);
    }
    // Deliberately not extended to plain database/cache/fileSystem — this is Object Storage's own
    // documented exception, not "storage can publish events" in general.
    expect(capabilityFor('database', 'queue')).toBeUndefined();
    expect(capabilityFor('cache', 'queue')).toBeUndefined();
    expect(capabilityFor('fileSystem', 'queue')).toBeUndefined();
  });

  it('service → search index: searches and indexes, deliberately no redundant "reads"', () => {
    const cap = capabilityFor('service', 'searchIndex')!;
    expect(cap.defaultRelation).toBe('searches');
    expect(cap.relations).toEqual(['searches', 'indexes', 'dependsOn']);
    expect(cap.relations).not.toContain('reads');
  });

  it('search index → service has no opinion — sparse is correct here, unlike the other storage reverses', () => {
    expect(capabilityFor('searchIndex', 'service')).toBeUndefined();
  });

  it('has no opinion about pairs the spec never described', () => {
    expect(capabilityFor('actor', 'database')).toBeUndefined();
    expect(capabilityFor('generic', 'service')).toBeUndefined();
    expect(capabilityFor('service', 'generic')).toBeUndefined();
    expect(capabilityFor('generic', 'generic')).toBeUndefined();
  });

  it('a topic never falls back to a plain queue\'s entry for an unlisted pairing — same "no fallback" rule cache already follows', () => {
    expect(capabilityFor('topic', 'topic')).toBeUndefined();
    expect(capabilityFor('database', 'topic')).toBeUndefined();
    expect(capabilityFor('topic', 'database')).toBeUndefined();
  });

  it('the new storage sub-kinds never fall back to a plain database\'s entry for an unlisted pairing', () => {
    expect(capabilityFor('fileSystem', 'database')).toBeUndefined();
    expect(capabilityFor('objectStorage', 'fileSystem')).toBeUndefined();
    expect(capabilityFor('searchIndex', 'cache')).toBeUndefined();
  });
});

describe('isSyncPairing — which pairings a request/response can attach to', () => {
  it('is true for the ambiguous call pairings, where sync is a real choice', () => {
    expect(isSyncPairing('service', 'service')).toBe(true);
    expect(isSyncPairing('service', 'external')).toBe(true);
  });

  it('is true for actor → service, predetermined-and-sync with no other option', () => {
    expect(isSyncPairing('actor', 'service')).toBe(true);
  });

  it('is true for a Worker on either end, via the same fallback-to-service treatment as external', () => {
    expect(isSyncPairing('worker', 'service')).toBe(true);
    expect(isSyncPairing('service', 'worker')).toBe(true);
    expect(isSyncPairing('worker', 'worker')).toBe(true);
  });

  it('is false for pairings predetermined to something other than sync', () => {
    expect(isSyncPairing('service', 'queue')).toBe(false);
    expect(isSyncPairing('queue', 'service')).toBe(false);
  });

  it('is false for pairings with no meaningful behaviour choice at all', () => {
    expect(isSyncPairing('service', 'database')).toBe(false);
    expect(isSyncPairing('database', 'service')).toBe(false);
    expect(isSyncPairing('service', 'cache')).toBe(false);
    expect(isSyncPairing('cache', 'service')).toBe(false);
  });

  it('is false for a pair the matrix has no opinion on', () => {
    expect(isSyncPairing('queue', 'queue')).toBe(false);
    expect(isSyncPairing('generic', 'generic')).toBe(false);
  });

  it('is false for database → database and every topic/queue pairing — none of them are a plain synchronous call', () => {
    expect(isSyncPairing('database', 'database')).toBe(false);
    expect(isSyncPairing('service', 'topic')).toBe(false);
    expect(isSyncPairing('topic', 'service')).toBe(false);
    expect(isSyncPairing('topic', 'queue')).toBe(false);
    expect(isSyncPairing('queue', 'topic')).toBe(false);
  });

  it('is false for Scheduler and Gateway — their defaults are triggers/routes, not calls', () => {
    expect(isSyncPairing('scheduler', 'worker')).toBe(false);
    expect(isSyncPairing('gateway', 'service')).toBe(false);
  });

  it('is false for Component → Component — its exact matrix row defaults to "uses", not "calls"', () => {
    expect(isSyncPairing('component', 'component')).toBe(false);
  });
});

describe('defaultsToResponse — which pairings the reply line is offered for', () => {
  it('is true for two service-shaped boxes talking to each other', () => {
    expect(defaultsToResponse('service', 'service')).toBe(true);
    expect(defaultsToResponse('worker', 'external')).toBe(true);
  });

  it('is false for Scheduler even though it folds to service like Worker/External/Gateway do — a schedule firing is fire-and-forget', () => {
    expect(defaultsToResponse('scheduler', 'worker')).toBe(false);
    expect(defaultsToResponse('scheduler', 'service')).toBe(false);
  });

  it('is true for Gateway → service — a reverse proxy genuinely forwards a request and returns the response', () => {
    expect(defaultsToResponse('gateway', 'service')).toBe(true);
  });

  it('is false for a person initiating a call, and for anything not service-shaped', () => {
    expect(defaultsToResponse('actor', 'service')).toBe(false);
    expect(defaultsToResponse('service', 'database')).toBe(false);
  });

  it('is false for Component → Component even though it resolves to service→service elsewhere — "uses" has no reply to default on', () => {
    expect(defaultsToResponse('component', 'component')).toBe(false);
  });

  it('no longer turns the reply line on by itself — it only decides who is offered it', () => {
    // The predicate still gates `EdgeInspectorPopover`'s Request/Response
    // section, but `connect()` stopped acting on it: at the altitude an
    // architecture diagram works at, the return path is implied, and drawing
    // it unasked doubles the lines on the busiest kind of diagram.
    const store = useEditorStore;
    __resetInteraction();
    store.setState({
      document: createDocument('Response default'),
      history: { past: [], future: [] },
      selection: { nodes: [], edges: [] },
      clipboard: null,
      revision: 0,
    });
    const a = store.getState().addNode({ type: 'service', x: 0, y: 0 });
    const b = store.getState().addNode({ type: 'service', x: 300, y: 0 });
    const edge = store.getState().connect(a.id, b.id)!;

    expect(defaultsToResponse('service', 'service')).toBe(true);
    expect(edge.hasResponse).toBeUndefined();
  });

  it('keeps a reply line the user explicitly asked for across a reverse', () => {
    const store = useEditorStore;
    __resetInteraction();
    store.setState({
      document: createDocument('Response kept'),
      history: { past: [], future: [] },
      selection: { nodes: [], edges: [] },
      clipboard: null,
      revision: 0,
    });
    const a = store.getState().addNode({ type: 'service', x: 0, y: 0 });
    const b = store.getState().addNode({ type: 'service', x: 300, y: 0 });
    const edge = store.getState().connect(a.id, b.id)!;
    // Deliberately *not* via `setEdgeHasResponse`, which stamps
    // `semanticsOrigin: 'explicit'` and makes the edge ineligible for
    // re-inference entirely — that would exercise the guard rather than the
    // patch. This is the shape a document saved before this change comes back
    // as: a reply line present on a still-inferred connector.
    store.getState().updateEdgeById(edge.id, { hasResponse: true });
    expect(store.getState().document.edges[0]!.semanticsOrigin).toBe('inferred');

    store.getState().reverseEdge(edge.id);
    // Re-inference must not name `hasResponse` in its patch at all: `applyPatch`
    // deletes keys whose value is undefined, so naming it would silently drop
    // the reply line every time a connector was reversed or re-pointed.
    expect(store.getState().document.edges[0]!.hasResponse).toBe(true);
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
    expect(inferRelationship({ type: 'text' }, { type: 'text' })).toBeUndefined();
  });

  it('a stream infers exactly like a plain queue — Draft Canvas doesn\'t differentiate that kind', () => {
    const service = createNode({ type: 'service', x: 0, y: 0 });
    const plainQueue = createNode({ type: 'queue', x: 0, y: 0 });
    const stream = createNode({ type: 'queue', x: 0, y: 0, queueKind: 'stream' });
    expect(inferRelationship(service, stream)).toEqual(inferRelationship(service, plainQueue));
    expect(inferRelationship(stream, service)).toEqual(inferRelationship(plainQueue, service));
  });

  it('a topic matches a plain queue publishing into it, but diverges reading out of it — a topic delivers, it isn\'t consumed by one puller', () => {
    const service = createNode({ type: 'service', x: 0, y: 0 });
    const topic = createNode({ type: 'queue', x: 0, y: 0, queueKind: 'topic' });
    const plainQueue = createNode({ type: 'queue', x: 0, y: 0 });
    expect(inferRelationship(service, topic)).toEqual(inferRelationship(service, plainQueue));
    expect(inferRelationship(topic, service)).toEqual({ semantic: 'deliversTo', kind: 'event' });
    expect(inferRelationship(topic, service)).not.toEqual(inferRelationship(plainQueue, service));
  });

  it('a topic publishing into a queue infers fan-out; a queue into a topic stays neutral (no default)', () => {
    const topic = createNode({ type: 'queue', x: 0, y: 0, queueKind: 'topic' });
    const plainQueue = createNode({ type: 'queue', x: 0, y: 0 });
    expect(inferRelationship(topic, plainQueue)).toEqual({ semantic: 'fansOut', kind: 'event' });
    expect(inferRelationship(plainQueue, topic)).toBeUndefined();
  });

  it('database → database infers ingests', () => {
    const a = createNode({ type: 'database', x: 0, y: 0 });
    const b = createNode({ type: 'database', x: 0, y: 0 });
    expect(inferRelationship(a, b)).toEqual({ semantic: 'ingests', kind: undefined });
  });

  it('component → component infers uses, not calls — regardless of componentKind on either side', () => {
    const generic = createNode({ type: 'component', x: 0, y: 0 });
    const adapter = createNode({ type: 'component', x: 0, y: 0, componentKind: 'adapter' });
    expect(inferRelationship(generic, generic)).toEqual({ semantic: 'uses', kind: undefined });
    expect(inferRelationship(generic, adapter)).toEqual({ semantic: 'uses', kind: undefined });
    expect(inferRelationship(adapter, generic)).toEqual({ semantic: 'uses', kind: undefined });
  });

  it('component → database still infers writes, exactly like service → database — only component → component is the exception', () => {
    const component = createNode({ type: 'component', x: 0, y: 0 });
    const database = createNode({ type: 'database', x: 0, y: 0 });
    expect(inferRelationship(component, database)).toEqual({ semantic: 'writes', kind: undefined });
  });
});

/**
 * The representative architecture pairings from the Service family redesign spec (§28) —
 * `inferRelationship`-level, so this exercises the same path a real `connect()` call takes, not
 * just `capabilityFor` in isolation. Most of these are deliberately *not* new matrix rows — the
 * point of the test is confirming the existing fallback machinery already gives sensible
 * architectural vocabulary for External/Worker/API once Scheduler/Gateway exist alongside them.
 */
describe('inferRelationship — Service family redesign test matrix (spec §28)', () => {
  const service = (serviceKind?: CreateNodeInput['serviceKind']) =>
    createNode({ type: 'service', x: 0, y: 0, serviceKind });
  const database = (databaseKind?: CreateNodeInput['databaseKind']) =>
    createNode({ type: 'database', x: 0, y: 0, databaseKind });
  const queue = (queueKind?: CreateNodeInput['queueKind']) => createNode({ type: 'queue', x: 0, y: 0, queueKind });

  it('External ↔ Gateway/API: calls both ways, exactly like any other service pairing', () => {
    expect(inferRelationship(service('external'), service('gateway'))).toEqual({ semantic: 'calls', kind: undefined });
    expect(inferRelationship(service('external'), service('api'))).toEqual({ semantic: 'calls', kind: undefined });
    expect(inferRelationship(service('api'), service('external'))).toEqual({ semantic: 'calls', kind: undefined });
  });

  it('Gateway → API: routes, not calls', () => {
    expect(inferRelationship(service('gateway'), service('api'))).toEqual({ semantic: 'routes', kind: undefined });
  });

  it('API → API: calls, exactly the plain service default', () => {
    expect(inferRelationship(service('api'), service('api'))).toEqual({ semantic: 'calls', kind: undefined });
  });

  it('API → storage: reads/writes/query per storage subtype, same as any other Service', () => {
    expect(inferRelationship(service('api'), database('sql'))).toEqual({ semantic: 'writes', kind: undefined });
    expect(inferRelationship(service('api'), database('cache'))).toEqual({ semantic: 'writes', kind: undefined });
    expect(inferRelationship(service('api'), database('object-storage'))).toEqual({ semantic: 'writes', kind: undefined });
  });

  it('Worker ↔ Queue/Topic: consumes/publishes both ways, exactly the plain service defaults', () => {
    expect(inferRelationship(service('worker'), queue())).toEqual({ semantic: 'publishes', kind: 'event' });
    expect(inferRelationship(queue(), service('worker'))).toEqual({ semantic: 'consumes', kind: 'event' });
    expect(inferRelationship(service('worker'), queue('topic'))).toEqual({ semantic: 'publishes', kind: 'event' });
    expect(inferRelationship(queue('topic'), service('worker'))).toEqual({ semantic: 'deliversTo', kind: 'event' });
  });

  it('Worker → storage: writes/reads/watches per storage subtype', () => {
    expect(inferRelationship(service('worker'), database('sql'))).toEqual({ semantic: 'writes', kind: undefined });
    expect(inferRelationship(service('worker'), database('cache'))).toEqual({ semantic: 'writes', kind: undefined });
    expect(inferRelationship(service('worker'), database('file-system'))).toEqual({ semantic: 'writes', kind: undefined });
    expect(inferRelationship(service('worker'), database('object-storage'))).toEqual({ semantic: 'writes', kind: undefined });
  });

  it('Worker → Search Index is the one storage pairing where Worker itself changes the default: indexes, not searches', () => {
    expect(inferRelationship(service('worker'), database('search-index'))).toEqual({ semantic: 'indexes', kind: undefined });
    expect(inferRelationship(service('api'), database('search-index'))).toEqual({ semantic: 'searches', kind: undefined });
  });

  it('Scheduler → Worker/API: triggers; Scheduler → Queue/Topic: publishes', () => {
    expect(inferRelationship(service('scheduler'), service('worker'))).toEqual({ semantic: 'triggers', kind: undefined });
    expect(inferRelationship(service('scheduler'), service('api'))).toEqual({ semantic: 'triggers', kind: undefined });
    expect(inferRelationship(service('scheduler'), queue())).toEqual({ semantic: 'publishes', kind: 'event' });
    expect(inferRelationship(service('scheduler'), queue('topic'))).toEqual({ semantic: 'publishes', kind: 'event' });
  });

  it('Gateway → Data Store: has an opinion (unusual, no default) rather than no opinion at all', () => {
    expect(inferRelationship(service('gateway'), database())).toBeUndefined();
    expect(capabilityFor('gateway', 'database')!.status).toBe('unusual');
  });

  it('External → Queue/Topic/Object Storage: may publish/upload, exactly the plain service defaults', () => {
    expect(inferRelationship(service('external'), queue())).toEqual({ semantic: 'publishes', kind: 'event' });
    expect(inferRelationship(service('external'), queue('topic'))).toEqual({ semantic: 'publishes', kind: 'event' });
    expect(inferRelationship(service('external'), database('object-storage'))).toEqual({ semantic: 'writes', kind: undefined });
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

describe('quickFixesFor', () => {
  it('is empty when there is no capability at all', () => {
    expect(quickFixesFor(undefined, { semantic: 'writes' })).toEqual([]);
  });

  it('is empty for a valid pairing whose edge already matches (or has no) semantic', () => {
    const cap = capabilityFor('service', 'database');
    expect(quickFixesFor(cap, { semantic: 'writes' })).toEqual([]);
    expect(quickFixesFor(cap, { semantic: undefined })).toEqual([]);
  });

  it('surfaces the matrix-level Insert Worker fix for queue → topic regardless of the edge\'s own semantic', () => {
    const cap = capabilityFor('queue', 'topic');
    expect(quickFixesFor(cap, { semantic: undefined })).toEqual([{ id: 'insert-worker', label: 'Insert Worker' }]);
  });

  it('offers a retarget fix when the edge\'s explicit semantic no longer fits its (re-pointed) endpoints', () => {
    // The exact "Service → Database writes, re-pointed to a Topic" scenario from the spec.
    const cap = capabilityFor('service', 'topic');
    const fixes = quickFixesFor(cap, { semantic: 'writes' });
    expect(fixes).toEqual([{ id: 'retarget-relation', label: 'Use "publishes" instead', semantic: 'publishes' }]);
  });

  it('queue → topic never adds a retarget fix on top of Insert Worker — there is no default to retarget to', () => {
    const cap = capabilityFor('queue', 'topic');
    // 'writes' isn't in queue → topic's relation list either, but with no `defaultRelation` there's
    // nothing sensible to suggest retargeting to — only the static Insert Worker fix shows.
    const fixes = quickFixesFor(cap, { semantic: 'writes' });
    expect(fixes).toEqual([{ id: 'insert-worker', label: 'Insert Worker' }]);
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

  it('service → topic infers publishes', () => {
    const edge = connect({ type: 'service' }, { type: 'queue', queueKind: 'topic' });
    expect(edge.semantic).toBe('publishes');
    expect(edge.kind).toBe('event');
  });

  it('topic → service infers deliversTo', () => {
    const edge = connect({ type: 'queue', queueKind: 'topic' }, { type: 'service' });
    expect(edge.semantic).toBe('deliversTo');
  });

  it('topic → queue infers fans out', () => {
    const edge = connect({ type: 'queue', queueKind: 'topic' }, { type: 'queue' });
    expect(edge.semantic).toBe('fansOut');
  });

  it('queue → topic stays neutral — drawable, but nothing auto-infers into it', () => {
    const edge = connect({ type: 'queue' }, { type: 'queue', queueKind: 'topic' });
    expect(edge.semantic).toBeUndefined();
    expect(edge.semanticsOrigin).toBeUndefined();
  });

  it('database → database infers ingests', () => {
    const edge = connect({ type: 'database' }, { type: 'database' });
    expect(edge.semantic).toBe('ingests');
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

  it('a Service → Database "writes" re-infers to "publishes" when the database is re-pointed to a Topic', () => {
    const service = store.getState().addNode({ type: 'service', x: 0, y: 0 });
    const database = store.getState().addNode({ type: 'database', x: 300, y: 0 });
    const topic = store.getState().addNode({ type: 'queue', queueKind: 'topic', x: 600, y: 0 });
    const edge = store.getState().connect(service.id, database.id)!;
    expect(edge.semantic).toBe('writes');

    store.getState().reconnectEdge(edge.id, 'target', topic.id, undefined);
    const stored = store.getState().document.edges[0]!;
    expect(stored.target).toBe(topic.id);
    expect(stored.semantic).toBe('publishes');
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

describe('updateNodeById() — reclassifying incident edges when a node\'s subtype changes', () => {
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

  it('re-labels an inferred edge when the source node\'s serviceKind changes to Scheduler', () => {
    const genericService = store.getState().addNode({ type: 'service', x: 0, y: 0 });
    const worker = store.getState().addNode({ type: 'service', serviceKind: 'worker', x: 300, y: 0 });
    const edge = store.getState().connect(genericService.id, worker.id)!;
    expect(edge.semantic).toBe('calls');

    store.getState().updateNodeById(genericService.id, { serviceKind: 'scheduler' });
    const stored = store.getState().document.edges[0]!;
    expect(stored.semantic).toBe('triggers');
    expect(stored.semanticsOrigin).toBe('inferred');
  });

  it('does not touch an edge with an explicitly-chosen semantic when the node\'s subtype changes', () => {
    const genericService = store.getState().addNode({ type: 'service', x: 0, y: 0 });
    const worker = store.getState().addNode({ type: 'service', serviceKind: 'worker', x: 300, y: 0 });
    const edge = store.getState().connect(genericService.id, worker.id)!;
    store.getState().setEdgeSemantic(edge.id, 'http');
    expect(store.getState().document.edges[0]!.semanticsOrigin).toBe('explicit');

    store.getState().updateNodeById(genericService.id, { serviceKind: 'scheduler' });
    const stored = store.getState().document.edges[0]!;
    expect(stored.semantic).toBe('http');
    expect(stored.semanticsOrigin).toBe('explicit');
  });

  it('leaves incident edges alone when the patch touches an unrelated field', () => {
    const genericService = store.getState().addNode({ type: 'service', x: 0, y: 0 });
    const worker = store.getState().addNode({ type: 'service', serviceKind: 'worker', x: 300, y: 0 });
    const edge = store.getState().connect(genericService.id, worker.id)!;
    expect(edge.semantic).toBe('calls');

    store.getState().updateNodeById(genericService.id, { text: 'Renamed' });
    const stored = store.getState().document.edges[0]!;
    expect(stored.semantic).toBe('calls');
  });
});

describe('updateNodeById() — a Service\'s auto-generated label follows its subtype', () => {
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

  function node(id: string) {
    return store.getState().document.nodes.find((n) => n.id === id)!;
  }

  it('relabels a still-auto node through a full chain of subtype changes', () => {
    const service = store.getState().addNode({ type: 'service', x: 0, y: 0 });
    expect(node(service.id).text).toBe('Service');

    store.getState().updateNodeById(service.id, { serviceKind: 'api' });
    expect(node(service.id).text).toBe('API');

    store.getState().updateNodeById(service.id, { serviceKind: 'worker' });
    expect(node(service.id).text).toBe('Worker');

    store.getState().updateNodeById(service.id, { serviceKind: 'gateway' });
    expect(node(service.id).text).toBe('Gateway');

    store.getState().updateNodeById(service.id, { serviceKind: 'external' });
    expect(node(service.id).text).toBe('External System');

    store.getState().updateNodeById(service.id, { serviceKind: 'generic' });
    expect(node(service.id).text).toBe('Service');
  });

  it('never overwrites a name the user typed — an explicit rename survives every later subtype change', () => {
    const service = store.getState().addNode({ type: 'service', x: 0, y: 0, serviceKind: 'api' });
    expect(node(service.id).text).toBe('API');

    store.getState().updateNodeText(service.id, 'Payments');
    expect(node(service.id).textOrigin).toBe('explicit');

    store.getState().updateNodeById(service.id, { serviceKind: 'worker' });
    expect(node(service.id).text).toBe('Payments');

    store.getState().updateNodeById(service.id, { serviceKind: 'gateway' });
    expect(node(service.id).text).toBe('Payments');
  });

  it('never overwrites a name explicitly supplied at creation, even before any rename', () => {
    const service = store.getState().addNode({ type: 'service', x: 0, y: 0, serviceKind: 'api', text: 'Payments API' });
    store.getState().updateNodeById(service.id, { serviceKind: 'worker' });
    expect(node(service.id).text).toBe('Payments API');
  });

  it('an unrelated patch (no serviceKind) never touches the label', () => {
    const service = store.getState().addNode({ type: 'service', x: 0, y: 0 });
    store.getState().updateNodeById(service.id, { accent: 'violet' });
    expect(node(service.id).text).toBe('Service');
  });

  it('undo restores both the label and its origin marker together with the subtype change', () => {
    const service = store.getState().addNode({ type: 'service', x: 0, y: 0 });
    store.getState().updateNodeById(service.id, { serviceKind: 'api' });
    expect(node(service.id).text).toBe('API');

    store.getState().undo();
    expect(node(service.id).text).toBe('Service');
    expect(node(service.id).serviceKind).toBe('generic');

    store.getState().redo();
    expect(node(service.id).text).toBe('API');
    expect(node(service.id).serviceKind).toBe('api');
  });

  it('undo restores an explicit rename\'s protection after a later subtype change is undone', () => {
    const service = store.getState().addNode({ type: 'service', x: 0, y: 0, serviceKind: 'api' });
    store.getState().updateNodeText(service.id, 'Payments');
    store.getState().updateNodeById(service.id, { serviceKind: 'worker' });
    expect(node(service.id).text).toBe('Payments');

    store.getState().undo();
    expect(node(service.id).text).toBe('Payments');
    expect(node(service.id).serviceKind).toBe('api');
    expect(node(service.id).textOrigin).toBe('explicit');
  });

  it('round-trips through export/import without losing textOrigin or the followed label', () => {
    const service = store.getState().addNode({ type: 'service', x: 0, y: 0 });
    store.getState().updateNodeById(service.id, { serviceKind: 'gateway' });
    expect(node(service.id).text).toBe('Gateway');

    const serialized = serializeDocument(store.getState().document);
    const result = deserializeDocument(serialized);
    if (!result.ok) throw new Error(result.error);
    const reloaded = result.document;
    const reloadedNode = reloaded.nodes.find((n) => n.id === service.id)!;
    expect(reloadedNode.text).toBe('Gateway');
    expect(reloadedNode.textOrigin).toBe('auto');

    // And the reloaded node still follows a further subtype change.
    store.setState({ document: reloaded, history: { past: [], future: [] } });
    store.getState().updateNodeById(service.id, { serviceKind: 'scheduler' });
    expect(node(service.id).text).toBe('Scheduler');
  });

  it('a legacy node with no textOrigin marker at all is never auto-relabeled', () => {
    const service = store.getState().addNode({ type: 'service', x: 0, y: 0, serviceKind: 'api' });
    // Simulate a document saved before `textOrigin` existed: a real label with no origin marker.
    store.setState({
      document: {
        ...store.getState().document,
        nodes: store.getState().document.nodes.map((n) =>
          n.id === service.id ? { ...n, text: 'API', textOrigin: undefined } : n,
        ),
      },
    });
    store.getState().updateNodeById(service.id, { serviceKind: 'worker' });
    expect(node(service.id).text).toBe('API');
  });
});

describe('insertWorkerOnEdge() — the "Insert Worker" quick fix', () => {
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

  function setUpQueueToTopic() {
    const queue = store.getState().addNode({ type: 'queue', x: 0, y: 0 });
    const topic = store.getState().addNode({ type: 'queue', queueKind: 'topic', x: 400, y: 0 });
    // A fresh queue → topic connect() infers nothing (no default), so build the edge directly to
    // exercise the quick fix independent of that.
    const edge = store.getState().connect(queue.id, topic.id)!;
    return { queue, topic, edge };
  }

  it('replaces the one edge with a Worker node and two correctly-inferred edges', () => {
    const { queue, topic, edge } = setUpQueueToTopic();

    store.getState().insertWorkerOnEdge(edge.id);
    const doc = store.getState().document;

    expect(doc.edges.find((e) => e.id === edge.id)).toBeUndefined();
    expect(doc.edges).toHaveLength(2);
    const toWorker = doc.edges.find((e) => e.source === queue.id)!;
    const fromWorker = doc.edges.find((e) => e.target === topic.id)!;
    expect(toWorker.target).toBe(fromWorker.source);
    expect(toWorker.semantic).toBe('consumes');
    expect(fromWorker.semantic).toBe('publishes');

    const worker = doc.nodes.find((n) => n.id === toWorker.target)!;
    expect(worker.type).toBe('service');
    expect(worker.serviceKind).toBe('worker');
  });

  it('positions the worker between the two original endpoints', () => {
    const { queue, topic, edge } = setUpQueueToTopic();
    store.getState().insertWorkerOnEdge(edge.id);
    const doc = store.getState().document;
    const worker = doc.nodes.find((n) => n.type === 'service')!;
    expect(worker.x).toBeGreaterThan(queue.x);
    expect(worker.x).toBeLessThan(topic.x);
  });

  it('is one undo step — undo restores the original single connector', () => {
    const { edge } = setUpQueueToTopic();
    const before = store.getState().history.past.length;

    store.getState().insertWorkerOnEdge(edge.id);
    expect(store.getState().history.past).toHaveLength(before + 1);
    expect(store.getState().document.nodes).toHaveLength(3);

    store.getState().undo();
    const doc = store.getState().document;
    expect(doc.nodes).toHaveLength(2);
    expect(doc.edges).toEqual([edge]);
  });

  it('is a no-op for an edge id that no longer resolves', () => {
    setUpQueueToTopic();
    const before = store.getState().document;
    store.getState().insertWorkerOnEdge('not-a-real-edge-id');
    expect(store.getState().document).toBe(before);
  });
});

describe('reverseEdge() — reclassifying an eligible connector after a direction swap', () => {
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

  it('a Service → Database "writes" becomes Database → Service "reads" once reversed', () => {
    const service = store.getState().addNode({ type: 'service', x: 0, y: 0 });
    const database = store.getState().addNode({ type: 'database', x: 300, y: 0 });
    const edge = store.getState().connect(service.id, database.id)!;
    expect(edge.semantic).toBe('writes');

    store.getState().reverseEdge(edge.id);
    const stored = store.getState().document.edges[0]!;
    expect(stored.source).toBe(database.id);
    expect(stored.target).toBe(service.id);
    expect(stored.semantic).toBe('reads');
    expect(stored.semanticsOrigin).toBe('inferred');
  });

  it('clears a stale inferred semantic when the reversed pair has no inference', () => {
    const actor = store.getState().addNode({ type: 'actor', x: 0, y: 0 });
    const service = store.getState().addNode({ type: 'service', x: 300, y: 0 });
    const edge = store.getState().connect(actor.id, service.id)!;
    expect(edge.semantic).toBe('calls'); // actor>service has an opinion; service>actor does not

    store.getState().reverseEdge(edge.id);
    const stored = store.getState().document.edges[0]!;
    expect(stored.source).toBe(service.id);
    expect(stored.target).toBe(actor.id);
    expect(stored.semantic).toBeUndefined();
    expect(stored.kind).toBeUndefined();
    expect(stored.semanticsOrigin).toBeUndefined();
  });

  it('never touches an explicitly-chosen semantic on reverse — deliberate intent survives a direction swap', () => {
    const service = store.getState().addNode({ type: 'service', x: 0, y: 0 });
    const database = store.getState().addNode({ type: 'database', x: 300, y: 0 });
    const edge = store.getState().connect(service.id, database.id)!;
    store.getState().setEdgeSemantic(edge.id, 'http');
    expect(store.getState().document.edges[0]!.semanticsOrigin).toBe('explicit');

    store.getState().reverseEdge(edge.id);
    const stored = store.getState().document.edges[0]!;
    expect(stored.source).toBe(database.id);
    expect(stored.semantic).toBe('http');
    expect(stored.semanticsOrigin).toBe('explicit');
  });

  it('never touches a legacy edge — semantic set with no origin marker — on reverse', () => {
    const service = store.getState().addNode({ type: 'service', x: 0, y: 0 });
    const database = store.getState().addNode({ type: 'database', x: 300, y: 0 });
    const edge = store.getState().connect(service.id, database.id)!;
    store.setState({
      document: {
        ...store.getState().document,
        edges: store.getState().document.edges.map((e) =>
          e.id === edge.id ? { ...e, semantic: 'dependsOn' as const, kind: undefined, semanticsOrigin: undefined } : e,
        ),
      },
    });

    store.getState().reverseEdge(edge.id);
    const stored = store.getState().document.edges[0]!;
    expect(stored.semantic).toBe('dependsOn');
    expect(stored.semanticsOrigin).toBeUndefined();
  });

  it('degrades safely (no crash, no stale value) when reversing dead-ends the junction\'s own transparency', () => {
    const service = store.getState().addNode({ type: 'service', x: 0, y: 0 });
    const junction = store.getState().addNode({ type: 'ellipse', x: 300, y: 0 });
    const database = store.getState().addNode({ type: 'database', x: 600, y: 0 });
    store.getState().connect(service.id, junction.id);
    const edge = store.getState().connect(junction.id, database.id)!;
    expect(edge.semantic).toBe('writes'); // service resolves transparently through the junction

    // Reversing junction→database leaves the junction with two *incoming* edges (from the service,
    // and now from the database too) and none outgoing — genuinely ambiguous as a source, the same
    // "no signal" case `resolveTransparentCategory` already returns `'junction'`/no-opinion for on
    // a fresh connect. The correct outcome is a clean `undefined`, not a stale carried-over value.
    store.getState().reverseEdge(edge.id);
    const stored = store.getState().document.edges.find((e) => e.id === edge.id)!;
    expect(stored.source).toBe(database.id);
    expect(stored.target).toBe(junction.id);
    expect(stored.semantic).toBeUndefined();
    expect(stored.semanticsOrigin).toBeUndefined();
  });

  it('is one undo step, reclassification included', () => {
    const service = store.getState().addNode({ type: 'service', x: 0, y: 0 });
    const database = store.getState().addNode({ type: 'database', x: 300, y: 0 });
    const edge = store.getState().connect(service.id, database.id)!;
    const before = store.getState().history.past.length;

    store.getState().reverseEdge(edge.id);
    expect(store.getState().history.past).toHaveLength(before + 1);

    store.getState().undo();
    const reverted = store.getState().document.edges[0]!;
    expect(reverted.source).toBe(service.id);
    expect(reverted.semantic).toBe('writes');
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

describe('resolveTransparentCategory — seeing through a Junction', () => {
  it('a non-Junction node resolves to its own category regardless of role', () => {
    const service = createNode({ type: 'service', x: 0, y: 0 });
    const g = { nodes: [service], edges: [] };
    expect(resolveTransparentCategory(g, service.id, 'source')).toBe('service');
    expect(resolveTransparentCategory(g, service.id, 'target')).toBe('service');
  });

  it('resolves a Junction as "source" to the single category feeding it', () => {
    const service = createNode({ type: 'service', x: 0, y: 0 });
    const junction = createNode({ type: 'ellipse', x: 200, y: 0 });
    const g = { nodes: [service, junction], edges: [createEdge({ source: service.id, target: junction.id })] };
    expect(resolveTransparentCategory(g, junction.id, 'source')).toBe('service');
  });

  it('resolves a Junction as "target" to the single category it feeds', () => {
    const junction = createNode({ type: 'ellipse', x: 0, y: 0 });
    const queue = createNode({ type: 'queue', x: 200, y: 0 });
    const g = { nodes: [junction, queue], edges: [createEdge({ source: junction.id, target: queue.id })] };
    expect(resolveTransparentCategory(g, junction.id, 'target')).toBe('queue');
  });

  it('an unfed Junction resolves to "junction" itself — no opinion', () => {
    const junction = createNode({ type: 'ellipse', x: 0, y: 0 });
    expect(resolveTransparentCategory({ nodes: [junction], edges: [] }, junction.id, 'source')).toBe('junction');
  });

  it('a Junction fed by mismatched categories resolves to "junction" — ambiguous, no opinion', () => {
    const service = createNode({ type: 'service', x: 0, y: 0 });
    const queue = createNode({ type: 'queue', x: 0, y: 150 });
    const junction = createNode({ type: 'ellipse', x: 200, y: 75 });
    const g = {
      nodes: [service, queue, junction],
      edges: [
        createEdge({ source: service.id, target: junction.id }),
        createEdge({ source: queue.id, target: junction.id }),
      ],
    };
    expect(resolveTransparentCategory(g, junction.id, 'source')).toBe('junction');
  });

  it('a Junction fed by two same-category sources still resolves unambiguously', () => {
    const serviceA = createNode({ type: 'service', x: 0, y: 0 });
    const serviceB = createNode({ type: 'service', x: 0, y: 150 });
    const junction = createNode({ type: 'ellipse', x: 200, y: 75 });
    const g = {
      nodes: [serviceA, serviceB, junction],
      edges: [
        createEdge({ source: serviceA.id, target: junction.id }),
        createEdge({ source: serviceB.id, target: junction.id }),
      ],
    };
    expect(resolveTransparentCategory(g, junction.id, 'source')).toBe('service');
  });

  it('chains through multiple Junctions to the real upstream category', () => {
    const service = createNode({ type: 'service', x: 0, y: 0 });
    const j1 = createNode({ type: 'ellipse', x: 200, y: 0 });
    const j2 = createNode({ type: 'ellipse', x: 400, y: 0 });
    const g = {
      nodes: [service, j1, j2],
      edges: [createEdge({ source: service.id, target: j1.id }), createEdge({ source: j1.id, target: j2.id })],
    };
    expect(resolveTransparentCategory(g, j2.id, 'source')).toBe('service');
  });
});

describe('inferredJunctionSemantic — the literal semantic a Junction\'s incoming edges converge on', () => {
  it('is undefined with no incoming edges', () => {
    const junction = createNode({ type: 'ellipse', x: 0, y: 0 });
    expect(inferredJunctionSemantic({ nodes: [junction], edges: [] }, junction.id)).toBeUndefined();
  });

  it('is the single incoming semantic when every typed incoming edge agrees', () => {
    const a = createNode({ type: 'service', x: 0, y: 0 });
    const junction = createNode({ type: 'ellipse', x: 200, y: 0 });
    const edge = createEdge({ source: a.id, target: junction.id, semantic: 'http', semanticsOrigin: 'explicit' });
    expect(inferredJunctionSemantic({ nodes: [a, junction], edges: [edge] }, junction.id)).toBe('http');
  });

  it('is undefined when incoming edges disagree — ambiguous convergence', () => {
    const a = createNode({ type: 'service', x: 0, y: 0 });
    const b = createNode({ type: 'service', x: 0, y: 150 });
    const junction = createNode({ type: 'ellipse', x: 200, y: 75 });
    const edges = [
      createEdge({ source: a.id, target: junction.id, semantic: 'http', semanticsOrigin: 'explicit' }),
      createEdge({ source: b.id, target: junction.id, semantic: 'event', semanticsOrigin: 'explicit' }),
    ];
    expect(inferredJunctionSemantic({ nodes: [a, b, junction], edges }, junction.id)).toBeUndefined();
  });

  it('ignores untyped incoming edges when checking for agreement', () => {
    const a = createNode({ type: 'service', x: 0, y: 0 });
    const b = createNode({ type: 'service', x: 0, y: 150 });
    const junction = createNode({ type: 'ellipse', x: 200, y: 75 });
    const edges = [
      createEdge({ source: a.id, target: junction.id, semantic: 'http', semanticsOrigin: 'explicit' }),
      createEdge({ source: b.id, target: junction.id }),
    ];
    expect(inferredJunctionSemantic({ nodes: [a, b, junction], edges }, junction.id)).toBe('http');
  });
});

describe('capabilityFor through a Junction — endpoint compatibility is preserved', () => {
  it('Junction → Queue resolves Queue-shaped relations, not Service→Service ones, even though the source is a Junction', () => {
    const service = createNode({ type: 'service', x: 0, y: 0 });
    const junction = createNode({ type: 'ellipse', x: 200, y: 0 });
    const queue = createNode({ type: 'queue', x: 400, y: 0 });
    const g = { nodes: [service, junction, queue], edges: [createEdge({ source: service.id, target: junction.id })] };

    const sourceCategory = resolveTransparentCategory(g, junction.id, 'source');
    const cap = capabilityFor(sourceCategory, categoryOf(queue))!;

    expect(cap.relations).toEqual(['publishes', 'command', 'event', 'dependsOn']);
    expect(cap.relations).not.toContain('query');
    expect(cap.relations).not.toContain('writes');
  });
});

describe('Junction connections — store integration (connect/reconnect through a Junction)', () => {
  const store = useEditorStore;

  beforeEach(() => {
    __resetInteraction();
    store.setState({
      document: createDocument('Junction'),
      history: { past: [], future: [] },
      selection: { nodes: [], edges: [] },
      clipboard: null,
      revision: 0,
    });
  });

  it('Service → Junction → Service: the outgoing leg gets the normal Service→Service treatment, not a blanked-out one', () => {
    const a = store.getState().addNode({ type: 'service', x: 0, y: 0 });
    const junction = store.getState().addNode({ type: 'ellipse', x: 200, y: 0 });
    const b = store.getState().addNode({ type: 'service', x: 400, y: 0 });
    store.getState().connect(a.id, junction.id);

    const outgoing = store.getState().connect(junction.id, b.id)!;
    // No unambiguous incoming semantic yet (the A→Junction leg is still untyped), so this falls
    // back to the ordinary Service→Service default — the same thing a direct Service→Service
    // connection infers — rather than staying untyped just because a Junction is on the way.
    expect(outgoing.semantic).toBe('calls');
    expect(outgoing.semanticsOrigin).toBe('inferred');
  });

  it('Service → Junction → Queue: the outgoing leg gets Queue-shaped options, not Service→Service ones', () => {
    const a = store.getState().addNode({ type: 'service', x: 0, y: 0 });
    const junction = store.getState().addNode({ type: 'ellipse', x: 200, y: 0 });
    const queue = store.getState().addNode({ type: 'queue', x: 400, y: 0 });
    store.getState().connect(a.id, junction.id);

    const outgoing = store.getState().connect(junction.id, queue.id)!;
    expect(outgoing.semantic).toBe('publishes');
    expect(outgoing.kind).toBe('event');
  });

  it('single incoming semantic inheritance: an unambiguous HTTP leg into the Junction defaults the outgoing leg to HTTP', () => {
    const a = store.getState().addNode({ type: 'service', x: 0, y: 0 });
    const junction = store.getState().addNode({ type: 'ellipse', x: 200, y: 0 });
    const b = store.getState().addNode({ type: 'service', x: 400, y: 0 });
    const incoming = store.getState().connect(a.id, junction.id)!;
    store.getState().setEdgeSemantic(incoming.id, 'http');

    const outgoing = store.getState().connect(junction.id, b.id)!;
    expect(outgoing.semantic).toBe('http');
    expect(outgoing.semanticsOrigin).toBe('inferred');
  });

  it('user overriding an inherited semantic: the inherited value is only a default, still freely changeable', () => {
    const a = store.getState().addNode({ type: 'service', x: 0, y: 0 });
    const junction = store.getState().addNode({ type: 'ellipse', x: 200, y: 0 });
    const b = store.getState().addNode({ type: 'service', x: 400, y: 0 });
    const incoming = store.getState().connect(a.id, junction.id)!;
    store.getState().setEdgeSemantic(incoming.id, 'http');
    const outgoing = store.getState().connect(junction.id, b.id)!;
    expect(outgoing.semantic).toBe('http');

    store.getState().setEdgeSemantic(outgoing.id, 'command');
    const stored = store.getState().document.edges.find((e) => e.id === outgoing.id)!;
    expect(stored.semantic).toBe('command');
    expect(stored.semanticsOrigin).toBe('explicit');
  });

  it('mixed incoming semantics (ambiguous convergence): does not guess between them, falls back to the neutral default', () => {
    const a = store.getState().addNode({ type: 'service', x: 0, y: 0 });
    const worker = store.getState().addNode({ type: 'service', x: 0, y: 150 });
    const junction = store.getState().addNode({ type: 'ellipse', x: 200, y: 75 });
    const c = store.getState().addNode({ type: 'service', x: 400, y: 75 });

    const inA = store.getState().connect(a.id, junction.id)!;
    store.getState().setEdgeSemantic(inA.id, 'http');
    const inWorker = store.getState().connect(worker.id, junction.id)!;
    store.getState().setEdgeSemantic(inWorker.id, 'event');

    const outgoing = store.getState().connect(junction.id, c.id)!;
    expect(outgoing.semantic).not.toBe('http');
    expect(outgoing.semantic).not.toBe('event');
    expect(outgoing.semantic).toBe('calls');
  });

  it('fan-out with different outgoing interaction types: two branches from the same Junction may differ', () => {
    const a = store.getState().addNode({ type: 'service', x: 0, y: 0 });
    const junction = store.getState().addNode({ type: 'ellipse', x: 200, y: 0 });
    const b = store.getState().addNode({ type: 'service', x: 400, y: -75 });
    const queue = store.getState().addNode({ type: 'queue', x: 400, y: 75 });
    const incoming = store.getState().connect(a.id, junction.id)!;
    store.getState().setEdgeSemantic(incoming.id, 'http');

    const toService = store.getState().connect(junction.id, b.id)!;
    const toQueue = store.getState().connect(junction.id, queue.id)!;

    expect(toService.semantic).toBe('http');
    expect(toQueue.semantic).toBe('publishes');
    expect(toQueue.kind).toBe('event');
  });

  it('endpoint compatibility filtering: Junction → Queue never inherits a Service-only semantic like "query"', () => {
    const a = store.getState().addNode({ type: 'service', x: 0, y: 0 });
    const junction = store.getState().addNode({ type: 'ellipse', x: 200, y: 0 });
    const queue = store.getState().addNode({ type: 'queue', x: 400, y: 0 });
    const incoming = store.getState().connect(a.id, junction.id)!;
    store.getState().setEdgeSemantic(incoming.id, 'query');

    const outgoing = store.getState().connect(junction.id, queue.id)!;
    expect(outgoing.semantic).not.toBe('query');
    expect(outgoing.semantic).toBe('publishes');
  });

  it('editing an existing Junction edge changes its interaction type and blocks further automatic reinference', () => {
    const a = store.getState().addNode({ type: 'service', x: 0, y: 0 });
    const junction = store.getState().addNode({ type: 'ellipse', x: 200, y: 0 });
    const b = store.getState().addNode({ type: 'service', x: 400, y: 0 });
    const queue = store.getState().addNode({ type: 'queue', x: 400, y: 150 });
    const incoming = store.getState().connect(a.id, junction.id)!;
    store.getState().setEdgeSemantic(incoming.id, 'http');
    const outgoing = store.getState().connect(junction.id, b.id)!;
    expect(outgoing.semantic).toBe('http');
    expect(outgoing.semanticsOrigin).toBe('inferred');

    // The user explicitly picks a different interaction type from the (now-visible) picker.
    store.getState().setEdgeSemantic(outgoing.id, 'query');
    let stored = store.getState().document.edges.find((e) => e.id === outgoing.id)!;
    expect(stored.semantic).toBe('query');
    expect(stored.semanticsOrigin).toBe('explicit');

    // Retargeting the edge afterward must not silently reclassify the explicit choice.
    store.getState().reconnectEdge(outgoing.id, 'target', queue.id, undefined);
    stored = store.getState().document.edges.find((e) => e.id === outgoing.id)!;
    expect(stored.target).toBe(queue.id);
    expect(stored.semantic).toBe('query');
    expect(stored.semanticsOrigin).toBe('explicit');
  });

  it('persistence/reload: a Junction connector\'s chosen interaction type survives a save/load round trip', () => {
    const a = createNode({ type: 'service', x: 0, y: 0 });
    const junction = createNode({ type: 'ellipse', x: 200, y: 0 });
    const b = createNode({ type: 'queue', x: 400, y: 0 });
    const incoming = createEdge({ source: a.id, target: junction.id, semantic: 'http', semanticsOrigin: 'explicit' });
    const outgoing = createEdge({
      source: junction.id,
      target: b.id,
      semantic: 'publishes',
      kind: 'event',
      semanticsOrigin: 'explicit',
    });
    let doc = addNodes(createDocument('Junction persistence'), [a, junction, b]);
    doc = addEdges(doc, [incoming, outgoing]);

    const result = deserializeDocument(serializeDocument(doc));
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const restoredOutgoing = result.document.edges.find((e) => e.id === outgoing.id)!;
    expect(restoredOutgoing.semantic).toBe('publishes');
    expect(restoredOutgoing.kind).toBe('event');
    expect(restoredOutgoing.semanticsOrigin).toBe('explicit');
  });
});
