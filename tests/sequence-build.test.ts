import { describe, expect, it } from 'vitest';
import { createAttachment, createDocument, createEdge, createNode } from '../src/document/factory';
import { createFlow } from '../src/document/flow';
import type { DraftDocument, DraftEdge, DraftFlow, DraftFlowStep, DraftNode } from '../src/document/types';
import { buildSequenceModel } from '../src/sequence/build';
import type { SequenceGroup, SequenceMessage, SequenceModel, SequenceNote } from '../src/sequence/types';

function doc(nodes: DraftNode[], edges: DraftEdge[], flows: DraftFlow[] = []): DraftDocument {
  return { ...createDocument(), nodes, edges, flows };
}

function flow(steps: DraftFlowStep[], overrides: Partial<DraftFlow> = {}): DraftFlow {
  return { ...createFlow({ title: 'Checkout' }), steps, ...overrides };
}

/** One step per edge id, in order — the common case. */
function linearFlow(edgeIds: string[]): DraftFlow {
  return flow(edgeIds.map((edgeId, i) => ({ id: `fs${i + 1}`, edgeId })));
}

/** A single-flow model, the shape most of these tests exercise. */
function buildOne(nodes: DraftNode[], edges: DraftEdge[], oneFlow: DraftFlow): SequenceModel {
  return buildSequenceModel(doc(nodes, edges, [oneFlow]));
}

function groupsOf(model: SequenceModel): SequenceGroup[] {
  return model.elements.filter((el): el is SequenceGroup => el.kind === 'group');
}

function messagesOf(model: SequenceModel): SequenceMessage[] {
  return groupsOf(model).flatMap((g) => g.children.filter((c): c is SequenceMessage => c.kind === 'message'));
}

function notesOf(model: SequenceModel): SequenceNote[] {
  return groupsOf(model).flatMap((g) => g.children.filter((c): c is SequenceNote => c.kind === 'note'));
}

