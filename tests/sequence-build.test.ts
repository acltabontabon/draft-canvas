import { describe, expect, it } from 'vitest';
import { createDocument, createEdge, createNode } from '../src/document/factory';
import { createFlow } from '../src/document/flow';
import type { DraftDocument, DraftEdge, DraftFlow, DraftFlowStep, DraftNode } from '../src/document/types';
import { buildSequenceModel } from '../src/sequence/build';

function doc(nodes: DraftNode[], edges: DraftEdge[]): DraftDocument {
  return { ...createDocument(), nodes, edges };
}

function flow(steps: DraftFlowStep[], overrides: Partial<DraftFlow> = {}): DraftFlow {
  return { ...createFlow({ title: 'Checkout' }), steps, ...overrides };
}

/** One step per edge id, in order — the common case. */
function linearFlow(edgeIds: string[]): DraftFlow {
  return flow(edgeIds.map((edgeId, i) => ({ id: `fs${i + 1}`, edgeId })));
}

describe('buildSequenceModel — basic interaction kinds', () => {
  it('actor → service becomes a plain sync message', () => {
    const user = createNode({ type: 'actor', x: 0, y: 0, text: 'Customer' });
    const api = createNode({ type: 'service', x: 200, y: 0, text: 'Order API' });
    const edge = createEdge({ source: user.id, target: api.id, semantic: 'calls' });
    const model = buildSequenceModel(doc([user, api], [edge]), linearFlow([edge.id]));

    expect(model.participants.map((p) => p.label)).toEqual(['Customer', 'Order API']);
    expect(model.participants[0]!.kind).toBe('actor');
    expect(model.messages).toHaveLength(1);
    expect(model.messages[0]).toMatchObject({ from: 'P1', to: 'P2', interaction: 'sync', label: 'calls' });
  });

  it('service → service sync call with no semantic falls back to the matrix default', () => {
    const a = createNode({ type: 'service', x: 0, y: 0, text: 'Web App' });
    const b = createNode({ type: 'service', x: 200, y: 0, text: 'Order API' });
    const edge = createEdge({ source: a.id, target: b.id });
    const model = buildSequenceModel(doc([a, b], [edge]), linearFlow([edge.id]));

    expect(model.messages[0]).toMatchObject({ interaction: 'sync', label: 'calls' });
  });

  it('service → service marked async (kind) is a distinct async message', () => {
    const a = createNode({ type: 'service', x: 0, y: 0, text: 'A' });
    const b = createNode({ type: 'service', x: 200, y: 0, text: 'B' });
    const edge = createEdge({ source: a.id, target: b.id, kind: 'async', async: true, label: 'Notify' });
    const model = buildSequenceModel(doc([a, b], [edge]), linearFlow([edge.id]));

    expect(model.messages[0]).toMatchObject({ interaction: 'async', label: 'Notify' });
  });

  it('a request with an explicit response emits a paired reply message', () => {
    const api = createNode({ type: 'service', x: 0, y: 0, text: 'Order API' });
    const pay = createNode({ type: 'service', x: 200, y: 0, text: 'Payment Service' });
    const edge = { ...createEdge({ source: api.id, target: pay.id, label: 'Charge', hasResponse: true }), response: 'OK' };
    const model = buildSequenceModel(doc([api, pay], [edge]), linearFlow([edge.id]));

    expect(model.messages).toHaveLength(2);
    expect(model.messages[0]).toMatchObject({ from: 'P1', to: 'P2', label: 'Charge', interaction: 'sync' });
    expect(model.messages[1]).toMatchObject({ from: 'P2', to: 'P1', label: 'OK', interaction: 'response', isResponse: true });
  });

  it('does NOT invent a response when hasResponse is unset, even for a service-to-service call', () => {
    const a = createNode({ type: 'service', x: 0, y: 0, text: 'A' });
    const b = createNode({ type: 'service', x: 200, y: 0, text: 'B' });
    const edge = createEdge({ source: a.id, target: b.id, semantic: 'calls' });
    const model = buildSequenceModel(doc([a, b], [edge]), linearFlow([edge.id]));

    expect(model.messages).toHaveLength(1);
  });

  it('a response with no explicit response text falls back to the generic word', () => {
    const a = createNode({ type: 'service', x: 0, y: 0, text: 'A' });
    const b = createNode({ type: 'service', x: 200, y: 0, text: 'B' });
    const edge = createEdge({ source: a.id, target: b.id, hasResponse: true });
    const model = buildSequenceModel(doc([a, b], [edge]), linearFlow([edge.id]));

    expect(model.messages[1]!.label).toBe('Response');
  });

  it('service → database write', () => {
    const api = createNode({ type: 'service', x: 0, y: 0, text: 'Order API' });
    const db = createNode({ type: 'database', x: 200, y: 0, text: 'Orders DB' });
    const edge = createEdge({ source: api.id, target: db.id, semantic: 'writes' });
    const model = buildSequenceModel(doc([api, db], [edge]), linearFlow([edge.id]));

    expect(model.participants[1]!.kind).toBe('database');
    expect(model.messages[0]).toMatchObject({ interaction: 'sync', label: 'writes' });
  });

  it('service → database read, with no explicit response manufactured', () => {
    const db = createNode({ type: 'database', x: 0, y: 0, text: 'Orders DB' });
    const api = createNode({ type: 'service', x: 200, y: 0, text: 'Order API' });
    const edge = createEdge({ source: db.id, target: api.id, semantic: 'reads' });
    const model = buildSequenceModel(doc([db, api], [edge]), linearFlow([edge.id]));

    expect(model.messages).toHaveLength(1);
    expect(model.messages[0]!.label).toBe('reads');
  });

  it('service → queue publish is an async message', () => {
    const api = createNode({ type: 'service', x: 0, y: 0, text: 'Order API' });
    const queue = createNode({ type: 'queue', x: 200, y: 0, text: 'Order Events', queueKind: 'topic' });
    const edge = createEdge({ source: api.id, target: queue.id, semantic: 'publishes', label: 'OrderCreated' });
    const model = buildSequenceModel(doc([api, queue], [edge]), linearFlow([edge.id]));

    expect(model.participants[1]!.kind).toBe('queue');
    expect(model.messages[0]).toMatchObject({ interaction: 'async', label: 'OrderCreated' });
  });

  it('queue → consumer is an async delivery message', () => {
    const queue = createNode({ type: 'queue', x: 0, y: 0, text: 'Order Events', queueKind: 'topic' });
    const worker = createNode({ type: 'service', x: 200, y: 0, text: 'Fulfillment Worker', serviceKind: 'worker' });
    const edge = createEdge({ source: queue.id, target: worker.id, semantic: 'deliversTo', label: 'OrderCreated' });
    const model = buildSequenceModel(doc([queue, worker], [edge]), linearFlow([edge.id]));

    expect(model.messages[0]).toMatchObject({ interaction: 'async', label: 'OrderCreated' });
  });

  it('producer → topic → consumer preserves the broker as its own participant', () => {
    const producer = createNode({ type: 'service', x: 0, y: 0, text: 'Order API' });
    const topic = createNode({ type: 'queue', x: 200, y: 0, text: 'Order Events', queueKind: 'topic' });
    const consumer = createNode({ type: 'service', x: 400, y: 0, text: 'Fulfillment Worker' });
    const publish = createEdge({ source: producer.id, target: topic.id, semantic: 'publishes', label: 'OrderCreated' });
    const deliver = createEdge({ source: topic.id, target: consumer.id, semantic: 'deliversTo', label: 'OrderCreated' });
    const model = buildSequenceModel(
      doc([producer, topic, consumer], [publish, deliver]),
      linearFlow([publish.id, deliver.id]),
    );

    expect(model.participants.map((p) => p.label)).toEqual(['Order API', 'Order Events', 'Fulfillment Worker']);
    expect(model.messages).toHaveLength(2);
  });
});

