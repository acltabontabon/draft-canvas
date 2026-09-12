import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { nodeCommands } from '../src/commands/registry';
import type { CommandContext } from '../src/commands/types';
import { __resetClipboardSync, __resetInteraction, useEditorStore } from '../src/store/editorStore';
import { useUiStore, type ContinuationOffer } from '../src/store/uiStore';
import {
  continuationsFor,
  dismissalKey,
  materialize,
  neighborhoodOf,
  RULES,
  type ContinuationRule,
  type ContinuationTrigger,
} from '../src/continuation';
import { capabilityFor, categoryOf, inferRelationship } from '../src/document/connectorSemantics';
import { createDocument, createEdge, createNode, defaultSizeFor } from '../src/document/factory';
import { addEdges, addNodes, placeNear } from '../src/document/operations';
import { rectOf, routeBetween } from '../src/edges/routing';
import type { CreateNodeInput } from '../src/document/factory';
import type { DraftDocument, DraftNode } from '../src/document/types';

/* ------------------------------------------------------------------ */
/* Fixture vocabulary — real factory + operations, nothing bespoke.    */
/* ------------------------------------------------------------------ */

type Spec = Omit<CreateNodeInput, 'x' | 'y'> & { id: string; x?: number; y?: number };

function graph(nodes: Spec[], edges: Array<[string, string]>): DraftDocument {
  const built = nodes.map((spec, i) => createNode({ x: i * 480, y: 0, ...spec }));
  const byId = new Map(built.map((n) => [n.id, n]));
  let doc = addNodes(createDocument('Continuation'), built);
  doc = addEdges(
    doc,
    edges.map(([source, target]) =>
      createEdge({ source, target, ...inferRelationship(byId.get(source)!, byId.get(target)!), semanticsOrigin: 'inferred' }),
    ),
  );
  return doc;
}

const service = (id: string, extra: Partial<Spec> = {}): Spec => ({ id, type: 'service', ...extra });
const topic = (id: string): Spec => ({ id, type: 'queue', queueKind: 'topic' });
const queue = (id: string, extra: Partial<Spec> = {}): Spec => ({ id, type: 'queue', queueKind: 'queue', ...extra });
const stream = (id: string): Spec => ({ id, type: 'queue', queueKind: 'stream' });
const dlq = (id: string): Spec => ({ id, type: 'queue', queueKind: 'queue', deliveryRole: 'dead-letter' });
const worker = (id: string): Spec => ({ id, type: 'service', serviceKind: 'worker' });
const gateway = (id: string): Spec => ({ id, type: 'service', serviceKind: 'gateway' });
const scheduler = (id: string): Spec => ({ id, type: 'service', serviceKind: 'scheduler' });
const database = (id: string): Spec => ({ id, type: 'database' });
const objectStorage = (id: string): Spec => ({ id, type: 'database', databaseKind: 'object-storage' });
const searchIndex = (id: string): Spec => ({ id, type: 'database', databaseKind: 'search-index' });
const port = (id: string): Spec => ({ id, type: 'component', componentKind: 'port' });
const actor = (id: string): Spec => ({ id, type: 'actor' });

const ids = (doc: DraftDocument, anchor: string, trigger: ContinuationTrigger, dismissed?: ReadonlySet<string>) =>
  continuationsFor(doc, anchor, trigger, dismissed).map((c) => c.ruleId);

/* ------------------------------------------------------------------ */
/* Rule tables                                                          */
/* ------------------------------------------------------------------ */

interface Case {
  name: string;
  doc: DraftDocument;
  anchor: string;
  select: string[];
  drop: string[];
}