describe('buildSequenceModel — basic interaction kinds', () => {
  it('actor → service becomes a plain sync message', () => {
    const user = createNode({ type: 'actor', x: 0, y: 0, text: 'Customer' });
    const api = createNode({ type: 'service', x: 200, y: 0, text: 'Order API' });
    const edge = createEdge({ source: user.id, target: api.id, semantic: 'calls' });
    const model = buildOne([user, api], [edge], linearFlow([edge.id]));

    expect(model.participants.map((p) => p.label)).toEqual(['Customer', 'Order API']);
    expect(model.participants[0]!.kind).toBe('actor');
    expect(messagesOf(model)).toHaveLength(1);
    expect(messagesOf(model)[0]).toMatchObject({ from: 'P1', to: 'P2', interaction: 'sync', label: 'calls' });
  });

  it('service → service sync call with no semantic falls back to the matrix default', () => {
    const a = createNode({ type: 'service', x: 0, y: 0, text: 'Web App' });
    const b = createNode({ type: 'service', x: 200, y: 0, text: 'Order API' });
    const edge = createEdge({ source: a.id, target: b.id });
    const model = buildOne([a, b], [edge], linearFlow([edge.id]));

    expect(messagesOf(model)[0]).toMatchObject({ interaction: 'sync', label: 'calls' });
  });

  it('service → service marked async (kind) is a distinct async message', () => {
    const a = createNode({ type: 'service', x: 0, y: 0, text: 'A' });
    const b = createNode({ type: 'service', x: 200, y: 0, text: 'B' });
    const edge = createEdge({ source: a.id, target: b.id, kind: 'async', async: true, label: 'Notify' });
    const model = buildOne([a, b], [edge], linearFlow([edge.id]));

    expect(messagesOf(model)[0]).toMatchObject({ interaction: 'async', label: 'Notify' });
  });

  it('a request with an explicit response emits a paired reply message', () => {
    const api = createNode({ type: 'service', x: 0, y: 0, text: 'Order API' });
    const pay = createNode({ type: 'service', x: 200, y: 0, text: 'Payment Service' });
    const edge = { ...createEdge({ source: api.id, target: pay.id, label: 'Charge', hasResponse: true }), response: 'OK' };
    const model = buildOne([api, pay], [edge], linearFlow([edge.id]));

    expect(messagesOf(model)).toHaveLength(2);
    expect(messagesOf(model)[0]).toMatchObject({ from: 'P1', to: 'P2', label: 'Charge', interaction: 'sync' });
    expect(messagesOf(model)[1]).toMatchObject({ from: 'P2', to: 'P1', label: 'OK', interaction: 'response', isResponse: true });
  });

  it('does NOT invent a response when hasResponse is unset, even for a service-to-service call', () => {
    const a = createNode({ type: 'service', x: 0, y: 0, text: 'A' });
    const b = createNode({ type: 'service', x: 200, y: 0, text: 'B' });
    const edge = createEdge({ source: a.id, target: b.id, semantic: 'calls' });
    const model = buildOne([a, b], [edge], linearFlow([edge.id]));

    expect(messagesOf(model)).toHaveLength(1);
  });

  it('a response with no explicit response text falls back to the generic word', () => {
    const a = createNode({ type: 'service', x: 0, y: 0, text: 'A' });
    const b = createNode({ type: 'service', x: 200, y: 0, text: 'B' });
    const edge = createEdge({ source: a.id, target: b.id, hasResponse: true });
    const model = buildOne([a, b], [edge], linearFlow([edge.id]));

    expect(messagesOf(model)[1]!.label).toBe('Response');
  });

  it('service → database write', () => {
    const api = createNode({ type: 'service', x: 0, y: 0, text: 'Order API' });
    const db = createNode({ type: 'database', x: 200, y: 0, text: 'Orders DB' });
    const edge = createEdge({ source: api.id, target: db.id, semantic: 'writes' });
    const model = buildOne([api, db], [edge], linearFlow([edge.id]));

    expect(model.participants[1]!.kind).toBe('database');
    expect(messagesOf(model)[0]).toMatchObject({ interaction: 'sync', label: 'writes' });
  });

  it('service → database read, with no explicit response manufactured', () => {
    const db = createNode({ type: 'database', x: 0, y: 0, text: 'Orders DB' });
    const api = createNode({ type: 'service', x: 200, y: 0, text: 'Order API' });
    const edge = createEdge({ source: db.id, target: api.id, semantic: 'reads' });
    const model = buildOne([db, api], [edge], linearFlow([edge.id]));

    expect(messagesOf(model)).toHaveLength(1);
    expect(messagesOf(model)[0]!.label).toBe('reads');
  });

  it('service → queue publish is an async message', () => {
    const api = createNode({ type: 'service', x: 0, y: 0, text: 'Order API' });
    const queue = createNode({ type: 'queue', x: 200, y: 0, text: 'Order Events', queueKind: 'topic' });
    const edge = createEdge({ source: api.id, target: queue.id, semantic: 'publishes', label: 'OrderCreated' });
    const model = buildOne([api, queue], [edge], linearFlow([edge.id]));

    expect(model.participants[1]!.kind).toBe('queue');
    expect(messagesOf(model)[0]).toMatchObject({ interaction: 'async', label: 'OrderCreated' });
  });

  it('queue → consumer is an async delivery message', () => {
    const queue = createNode({ type: 'queue', x: 0, y: 0, text: 'Order Events', queueKind: 'topic' });
    const worker = createNode({ type: 'service', x: 200, y: 0, text: 'Fulfillment Worker', serviceKind: 'worker' });
    const edge = createEdge({ source: queue.id, target: worker.id, semantic: 'deliversTo', label: 'OrderCreated' });
    const model = buildOne([queue, worker], [edge], linearFlow([edge.id]));

    expect(messagesOf(model)[0]).toMatchObject({ interaction: 'async', label: 'OrderCreated' });
  });

  it('producer → topic → consumer preserves the broker as its own participant', () => {
    const producer = createNode({ type: 'service', x: 0, y: 0, text: 'Order API' });
    const topic = createNode({ type: 'queue', x: 200, y: 0, text: 'Order Events', queueKind: 'topic' });
    const consumer = createNode({ type: 'service', x: 400, y: 0, text: 'Fulfillment Worker' });
    const publish = createEdge({ source: producer.id, target: topic.id, semantic: 'publishes', label: 'OrderCreated' });
    const deliver = createEdge({ source: topic.id, target: consumer.id, semantic: 'deliversTo', label: 'OrderCreated' });
    const model = buildOne(
      [producer, topic, consumer],
      [publish, deliver],
      linearFlow([publish.id, deliver.id]),
    );

    expect(model.participants.map((p) => p.label)).toEqual(['Order API', 'Order Events', 'Fulfillment Worker']);
    expect(messagesOf(model)).toHaveLength(2);
  });
});

