import { beforeEach, describe, expect, it } from 'vitest';
import { quickConnectItems } from '../src/canvas/quickConnectItems';
import { capabilityFor, categoryOf, edgeRelationLabel, type NodeCategory } from '../src/document/connectorSemantics';
import {
  hasPassiveReading,
  MESSAGING_CATEGORIES,
  relationLabel,
  relationshipCaptionLabel,
  STORE_CATEGORIES,
} from '../src/document/edgeSemantics';
import { createDocument, createEdge, createNode, type CreateNodeInput } from '../src/document/factory';
import { addEdges, addNodes } from '../src/document/operations';
import type { EdgeSemantic } from '../src/document/types';
import { deserializeDocument, serializeDocument } from '../src/export/project';
import { __resetInteraction, useEditorStore } from '../src/store/editorStore';
import type { QuickConnectState } from '../src/store/uiStore';

/**
 * The one rule this file guards: a connector's caption reads "source *verb* target", so the words
 * and the arrow must say the same thing — whichever way the arrow was drawn, whether the
 * relationship was inferred or picked, and after it is reversed.
 */

const store = useEditorStore;

const KINDS = {
  service: { type: 'service' },
  api: { type: 'service', serviceKind: 'api' },
  worker: { type: 'service', serviceKind: 'worker' },
  gateway: { type: 'service', serviceKind: 'gateway' },
  scheduler: { type: 'service', serviceKind: 'scheduler' },
  external: { type: 'service', serviceKind: 'external' },
  queue: { type: 'queue' },
  stream: { type: 'queue', queueKind: 'stream' },
  topic: { type: 'queue', queueKind: 'topic' },
  dlq: { type: 'queue', deliveryRole: 'dead-letter' },
  sql: { type: 'database', databaseKind: 'sql' },
  cache: { type: 'database', databaseKind: 'cache' },
  searchIndex: { type: 'database', databaseKind: 'search-index' },
  adapter: { type: 'component', componentKind: 'adapter' },
  port: { type: 'component', componentKind: 'port' },
  note: { type: 'note' },
} satisfies Record<string, Omit<CreateNodeInput, 'x' | 'y'>>;
type Kind = keyof typeof KINDS;

function reset() {
  __resetInteraction();
  store.setState({
    document: createDocument('Direction'),
    history: { past: [], future: [] },
    selection: { nodes: [], edges: [] },
    clipboard: null,
    revision: 0,
  });
}

function draw(from: Kind, to: Kind) {
  const a = store.getState().addNode({ ...KINDS[from], x: 0, y: 0 });
  const b = store.getState().addNode({ ...KINDS[to], x: 400, y: 0 });
  const edge = store.getState().connect(a.id, b.id)!;
  return { a, b, edge };
}

/** The caption the canvas would draw for the stored edge right now. */
function captionOf(edgeId: string) {
  const doc = store.getState().document;
  const edge = doc.edges.find((e) => e.id === edgeId)!;
  if (edge.label) return edge.label;
  if (!edge.semantic) return undefined;
  const source = doc.nodes.find((n) => n.id === edge.source)!;
  const target = doc.nodes.find((n) => n.id === edge.target)!;
  return relationshipCaptionLabel(edge.semantic, {
    hasResponse: edge.hasResponse,
    deliveryAttempts: edge.deliveryAttempts,
    source: categoryOf(source),
    target: categoryOf(target),
  });
}