const CASES: Case[] = [
  {
    name: 'Topic with a publisher and no delivery path',
    doc: graph([service('pub'), topic('t')], [['pub', 't']]),
    anchor: 't',
    select: ['topic-fan-out-queue'],
    drop: ['topic-fan-out-queue', 'topic-fan-out-worker'],
  },
  {
    name: 'Topic with no edges at all — no evidence on select, offered on explicit drop',
    doc: graph([topic('t')], []),
    anchor: 't',
    select: [],
    drop: ['topic-fan-out-queue', 'topic-fan-out-worker'],
  },
  {
    name: 'Topic already fanning into a Queue — silent on select, another Queue on drop',
    doc: graph([service('pub'), topic('t'), queue('q')], [['pub', 't'], ['t', 'q']]),
    anchor: 't',
    select: [],
    drop: ['topic-fan-out-queue', 'topic-fan-out-worker'],
  },
  {
    name: 'Topic delivering straight to a Service — equivalent delivery exists, silent on select',
    doc: graph([service('pub'), topic('t'), service('sub')], [['pub', 't'], ['t', 'sub']]),
    anchor: 't',
    select: [],
    drop: ['topic-fan-out-queue', 'topic-fan-out-worker'],
  },
  {
    name: 'Queue with inbound and no consumer',
    doc: graph([topic('t'), queue('q')], [['t', 'q']]),
    anchor: 'q',
    select: ['queue-consumer'],
    drop: ['queue-consumer'],
  },
  {
    name: 'Queue fed by a Service directly',
    doc: graph([service('s'), queue('q')], [['s', 'q']]),
    anchor: 'q',
    select: ['queue-consumer'],
    drop: ['queue-consumer'],
  },
  {
    name: 'Queue with a Worker consumer — consumer suppressed, DLQ becomes the drop offer',
    doc: graph([service('s'), queue('q'), worker('w')], [['s', 'q'], ['q', 'w']]),
    anchor: 'q',
    select: [],
    drop: ['queue-consumer', 'queue-dead-letter'],
  },
  {
    name: 'Queue whose consumer is a plain Service — counts as consumed (compared on semantic)',
    doc: graph([service('s'), queue('q'), service('c')], [['s', 'q'], ['q', 'c']]),
    anchor: 'q',
    select: [],
    drop: ['queue-consumer', 'queue-dead-letter'],
  },
  {
    name: 'Queue with consumer and DLQ — nothing left to add',
    doc: graph([service('s'), queue('q'), worker('w'), dlq('d')], [['s', 'q'], ['q', 'w'], ['q', 'd']]),
    anchor: 'q',
    select: [],
    drop: ['queue-consumer'],
  },
  {
    name: 'Stream with a consumer and no dead-letter path — another Worker and a Dead-letter topic, both on drop',
    doc: graph([service('s'), stream('st'), worker('w')], [['s', 'st'], ['st', 'w']]),
    anchor: 'st',
    select: [],
    drop: ['queue-consumer', 'stream-dead-letter'],
  },
  {
    name: 'Stream with a consumer and a dead-letter topic already — nothing left to add',
    doc: graph(
      [service('s'), stream('st'), worker('w'), { id: 'd', type: 'queue', queueKind: 'topic', deliveryRole: 'dead-letter' }],
      [['s', 'st'], ['st', 'w'], ['st', 'd']],
    ),
    anchor: 'st',
    select: [],
    drop: ['queue-consumer'],
  },
  {
    name: 'A dead-letter queue itself — a DLQ without a re-drive worker is normal',
    doc: graph([queue('q'), dlq('d')], [['q', 'd']]),
    anchor: 'd',
    select: [],
    drop: [],
  },
  {
    name: 'Lone Queue with no inbound — no evidence on select',
    doc: graph([queue('q')], []),
    anchor: 'q',
    select: [],
    drop: ['queue-consumer'],
  },
  {
    name: 'Gateway with an inbound actor and nothing routed',
    doc: graph([actor('u'), gateway('g')], [['u', 'g']]),
    anchor: 'g',
    select: ['gateway-route'],
    drop: ['gateway-route'],
  },
  {
    name: 'Gateway already routing',
    doc: graph([actor('u'), gateway('g'), service('s')], [['u', 'g'], ['g', 's']]),
    anchor: 'g',
    select: [],
    drop: ['gateway-route'],
  },
  {
    name: 'API → Service → Data Store: perfect, do nothing (Service anchor)',
    doc: graph([service('api', { serviceKind: 'api' }), service('s'), database('db')], [['api', 's'], ['s', 'db']]),
    anchor: 's',
    select: [],
    drop: [],
  },
  {
    name: 'Data Store anchor — nothing to continue',
    doc: graph([service('s'), database('db')], [['s', 'db']]),
    anchor: 'db',
    select: [],
    drop: [],
  },
  {
    name: 'Actor anchor — too open to have one move',
    doc: graph([actor('u')], []),
    anchor: 'u',
    select: [],
    drop: [],
  },
  {
    name: 'Scheduler with nothing triggered yet',
    doc: graph([scheduler('t')], []),
    anchor: 't',
    select: ['scheduler-trigger-service'],
    drop: ['scheduler-trigger-service', 'scheduler-trigger-worker'],
  },
  {
    name: 'Scheduler already triggering something — silent on select, still offered on an explicit drop',
    doc: graph([scheduler('t'), service('s')], [['t', 's']]),
    anchor: 't',
    select: [],
    drop: ['scheduler-trigger-service', 'scheduler-trigger-worker'],
  },
  {
    name: 'Object Storage with an upload and nowhere for it to notify',
    doc: graph([service('p'), objectStorage('t')], [['p', 't']]),
    anchor: 't',
    select: ['object-storage-fan-out-queue'],
    drop: ['object-storage-fan-out-queue', 'object-storage-fan-out-topic'],
  },
  {
    name: 'Object Storage with no inbound evidence — silent on select, still offered on an explicit drop',
    doc: graph([objectStorage('t')], []),
    anchor: 't',
    select: [],
    drop: ['object-storage-fan-out-queue', 'object-storage-fan-out-topic'],
  },
  {
    name: 'Port depended on and not implemented by anything',
    doc: graph([service('p'), port('t')], [['p', 't']]),
    anchor: 't',
    select: ['port-implementation-component'],
    drop: ['port-implementation-component', 'port-implementation-service'],
  },
  {
    name: 'Port with no inbound evidence — silent on select, still offered on an explicit drop',
    doc: graph([port('t')], []),
    anchor: 't',
    select: [],
    drop: ['port-implementation-component', 'port-implementation-service'],
  },
  {
    name: 'Search Index anchor — no rule starts from it',
    doc: graph([service('s'), searchIndex('idx')], [['s', 'idx']]),
    anchor: 'idx',
    select: [],
    drop: [],
  },
  {
    name: 'Cache anchor — no rule starts from it either',
    doc: graph([{ id: 'c', type: 'database', databaseKind: 'cache' }, service('s')], [['s', 'c']]),
    anchor: 'c',
    select: [],
    drop: [],
  },
];