describe('buildSequenceModel — junction flattening', () => {
  it('flattens Service → Junction → Service into one message', () => {
    const a = createNode({ type: 'service', x: 0, y: 0, text: 'A' });
    const junction = createNode({ type: 'ellipse', x: 200, y: 0 });
    const b = createNode({ type: 'service', x: 400, y: 0, text: 'B' });
    const e1 = createEdge({ source: a.id, target: junction.id });
    const e2 = createEdge({ source: junction.id, target: b.id, label: 'Charge' });
    const model = buildOne([a, junction, b], [e1, e2], linearFlow([e1.id, e2.id]));

    expect(model.participants.map((p) => p.label)).toEqual(['A', 'B']);
    expect(messagesOf(model)).toHaveLength(1);
    expect(messagesOf(model)[0]).toMatchObject({ from: 'P1', to: 'P2', label: 'Charge' });
    expect(messagesOf(model)[0]!.sourceEdgeIds).toEqual([e1.id, e2.id]);
  });

  it('flattens a chain of two junctions', () => {
    const a = createNode({ type: 'service', x: 0, y: 0, text: 'A' });
    const j1 = createNode({ type: 'ellipse', x: 150, y: 0 });
    const j2 = createNode({ type: 'ellipse', x: 300, y: 0 });
    const b = createNode({ type: 'service', x: 450, y: 0, text: 'B' });
    const e1 = createEdge({ source: a.id, target: j1.id });
    const e2 = createEdge({ source: j1.id, target: j2.id });
    const e3 = createEdge({ source: j2.id, target: b.id, label: 'Ship' });
    const model = buildOne([a, j1, j2, b], [e1, e2, e3], linearFlow([e1.id, e2.id, e3.id]));

    expect(model.participants.map((p) => p.label)).toEqual(['A', 'B']);
    expect(messagesOf(model)).toHaveLength(1);
    expect(messagesOf(model)[0]!.label).toBe('Ship');
  });

  it('resolves a junction leg purely from the document graph, even when only the other leg is a flow step', () => {
    const a = createNode({ type: 'service', x: 0, y: 0, text: 'A' });
    const junction = createNode({ type: 'ellipse', x: 200, y: 0 });
    const b = createNode({ type: 'service', x: 400, y: 0, text: 'B' });
    const e1 = createEdge({ source: a.id, target: junction.id });
    const e2 = createEdge({ source: junction.id, target: b.id, label: 'Ship' });
    // Only e2 is a member of this flow — e1 exists in the document but isn't a step.
    const model = buildOne([a, junction, b], [e1, e2], linearFlow([e2.id]));

    expect(model.participants.map((p) => p.label)).toEqual(['A', 'B']);
    expect(messagesOf(model)[0]).toMatchObject({ from: 'P1', to: 'P2', label: 'Ship' });
  });

  it('an ambiguous junction fan-in falls back to the Junction itself as a participant', () => {
    const a = createNode({ type: 'service', x: 0, y: 0, text: 'A' });
    const b = createNode({ type: 'service', x: 0, y: 150, text: 'B' });
    const junction = createNode({ type: 'ellipse', x: 200, y: 75 });
    const c = createNode({ type: 'service', x: 400, y: 75, text: 'C' });
    const e1 = createEdge({ source: a.id, target: junction.id });
    const e2 = createEdge({ source: b.id, target: junction.id });
    const e3 = createEdge({ source: junction.id, target: c.id, label: 'Fan out' });
    const model = buildOne([a, b, junction, c], [e1, e2, e3], linearFlow([e3.id]));

    expect(model.participants.some((p) => p.isJunctionFallback)).toBe(true);
    expect(messagesOf(model)[0]!.label).toBe('Fan out');
  });

  it('a dangling junction (nothing feeding it) falls back to the Junction itself', () => {
    const junction = createNode({ type: 'ellipse', x: 0, y: 0 });
    const b = createNode({ type: 'service', x: 200, y: 0, text: 'B' });
    const edge = createEdge({ source: junction.id, target: b.id, label: 'Go' });
    const model = buildOne([junction, b], [edge], linearFlow([edge.id]));

    expect(model.participants[0]).toMatchObject({ label: 'Junction', isJunctionFallback: true });
  });

  it('a junction crossed twice with unrelated steps in between stays two separate messages', () => {
    const a = createNode({ type: 'service', x: 0, y: 0, text: 'A' });
    const junction = createNode({ type: 'ellipse', x: 200, y: 0 });
    const b = createNode({ type: 'service', x: 400, y: 0, text: 'B' });
    const c = createNode({ type: 'service', x: 0, y: 200, text: 'C' });
    const d = createNode({ type: 'service', x: 400, y: 200, text: 'D' });
    const first = createEdge({ source: a.id, target: junction.id });
    const firstOut = createEdge({ source: junction.id, target: b.id, label: 'First' });
    const unrelated = createEdge({ source: c.id, target: d.id, label: 'Unrelated' });
    const second = createEdge({ source: a.id, target: junction.id });
    const secondOut = createEdge({ source: junction.id, target: b.id, label: 'Second' });
    const model = buildOne(
      [a, junction, b, c, d],
      [first, firstOut, unrelated, second, secondOut],
      linearFlow([first.id, firstOut.id, unrelated.id, second.id, secondOut.id]),
    );

    expect(messagesOf(model).map((m) => m.label)).toEqual(['First', 'Unrelated', 'Second']);
  });
});

