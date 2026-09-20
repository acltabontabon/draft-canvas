import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { nodeCommands } from '../src/commands/registry';
import type { CommandContext } from '../src/commands/types';
import { __resetClipboardSync, __resetInteraction, useEditorStore } from '../src/store/editorStore';
import { useUiStore, type ContinuationOffer } from '../src/store/uiStore';
import {
  continuationSets,
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
import { addFlow, createFlow } from '../src/document/flow';
import { addEdges, addNodes, placeNear } from '../src/document/operations';
import { flattenPath, rectOf, routeBetween, routeEdge } from '../src/edges/routing';
import type { CreateNodeInput } from '../src/document/factory';
import type { DraftDocument, DraftNode, ViewLevel } from '../src/document/types';

/* ------------------------------------------------------------------ */
/* Fixture vocabulary — real factory + operations, nothing bespoke.    */
/* ------------------------------------------------------------------ */

type Spec = Omit<CreateNodeInput, 'x' | 'y'> & { id: string; x?: number; y?: number };

function graph(nodes: Spec[], edges: Array<[string, string]>, level?: ViewLevel): DraftDocument {
  const built = nodes.map((spec, i) => createNode({ x: i * 480, y: 0, ...spec }));
  const byId = new Map(built.map((n) => [n.id, n]));
  let doc = addNodes(createDocument('Continuation'), built);
  doc = addEdges(
    doc,
    edges.map(([source, target]) =>
      createEdge({ source, target, ...inferRelationship(byId.get(source)!, byId.get(target)!), semanticsOrigin: 'inferred' }),
    ),
  );
  return level ? { ...doc, level } : doc;
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
const component = (id: string): Spec => ({ id, type: 'component' });
const actor = (id: string): Spec => ({ id, type: 'actor' });

/**
 * Which connectors a rect lands on. Deliberately derived here rather than from
 * `edges/clearance.ts` — a test that asked the implementation where it thought the lines were
 * would agree with itself no matter what it got wrong. This routes every connector for real.
 */
function crossedConnectors(doc: DraftDocument, rect: { x: number; y: number; width: number; height: number }): string[] {
  const byId = new Map(doc.nodes.map((node) => [node.id, node]));
  const inside = (p: { x: number; y: number }) =>
    p.x >= rect.x && p.x <= rect.x + rect.width && p.y >= rect.y && p.y <= rect.y + rect.height;
  type P = { x: number; y: number };
  const side = (o: P, p: P, q: P) => (p.x - o.x) * (q.y - o.y) - (p.y - o.y) * (q.x - o.x);
  const corners = [
    { x: rect.x, y: rect.y },
    { x: rect.x + rect.width, y: rect.y },
    { x: rect.x + rect.width, y: rect.y + rect.height },
    { x: rect.x, y: rect.y + rect.height },
  ];
  const hits = (a: P, b: P) => {
    if (inside(a) || inside(b)) return true;
    return corners.some((c, i) => {
      const d = corners[(i + 1) % corners.length]!;
      const [d1, d2, d3, d4] = [side(a, b, c), side(a, b, d), side(c, d, a), side(c, d, b)];
      return d1 > 0 !== d2 > 0 && d3 > 0 !== d4 > 0;
    });
  };
  return doc.edges
    .filter((edge) => {
      const route = routeEdge(edge, byId);
      if (!route) return false;
      const points = flattenPath(route.d);
      return points.some((point, i) => i > 0 && hits(points[i - 1]!, point));
    })
    .map((edge) => `${edge.source}->${edge.target}`);
}

const ids = (doc: DraftDocument, anchor: string, trigger: ContinuationTrigger, dismissed?: ReadonlySet<string>) =>
  continuationsFor(doc, anchor, trigger, { dismissed }).map((c) => c.ruleId);

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
    drop: ['topic-fan-out-queue', 'topic-subscriber', 'topic-fan-out-worker'],
  },
  {
    name: 'Topic with no edges at all — no evidence on select, offered on explicit drop',
    doc: graph([topic('t')], []),
    anchor: 't',
    select: [],
    drop: ['topic-fan-out-queue', 'topic-subscriber', 'topic-fan-out-worker'],
  },
  {
    name: 'Topic already fanning into a Queue — silent on select, another Queue first on drop',
    doc: graph([service('pub'), topic('t'), queue('q')], [['pub', 't'], ['t', 'q']]),
    anchor: 't',
    select: [],
    drop: ['topic-fan-out-queue', 'topic-subscriber', 'topic-fan-out-worker'],
  },
  {
    name: 'Topic with a Queue → Worker subscriber — silent on select, another whole subscriber first on drop',
    doc: graph([service('pub'), topic('t'), queue('q'), worker('w')], [['pub', 't'], ['t', 'q'], ['q', 'w']]),
    anchor: 't',
    select: [],
    drop: ['topic-subscriber', 'topic-fan-out-queue', 'topic-fan-out-worker'],
  },
  {
    name: 'Topic delivering straight to a Service — silent on select, another direct subscriber first on drop',
    doc: graph([service('pub'), topic('t'), service('sub')], [['pub', 't'], ['t', 'sub']]),
    anchor: 't',
    select: [],
    drop: ['topic-fan-out-worker', 'topic-fan-out-queue', 'topic-subscriber'],
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
    name: 'Queue with a Worker consumer — silent on select; on drop the DLQ outranks another consumer',
    doc: graph([service('s'), queue('q'), worker('w')], [['s', 'q'], ['q', 'w']]),
    anchor: 'q',
    select: [],
    drop: ['queue-dead-letter', 'queue-consumer'],
  },
  {
    name: 'Queue whose consumer is a plain Service — counts as consumed (compared on semantic)',
    doc: graph([service('s'), queue('q'), service('c')], [['s', 'q'], ['q', 'c']]),
    anchor: 'q',
    select: [],
    drop: ['queue-dead-letter', 'queue-consumer'],
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
    drop: ['stream-dead-letter', 'queue-consumer'],
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
    it(`${c.name} (confidence: select is exactly the high-confidence slice of invoke)`, () => {
      const high = continuationsFor(c.doc, c.anchor, 'invoke')
        .filter((candidate) => candidate.confidence === 'high')
        .map((candidate) => candidate.ruleId);
      expect(high).toEqual(c.select);
    });
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

  it('with no contextual signal, orders primaries before secondaries regardless of declaration order', () => {
    const rule = (id: string, tier: ContinuationRule['tier']): ContinuationRule => ({
      id,
      tier,
      label: id,
      reason: 'test.',
      when: (_nb, trigger) => trigger !== 'select',
      fragment: () => ({ nodes: [{ key: 'q', type: 'queue', queueKind: 'queue' }], edges: [{ from: 'anchor', to: 'q' }] }),
    });
    const doc = graph([topic('t')], []);
    const offered = continuationsFor(doc, 't', 'drop', { rules: [rule('late', 'secondary'), rule('early', 'primary')] });
    expect(offered.map((c) => c.id)).toEqual(['early', 'late']);
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
    expect(continuationsFor(doc, 'q', 'drop', { rules: [rule] })).toEqual([]);
  });

  it('drops a rule whose fragment pairing has no matrix row at all (actor → database)', () => {
    const rule: ContinuationRule = {
      ...always,
      id: 'bad-actor-to-db',
      fragment: () => ({ nodes: [{ key: 'db', type: 'database' }], edges: [{ from: 'anchor', to: 'db' }] }),
    };
    expect(capabilityFor('actor', 'database')).toBeUndefined();
    expect(continuationsFor(graph([actor('u')], []), 'u', 'drop', { rules: [rule] })).toEqual([]);
  });

  it('drops a rule whose fragment adds nodes but no connector', () => {
    const rule: ContinuationRule = {
      ...always,
      id: 'orphan',
      fragment: () => ({ nodes: [{ key: 'w', type: 'service' }], edges: [] }),
    };
    expect(continuationsFor(graph([queue('q')], []), 'q', 'drop', { rules: [rule] })).toEqual([]);
  });

  it('every shipped rule produces matrix-valid fragments from a neighborhood it fires on', () => {
    const anchors: Record<string, DraftDocument> = {
      'topic-fan-out-queue': graph([service('p'), topic('t')], [['p', 't']]),
      'topic-subscriber': graph([service('p'), topic('t')], [['p', 't']]),
      'service-data-store': graph([service('t')], []),
      'service-topic': graph([service('t')], []),
      'service-queue': graph([service('t')], []),
      'service-service': graph([service('t')], []),
      'service-cache': graph([service('t')], []),
      'service-external': graph([service('t')], []),
      'service-search-index': graph([service('t'), database('db')], [['t', 'db']]),
      'actor-gateway': graph([actor('t')], []),
      'actor-api': graph([actor('t')], []),
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
      'adapter-port': graph([{ id: 't', type: 'component', componentKind: 'adapter' }], []),
      'worker-indexes': graph([service('p'), worker('t')], [['p', 't']]),
      // Level-gated rules (see `ContinuationRule.levels`) only fire where the view has been said
      // to be one — the fixture says so the same way the editor does.
      'person-system': graph([actor('t')], [], 'context'),
      'person-external': graph([actor('t')], [], 'context'),
      'component-component': graph([component('t')], [], 'component'),
      'component-adapter': graph([component('t')], [], 'component'),
      'component-data-store': graph([component('t')], [], 'component'),
    };
    for (const rule of RULES) {
      const doc = anchors[rule.id];
      expect(doc, `no fixture for ${rule.id}`).toBeDefined();
      const nb = neighborhoodOf(doc!, 't', doc!.level)!;
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
    // The secondaries are different rules — still offered on drop.
    expect(ids(doc, 't', 'drop', dismissed)).toEqual(['topic-subscriber', 'topic-fan-out-worker']);
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
    expect(m.continueFromId).toBe(node.id);
    const edge = m.edges[0]!;
    expect(edge.source).toBe('q');
    expect(edge.target).toBe(node.id);
    expect(edge.semantic).toBe('deadLetters');
    expect(edge.kind).toBe('failure');
    expect(edge.async).toBe(true);
    expect(edge.semanticsOrigin).toBe('inferred');
    expect(edge.deliveryAttempts).toBe(3);
    // Directly right of the queue is where this used to go, and it put the dead-letter queue on
    // top of the `q -> w` connector and its caption both. Placement steps off a connector when it
    // can (#15), so the DLQ hangs below the queue instead — which is where one is usually drawn.
    const anchor = doc.nodes.find((n) => n.id === 'q')!;
    expect(node.x).toBe(anchor.x);
    expect(node.y).toBeGreaterThan(anchor.y + anchor.height);
    expect(crossedConnectors(doc, node)).toEqual([]);
    // Vertical companion → the tube's own top and bottom.
    expect(edge.sourceAnchor?.side).toBe('bottom');
    expect(edge.targetAnchor?.side).toBe('top');
  });

  /*
   * Connectors are a *preference*, never an obstacle. Placement failing is how a suggestion
   * silently disappears, so every case below that has somewhere better to go takes it, and every
   * case that doesn't still lands exactly where it always did.
   */
  describe('steps off the connectors already drawn there', () => {
    it('does not sit on the anchor\'s own outgoing connector when a neighbouring slot is free', () => {
      // `a` calls `b` away to the right; the slot directly right of `a` is empty of nodes but the
      // connector runs straight through it.
      const base = graph([service('a'), service('b')], [['a', 'b']]);
      const doc = { ...base, nodes: base.nodes.map((n) => (n.id === 'b' ? { ...n, x: 1100 } : n)) };
      const [offer] = continuationsFor(doc, 'a', 'invoke');
      const node = materialize(doc, offer!)!.nodes[0]!;
      expect(crossedConnectors(doc, node)).toEqual([]);
      expect(node.y).toBeGreaterThan(doc.nodes.find((n) => n.id === 'a')!.y);
    });

    it('keeps clear of a connector running past the anchor that it has nothing to do with', () => {
      // `up -> down` passes vertically through the slot to the right of the topic, touching neither end.
      const built = [
        createNode({ id: 'pub', type: 'service', x: 0, y: 0 }),
        createNode({ id: 't', type: 'queue', queueKind: 'topic', x: 480, y: 0 }),
        createNode({ id: 'up', type: 'service', x: 760, y: -420 }),
        createNode({ id: 'down', type: 'service', x: 760, y: 420 }),
      ];
      let doc = addNodes(createDocument('Crossing'), built);
      doc = addEdges(doc, [
        createEdge({ source: 'pub', target: 't', ...inferRelationship(built[0]!, built[1]!), semanticsOrigin: 'inferred' }),
        createEdge({ source: 'up', target: 'down', ...inferRelationship(built[2]!, built[3]!), semanticsOrigin: 'inferred' }),
      ]);
      const [offer] = continuationsFor(doc, 't', 'select');
      const node = materialize(doc, offer!)!.nodes[0]!;
      expect(crossedConnectors(doc, node)).toEqual([]);
    });

    it('never overrules staying inside the host\'s boundary', () => {
      // The candidate inside the boundary is crossed by a connector; the ones outside are not.
      // Membership is meaning and cosmetics do not get to trade it away.
      const built = [
        createNode({ id: 'b', type: 'group', x: -60, y: -120, width: 900, height: 560 }),
        createNode({ id: 'pub', type: 'service', x: 0, y: 0 }),
        createNode({ id: 't', type: 'queue', queueKind: 'topic', x: 0, y: 260 }),
        createNode({ id: 'far', type: 'service', serviceKind: 'worker', x: 640, y: 260 }),
      ];
      let doc = addNodes(createDocument('Bounded'), [
        built[0]!,
        { ...built[1]!, parentId: 'b' },
        { ...built[2]!, parentId: 'b' },
        { ...built[3]!, parentId: 'b' },
      ]);
      doc = addEdges(doc, [
        createEdge({ source: 'pub', target: 't', ...inferRelationship(built[1]!, built[2]!), semanticsOrigin: 'inferred' }),
        createEdge({ source: 't', target: 'far', ...inferRelationship(built[2]!, built[3]!), semanticsOrigin: 'inferred' }),
      ]);
      const [offer] = continuationsFor(doc, 't', 'invoke');
      const node = materialize(doc, offer!)!.nodes[0]!;
      expect(node.parentId).toBe('b');
    });

    it('leaves an explicit drop position alone — the user said where', () => {
      const base = graph([service('a'), service('b')], [['a', 'b']]);
      const doc = { ...base, nodes: base.nodes.map((n) => (n.id === 'b' ? { ...n, x: 1100 } : n)) };
      const [offer] = continuationsFor(doc, 'a', 'invoke');
      const at = { x: 300, y: 6 };
      const node = materialize(doc, offer!, { at })!.nodes[0]!;
      expect({ x: node.x, y: node.y }).toEqual(at);
    });
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
  const [first] = continuationsFor(doc, anchor, 'select', { dismissed: useUiStore.getState().continuationDismissals });
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
    expect(state.document.nodes.map((n) => n.id)).toContain(offer.continueFromId);
    expect(state.document.edges.some((e) => e.id === offer.edges[0]!.id)).toBe(true);
    expect(state.selection).toEqual({ nodes: [offer.continueFromId], edges: [] });
    expect(useUiStore.getState().continuation).toBeNull();
    expect(useUiStore.getState().settleNodeIds).toEqual([offer.continueFromId]);

    state.undo();
    expect(useEditorStore.getState().document.nodes).toHaveLength(2);
    expect(useEditorStore.getState().document.edges).toHaveLength(1);
    useEditorStore.getState().redo();
    expect(useEditorStore.getState().document.nodes.map((n) => n.id)).toContain(offer.continueFromId);
  });

  it('chains: after accepting the Queue, the new Queue itself has a Worker offer', () => {
    const offer = selectOffer('t');
    useEditorStore.getState().acceptContinuation(offer);
    expect(ids(useEditorStore.getState().document, offer.continueFromId, 'select')).toEqual(['queue-consumer']);
  });

  it('never touches flows: an accept adds drawing, not narration', () => {
    const doc = useEditorStore.getState().document;
    const flow = { ...createFlow({ title: 'Publish' }), steps: [{ id: 'st1', edgeId: doc.edges[0]!.id }] };
    resetStores(addFlow(doc, flow));
    const before = useEditorStore.getState().document.flows;
    useEditorStore.getState().acceptContinuation(selectOffer('t'));
    expect(useEditorStore.getState().document.flows).toBe(before);
  });

  it('remembers the accepted rule for ranking, newest last and capped', () => {
    for (let i = 0; i < 14; i++) useUiStore.getState().recordContinuationAccepted(`r${i}`);
    useEditorStore.getState().acceptContinuation(selectOffer('t'));
    const recent = useUiStore.getState().continuationRecent;
    expect(recent).toHaveLength(12);
    expect(recent.at(-1)).toBe('topic-fan-out-queue');
  });

  it('settle markers expire on their own, and a newer accept is not cut short by an older one', () => {
    vi.useFakeTimers();
    try {
      useUiStore.getState().setSettleNodeIds(['a', 'b']);
      vi.advanceTimersByTime(200);
      useUiStore.getState().setSettleNodeIds(['c']);
      vi.advanceTimersByTime(200);
      expect(useUiStore.getState().settleNodeIds).toEqual(['c']);
      vi.advanceTimersByTime(100);
      expect(useUiStore.getState().settleNodeIds).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not remember a Quick Connect preset row as an accepted rule', () => {
    const offer = selectOffer('t');
    useEditorStore.getState().acceptContinuation({ ...offer, id: 'preset:queue', ruleId: 'preset:queue' });
    expect(useUiStore.getState().continuationRecent).not.toContain('preset:queue');
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
    expect(current.continueFromId).toBe(a.continueFromId);
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
      continueFromId: 'fresh-node-id',
    };
    useUiStore.getState().setContinuation(b);
    const current = useUiStore.getState().continuation!;
    // Ids stay the ones the ghost already rendered with — no React remount.
    expect(current.nodes[0]!.id).toBe(a.nodes[0]!.id);
    expect(current.edges[0]!.id).toBe(a.edges[0]!.id);
    expect(current.continueFromId).toBe(a.continueFromId);
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
    const workerOffer = selectOffer(queueOffer.continueFromId);
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

  it('Escape ends continuation at the anchor — every candidate, not just the one showing — until its neighborhood changes', () => {
    const doc = useEditorStore.getState().document;
    const twoStrong: ContinuationRule[] = ['first', 'second'].map((id) => ({
      id,
      tier: 'primary',
      label: id,
      reason: 'test.',
      when: () => true,
      fragment: () => ({ nodes: [{ key: 'q', type: 'queue', queueKind: 'queue' }], edges: [{ from: 'anchor', to: 'q' }] }),
      repeatable: () => true,
    }));
    const [first] = continuationsFor(doc, 't', 'select', { rules: twoStrong });
    useUiStore.getState().setContinuation({ ...materialize(doc, first!)!, trigger: 'select' });
    useUiStore.getState().dismissContinuation();
    const dismissed = useUiStore.getState().continuationDismissals;
    expect(continuationsFor(doc, 't', 'select', { rules: twoStrong, dismissed })).toEqual([]);
    // Asking explicitly still answers — Escape means "not unprompted", never "never".
    expect(continuationsFor(doc, 't', 'invoke', { rules: twoStrong }).map((c) => c.id)).toEqual(['first', 'second']);
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
/* Ranking, fragments, naming                                           */
/* ------------------------------------------------------------------ */

describe('ranking — asked-for alternatives', () => {
  it('a plain Service is silent unprompted and in the picker, but has a short list when asked', () => {
    const doc = graph([service('s')], []);
    expect(ids(doc, 's', 'select')).toEqual([]);
    expect(ids(doc, 's', 'drop')).toEqual([]);
    expect(ids(doc, 's', 'invoke')).toEqual([
      'service-data-store',
      'service-topic',
      'service-queue',
      'service-service',
      'service-cache',
      'service-external',
    ]);
  });

  it('pushes down what the anchor already does — same verb to the same kind of thing — and nothing else', () => {
    const doc = graph([service('s'), database('db')], [['s', 'db']]);
    const order = ids(doc, 's', 'invoke');
    expect(order.at(-1)).toBe('service-data-store');
    // A Cache is also `writes`, but not another Data Store: not demoted.
    expect(order.indexOf('service-cache')).toBeLessThan(order.indexOf('service-data-store'));
  });

  it('an Actor gets where a request enters, only when asked', () => {
    const doc = graph([actor('u')], []);
    expect(ids(doc, 'u', 'select')).toEqual([]);
    expect(ids(doc, 'u', 'invoke')).toEqual(['actor-gateway', 'actor-api']);
  });

  it('recently accepted rules get a nudge among optional candidates, never a promotion to unprompted', () => {
    const doc = graph([service('s')], []);
    const recent = ['service-cache'];
    expect(continuationsFor(doc, 's', 'invoke', { recent })[0]!.ruleId).toBe('service-cache');
    expect(continuationsFor(doc, 's', 'select', { recent })).toEqual([]);
  });

  it('confidence always dominates signals: the quiet suggestion stays first however the rest score', () => {
    const doc = graph([service('pub'), topic('t')], [['pub', 't']]);
    const offered = continuationsFor(doc, 't', 'invoke', { recent: ['topic-subscriber', 'topic-fan-out-worker'] });
    expect(offered[0]!.confidence).toBe('high');
    expect(offered[0]!.ruleId).toBe('topic-fan-out-queue');
  });

  it('is deterministic for the explicit trigger too', () => {
    const doc = graph([service('pub'), topic('t'), queue('q'), worker('w')], [['pub', 't'], ['t', 'q'], ['q', 'w']]);
    const first = continuationsFor(doc, 't', 'invoke');
    for (let i = 0; i < 3; i++) expect(continuationsFor(doc, 't', 'invoke')).toEqual(first);
  });
});

describe('a Service asks its neighborhood what comes next', () => {
  // The same six alternatives every time — what changes is which one `]` lands on first.
  const SIX = ['service-data-store', 'service-topic', 'service-queue', 'service-service', 'service-cache', 'service-external'];

  it('alone on the canvas, keeps the authored order: nothing points at it, so there is nothing to read', () => {
    expect(ids(graph([service('s')], []), 's', 'invoke')).toEqual(SIX);
  });

  it('behind a Gateway, leads with its own data, then what keeps those reads fast', () => {
    const doc = graph([gateway('gw'), service('s')], [['gw', 's']]);
    expect(ids(doc, 's', 'invoke')).toEqual([
      'service-data-store',
      'service-cache',
      'service-service',
      'service-topic',
      'service-queue',
      'service-external',
    ]);
  });

  it('reads an Actor calling it the same way a Gateway routing to it reads', () => {
    const viaGateway = ids(graph([gateway('gw'), service('s')], [['gw', 's']]), 's', 'invoke');
    const viaActor = ids(graph([actor('u'), service('s')], [['u', 's']]), 's', 'invoke');
    expect(viaActor).toEqual(viaGateway);
  });

  it('fed by a Queue, leads with where the result lands, then what it announces', () => {
    const doc = graph([queue('q'), service('s')], [['q', 's']]);
    expect(ids(doc, 's', 'invoke')).toEqual([
      'service-data-store',
      'service-topic',
      'service-external',
      'service-queue',
      'service-service',
      'service-cache',
    ]);
  });

  it('is genuinely a different answer per neighborhood, not the same list reshuffled by luck', () => {
    const behindGateway = ids(graph([gateway('gw'), service('s')], [['gw', 's']]), 's', 'invoke');
    const onAQueue = ids(graph([queue('q'), service('s')], [['q', 's']]), 's', 'invoke');
    const alone = ids(graph([service('s')], []), 's', 'invoke');
    expect(behindGateway).not.toEqual(onAQueue);
    expect(behindGateway).not.toEqual(alone);
    expect(onAQueue).not.toEqual(alone);
    // Same candidates throughout: a role reorders, it never adds or takes away.
    expect([...behindGateway].sort()).toEqual([...onAQueue].sort());
    expect([...behindGateway].sort()).toEqual([...alone].sort());
  });

  it('woken by a Scheduler, reaches outward before it publishes — where a Queue consumer does the reverse', () => {
    const scheduled = ids(graph([scheduler('cron'), service('s')], [['cron', 's']]), 's', 'invoke');
    expect(scheduled[0]).toBe('service-data-store');
    expect(scheduled.indexOf('service-external')).toBeLessThan(scheduled.indexOf('service-topic'));

    const consuming = ids(graph([queue('q'), service('s')], [['q', 's']]), 's', 'invoke');
    expect(consuming.indexOf('service-topic')).toBeLessThan(consuming.indexOf('service-external'));
  });

  it('a Worker is read the same way a Service is', () => {
    const order = ids(graph([queue('q'), worker('w')], [['q', 'w']]), 'w', 'invoke');
    expect(order[0]).toBe('service-data-store');
    expect(order.indexOf('service-topic')).toBeLessThan(order.indexOf('service-external'));
  });

  it('never argues a shape back up that the anchor already draws', () => {
    // Behind a gateway a Data Store would lead — but this one already has one, and that wins.
    const doc = graph([gateway('gw'), service('s'), database('db')], [['gw', 's'], ['s', 'db']]);
    const order = ids(doc, 's', 'invoke');
    expect(order[0]).toBe('service-cache');
    expect(order.at(-1)).toBe('service-data-store');
  });

  it('stays silent unprompted and in the picker, whatever its neighborhood says', () => {
    for (const doc of [
      graph([gateway('gw'), service('s')], [['gw', 's']]),
      graph([queue('q'), service('s')], [['q', 's']]),
      graph([scheduler('cron'), service('s')], [['cron', 's']]),
    ]) {
      expect(ids(doc, 's', 'select')).toEqual([]);
      expect(ids(doc, 's', 'drop')).toEqual([]);
    }
  });
});

describe('a Search Index is the one Service row that has to be earned', () => {
  it('is not offered to a Service with nothing to index', () => {
    expect(ids(graph([service('s')], []), 's', 'invoke')).not.toContain('service-search-index');
  });

  it('appears once the Service writes to a Data Store', () => {
    const doc = graph([service('s'), database('db')], [['s', 'db']]);
    expect(ids(doc, 's', 'invoke')).toContain('service-search-index');
  });

  it('a Cache is not something you build an index from', () => {
    const doc = graph([service('s'), { id: 'c', type: 'database', databaseKind: 'cache' }], [['s', 'c']]);
    expect(ids(doc, 's', 'invoke')).not.toContain('service-search-index');
  });

  it('goes away again once there is one', () => {
    const doc = graph([service('s'), database('db'), searchIndex('si')], [['s', 'db'], ['s', 'si']]);
    expect(ids(doc, 's', 'invoke')).not.toContain('service-search-index');
  });

  it('never appears unprompted, and never turns a plain Service into a ghost', () => {
    const doc = graph([service('s'), database('db')], [['s', 'db']]);
    expect(ids(doc, 's', 'select')).toEqual([]);
    expect(ids(doc, 's', 'drop')).toEqual([]);
  });

  it('leaves a Worker to the Worker rule, so the same shape is never listed twice', () => {
    for (const doc of [
      graph([queue('q'), worker('w')], [['q', 'w']]),
      graph([queue('q'), worker('w'), database('db')], [['q', 'w'], ['w', 'db']]),
    ]) {
      const offered = ids(doc, 'w', 'invoke');
      expect(offered).toContain('worker-indexes');
      expect(offered).not.toContain('service-search-index');
    }
  });
});

describe('compound fragments', () => {
  beforeEach(() =>
    resetStores(graph([service('pub'), topic('t'), queue('q'), worker('w')], [['pub', 't'], ['t', 'q'], ['q', 'w']])),
  );

  const subscriberOffer = (): ContinuationOffer => {
    const doc = useEditorStore.getState().document;
    const candidate = continuationsFor(doc, 't', 'invoke').find((c) => c.ruleId === 'topic-subscriber')!;
    return { ...materialize(doc, candidate)!, trigger: 'select' };
  };

  it('materializes the whole chain with matrix semantics, placed outward from the anchor without overlap', () => {
    const offer = subscriberOffer();
    expect(offer.label).toBe('Queue → Worker');
    expect(offer.nodes.map((n) => [n.type, n.queueKind ?? n.serviceKind])).toEqual([
      ['queue', 'queue'],
      ['service', 'worker'],
    ]);
    const [newQueue, newWorker] = offer.nodes;
    expect(offer.edges.map((e) => [e.source, e.target, e.semantic])).toEqual([
      ['t', newQueue!.id, 'fansOut'],
      [newQueue!.id, newWorker!.id, 'consumes'],
    ]);
    const doc = useEditorStore.getState().document;
    const rects = [...doc.nodes, ...offer.nodes].map(rectOf);
    for (let i = 0; i < rects.length; i++) {
      for (let j = i + 1; j < rects.length; j++) {
        const a = rects[i]!;
        const b = rects[j]!;
        const overlap = a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
        expect(overlap, `nodes ${i} and ${j} overlap`).toBe(false);
      }
    }
  });

  it('previewing persists nothing: no document write, no history', () => {
    const before = useEditorStore.getState().document;
    const revision = useEditorStore.getState().revision;
    useUiStore.getState().setContinuation(subscriberOffer());
    expect(useEditorStore.getState().document).toBe(before);
    expect(useEditorStore.getState().revision).toBe(revision);
    expect(useEditorStore.getState().history.past).toHaveLength(0);
  });

  it('accepts as one undo step, selects the tail so the chain can continue, and undo removes all of it', () => {
    const offer = subscriberOffer();
    useEditorStore.getState().acceptContinuation(offer);
    const state = useEditorStore.getState();
    expect(state.document.nodes).toHaveLength(6);
    expect(state.document.edges).toHaveLength(5);
    expect(state.history.past).toHaveLength(1);
    expect(state.history.past[0]!.label).toBe('Add Queue → Worker');
    expect(state.selection).toEqual({ nodes: [offer.nodes[1]!.id], edges: [] });
    expect(useUiStore.getState().settleNodeIds).toEqual(offer.nodes.map((n) => n.id));

    state.undo();
    expect(useEditorStore.getState().document.nodes).toHaveLength(4);
    expect(useEditorStore.getState().document.edges).toHaveLength(3);
  });

  it('keeps a whole fragment inside the anchor’s boundary when it fits', () => {
    const doc = useEditorStore.getState().document;
    const boundary = createNode({ id: 'b', type: 'group', x: -200, y: -400, width: 3200, height: 1200 });
    const inside = { ...addNodes(doc, [boundary]), nodes: [...doc.nodes.map((n) => ({ ...n, parentId: 'b' })), boundary] };
    const candidate = continuationsFor(inside, 't', 'invoke').find((c) => c.ruleId === 'topic-subscriber')!;
    const offer = materialize(inside, candidate)!;
    expect(offer.nodes.map((n) => n.parentId)).toEqual(['b', 'b']);
  });
});

describe('connecting to what is already drawn', () => {
  // Everything on one row, 300 apart: a 160-wide Service leaves a 140 gap — "right here".
  const at = (spec: Spec, x: number, y = 0): Spec => ({ ...spec, x, y });
  const named = (spec: Spec, text: string): Spec => ({ ...spec, text });

  // Order API → Order Service, with Order Events drawn nearby but not yet wired.
  const orderDoc = () =>
    graph(
      [
        at(named(service('api', { serviceKind: 'api' }), 'Order API'), -300),
        at(named(service('svc'), 'Order Service'), 0),
        at(named(topic('events'), 'Order Events'), 300),
      ],
      [['api', 'svc']],
    );

  it('offers the nearby Order Events instead of a new topic, previews only the connector, and never duplicates it', () => {
    const doc = orderDoc();
    const [best] = continuationsFor(doc, 'svc', 'select');
    expect(best!.id).toBe('connect-existing:events');
    expect(best!.confidence).toBe('high');
    expect(best!.actionLabel).toBe('Connect to Order Events');

    const offer = materialize(doc, best!)!;
    expect(offer.nodes).toEqual([]);
    expect(offer.edges).toHaveLength(1);
    expect(offer.edges[0]).toMatchObject({ source: 'svc', target: 'events', semantic: 'publishes', semanticsOrigin: 'inferred' });
    // Routes like a hand-drawn connector to it would — nothing pinned.
    expect(offer.edges[0]!.sourceAnchor).toBeUndefined();
    expect(offer.continueFromId).toBe('events');

    resetStores(doc);
    useEditorStore.getState().acceptContinuation(offer);
    const after = useEditorStore.getState();
    expect(after.document.nodes).toHaveLength(3);
    expect(after.document.edges).toHaveLength(2);
    expect(after.history.past[0]!.label).toBe('Connect to Order Events');
    // The sentence continues from the topic, which now has a publisher and nowhere to deliver.
    expect(after.selection.nodes).toEqual(['events']);
    expect(ids(after.document, 'events', 'select')).toEqual(['topic-fan-out-queue']);
  });

  it('two loose shapes that could each continue into the other are a coin toss: nothing unprompted', () => {
    const loose = graph([at(named(service('svc'), 'Order Service'), 0), at(named(topic('events'), 'Order Events'), 300)], []);
    expect(continuationsFor(loose, 'svc', 'select')).toEqual([]);
    expect(continuationsFor(loose, 'events', 'select')).toEqual([]);
    expect(continuationsFor(loose, 'svc', 'invoke')[0]!.id).toBe('connect-existing:events');
  });

  it('a name in common picks the right one of several: Payment Service → Payments DB, not Audit Log', () => {
    const doc = graph(
      [
        at(named(service('pay'), 'Payment Service'), 0),
        at(named(database('paydb'), 'Payments DB'), 300),
        at(named(database('audit'), 'Audit Log'), 0, 200),
      ],
      [],
    );
    expect(continuationsFor(doc, 'pay', 'select').map((c) => c.id)).toEqual(['connect-existing:paydb']);
    const asked = continuationsFor(doc, 'pay', 'invoke').map((c) => c.id);
    expect(asked[0]).toBe('connect-existing:paydb');
    expect(asked).toContain('connect-existing:audit');
  });

  it('several look-alikes and no name to tell them apart: nothing unprompted, all of them when asked', () => {
    const doc = graph([at(service('s'), 0), at(database('a'), 300), at(database('b'), 0, 200)], []);
    expect(continuationsFor(doc, 's', 'select')).toEqual([]);
    expect(continuationsFor(doc, 's', 'invoke').filter((c) => c.ruleId === 'connect-existing')).toHaveLength(2);
  });

  it('a kind word in the plural is still a kind word, not a shared name', () => {
    const doc = graph(
      [
        at(named(service('s'), 'Billing Streams'), 0),
        at(named(database('a'), 'Audit Streams'), 300),
        at(named(database('b'), 'Ledger'), 0, 200),
      ],
      [],
    );
    expect(continuationsFor(doc, 's', 'select')).toEqual([]);
  });

  it('continuationSets answers exactly what the select and invoke calls would, in one pass', () => {
    const fixtures = [
      graph([service('pub'), topic('t')], [['pub', 't']]),
      graph([at(named(service('pay'), 'Payment Service'), 0), at(named(database('paydb'), 'Payments DB'), 300), at(named(database('audit'), 'Audit Log'), 0, 200)], []),
      graph([at(named(service('svc'), 'Order Service'), 0), at(named(topic('events'), 'Order Events'), 300)], []),
    ];
    for (const doc of fixtures) {
      for (const node of doc.nodes) {
        const first = continuationsFor(doc, node.id, 'select')[0];
        const dismissed = new Set(first ? [dismissalKey(node.id, first.id, first.neighborhoodKey)] : []);
        const recent = ['topic-fan-out-queue'];
        const sets = continuationSets(doc, node.id, { dismissed, recent });
        expect(sets.quiet).toEqual(continuationsFor(doc, node.id, 'select', { dismissed, recent }));
        expect(sets.explicit).toEqual(continuationsFor(doc, node.id, 'invoke', { recent }));
      }
    }
  });

  it('skips targets that are already connected, far away, or in another boundary', () => {
    const connected = graph([at(service('s'), 0), at(database('db'), 300)], [['s', 'db']]);
    expect(continuationsFor(connected, 's', 'invoke').some((c) => c.ruleId === 'connect-existing')).toBe(false);

    const far = graph([at(service('s'), 0), at(database('db'), 2000)], []);
    expect(continuationsFor(far, 's', 'invoke').some((c) => c.ruleId === 'connect-existing')).toBe(false);

    const boundary = createNode({ id: 'b', type: 'group', x: 250, y: -100, width: 400, height: 300 });
    const base = graph([at(service('s'), 0), at(database('db'), 300)], []);
    const walled = { ...base, nodes: [...base.nodes.map((n) => (n.id === 'db' ? { ...n, parentId: 'b' } : n)), boundary] };
    expect(continuationsFor(walled, 's', 'invoke').some((c) => c.ruleId === 'connect-existing')).toBe(false);
  });

  it('skips a target already receiving that relationship from someone else', () => {
    const doc = graph(
      [at(named(service('s'), 'Order Service'), 0), at(named(topic('t'), 'Order Events'), 300), at(service('other'), 600)],
      [['other', 't']],
    );
    expect(continuationsFor(doc, 's', 'invoke').some((c) => c.ruleId === 'connect-existing')).toBe(false);
  });

  it('never suggests closing a loop back to what feeds the anchor', () => {
    // Service → Topic → Queue: from the Queue, the Service two hops up is not a consumer to wire.
    const doc = graph([at(service('s'), 0), at(topic('t'), 300), at(queue('q'), 600)], [['s', 't'], ['t', 'q']]);
    expect(continuationsFor(doc, 'q', 'invoke').some((c) => c.id === 'connect-existing:s')).toBe(false);
  });

  it('never suggests a shortcut to what the anchor already reaches two hops downstream', () => {
    // Topic → Queue → Worker: the Worker already gets the Topic's messages through its queue.
    const doc = graph([at(topic('t'), 0), at(queue('q'), 300), at(worker('w'), 300, 150)], [['t', 'q'], ['q', 'w']]);
    expect(continuationsFor(doc, 't', 'invoke').some((c) => c.id === 'connect-existing:w')).toBe(false);
  });

  it('an anchor already doing the same thing to the same kind of node only gets it when asked', () => {
    const doc = graph(
      [
        at(named(service('s'), 'Order Service'), 0),
        at(named(topic('t1'), 'Order Events'), 300),
        at(named(topic('t2'), 'Order Audit'), 0, 200),
      ],
      [['s', 't1']],
    );
    expect(continuationsFor(doc, 's', 'select')).toEqual([]);
    const asked = continuationsFor(doc, 's', 'invoke').find((c) => c.id === 'connect-existing:t2');
    expect(asked?.confidence).toBe('medium');
  });

  it('is never offered in the drop picker, and Escape at the anchor hides it like anything else', () => {
    const doc = orderDoc();
    expect(continuationsFor(doc, 'svc', 'drop')).toEqual([]);
    const [best] = continuationsFor(doc, 'svc', 'select');
    const dismissed = new Set([dismissalKey('svc', '*', best!.neighborhoodKey)]);
    expect(continuationsFor(doc, 'svc', 'select', { dismissed })).toEqual([]);
  });

  it('keeps a connect-only ghost’s connector id stable across recomputes', () => {
    const doc = orderDoc();
    resetStores(doc);
    const make = (): ContinuationOffer => ({ ...materialize(doc, continuationsFor(doc, 'svc', 'select')[0]!)!, trigger: 'select' });
    const first = make();
    useUiStore.getState().setContinuation(first);
    useUiStore.getState().setContinuation(make());
    expect(useUiStore.getState().continuation!.edges[0]!.id).toBe(first.edges[0]!.id);
  });

  it('accepting does nothing if the target was deleted in the meantime', () => {
    const doc = orderDoc();
    resetStores(doc);
    const offer: ContinuationOffer = { ...materialize(doc, continuationsFor(doc, 'svc', 'select')[0]!)!, trigger: 'select' };
    useEditorStore.setState({ document: { ...doc, nodes: doc.nodes.filter((n) => n.id !== 'events') } });
    useEditorStore.getState().acceptContinuation(offer);
    // Only the Order API → Order Service connector that was already there.
    expect(useEditorStore.getState().document.edges).toHaveLength(1);
    expect(useEditorStore.getState().history.past).toHaveLength(0);
  });
});

describe('naming', () => {
  it('a Worker after an explicitly named “Billing Queue” is “Billing Worker”, still an automatic name', () => {
    const doc = graph([service('s'), queue('q', { text: 'Billing Queue' })], [['s', 'q']]);
    const [offer] = continuationsFor(doc, 'q', 'select');
    const node = materialize(doc, offer!)!.nodes[0]!;
    expect(node.text).toBe('Billing Worker');
    expect(node.textOrigin).toBe('auto');
  });

  it('anything else keeps the factory default — including an unnamed queue’s Worker and every queue', () => {
    const unnamed = graph([service('s'), queue('q')], [['s', 'q']]);
    const [consumer] = continuationsFor(unnamed, 'q', 'select');
    expect(materialize(unnamed, consumer!)!.nodes[0]!.text).toBe('Worker');
    const named = graph([service('s'), { id: 't', type: 'queue', queueKind: 'topic', text: 'Order Events' }], [['s', 't']]);
    const [queueOffer] = continuationsFor(named, 't', 'select');
    expect(materialize(named, queueOffer!)!.nodes[0]!.text).toBe('');
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
    // And a crowded corner: a Service surrounded by 50 unconnected shapes it could connect to,
    // the worst case for the nearby scan.
    nodeSpecs.push({ ...service('hub'), x: 0, y: 5000 });
    for (let i = 0; i < 50; i++) nodeSpecs.push({ ...database(`near${i}`), x: ((i % 10) - 5) * 90, y: 5000 + (Math.floor(i / 10) - 2) * 90 });
    const doc = graph(nodeSpecs, edges);

    const start = performance.now();
    for (let i = 0; i < 50; i++) {
      // What one evaluation of the hook does: the quiet list, the alternatives, one materialize.
      const [offer] = continuationsFor(doc, 't', 'select');
      continuationsFor(doc, 't', 'invoke');
      materialize(doc, offer!);
      continuationsFor(doc, 'hub', 'select');
      continuationsFor(doc, 'hub', 'invoke');
    }
    const elapsed = performance.now() - start;
    // Generous ceiling to absorb CI variance — the point is "milliseconds for 50 runs against a
    // 150-node document," not a tight benchmark. A real regression (an accidental full-document
    // scan somewhere in the pipeline) would blow past this by orders of magnitude, not a fraction.
    expect(elapsed).toBeLessThan(500);
  });

  it('stays fast where placement actually has to look at connectors', () => {
    // The case above has one connector near its anchor and none near the other. This is the
    // opposite: a hub wired to 40 neighbours on every side, so the clearance pass can't take its
    // cheap way out and routes for real, once per `materialize`. Routing is the expensive thing
    // placement now touches, and `DEFAULT_LIMIT` is what bounds it — this is the test that notices
    // if that bound is ever removed.
    const nodeSpecs: Spec[] = [{ ...service('hub'), x: 0, y: 0 }];
    const edges: Array<[string, string]> = [];
    for (let i = 0; i < 40; i++) {
      const angle = (i / 40) * Math.PI * 2;
      nodeSpecs.push({ ...database(`d${i}`), x: Math.round(Math.cos(angle) * 520), y: Math.round(Math.sin(angle) * 520) });
      edges.push(['hub', `d${i}`]);
    }
    const doc = graph(nodeSpecs, edges);

    const start = performance.now();
    for (let i = 0; i < 50; i++) {
      const [offer] = continuationsFor(doc, 'hub', 'invoke');
      materialize(doc, offer!);
    }
    const elapsed = performance.now() - start;
    expect(elapsed).toBeLessThan(500);
  });
});

/* ------------------------------------------------------------------ */
/* docs/reference/semantics.md stays in step with the rules                       */
/* ------------------------------------------------------------------ */

describe('docs/reference/semantics.md rules table', () => {
  it('lists exactly the shipped rules, in order, with their authored reasons', () => {
    const doc = readFileSync(resolve(__dirname, '../docs/reference/semantics.md'), 'utf8');
    const block = doc.split('<!-- continuation-rules:start')[1]?.split('<!-- continuation-rules:end -->')[0] ?? '';
    const rows = block
      .split('\n')
      .filter((line) => line.startsWith('| `'))
      .map((line) => line.split('|').map((cell) => cell.trim()).filter(Boolean));
    expect(rows).toEqual(RULES.map((rule) => [`\`${rule.id}\``, rule.tier, rule.label, rule.reason]));
  });
});

/**
 * What a view says it is showing changes what "what next?" means.
 *
 * The rule the level has to keep is that it only ever narrows, and only where somebody actually
 * said what the view is: a canvas that has said nothing behaves exactly as it always did, which is
 * most canvases. Where it has, the answer stays at the altitude of the conversation — answering
 * "what comes after the Lending Platform?" with a Data Store is how a picture of a business quietly
 * stops being one.
 */
describe('what a view is showing changes what comes next', () => {
  function customerAndSystem() {
    const customer = createNode({ type: 'actor', x: 0, y: 0, text: 'Customer' });
    const platform = createNode({ type: 'service', x: 300, y: 0, text: 'Lending Platform' });
    const edge = createEdge({ source: customer.id, target: platform.id });
    return {
      doc: addEdges(addNodes(createDocument('Lending'), [customer, platform]), [edge]),
      customer,
      platform,
    };
  }

  const asked = (doc: DraftDocument, anchorId: string, level: ViewLevel | undefined) =>
    continuationSets(doc, anchorId, { level }).explicit.map((c) => c.label);

  it('offers other systems, not infrastructure, in a system overview', () => {
    const { doc, platform } = customerAndSystem();
    expect(asked(doc, platform.id, 'context')).toEqual(['Service', 'External System']);
  });

  it('offers the system and who else runs one, off a person in an overview', () => {
    const { doc, customer } = customerAndSystem();
    expect(asked(doc, customer.id, 'context')).toEqual(['System', 'External System']);
  });

  // The Customer calling the Platform is what orders this list — a system someone talks to leads
  // with its own data and a cache (`role.ts`). The level's job is which rows exist, not their order.
  const WHOLE_VOCABULARY = ['Data Store', 'Cache', 'Service', 'Topic', 'Queue', 'External System'];

  it.each([undefined, 'none'] as const)('is exactly what it always was when the view says %s', (level) => {
    const { doc, platform, customer } = customerAndSystem();
    expect(asked(doc, platform.id, level)).toEqual(WHOLE_VOCABULARY);
    expect(asked(doc, customer.id, level)).toEqual(['Gateway', 'API']);
  });

  it.each(['container', 'component'] as const)('leaves the whole vocabulary alone at %s', (level) => {
    const { doc, platform } = customerAndSystem();
    expect(asked(doc, platform.id, level)).toEqual(WHOLE_VOCABULARY);
  });
});