describe('continuationsFor — rule tables', () => {
  for (const c of CASES) {
    it(`${c.name} (select)`, () => expect(ids(c.doc, c.anchor, 'select')).toEqual(c.select));
    it(`${c.name} (drop)`, () => expect(ids(c.doc, c.anchor, 'drop')).toEqual(c.drop));
  }

  it('never offers anything for a boundary, note, text, code or junction anchor', () => {
    const doc = graph(
      [
        { id: 'g', type: 'group' },
        { id: 'n', type: 'note' },
        { id: 'x', type: 'text' },
        { id: 'c', type: 'code' },
        { id: 'j', type: 'ellipse' },
      ],
      [],
    );
    for (const anchor of ['g', 'n', 'x', 'c', 'j']) {
      expect(ids(doc, anchor, 'select')).toEqual([]);
      expect(ids(doc, anchor, 'drop')).toEqual([]);
    }
  });

  it('a broad silence sweep: every category with no rule at all stays silent on both select and drop', () => {
    // Every category NOT among a rule's `sourceCategories` (topic, queue, gateway, scheduler,
    // objectStorage, port, worker) — not merely lacking evidence, but with no rule that could ever
    // fire for it regardless of graph shape. This is the negative-space check the rest of this
    // file's positive cases don't cover on their own: adding a rule for one category must never be
    // mistaken for having covered a neighboring one.
    const bareCategoryDocs: Record<string, DraftDocument> = {
      'plain service': graph([service('t')], []),
      'external service': graph([{ id: 't', type: 'service', serviceKind: 'external' }], []),
      actor: graph([actor('t')], []),
      'generic component': graph([{ id: 't', type: 'component' }], []),
      'plain database': graph([database('t')], []),
      cache: graph([{ id: 't', type: 'database', databaseKind: 'cache' }], []),
      'file system': graph([{ id: 't', type: 'database', databaseKind: 'file-system' }], []),
      'search index': graph([searchIndex('t')], []),
    };
    for (const [label, doc] of Object.entries(bareCategoryDocs)) {
      expect(ids(doc, 't', 'select'), `${label} (select)`).toEqual([]);
      expect(ids(doc, 't', 'drop'), `${label} (drop)`).toEqual([]);
    }
  });

  it('returns nothing for an unknown anchor', () => {
    expect(ids(graph([topic('t')], []), 'nope', 'drop')).toEqual([]);
  });

  it('a Junction sitting in a chain misfires no current rule', () => {
    // Actor -> Junction -> Service
    const doc = graph([actor('u'), { id: 'j', type: 'ellipse' }, service('s')], [['u', 'j'], ['j', 's']]);

    // A Junction never anchors a continuation, and sitting between two other nodes changes neither
    // of their own category nor their own incident-edge shape — no existing rule reacts to it.
    expect(ids(doc, 'u', 'select')).toEqual([]);
    expect(ids(doc, 's', 'select')).toEqual([]);
    expect(ids(doc, 'j', 'select')).toEqual([]);
  });

  it('is deterministic: the same inputs give the same ordered result every time', () => {
    const doc = graph([service('s'), queue('q'), worker('w')], [['s', 'q'], ['q', 'w']]);
    const first = continuationsFor(doc, 'q', 'drop');
    for (let i = 0; i < 3; i++) expect(continuationsFor(doc, 'q', 'drop')).toEqual(first);
  });

  it('orders primaries before secondaries regardless of declaration order', () => {
    const doc = graph([service('s'), queue('q'), worker('w')], [['s', 'q'], ['q', 'w']]);
    const offered = continuationsFor(doc, 'q', 'drop');
    expect(offered.map((c) => c.tier)).toEqual(['primary', 'secondary']);
  });
});

/* ------------------------------------------------------------------ */
/* The matrix is the only authority on validity                        */
/* ------------------------------------------------------------------ */