describe('buildSequenceModel — participants, labels, and aliases', () => {
  it('duplicate display names are disambiguated in the shown label, not the machine id', () => {
    const a = createNode({ type: 'service', x: 0, y: 0, text: 'Service' });
    const b = createNode({ type: 'service', x: 200, y: 0, text: 'Service' });
    const edge = createEdge({ source: a.id, target: b.id, label: 'Calls' });
    const model = buildOne([a, b], [edge], linearFlow([edge.id]));

    expect(model.participants.map((p) => p.label)).toEqual(['Service', 'Service (2)']);
    expect(model.participants.map((p) => p.id)).toEqual(['P1', 'P2']);
  });

  it('participant order is first-appearance-in-message order, not document node order', () => {
    const a = createNode({ type: 'service', x: 0, y: 0, text: 'A' });
    const b = createNode({ type: 'service', x: 200, y: 0, text: 'B' });
    const c = createNode({ type: 'service', x: 400, y: 0, text: 'C' });
    const e1 = createEdge({ source: b.id, target: c.id, label: 'first' });
    const e2 = createEdge({ source: a.id, target: b.id, label: 'second' });
    // doc.nodes lists A, B, C — but the flow visits B→C before A→B.
    const model = buildOne([a, b, c], [e1, e2], linearFlow([e1.id, e2.id]));

    expect(model.participants.map((p) => p.label)).toEqual(['B', 'C', 'A']);
  });

  it('an edge with no label and no semantic falls through every tier to the generic bucket word', () => {
    const note = createNode({ type: 'note', x: 0, y: 0 });
    const service = createNode({ type: 'service', x: 200, y: 0, text: 'Service' });
    // A decorative node has category 'generic' — the matrix has no opinion on generic>service.
    const edge = createEdge({ source: note.id, target: service.id });
    const model = buildOne([note, service], [edge], linearFlow([edge.id]));

    expect(messagesOf(model)[0]!.label).toBe('Call');
  });

  it('handles a decorative node as an edge endpoint without crashing', () => {
    const codeNode = createNode({ type: 'code', x: 0, y: 0 });
    const service = createNode({ type: 'service', x: 200, y: 0, text: 'Service' });
    const edge = createEdge({ source: codeNode.id, target: service.id, label: 'Deploys' });
    const model = buildOne([codeNode, service], [edge], linearFlow([edge.id]));

    expect(model.participants).toHaveLength(2);
    expect(messagesOf(model)[0]!.label).toBe('Deploys');
  });

  it('a self-referencing edge does not crash and collapses to a single participant', () => {
    const a = createNode({ type: 'service', x: 0, y: 0, text: 'A' });
    const edge = createEdge({ source: a.id, target: a.id, label: 'Retry' });
    const model = buildOne([a], [edge], linearFlow([edge.id]));

    expect(model.participants).toHaveLength(1);
    expect(messagesOf(model)[0]).toMatchObject({ from: 'P1', to: 'P1', label: 'Retry' });
  });

  it('assigns a readable, collision-safe alias to every participant, derived from its final label', () => {
    const a = createNode({ type: 'service', x: 0, y: 0, text: 'Payment Service' });
    const b = createNode({ type: 'service', x: 200, y: 0, text: 'Payment Service' });
    const edge = createEdge({ source: a.id, target: b.id, label: 'x' });
    const model = buildOne([a, b], [edge], linearFlow([edge.id]));

    expect(model.participants.map((p) => p.alias)).toEqual(['PaymentService', 'PaymentService2']);
  });
});

