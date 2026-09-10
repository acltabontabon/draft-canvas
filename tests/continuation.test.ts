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
const database = (id: string): Spec => ({ id, type: 'database' });
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
    name: 'Stream with inbound and no consumer — consumer yes, DLQ never',
    doc: graph([service('s'), stream('st'), worker('w')], [['s', 'st'], ['st', 'w']]),
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

  it('returns nothing for an unknown anchor', () => {
    expect(ids(graph([topic('t')], []), 'nope', 'drop')).toEqual([]);
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
      'gateway-route': graph([actor('p'), gateway('t')], [['p', 't']]),
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

  it('inherits the anchor\'s boundary only when the companion fits inside it', () => {
    const roomy = createNode({ id: 'b', type: 'group', x: 0, y: 0, width: 800, height: 300 });
    const topicIn = createNode({ id: 't', type: 'queue', queueKind: 'topic', x: 40, y: 100, parentId: 'b' });
    const pub = createNode({ id: 'p', type: 'service', x: -400, y: 100 });
    let doc = addNodes(createDocument('Boundary'), [roomy, topicIn, pub]);
    doc = addEdges(doc, [createEdge({ source: 'p', target: 't', ...inferRelationship(pub, topicIn) })]);
    const [offer] = continuationsFor(doc, 't', 'select');
    expect(materialize(doc, offer!)!.nodes[0]!.parentId).toBe('b');

    const tight: DraftDocument = { ...doc, nodes: doc.nodes.map((n) => (n.id === 'b' ? { ...n, width: 200 } : n)) };
    expect(materialize(tight, offer!)!.nodes[0]!.parentId).toBeUndefined();
  });

  it('mints fresh ids on every call so an accepted offer never collides with a re-offer', () => {
    const doc = graph([service('pub'), topic('t')], [['pub', 't']]);
    const [offer] = continuationsFor(doc, 't', 'select');
    expect(materialize(doc, offer!)!.nodes[0]!.id).not.toBe(materialize(doc, offer!)!.nodes[0]!.id);
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

  it('keeps the same offer object when an equal offer is set again', () => {
    const a = selectOffer('t');
    useUiStore.getState().setContinuation(a);
    const b = selectOffer('t');
    expect(b.nodes[0]!.id).not.toBe(a.nodes[0]!.id);
    useUiStore.getState().setContinuation(b);
    expect(useUiStore.getState().continuation).toBe(a);
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
      toggleTheme: () => {},
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