describe('continuationsFor — technical validity is the matrix, never the rule', () => {
  const always: Pick<ContinuationRule, 'tier' | 'label' | 'reason' | 'when'> = {
    tier: 'primary',
    label: 'X',
    reason: 'test',
    when: () => true,
  };

  it('drops a rule whose fragment pairing the matrix flags as unusual (queue → topic)', () => {
    const rule: ContinuationRule = {
      ...always,
      id: 'bad-queue-to-topic',
      fragment: () => ({ nodes: [{ key: 't', type: 'queue', queueKind: 'topic' }], edges: [{ from: 'anchor', to: 't' }] }),
    };
    expect(capabilityFor('queue', 'topic')?.status).toBe('unusual');
    const doc = graph([service('s'), queue('q')], [['s', 'q']]);
    expect(continuationsFor(doc, 'q', 'drop', undefined, [rule])).toEqual([]);
  });

  it('drops a rule whose fragment pairing has no matrix row at all (actor → database)', () => {
    const rule: ContinuationRule = {
      ...always,
      id: 'bad-actor-to-db',
      fragment: () => ({ nodes: [{ key: 'db', type: 'database' }], edges: [{ from: 'anchor', to: 'db' }] }),
    };
    expect(capabilityFor('actor', 'database')).toBeUndefined();
    expect(continuationsFor(graph([actor('u')], []), 'u', 'drop', undefined, [rule])).toEqual([]);
  });

  it('drops a rule whose fragment adds nodes but no connector', () => {
    const rule: ContinuationRule = {
      ...always,
      id: 'orphan',
      fragment: () => ({ nodes: [{ key: 'w', type: 'service' }], edges: [] }),
    };
    expect(continuationsFor(graph([queue('q')], []), 'q', 'drop', undefined, [rule])).toEqual([]);
  });

  it('every shipped rule produces matrix-valid fragments from a neighborhood it fires on', () => {
    const anchors: Record<string, DraftDocument> = {
      'topic-fan-out-queue': graph([service('p'), topic('t')], [['p', 't']]),
      'topic-fan-out-worker': graph([service('p'), topic('t')], [['p', 't']]),
      'queue-consumer': graph([service('p'), queue('t')], [['p', 't']]),
      'queue-dead-letter': graph([service('p'), queue('t'), worker('w')], [['p', 't'], ['t', 'w']]),
      'stream-dead-letter': graph([service('p'), stream('t'), worker('w')], [['p', 't'], ['t', 'w']]),
      'gateway-route': graph([actor('p'), gateway('t')], [['p', 't']]),
      'scheduler-trigger-service': graph([scheduler('t')], []),
      'scheduler-trigger-worker': graph([scheduler('t')], []),
      'object-storage-fan-out-queue': graph([service('p'), objectStorage('t')], [['p', 't']]),
      'object-storage-fan-out-topic': graph([service('p'), objectStorage('t')], [['p', 't']]),
      'port-implementation-component': graph([service('p'), port('t')], [['p', 't']]),
      'port-implementation-service': graph([service('p'), port('t')], [['p', 't']]),
      'worker-indexes': graph([service('p'), worker('t')], [['p', 't']]),
    };
    for (const rule of RULES) {
      const doc = anchors[rule.id];
      expect(doc, `no fixture for ${rule.id}`).toBeDefined();
      const nb = neighborhoodOf(doc!, 't')!;
      expect(rule.when(nb, 'drop')).toBe(true);
      const fragment = rule.fragment(nb);
      for (const edge of fragment.edges) {
        const from = edge.from === 'anchor' ? nb.node : fragment.nodes.find((n) => n.key === edge.from)!;
        const to = edge.to === 'anchor' ? nb.node : fragment.nodes.find((n) => n.key === edge.to)!;
        const cap = capabilityFor(categoryOf(from), categoryOf(to));
        expect(cap?.defaultRelation, `${rule.id}: ${edge.from} → ${edge.to}`).toBeDefined();
        expect(cap?.status ?? 'valid').toBe('valid');
      }
    }
  });

  it('every rule carries a stable id, a label and an authored reason', () => {
    const seen = new Set<string>();
    for (const rule of RULES) {
      expect(seen.has(rule.id)).toBe(false);
      seen.add(rule.id);
      expect(rule.label.length).toBeGreaterThan(0);
      expect(rule.reason.endsWith('.')).toBe(true);
    }
  });
});

/* ------------------------------------------------------------------ */
/* Dismissal                                                            */
/* ------------------------------------------------------------------ */

describe('continuationsFor — dismissal', () => {
  it('suppresses a dismissed (anchor, rule, neighborhood) and nothing else', () => {
    const doc = graph([service('pub'), topic('t')], [['pub', 't']]);
    const [offer] = continuationsFor(doc, 't', 'select');
    const dismissed = new Set([dismissalKey(offer!.anchorId, offer!.ruleId, offer!.neighborhoodKey)]);
    expect(ids(doc, 't', 'select', dismissed)).toEqual([]);
    // The secondary is a different rule — still offered on drop.
    expect(ids(doc, 't', 'drop', dismissed)).toEqual(['topic-fan-out-worker']);
  });

  it('a dismissal stops applying once the neighborhood changes', () => {
    const doc = graph([service('pub'), topic('t')], [['pub', 't']]);
    const [offer] = continuationsFor(doc, 't', 'select');
    const dismissed = new Set([dismissalKey(offer!.anchorId, offer!.ruleId, offer!.neighborhoodKey)]);
    const second = createNode({ type: 'service', x: 0, y: 300 });
    const grown = addEdges(addNodes(doc, [second]), [
      createEdge({ source: second.id, target: 't', ...inferRelationship(second, doc.nodes[1]!) }),
    ]);
    expect(ids(grown, 't', 'select', dismissed)).toEqual(['topic-fan-out-queue']);
  });

  it('a dismissal survives moves and renames — only incident connectors and kind move the key', () => {
    const doc = graph([service('pub'), topic('t')], [['pub', 't']]);
    const before = neighborhoodOf(doc, 't')!.key;
    const moved: DraftDocument = {
      ...doc,
      nodes: doc.nodes.map((n) => (n.id === 't' ? { ...n, x: 999, y: 999, text: 'Renamed' } : n)),
    };
    expect(neighborhoodOf(moved, 't')!.key).toBe(before);
    const retyped: DraftDocument = {
      ...doc,
      nodes: doc.nodes.map((n) => (n.id === 't' ? { ...n, queueKind: 'queue' } : n)),
    };
    expect(neighborhoodOf(retyped, 't')!.key).not.toBe(before);
  });
});