describe('buildSequenceModel — steps, frames, and ordering', () => {
  it('a frame step (no edgeId, no extraEdgeIds) contributes no message', () => {
    const a = createNode({ type: 'service', x: 0, y: 0, text: 'A' });
    const b = createNode({ type: 'service', x: 200, y: 0, text: 'B' });
    const model = buildOne(
      [a, b],
      [],
      flow([{ id: 'fs1', extraNodeIds: [a.id, b.id], caption: 'Starting state' }]),
    );

    expect(messagesOf(model)).toHaveLength(0);
    expect(model.participants).toHaveLength(0);
  });

  it('extraEdgeIds each produce their own message, in [edgeId, ...extraEdgeIds] order', () => {
    const a = createNode({ type: 'service', x: 0, y: 0, text: 'A' });
    const b = createNode({ type: 'service', x: 200, y: 0, text: 'B' });
    const c = createNode({ type: 'service', x: 400, y: 0, text: 'C' });
    const primary = createEdge({ source: a.id, target: b.id, label: 'Primary' });
    const extra = createEdge({ source: b.id, target: c.id, label: 'Extra' });
    const model = buildOne(
      [a, b, c],
      [primary, extra],
      flow([{ id: 'fs1', edgeId: primary.id, extraEdgeIds: [extra.id] }]),
    );

    expect(messagesOf(model).map((m) => m.label)).toEqual(['Primary', 'Extra']);
  });

  it('an empty flow produces an empty, non-crashing model', () => {
    const model = buildOne([], [], flow([]));
    expect(model.participants).toHaveLength(0);
    expect(messagesOf(model)).toHaveLength(0);
    expect(groupsOf(model)).toHaveLength(0);
  });

  it('message order is gapless and stable regardless of step count', () => {
    const nodes = Array.from({ length: 4 }, (_, i) => createNode({ type: 'service', x: i * 200, y: 0, text: `N${i}` }));
    const edges = nodes.slice(0, -1).map((n, i) => createEdge({ source: n.id, target: nodes[i + 1]!.id, label: `E${i}` }));
    const model = buildOne(nodes, edges, linearFlow(edges.map((e) => e.id)));

    expect(messagesOf(model).map((m) => m.order)).toEqual([0, 1, 2]);
  });
});

