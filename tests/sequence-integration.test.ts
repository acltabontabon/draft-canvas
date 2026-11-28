import { describe, expect, it } from 'vitest';
import { createDocument, createEdge, createNode } from '../src/document/factory';
import { createFlow } from '../src/document/flow';
import type { DraftDocument } from '../src/document/types';
import { buildSequenceModel } from '../src/sequence/build';
import { sequenceFromFlow } from '../src/sequence/fromFlow';

/**
 * End-to-end: a realistic Saga-style canvas (two flows sharing participants, a Note, a Question,
 * and a structural `dependsOn` edge) read as a sequence — the same shape of diagram the product
 * brief itself uses as its worked example, run for real rather than hand-built.
 */
function buildSagaDocument(): DraftDocument {
  const customer = createNode({ type: 'actor', x: 0, y: 0, text: 'Customer' });
  const orderApi = createNode({ type: 'service', x: 200, y: 0, text: 'Order API' });
  const paymentService = createNode({ type: 'service', x: 400, y: 0, text: 'Payment Service' });
  const paymentDb = createNode({ type: 'database', x: 600, y: 0, text: 'Payment DB' });

  const placeOrder = {
    ...createEdge({ source: customer.id, target: orderApi.id, label: 'Place Order', hasResponse: true }),
    response: 'Order Confirmed',
  };
  const chargeCard = {
    ...createEdge({ source: orderApi.id, target: paymentService.id, label: 'Charge Card', hasResponse: true }),
    response: 'Approved',
  };
  const saveTransaction = createEdge({ source: paymentService.id, target: paymentDb.id, label: 'Save Transaction' });
  const releasePayment = createEdge({ source: paymentService.id, target: orderApi.id, label: 'Release Payment' });
  const dependsOnDb = createEdge({ source: paymentService.id, target: paymentDb.id, semantic: 'dependsOn' });

  const retryNote = createNode({ type: 'note', x: 400, y: 200, text: 'Retries up to 3 times on timeout' });
  const question = createNode({
    type: 'note',
    noteKind: 'question',
    x: 200,
    y: 200,
    text: 'Should this retry on failure?',
  });

  const happyPath = createFlow({ title: 'Happy Path' });
  happyPath.steps = [
    { id: 'hp1', edgeId: placeOrder.id },
    { id: 'hp2', edgeId: chargeCard.id, extraNodeIds: [retryNote.id] },
    { id: 'hp3', edgeId: saveTransaction.id },
  ];
  const compensation = createFlow({ title: 'Compensation' });
  compensation.steps = [
    { id: 'c1', edgeId: releasePayment.id, extraNodeIds: [question.id] },
    { id: 'c2', edgeId: dependsOnDb.id },
  ];

  return {
    ...createDocument('Payment Saga'),
    nodes: [customer, orderApi, paymentService, paymentDb, retryNote, question],
    edges: [placeOrder, chargeCard, saveTransaction, releasePayment, dependsOnDb],
    flows: [happyPath, compensation],
  };
}

describe('Canvas -> SequenceModel — Saga (Happy Path + Compensation)', () => {
  it('produces one coherent model with both flows as separate groups, in participant-appearance order', () => {
    const model = buildSequenceModel(buildSagaDocument());

    expect(model.participants.map((p) => p.label)).toEqual(['Customer', 'Order API', 'Payment Service', 'Payment DB']);
    expect(model.elements.map((el) => (el.kind === 'group' ? el.label : el.kind))).toEqual(['Happy Path', 'Compensation']);
  });

  it('the dependsOn edge (Payment Service -> Payment DB) contributes no message — only Save Transaction does', () => {
    const model = buildSequenceModel(buildSagaDocument());
    const messages = model.elements.flatMap((el) => (el.kind === 'group' ? el.children.filter((c) => c.kind === 'message') : []));

    // Place Order+response, Charge Card+response, Save Transaction (Happy Path) = 5;
    // Release Payment (Compensation) = 1; the dependsOn hop contributes nothing. Total 6.
    expect(messages).toHaveLength(6);
    const paymentToDb = messages.filter((m) => m.from === 'P3' && m.to === 'P4');
    expect(paymentToDb).toHaveLength(1);
    expect(paymentToDb[0]).toMatchObject({ label: 'Save Transaction' });
  });

  it('keeps each flow\'s notes in its own group, with the words they were written in', () => {
    const model = buildSequenceModel(buildSagaDocument());
    const notesIn = (label: string) =>
      model.elements.flatMap((el) => (el.kind === 'group' && el.label === label ? el.children.flatMap((c) => (c.kind === 'note' ? [c] : [])) : []));

    expect(notesIn('Happy Path').map((note) => note.text)).toEqual(['Retries up to 3 times on timeout']);
    expect(notesIn('Compensation')).toMatchObject([{ text: 'Should this retry on failure?', noteKind: 'question' }]);
  });

  it('draws one flow as a native sequence: its participants, its calls and replies, its note', () => {
    const document = buildSagaDocument();
    const drawn = sequenceFromFlow(document, document.flows[0]!.id)!;

    expect(drawn.title).toBe('Happy Path');
    expect(drawn.sequence.participants.map((participant) => participant.name)).toEqual(['Customer', 'Order API', 'Payment Service', 'Payment DB']);
    const messages = drawn.sequence.items.flatMap((item) => (item.t === 'message' ? [item] : []));
    expect(messages.map((message) => message.label)).toEqual(expect.arrayContaining(['Place Order', 'Order Confirmed', 'Charge Card', 'Approved', 'Save Transaction']));
    expect(messages.filter((message) => message.kind === 'reply')).toHaveLength(2);
    expect(drawn.sequence.items.some((item) => item.t === 'note' && item.text === 'Retries up to 3 times on timeout')).toBe(true);
  });
});