/* ------------------------------------------------------------------ */
/* Materialize                                                          */
/* ------------------------------------------------------------------ */

describe('materialize', () => {
  it('places the node where placeNear would, with matrix semantics and a DLQ attempt count', () => {
    const doc = graph([service('s'), queue('q'), worker('w')], [['s', 'q'], ['q', 'w']]);
    const dlqOffer = continuationsFor(doc, 'q', 'drop').find((c) => c.ruleId === 'queue-dead-letter')!;
    const m = materialize(doc, dlqOffer)!;
    expect(m.nodes).toHaveLength(1);
    expect(m.edges).toHaveLength(1);
    const node = m.nodes[0]!;
    expect(node.type).toBe('queue');
    expect(node.deliveryRole).toBe('dead-letter');
    expect(m.primaryNodeId).toBe(node.id);
    const edge = m.edges[0]!;
    expect(edge.source).toBe('q');
    expect(edge.target).toBe(node.id);
    expect(edge.semantic).toBe('deadLetters');
    expect(edge.kind).toBe('failure');
    expect(edge.async).toBe(true);
    expect(edge.semanticsOrigin).toBe('inferred');
    expect(edge.deliveryAttempts).toBe(3);
    // Same gap rule `addDeadLetterQueue` uses: the caption "after 3 attempts" fits between them.
    const anchor = doc.nodes.find((n) => n.id === 'q')!;
    expect(node.x).toBeGreaterThan(anchor.x + anchor.width + 32);
    expect(node.y).toBe(anchor.y);
    // Horizontal companion → tube-centred anchors on both queue ends.
    expect(edge.sourceAnchor?.side).toBe('right');
    expect(edge.targetAnchor?.side).toBe('left');
  });

  it('is identical to what placeNear + inferRelationship give for a Topic → Queue', () => {
    const doc = graph([service('pub'), topic('t')], [['pub', 't']]);
    const [offer] = continuationsFor(doc, 't', 'select');
    const m = materialize(doc, offer!)!;
    const anchor = doc.nodes.find((n) => n.id === 't')!;
    const expected = placeNear(doc, anchor, defaultSizeFor('queue'), m.nodes[0]!.x - anchor.x - anchor.width);
    expect({ x: m.nodes[0]!.x, y: m.nodes[0]!.y }).toEqual(expected);
    expect(m.edges[0]!.semantic).toBe('fansOut');
    expect(m.edges[0]!.kind).toBe('event');
  });

  it('honours an explicit drop position for the first node', () => {
    const doc = graph([service('pub'), topic('t')], [['pub', 't']]);
    const [offer] = continuationsFor(doc, 't', 'drop');
    const m = materialize(doc, offer!, { at: { x: 1000.4, y: -200.6 } })!;
    expect(m.nodes[0]!.x).toBe(1000);
    expect(m.nodes[0]!.y).toBe(-201);
  });

  it('returns undefined instead of previewing on top of the user\'s content', () => {
    // Surround the queue's five candidate spots with nodes.
    const anchor = createNode({ id: 'q', type: 'queue', queueKind: 'queue', x: 0, y: 0 });
    const pub = createNode({ id: 's', type: 'service', x: -400, y: 0 });
    const blockers: DraftNode[] = [
      createNode({ type: 'service', x: 150, y: -120, width: 400, height: 400 }),
      createNode({ type: 'service', x: -50, y: 60, width: 400, height: 400 }),
    ];
    let doc = addNodes(createDocument('Crowded'), [anchor, pub, ...blockers]);
    doc = addEdges(doc, [createEdge({ source: 's', target: 'q', ...inferRelationship(pub, anchor) })]);
    const [offer] = continuationsFor(doc, 'q', 'select');
    expect(offer?.ruleId).toBe('queue-consumer');
    expect(materialize(doc, offer!)).toBeUndefined();
    // …but an explicit drop position is the user's call.
    expect(materialize(doc, offer!, { at: { x: 900, y: 900 } })).toBeDefined();
  });

  it('inherits the anchor\'s boundary when the companion fits inside it — trying another direction first if that\'s what it takes — and leaves it unparented only when nothing fits', () => {
    const roomy = createNode({ id: 'b', type: 'group', x: 0, y: 0, width: 800, height: 300 });
    const topicIn = createNode({ id: 't', type: 'queue', queueKind: 'topic', x: 40, y: 100, parentId: 'b' });
    const pub = createNode({ id: 'p', type: 'service', x: -400, y: 100 });
    let doc = addNodes(createDocument('Boundary'), [roomy, topicIn, pub]);
    doc = addEdges(doc, [createEdge({ source: 'p', target: 't', ...inferRelationship(pub, topicIn) })]);
    const [offer] = continuationsFor(doc, 't', 'select');
    expect(materialize(doc, offer!)!.nodes[0]!.parentId).toBe('b');

    // Too narrow for the preferred (rightward) candidate to fit inside the boundary, but there is
    // still room below it — placement prefers staying inside the boundary over its usual direction.
    const narrow: DraftDocument = { ...doc, nodes: doc.nodes.map((n) => (n.id === 'b' ? { ...n, width: 200 } : n)) };
    const belowInB = materialize(narrow, offer!)!.nodes[0]!;
    expect(belowInB.parentId).toBe('b');
    expect(belowInB.y).toBeGreaterThan(topicIn.y);

    // Genuinely no room in any of the five candidate directions — stays unparented rather than
    // being forced somewhere inside, exactly as it would with no boundary involved at all.
    const cramped: DraftDocument = {
      ...doc,
      nodes: doc.nodes.map((n) => (n.id === 'b' ? { ...n, width: 200, height: 150 } : n)),
    };
    expect(materialize(cramped, offer!)!.nodes[0]!.parentId).toBeUndefined();
  });

  it('continues in whichever direction the diagram is already flowing at the anchor, not always rightward', () => {
    const pubAbove = createNode({ id: 'p', type: 'service', x: 0, y: -300 });
    const t = createNode({ id: 't', type: 'queue', queueKind: 'topic', x: 0, y: 0 });
    let doc = addNodes(createDocument('Vertical flow'), [pubAbove, t]);
    doc = addEdges(doc, [createEdge({ source: 'p', target: 't', ...inferRelationship(pubAbove, t) })]);
    const [offer] = continuationsFor(doc, 't', 'select');
    const node = materialize(doc, offer!)!.nodes[0]!;
    // A publisher directly above continues downward, not off to the side.
    expect(node.y).toBeGreaterThan(t.y);
    expect(node.x).toBe(t.x);
  });

  it('mints fresh ids on every call so an accepted offer never collides with a re-offer', () => {
    const doc = graph([service('pub'), topic('t')], [['pub', 't']]);
    const [offer] = continuationsFor(doc, 't', 'select');
    expect(materialize(doc, offer!)!.nodes[0]!.id).not.toBe(materialize(doc, offer!)!.nodes[0]!.id);
  });

  it('materializing the same offer against the same document twice picks the same position and anchors', () => {
    const doc = graph([service('pub'), topic('t')], [['pub', 't']]);
    const [offer] = continuationsFor(doc, 't', 'select');
    const a = materialize(doc, offer!)!;
    const b = materialize(doc, offer!)!;
    expect({ x: b.nodes[0]!.x, y: b.nodes[0]!.y }).toEqual({ x: a.nodes[0]!.x, y: a.nodes[0]!.y });
    expect(b.edges[0]!.sourceAnchor).toEqual(a.edges[0]!.sourceAnchor);
    expect(b.edges[0]!.targetAnchor).toEqual(a.edges[0]!.targetAnchor);
  });

  it('a materialized edge\'s pinned anchors reproduce exactly the route it previewed, once accepted', () => {
    const doc = graph([service('pub'), topic('t')], [['pub', 't']]);
    const [offer] = continuationsFor(doc, 't', 'select');
    const m = materialize(doc, offer!)!;
    const anchor = doc.nodes.find((n) => n.id === 't')!;

    // What the ghost would have drawn, before anything is real.
    const previewRoute = routeBetween(rectOf(anchor), rectOf(m.nodes[0]!), m.edges[0]!.routing, {
      anchors: { source: m.edges[0]!.sourceAnchor, target: m.edges[0]!.targetAnchor },
      obstacles: [],
    });

    // What the same anchors resolve to once the node and edge are committed to the document.
    const accepted = addEdges(addNodes(doc, m.nodes), m.edges);
    const realAnchor = accepted.nodes.find((n) => n.id === 't')!;
    const realNode = accepted.nodes.find((n) => n.id === m.nodes[0]!.id)!;
    const realEdge = accepted.edges.find((e) => e.id === m.edges[0]!.id)!;
    const acceptedRoute = routeBetween(rectOf(realAnchor), rectOf(realNode), realEdge.routing, {
      anchors: { source: realEdge.sourceAnchor, target: realEdge.targetAnchor },
      obstacles: [],
    });

    expect(acceptedRoute.d).toBe(previewRoute.d);
  });
});