describe('buildSequenceModel — multi-flow aggregation', () => {
  it('a shared participant across two flows is one participant, not two', () => {
    const customer = createNode({ type: 'actor', x: 0, y: 0, text: 'Customer' });
    const order = createNode({ type: 'service', x: 200, y: 0, text: 'Order API' });
    const payment = createNode({ type: 'service', x: 400, y: 0, text: 'Payment Service' });
    const place = createEdge({ source: customer.id, target: order.id, label: 'Place Order' });
    const charge = createEdge({ source: order.id, target: payment.id, label: 'Charge Card' });
    const release = createEdge({ source: payment.id, target: order.id, label: 'Release Payment' });

    const happyPath = flow(
      [{ id: 'fs1', edgeId: place.id }, { id: 'fs2', edgeId: charge.id }],
      { title: 'Happy Path' },
    );
    const compensation = flow([{ id: 'fs3', edgeId: release.id }], { title: 'Compensation' });
    const model = buildSequenceModel(doc([customer, order, payment], [place, charge, release], [happyPath, compensation]));

    expect(model.participants.map((p) => p.label)).toEqual(['Customer', 'Order API', 'Payment Service']);
    expect(model.participants).toHaveLength(3);
  });

  it('two flows become two named groups, never blindly concatenated into one', () => {
    const a = createNode({ type: 'service', x: 0, y: 0, text: 'A' });
    const b = createNode({ type: 'service', x: 200, y: 0, text: 'B' });
    const e1 = createEdge({ source: a.id, target: b.id, label: 'Happy' });
    const e2 = createEdge({ source: b.id, target: a.id, label: 'Sorry' });
    const happyPath = flow([{ id: 'fs1', edgeId: e1.id }], { title: 'Happy Path' });
    const compensation = flow([{ id: 'fs2', edgeId: e2.id }], { title: 'Compensation' });
    const model = buildSequenceModel(doc([a, b], [e1, e2], [happyPath, compensation]));

    const groups = groupsOf(model);
    expect(groups).toHaveLength(2);
    expect(groups.map((g) => g.label)).toEqual(['Happy Path', 'Compensation']);
    expect(groups[0]!.children.map((c) => (c.kind === 'message' ? c.label : c.kind))).toEqual(['Happy']);
    expect(groups[1]!.children.map((c) => (c.kind === 'message' ? c.label : c.kind))).toEqual(['Sorry']);
  });

  it('participant order is first-appearance across flows in document.flows array order, not alphabetical', () => {
    const zebra = createNode({ type: 'service', x: 0, y: 0, text: 'Zebra' });
    const apple = createNode({ type: 'service', x: 200, y: 0, text: 'Apple' });
    const e1 = createEdge({ source: zebra.id, target: apple.id, label: 'first' });
    const model = buildOne([zebra, apple], [e1], linearFlow([e1.id]));

    expect(model.participants.map((p) => p.label)).toEqual(['Zebra', 'Apple']);
  });

  it("the order flows are arranged in document.flows determines who appears first — the user's own lever", () => {
    const a = createNode({ type: 'service', x: 0, y: 0, text: 'A' });
    const b = createNode({ type: 'service', x: 200, y: 0, text: 'B' });
    const e1 = createEdge({ source: a.id, target: b.id, label: 'A calls B' });
    const e2 = createEdge({ source: b.id, target: a.id, label: 'B calls A' });
    const flowB = flow([{ id: 'fs1', edgeId: e2.id }], { title: 'B first' });
    const flowA = flow([{ id: 'fs2', edgeId: e1.id }], { title: 'A first' });
    // flowB is listed before flowA in doc.flows -> B is introduced first, regardless of node kind.
    const model = buildSequenceModel(doc([a, b], [e1, e2], [flowB, flowA]));

    expect(model.participants.map((p) => p.label)).toEqual(['B', 'A']);
  });

  it('an unplayable (empty) flow contributes no group, but does not block later flows', () => {
    const a = createNode({ type: 'service', x: 0, y: 0, text: 'A' });
    const b = createNode({ type: 'service', x: 200, y: 0, text: 'B' });
    const edge = createEdge({ source: a.id, target: b.id, label: 'Go' });
    const empty = flow([], { title: 'Empty' });
    const real = flow([{ id: 'fs1', edgeId: edge.id }], { title: 'Real' });
    const model = buildSequenceModel(doc([a, b], [edge], [empty, real]));

    expect(groupsOf(model).map((g) => g.label)).toEqual(['Real']);
  });

  it('a duplicate display label across two different flows disambiguates once, globally', () => {
    const a = createNode({ type: 'service', x: 0, y: 0, text: 'Service' });
    const b = createNode({ type: 'service', x: 200, y: 0, text: 'Service' });
    const c = createNode({ type: 'service', x: 400, y: 0, text: 'C' });
    const e1 = createEdge({ source: a.id, target: b.id, label: 'first' });
    const e2 = createEdge({ source: b.id, target: c.id, label: 'second' });
    const flow1 = flow([{ id: 'fs1', edgeId: e1.id }], { title: 'One' });
    const flow2 = flow([{ id: 'fs2', edgeId: e2.id }], { title: 'Two' });
    const model = buildSequenceModel(doc([a, b, c], [e1, e2], [flow1, flow2]));

    expect(model.participants.map((p) => p.label)).toEqual(['Service', 'Service (2)', 'C']);
  });
});