describe('drawing a connector: the inferred relationship reads in the arrow\'s direction', () => {
  beforeEach(reset);

  const cases: [Kind, Kind, EdgeSemantic, string][] = [
    ['service', 'api', 'calls', 'calls'],
    ['service', 'service', 'calls', 'calls'],
    ['service', 'queue', 'publishes', 'publishes to'],
    ['queue', 'worker', 'consumes', 'consumed by'],
    ['stream', 'worker', 'consumes', 'consumed by'],
    ['service', 'topic', 'publishes', 'publishes to'],
    ['topic', 'queue', 'fansOut', 'fans out to'],
    ['topic', 'worker', 'deliversTo', 'delivers to'],
    ['worker', 'dlq', 'deadLetters', 'dead-letters to'],
    ['scheduler', 'worker', 'triggers', 'triggers'],
    ['gateway', 'api', 'routes', 'routes to'],
    ['service', 'sql', 'writes', 'writes to'],
    ['sql', 'service', 'reads', 'read by'],
    ['service', 'cache', 'writes', 'writes to'],
    ['service', 'searchIndex', 'searches', 'searches'],
    ['topic', 'searchIndex', 'indexes', 'indexed by'],
    ['adapter', 'port', 'uses', 'uses'],
    ['port', 'adapter', 'implementedBy', 'implemented by'],
    ['external', 'api', 'calls', 'calls'],
  ];

  it.each(cases)('%s → %s infers %s and reads "%s"', (from, to, semantic, caption) => {
    const { edge } = draw(from, to);
    expect(edge.semantic).toBe(semantic);
    expect(edge.semanticsOrigin).toBe('inferred');
    // Inference never writes a label — the caption is derived, so it can follow the arrow.
    expect(edge.label).toBeUndefined();
    expect(captionOf(edge.id)).toBe(caption);
  });

  it('Worker → DLQ is a dashed failure path, the same treatment the broker\'s own dead-letter route gets', () => {
    const { edge } = draw('worker', 'dlq');
    expect(edge.kind).toBe('failure');
    expect(edge.async).toBe(true);
  });

  it('Worker → Queue keeps publishing as the default, with "consumes from" one pick away', () => {
    const { edge } = draw('worker', 'queue');
    expect(edge.semantic).toBe('publishes');
    expect(capabilityFor('worker', 'queue')!.relations).toContain('consumes');
    store.getState().setEdgeSemantic(edge.id, 'consumes');
    expect(captionOf(edge.id)).toBe('consumes from');
  });

  it('a topic delivers to its subscribers; it is never offered as "consumed by" the way a queue is', () => {
    expect(capabilityFor('topic', 'service')!.relations).not.toContain('consumes');
    expect(capabilityFor('queue', 'service')!.relations).toContain('consumes');
  });
});

describe('unusual and unknown pairings stay drawable', () => {
  beforeEach(reset);

  it('Database → Queue (CDC, triggers, change streams) connects as a plain connector with no opinion', () => {
    expect(capabilityFor('database', 'queue')).toBeUndefined();
    const { edge } = draw('sql', 'queue');
    expect(edge).toBeDefined();
    expect(edge.semantic).toBeUndefined();
    expect(captionOf(edge.id)).toBeUndefined();
  });

  it('a Note → Service connector is created, with nothing inferred', () => {
    const { edge } = draw('note', 'service');
    expect(edge).toBeDefined();
    expect(edge.semantic).toBeUndefined();
  });

  it('any relationship can still be picked for any pairing, and reads sensibly', () => {
    const { edge } = draw('sql', 'queue');
    store.getState().setEdgeSemantic(edge.id, 'cdc');
    expect(store.getState().document.edges[0]!.semantic).toBe('cdc');
    expect(captionOf(edge.id)).toBe('CDC');
  });
});