/* ------------------------------------------------------------------ */
/* Store: accept, undo, dismiss, identity                              */
/* ------------------------------------------------------------------ */


function resetStores(doc: DraftDocument) {
  __resetInteraction();
  __resetClipboardSync();
  useEditorStore.setState({
    document: doc,
    history: { past: [], future: [] },
    selection: { nodes: [], edges: [] },
    clipboard: null,
    pasteRepeat: 0,
    revision: 0,
  });
  useUiStore.getState().resetContinuation();
  useUiStore.getState().setContinuationsEnabled(true);
}

function selectOffer(anchor: string): ContinuationOffer {
  const doc = useEditorStore.getState().document;
  const [first] = continuationsFor(doc, anchor, 'select', useUiStore.getState().continuationDismissals);
  return { ...materialize(doc, first!)!, trigger: 'select' };
}

describe('editorStore.acceptContinuation', () => {
  beforeEach(() => resetStores(graph([service('pub'), topic('t')], [['pub', 't']])));

  it('commits the previewed nodes and connectors as one undo entry and selects the new node', () => {
    const offer = selectOffer('t');
    useUiStore.getState().setContinuation(offer);
    useEditorStore.getState().acceptContinuation(offer);

    const state = useEditorStore.getState();
    expect(state.history.past).toHaveLength(1);
    expect(state.history.past[0]!.label).toBe('Add Queue');
    expect(state.document.nodes.map((n) => n.id)).toContain(offer.primaryNodeId);
    expect(state.document.edges.some((e) => e.id === offer.edges[0]!.id)).toBe(true);
    expect(state.selection).toEqual({ nodes: [offer.primaryNodeId], edges: [] });
    expect(useUiStore.getState().continuation).toBeNull();
    expect(useUiStore.getState().settleNodeId).toBe(offer.primaryNodeId);

    state.undo();
    expect(useEditorStore.getState().document.nodes).toHaveLength(2);
    expect(useEditorStore.getState().document.edges).toHaveLength(1);
    useEditorStore.getState().redo();
    expect(useEditorStore.getState().document.nodes.map((n) => n.id)).toContain(offer.primaryNodeId);
  });

  it('chains: after accepting the Queue, the new Queue itself has a Worker offer', () => {
    const offer = selectOffer('t');
    useEditorStore.getState().acceptContinuation(offer);
    expect(ids(useEditorStore.getState().document, offer.primaryNodeId, 'select')).toEqual(['queue-consumer']);
  });

  it('ignores an offer whose anchor no longer exists', () => {
    const offer = selectOffer('t');
    useEditorStore.getState().deleteSelection();
    useEditorStore.setState({ document: { ...useEditorStore.getState().document, nodes: [] , edges: [] } });
    useEditorStore.getState().acceptContinuation(offer);
    expect(useEditorStore.getState().document.nodes).toHaveLength(0);
  });
});