describe('buildSequenceModel — structural exclusion', () => {
  it('a dependsOn edge produces no message; an otherwise-unreferenced participant never appears', () => {
    const a = createNode({ type: 'service', x: 0, y: 0, text: 'A' });
    const b = createNode({ type: 'service', x: 200, y: 0, text: 'B' });
    const edge = createEdge({ source: a.id, target: b.id, semantic: 'dependsOn' });
    const model = buildOne([a, b], [edge], linearFlow([edge.id]));

    expect(messagesOf(model)).toHaveLength(0);
    expect(model.participants).toHaveLength(0);
    expect(groupsOf(model)).toHaveLength(0);
  });

  it('an implementedBy edge (hexagonal ports) is also excluded — structural, not runtime', () => {
    const port = createNode({ type: 'component', componentKind: 'port', x: 0, y: 0, text: 'Payment Port' });
    const adapter = createNode({ type: 'component', componentKind: 'adapter', x: 200, y: 0, text: 'Payment Adapter' });
    const edge = createEdge({ source: port.id, target: adapter.id, semantic: 'implementedBy' });
    const model = buildOne([port, adapter], [edge], linearFlow([edge.id]));

    expect(messagesOf(model)).toHaveLength(0);
  });

  it('a dependsOn edge alongside a real message still lets the participant appear via the real message', () => {
    const a = createNode({ type: 'service', x: 0, y: 0, text: 'A' });
    const b = createNode({ type: 'service', x: 200, y: 0, text: 'B' });
    const dep = createEdge({ source: a.id, target: b.id, semantic: 'dependsOn' });
    const call = createEdge({ source: a.id, target: b.id, label: 'Call' });
    const model = buildOne([a, b], [dep, call], flow([{ id: 'fs1', edgeId: dep.id }, { id: 'fs2', edgeId: call.id }]));

    expect(messagesOf(model)).toHaveLength(1);
    expect(model.participants.map((p) => p.label)).toEqual(['A', 'B']);
  });

  it('component>component "uses" is NOT structural — it becomes a real message', () => {
    const a = createNode({ type: 'component', x: 0, y: 0, text: 'Module A' });
    const b = createNode({ type: 'component', x: 200, y: 0, text: 'Module B' });
    const edge = createEdge({ source: a.id, target: b.id, semantic: 'uses' });
    const model = buildOne([a, b], [edge], linearFlow([edge.id]));

    expect(messagesOf(model)).toHaveLength(1);
    expect(messagesOf(model)[0]!.label).toBe('uses');
  });
});