describe('buildSequenceModel — junction flattening', () => {
  it('flattens Service → Junction → Service into one message', () => {
    const a = createNode({ type: 'service', x: 0, y: 0, text: 'A' });
    const junction = createNode({ type: 'ellipse', x: 200, y: 0 });
    const b = createNode({ type: 'service', x: 400, y: 0, text: 'B' });
    const e1 = createEdge({ source: a.id, target: junction.id });
    const e2 = createEdge({ source: junction.id, target: b.id, label: 'Charge' });
    const model = buildSequenceModel(doc([a, junction, b], [e1, e2]), linearFlow([e1.id, e2.id]));

    expect(model.participants.map((p) => p.label)).toEqual(['A', 'B']);
    expect(model.messages).toHaveLength(1);
    expect(model.messages[0]).toMatchObject({ from: 'P1', to: 'P2', label: 'Charge' });
    expect(model.messages[0]!.sourceEdgeIds).toEqual([e1.id, e2.id]);
  });

  it('flattens a chain of two junctions', () => {
    const a = createNode({ type: 'service', x: 0, y: 0, text: 'A' });
    const j1 = createNode({ type: 'ellipse', x: 150, y: 0 });
    const j2 = createNode({ type: 'ellipse', x: 300, y: 0 });
    const b = createNode({ type: 'service', x: 450, y: 0, text: 'B' });
    const e1 = createEdge({ source: a.id, target: j1.id });
    const e2 = createEdge({ source: j1.id, target: j2.id });
    const e3 = createEdge({ source: j2.id, target: b.id, label: 'Ship' });
    const model = buildSequenceModel(doc([a, j1, j2, b], [e1, e2, e3]), linearFlow([e1.id, e2.id, e3.id]));

    expect(model.participants.map((p) => p.label)).toEqual(['A', 'B']);
    expect(model.messages).toHaveLength(1);
    expect(model.messages[0]!.label).toBe('Ship');
  });

  it('resolves a junction leg purely from the document graph, even when only the other leg is a flow step', () => {
    const a = createNode({ type: 'service', x: 0, y: 0, text: 'A' });
    const junction = createNode({ type: 'ellipse', x: 200, y: 0 });
    const b = createNode({ type: 'service', x: 400, y: 0, text: 'B' });
    const e1 = createEdge({ source: a.id, target: junction.id });
    const e2 = createEdge({ source: junction.id, target: b.id, label: 'Ship' });
    // Only e2 is a member of this flow — e1 exists in the document but isn't a step.
    const model = buildSequenceModel(doc([a, junction, b], [e1, e2]), linearFlow([e2.id]));

    expect(model.participants.map((p) => p.label)).toEqual(['A', 'B']);
    expect(model.messages[0]).toMatchObject({ from: 'P1', to: 'P2', label: 'Ship' });
  });

  it('an ambiguous junction fan-in falls back to the Junction itself as a participant', () => {
    const a = createNode({ type: 'service', x: 0, y: 0, text: 'A' });
    const b = createNode({ type: 'service', x: 0, y: 150, text: 'B' });
    const junction = createNode({ type: 'ellipse', x: 200, y: 75 });
    const c = createNode({ type: 'service', x: 400, y: 75, text: 'C' });
    const e1 = createEdge({ source: a.id, target: junction.id });
    const e2 = createEdge({ source: b.id, target: junction.id });
    const e3 = createEdge({ source: junction.id, target: c.id, label: 'Fan out' });
    const model = buildSequenceModel(doc([a, b, junction, c], [e1, e2, e3]), linearFlow([e3.id]));

    expect(model.participants.some((p) => p.isJunctionFallback)).toBe(true);
    expect(model.messages[0]!.label).toBe('Fan out');
  });

  it('a dangling junction (nothing feeding it) falls back to the Junction itself', () => {
    const junction = createNode({ type: 'ellipse', x: 0, y: 0 });
    const b = createNode({ type: 'service', x: 200, y: 0, text: 'B' });
    const edge = createEdge({ source: junction.id, target: b.id, label: 'Go' });
    const model = buildSequenceModel(doc([junction, b], [edge]), linearFlow([edge.id]));

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
    const model = buildSequenceModel(
      doc([a, junction, b, c, d], [first, firstOut, unrelated, second, secondOut]),
      linearFlow([first.id, firstOut.id, unrelated.id, second.id, secondOut.id]),
    );

    const labels = model.messages.map((m) => m.label);
    expect(labels).toEqual(['First', 'Unrelated', 'Second']);
  });
});