describe('uiStore continuation state', () => {
  beforeEach(() => resetStores(graph([service('pub'), topic('t')], [['pub', 't']])));

  it('keeps the same node/edge ids when an equal offer is set again', () => {
    const a = selectOffer('t');
    useUiStore.getState().setContinuation(a);
    const b = selectOffer('t');
    // materialize mints a fresh random id every call — this is the raw material of the flicker bug.
    expect(b.nodes[0]!.id).not.toBe(a.nodes[0]!.id);
    useUiStore.getState().setContinuation(b);
    const current = useUiStore.getState().continuation!;
    expect(current.nodes[0]!.id).toBe(a.nodes[0]!.id);
    expect(current.edges[0]!.id).toBe(a.edges[0]!.id);
    expect(current.primaryNodeId).toBe(a.primaryNodeId);
  });

  it('re-keys a same-identity offer onto the ids already held even when its geometry moved, and remaps edge endpoints to match', () => {
    const a = selectOffer('t');
    useUiStore.getState().setContinuation(a);
    // A same-identity recompute that landed somewhere new (e.g. an obstacle moved) — simulated
    // directly rather than via a real placement change, so this test isolates `reidentify` itself.
    const b: ContinuationOffer = {
      ...a,
      nodes: [{ ...a.nodes[0]!, id: 'fresh-node-id', x: a.nodes[0]!.x + 40, y: a.nodes[0]!.y + 40 }],
      edges: [{ ...a.edges[0]!, id: 'fresh-edge-id', target: 'fresh-node-id' }],
      primaryNodeId: 'fresh-node-id',
    };
    useUiStore.getState().setContinuation(b);
    const current = useUiStore.getState().continuation!;
    // Ids stay the ones the ghost already rendered with — no React remount.
    expect(current.nodes[0]!.id).toBe(a.nodes[0]!.id);
    expect(current.edges[0]!.id).toBe(a.edges[0]!.id);
    expect(current.primaryNodeId).toBe(a.primaryNodeId);
    // The edge's endpoint is remapped along with the node it points at, not left dangling on the
    // fresh id `materialize` minted.
    expect(current.edges[0]!.target).toBe(a.nodes[0]!.id);
    // But the actual content — the reason this offer exists — did update.
    expect(current.nodes[0]!.x).toBe(a.nodes[0]!.x + 40);
    expect(current.nodes[0]!.y).toBe(a.nodes[0]!.y + 40);
  });

  it('replaces the offer entirely (fresh ids and all) when the new one is a genuinely different suggestion', () => {
    useUiStore.getState().setContinuation(selectOffer('t'));
    const queueOffer = useUiStore.getState().continuation!;
    useEditorStore.getState().acceptContinuation(queueOffer);
    const workerOffer = selectOffer(queueOffer.primaryNodeId);
    useUiStore.getState().setContinuation(workerOffer);
    expect(useUiStore.getState().continuation).toBe(workerOffer);
  });

  it('dismiss records the offer against its neighborhood and clears it without touching the document', () => {
    const offer = selectOffer('t');
    useUiStore.getState().setContinuation(offer);
    const revision = useEditorStore.getState().revision;
    useUiStore.getState().dismissContinuation();
    expect(useUiStore.getState().continuation).toBeNull();
    expect(useEditorStore.getState().revision).toBe(revision);
    expect(useEditorStore.getState().history.past).toHaveLength(0);
    const doc = useEditorStore.getState().document;
    expect(ids(doc, 't', 'select', useUiStore.getState().continuationDismissals)).toEqual([]);
  });

  it('turning the preference off clears the current offer; resetContinuation forgets dismissals', () => {
    useUiStore.getState().setContinuation(selectOffer('t'));
    useUiStore.getState().setContinuationsEnabled(false);
    expect(useUiStore.getState().continuation).toBeNull();
    useUiStore.getState().setContinuationsEnabled(true);
    useUiStore.getState().setContinuation(selectOffer('t'));
    useUiStore.getState().dismissContinuation();
    expect(useUiStore.getState().continuationDismissals.size).toBe(1);
    useUiStore.getState().resetContinuation();
    expect(useUiStore.getState().continuationDismissals.size).toBe(0);
  });
});