describe('buildSequenceModel — notes, questions, and code annotations', () => {
  it("a standalone Note in a step's extraNodeIds anchors to that step's own message", () => {
    const a = createNode({ type: 'service', x: 0, y: 0, text: 'A' });
    const b = createNode({ type: 'service', x: 200, y: 0, text: 'B' });
    const note = createNode({ type: 'note', x: 400, y: 0, text: 'Retries up to 3 times on timeout' });
    const edge = createEdge({ source: a.id, target: b.id, label: 'Charge' });
    const model = buildOne([a, b, note], [edge], flow([{ id: 'fs1', edgeId: edge.id, extraNodeIds: [note.id] }]));

    const notes = notesOf(model);
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({ text: 'Retries up to 3 times on timeout', noteKind: 'note' });
    expect(notes[0]!.participantIds).toEqual(['P1', 'P2']);
  });

  it('a standalone Question node carries noteKind through, unresolved', () => {
    const a = createNode({ type: 'service', x: 0, y: 0, text: 'A' });
    const b = createNode({ type: 'service', x: 200, y: 0, text: 'B' });
    const question = createNode({
      type: 'note',
      noteKind: 'question',
      x: 400,
      y: 0,
      text: 'Should this retry on failure?',
    });
    const edge = createEdge({ source: a.id, target: b.id, label: 'Release Payment' });
    const model = buildOne(
      [a, b, question],
      [edge],
      flow([{ id: 'fs1', edgeId: edge.id, extraNodeIds: [question.id] }]),
    );

    expect(notesOf(model)[0]).toMatchObject({ noteKind: 'question', text: 'Should this retry on failure?' });
  });

  it('a standalone Code node carries language through, with no noteKind prefix', () => {
    const a = createNode({ type: 'service', x: 0, y: 0, text: 'A' });
    const b = createNode({ type: 'service', x: 200, y: 0, text: 'B' });
    const code = createNode({ type: 'code', language: 'typescript', x: 400, y: 0, code: 'retry({ times: 3 })' });
    const edge = createEdge({ source: a.id, target: b.id, label: 'Charge' });
    const model = buildOne([a, b, code], [edge], flow([{ id: 'fs1', edgeId: edge.id, extraNodeIds: [code.id] }]));

    const notes = notesOf(model);
    expect(notes[0]).toMatchObject({ text: 'retry({ times: 3 })', language: 'typescript' });
    expect(notes[0]!.noteKind).toBeUndefined();
  });

  it("a note folded onto a participant node surfaces once, at that participant's first appearance", () => {
    const a = createNode({ type: 'service', x: 0, y: 0, text: 'A' });
    const b = {
      ...createNode({ type: 'service', x: 200, y: 0, text: 'Payment Service' }),
      attachments: [createAttachment({ type: 'note', text: 'Idempotent' })],
    };
    const edge1 = createEdge({ source: a.id, target: b.id, label: 'Charge' });
    const edge2 = createEdge({ source: b.id, target: a.id, label: 'Ack' });
    const happyPath = flow([{ id: 'fs1', edgeId: edge1.id }], { title: 'Happy Path' });
    const compensation = flow([{ id: 'fs2', edgeId: edge2.id }], { title: 'Compensation' });
    const model = buildSequenceModel(doc([a, b], [edge1, edge2], [happyPath, compensation]));

    expect(notesOf(model)).toHaveLength(1); // not duplicated across flows
    expect(notesOf(model)[0]).toMatchObject({ text: 'Idempotent', participantIds: ['P2'] });
  });

  it("a note folded onto an edge anchors to that message's participants, right after it", () => {
    const a = createNode({ type: 'service', x: 0, y: 0, text: 'A' });
    const b = createNode({ type: 'service', x: 200, y: 0, text: 'B' });
    const edge = {
      ...createEdge({ source: a.id, target: b.id, label: 'Charge' }),
      attachments: [createAttachment({ type: 'note', noteKind: 'warning', text: 'Rate-limited' })],
    };
    const model = buildOne([a, b], [edge], linearFlow([edge.id]));

    const children = groupsOf(model)[0]!.children;
    expect(children.map((c) => c.kind)).toEqual(['message', 'note']);
    expect(notesOf(model)[0]).toMatchObject({ noteKind: 'warning', text: 'Rate-limited' });
  });

  it('a plain Text node/attachment is never treated as an annotation', () => {
    const a = createNode({ type: 'service', x: 0, y: 0, text: 'A' });
    const b = createNode({ type: 'service', x: 200, y: 0, text: 'B' });
    const label = createNode({ type: 'text', x: 400, y: 0, text: 'not an annotation' });
    const edge = createEdge({ source: a.id, target: b.id, label: 'Charge' });
    const model = buildOne([a, b, label], [edge], flow([{ id: 'fs1', edgeId: edge.id, extraNodeIds: [label.id] }]));

    expect(notesOf(model)).toHaveLength(0);
  });

  it('empty/whitespace-only note text is skipped rather than emitting a blank note', () => {
    const a = createNode({ type: 'service', x: 0, y: 0, text: 'A' });
    const b = createNode({ type: 'service', x: 200, y: 0, text: 'B' });
    const blank = createNode({ type: 'note', x: 400, y: 0, text: '   ' });
    const edge = createEdge({ source: a.id, target: b.id, label: 'Charge' });
    const model = buildOne([a, b, blank], [edge], flow([{ id: 'fs1', edgeId: edge.id, extraNodeIds: [blank.id] }]));

    expect(notesOf(model)).toHaveLength(0);
  });

  it('a note in a frame step with no resolvable participant is dropped, never fabricating one', () => {
    const a = createNode({ type: 'service', x: 0, y: 0, text: 'A' });
    const note = createNode({ type: 'note', x: 200, y: 0, text: 'Orphaned' });
    const model = buildOne([a, note], [], flow([{ id: 'fs1', extraNodeIds: [note.id] }]));

    expect(notesOf(model)).toHaveLength(0);
  });
});

describe('buildSequenceModel — never crashes on stale references', () => {
  it("a step whose primary edgeId no longer exists in the document contributes nothing, and doesn't crash", () => {
    const a = createNode({ type: 'service', x: 0, y: 0, text: 'A' });
    const b = createNode({ type: 'service', x: 200, y: 0, text: 'B' });
    const model = buildOne([a, b], [], flow([{ id: 'fs1', edgeId: 'missing-edge' }]));

    expect(messagesOf(model)).toHaveLength(0);
    expect(model.participants).toHaveLength(0);
  });

  it("extraNodeIds pointing at a deleted node contribute nothing, and don't crash", () => {
    const a = createNode({ type: 'service', x: 0, y: 0, text: 'A' });
    const b = createNode({ type: 'service', x: 200, y: 0, text: 'B' });
    const edge = createEdge({ source: a.id, target: b.id, label: 'Go' });
    const model = buildOne([a, b], [edge], flow([{ id: 'fs1', edgeId: edge.id, extraNodeIds: ['missing-node'] }]));

    expect(messagesOf(model)).toHaveLength(1);
    expect(notesOf(model)).toHaveLength(0);
  });
});