describe('buildSequenceModel — participants and labels', () => {
  it('duplicate display names are disambiguated in the shown label, not the machine id', () => {
    const a = createNode({ type: 'service', x: 0, y: 0, text: 'Service' });
    const b = createNode({ type: 'service', x: 200, y: 0, text: 'Service' });
    const edge = createEdge({ source: a.id, target: b.id, label: 'Calls' });
    const model = buildSequenceModel(doc([a, b], [edge]), linearFlow([edge.id]));

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
    const model = buildSequenceModel(doc([a, b, c], [e1, e2]), linearFlow([e1.id, e2.id]));

    expect(model.participants.map((p) => p.label)).toEqual(['B', 'C', 'A']);
  });

  it('an edge with no label and no semantic falls through every tier to the generic bucket word', () => {
    const note = createNode({ type: 'note', x: 0, y: 0 });
    const service = createNode({ type: 'service', x: 200, y: 0, text: 'Service' });
    // A decorative node has category 'generic' — the matrix has no opinion on generic>service.
    const edge = createEdge({ source: note.id, target: service.id });
    const model = buildSequenceModel(doc([note, service], [edge]), linearFlow([edge.id]));

    expect(model.messages[0]!.label).toBe('Call');
  });

  it('handles a decorative node as an edge endpoint without crashing', () => {
    const codeNode = createNode({ type: 'code', x: 0, y: 0 });
    const service = createNode({ type: 'service', x: 200, y: 0, text: 'Service' });
    const edge = createEdge({ source: codeNode.id, target: service.id, label: 'Deploys' });
    const model = buildSequenceModel(doc([codeNode, service], [edge]), linearFlow([edge.id]));

    expect(model.participants).toHaveLength(2);
    expect(model.messages[0]!.label).toBe('Deploys');
  });

  it('a self-referencing edge does not crash and collapses to a single participant', () => {
    const a = createNode({ type: 'service', x: 0, y: 0, text: 'A' });
    const edge = createEdge({ source: a.id, target: a.id, label: 'Retry' });
    const model = buildSequenceModel(doc([a], [edge]), linearFlow([edge.id]));

    expect(model.participants).toHaveLength(1);
    expect(model.messages[0]).toMatchObject({ from: 'P1', to: 'P1', label: 'Retry' });
  });
});