describe('commands: Add <label> (suggested)', () => {
  beforeEach(() => resetStores(graph([service('pub'), topic('t')], [['pub', 't']])));

  function ctx(): CommandContext {
    return {
      editor: useEditorStore.getState(),
      ui: useUiStore.getState(),
      camera: {
        fitView: () => Promise.resolve(true),
        zoomIn: () => Promise.resolve(true),
        zoomOut: () => Promise.resolve(true),
        screenToFlowPosition: (p: { x: number; y: number }) => p,
        setViewport: () => Promise.resolve(true),
        viewWidth: 1000,
        viewHeight: 800,
      },
      playback: { active: false, flowId: null, step: 0, start: () => {}, stop: () => {}, next: () => {}, prev: () => {} },
      createAt: () => undefined as never,
      createAtPointer: () => undefined as never,
    } as unknown as CommandContext;
  }

  it('leads the node commands for a Topic with a publisher, and runs the same accept', () => {
    const topicNode = useEditorStore.getState().document.nodes.find((n) => n.id === 't')!;
    const commands = nodeCommands(ctx(), topicNode);
    expect(commands[0]!.id).toBe('accept-continuation');
    expect(commands[0]!.title).toBe('Add Queue');
    expect(commands[0]!.shortcut).toBe('Tab');
    commands[0]!.run(ctx());
    expect(useEditorStore.getState().document.nodes).toHaveLength(3);
    expect(useEditorStore.getState().history.past[0]!.label).toBe('Add Queue');
  });

  it('is absent when the preference is off or there is nothing to suggest', () => {
    const topicNode = useEditorStore.getState().document.nodes.find((n) => n.id === 't')!;
    useUiStore.getState().setContinuationsEnabled(false);
    expect(nodeCommands(ctx(), topicNode).some((c) => c.id === 'accept-continuation')).toBe(false);
    useUiStore.getState().setContinuationsEnabled(true);
    const pub = useEditorStore.getState().document.nodes.find((n) => n.id === 'pub')!;
    expect(nodeCommands(ctx(), pub).some((c) => c.id === 'accept-continuation')).toBe(false);
  });
});

/* ------------------------------------------------------------------ */
/* Performance — a proxy for the full profiling pass this repo's tooling  */
/* can't automate: not a tight benchmark, just a guard against an          */
/* accidental full-document scan creeping back in.                          */
/* ------------------------------------------------------------------ */

describe('performance — local neighborhoods, not full-graph scans', () => {
  it('stays fast on a large diagram unrelated to the anchor', () => {
    const nodeSpecs: Spec[] = [];
    const edges: Array<[string, string]> = [];
    for (let i = 0; i < 150; i++) {
      nodeSpecs.push(service(`s${i}`));
      if (i > 0) edges.push([`s${i - 1}`, `s${i}`]);
    }
    // A genuine continuation target, unrelated to the other 150 nodes except by sharing a document.
    nodeSpecs.push(topic('t'));
    edges.push(['s149', 't']);
    const doc = graph(nodeSpecs, edges);

    const start = performance.now();
    for (let i = 0; i < 50; i++) {
      const [offer] = continuationsFor(doc, 't', 'select');
      materialize(doc, offer!);
    }
    const elapsed = performance.now() - start;
    // Generous ceiling to absorb CI variance — the point is "milliseconds for 50 runs against a
    // 150-node document," not a tight benchmark. A real regression (an accidental full-document
    // scan somewhere in the pipeline) would blow past this by orders of magnitude, not a fraction.
    expect(elapsed).toBeLessThan(500);
  });
});

/* ------------------------------------------------------------------ */
/* docs/SEMANTICS.md stays in step with the rules                       */
/* ------------------------------------------------------------------ */

describe('docs/SEMANTICS.md rules table', () => {
  it('lists exactly the shipped rules, in order, with their authored reasons', () => {
    const doc = readFileSync(resolve(__dirname, '../docs/SEMANTICS.md'), 'utf8');
    const block = doc.split('<!-- continuation-rules:start')[1]?.split('<!-- continuation-rules:end -->')[0] ?? '';
    const rows = block
      .split('\n')
      .filter((line) => line.startsWith('| `'))
      .map((line) => line.split('|').map((cell) => cell.trim()).filter(Boolean));
    expect(rows).toEqual(RULES.map((rule) => [`\`${rule.id}\``, rule.tier, rule.label, rule.reason]));
  });
});