describe('reversing a connector', () => {
  beforeEach(reset);

  it('an inferred Service → Queue "publishes to" becomes Queue → Service "consumed by"', () => {
    const { edge } = draw('service', 'queue');
    store.getState().reverseEdge(edge.id);
    const stored = store.getState().document.edges[0]!;
    expect(stored.semantic).toBe('consumes');
    expect(captionOf(edge.id)).toBe('consumed by');
  });

  it('an explicit relationship keeps its meaning, and its caption turns to match the arrow', () => {
    const { edge } = draw('service', 'sql');
    store.getState().setEdgeSemantic(edge.id, 'reads');
    expect(captionOf(edge.id)).toBe('reads from');
    store.getState().reverseEdge(edge.id);
    const stored = store.getState().document.edges[0]!;
    expect(stored.semantic).toBe('reads');
    expect(stored.semanticsOrigin).toBe('explicit');
    // Still "the service reads the database", now said from the database's end.
    expect(captionOf(edge.id)).toBe('read by');
  });

  it('never rewrites a label the user typed', () => {
    const { edge } = draw('service', 'queue');
    store.getState().updateEdgeLabel(edge.id, 'OrderPlaced');
    store.getState().reverseEdge(edge.id);
    expect(store.getState().document.edges[0]!.label).toBe('OrderPlaced');
    expect(captionOf(edge.id)).toBe('OrderPlaced');
  });

  it('an inferred Queue → DLQ loses the dead-letter dashes once it no longer is one', () => {
    const q = store.getState().addNode({ ...KINDS.queue, x: 0, y: 0 });
    const dlq = store.getState().addNode({ ...KINDS.dlq, x: 400, y: 0 });
    const edge = store.getState().connect(q.id, dlq.id)!;
    expect(edge.async).toBe(true);
    store.getState().reverseEdge(edge.id);
    const stored = store.getState().document.edges[0]!;
    expect(stored.semantic).toBeUndefined();
    expect(stored.async).toBeUndefined();
  });

  it('keeps a dashed line the user chose', () => {
    const { edge } = draw('service', 'sql');
    store.getState().toggleEdgeAsync(edge.id);
    store.getState().reverseEdge(edge.id);
    expect(store.getState().document.edges[0]!.async).toBe(true);
  });

  it('is one undo step, and redo brings the reversed relationship back', () => {
    const { a, edge } = draw('service', 'queue');
    store.getState().reverseEdge(edge.id);
    store.getState().undo();
    let stored = store.getState().document.edges[0]!;
    expect(stored.source).toBe(a.id);
    expect(stored.semantic).toBe('publishes');
    store.getState().redo();
    stored = store.getState().document.edges[0]!;
    expect(stored.target).toBe(a.id);
    expect(stored.semantic).toBe('consumes');
  });
});

describe('saved diagrams', () => {
  beforeEach(reset);

  it('round-trips the relationship without writing a label', () => {
    const { edge } = draw('service', 'topic');
    store.getState().setEdgeSemantic(edge.id, 'event');
    const parsed = deserializeDocument(serializeDocument(store.getState().document));
    expect(parsed.ok).toBe(true);
    const reloaded = parsed.ok ? parsed.document.edges[0]! : undefined;
    expect(reloaded).toMatchObject({ semantic: 'event', semanticsOrigin: 'explicit' });
    expect(reloaded!.label).toBeUndefined();
  });

  it('an older diagram drawn Queue → Worker "consumes" loads unchanged and now reads "consumed by"', () => {
    const queue = createNode({ id: 'q', type: 'queue', x: 0, y: 0 });
    const worker = createNode({ id: 'w', type: 'service', serviceKind: 'worker', x: 400, y: 0 });
    // Legacy: a semantic with no `semanticsOrigin`, exactly as documents saved before it existed.
    const legacy = addEdges(addNodes(createDocument('Legacy'), [queue, worker]), [
      createEdge({ id: 'e', source: 'q', target: 'w', semantic: 'consumes' }),
    ]);
    const parsed = deserializeDocument(serializeDocument(legacy));
    expect(parsed.ok).toBe(true);
    const doc = parsed.ok ? parsed.document : legacy;
    expect(doc.edges).toEqual(legacy.edges);
    expect(edgeRelationLabel(doc, doc.edges[0]!)).toBe('consumed by');
  });
});