describe('buildSequenceModel — steps, frames, and ordering', () => {
  it('a frame step (no edgeId, no extraEdgeIds) contributes no message', () => {
    const a = createNode({ type: 'service', x: 0, y: 0, text: 'A' });
    const b = createNode({ type: 'service', x: 200, y: 0, text: 'B' });
    const model = buildSequenceModel(
      doc([a, b], []),
      flow([{ id: 'fs1', extraNodeIds: [a.id, b.id], caption: 'Starting state' }]),
    );

    expect(model.messages).toHaveLength(0);
    expect(model.participants).toHaveLength(0);
  });

  it('extraEdgeIds each produce their own message, in [edgeId, ...extraEdgeIds] order', () => {
    const a = createNode({ type: 'service', x: 0, y: 0, text: 'A' });
    const b = createNode({ type: 'service', x: 200, y: 0, text: 'B' });
    const c = createNode({ type: 'service', x: 400, y: 0, text: 'C' });
    const primary = createEdge({ source: a.id, target: b.id, label: 'Primary' });
    const extra = createEdge({ source: b.id, target: c.id, label: 'Extra' });
    const model = buildSequenceModel(
      doc([a, b, c], [primary, extra]),
      flow([{ id: 'fs1', edgeId: primary.id, extraEdgeIds: [extra.id] }]),
    );

    expect(model.messages.map((m) => m.label)).toEqual(['Primary', 'Extra']);
  });

  it('an empty flow produces an empty, non-crashing model', () => {
    const model = buildSequenceModel(doc([], []), flow([]));
    expect(model.participants).toHaveLength(0);
    expect(model.messages).toHaveLength(0);
    expect(model.flowTitle).toBe('Checkout');
  });

  it('message order is gapless and stable regardless of step count', () => {
    const nodes = Array.from({ length: 4 }, (_, i) => createNode({ type: 'service', x: i * 200, y: 0, text: `N${i}` }));
    const edges = nodes.slice(0, -1).map((n, i) => createEdge({ source: n.id, target: nodes[i + 1]!.id, label: `E${i}` }));
    const model = buildSequenceModel(doc(nodes, edges), linearFlow(edges.map((e) => e.id)));

    expect(model.messages.map((m) => m.order)).toEqual([0, 1, 2]);
  });
});