describe('the vocabulary itself', () => {
  const HOLDERS = new Set<NodeCategory>([...STORE_CATEGORIES, ...MESSAGING_CATEGORIES]);
  // What a store or a messaging channel genuinely does itself, so the active form already reads
  // in the arrow's direction.
  const HOLDER_VERBS = new Set<EdgeSemantic>([
    'deliversTo',
    'fansOut',
    'deadLetters',
    'publishes',
    'cdc',
    'replicates',
    'syncs',
    'transforms',
    'event',
  ]);
  const CATEGORIES: NodeCategory[] = [
    'actor',
    'service',
    'external',
    'worker',
    'scheduler',
    'gateway',
    'component',
    'port',
    'database',
    'cache',
    'fileSystem',
    'objectStorage',
    'searchIndex',
    'queue',
    'topic',
    'deadLetter',
  ];

  // Rows flagged `unusual` (Queue → Topic, Topic → DLQ, Port → Database) are exempt: they infer
  // nothing, carry their own marker and guidance, and keep `dependsOn` only as a neutral choice a
  // user makes deliberately.
  const opinionated = (source: NodeCategory, target: NodeCategory) => {
    const cap = capabilityFor(source, target);
    return cap && cap.status !== 'unusual' ? cap.relations : [];
  };

  it('never offers "depends on" from something that can\'t depend: a store, a channel, or a port', () => {
    for (const source of [...HOLDERS, 'port' as const]) {
      for (const target of CATEGORIES) {
        const relations = opinionated(source, target);
        expect(relations, `${source} → ${target}`).not.toContain('dependsOn');
      }
    }
  });

  it('every relation offered from a store or channel either reads actively or has a passive reading', () => {
    for (const source of HOLDERS) {
      for (const target of CATEGORIES) {
        for (const relation of opinionated(source, target)) {
          expect(HOLDER_VERBS.has(relation) || hasPassiveReading(relation), `${source} → ${target}: ${relation}`).toBe(
            true,
          );
        }
      }
    }
  });

  it('a store feeding a store has no subject to be passive about, so a data-access verb stays active', () => {
    expect(relationLabel('reads', 'database', 'database')).toBe('reads from');
    expect(relationLabel('ingests', 'database', 'database')).toBe('ingested by');
  });

  it('without categories a caption falls back to the active wording', () => {
    expect(relationLabel('consumes')).toBe('consumes from');
  });
});

describe('Quick Connect and Intent Continuation from architecture-aware shapes', () => {
  const drop = (source: string): QuickConnectState => ({
    source,
    sourceSide: 'right',
    sourceOffset: 0.5,
    flowPosition: { x: 400, y: 0 },
    screenPosition: { x: 400, y: 0 },
    center: { x: 400, y: 0 },
  });

  function withFeed(kind: Kind) {
    const producer = createNode({ id: 'p', type: 'service', x: 0, y: 0 });
    const anchor = createNode({ id: 'a', ...KINDS[kind], x: 400, y: 0 });
    return addEdges(addNodes(createDocument('Q'), [producer, anchor]), [createEdge({ source: 'p', target: 'a' })]);
  }

  it('dragging off an Adapter leads with a Port, inferred as "uses"', () => {
    const doc = addNodes(createDocument('Q'), [createNode({ id: 'a', ...KINDS.adapter, x: 0, y: 0 })]);
    const rows = quickConnectItems(doc, drop('a'));
    expect(rows[0]).toMatchObject({ kind: 'continuation', label: 'Port' });
    expect(capabilityFor('component', 'port')!.defaultRelation).toBe('uses');
  });

  it('dragging off a fed Queue leads with its Worker', () => {
    expect(quickConnectItems(withFeed('queue'), drop('a'))[0]).toMatchObject({ kind: 'continuation', label: 'Worker' });
  });

  it('dragging off a fed Topic leads with a Queue', () => {
    expect(quickConnectItems(withFeed('topic'), drop('a'))[0]).toMatchObject({ kind: 'continuation', label: 'Queue' });
  });

  it('a plain Component (not an Adapter) is not offered a Port', () => {
    const doc = addNodes(createDocument('Q'), [createNode({ id: 'a', type: 'component', x: 0, y: 0 })]);
    expect(quickConnectItems(doc, drop('a')).some((row) => row.label === 'Port')).toBe(false);
  });
});
