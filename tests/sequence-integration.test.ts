import { describe, expect, it } from 'vitest';
import { createDocument, createEdge, createNode } from '../src/document/factory';
import { createFlow } from '../src/document/flow';
import type { DraftDocument } from '../src/document/types';
import { buildSequenceModel } from '../src/sequence/build';
import { toMermaid } from '../src/sequence/mermaid';
import { toPlantUml } from '../src/sequence/plantuml';

/**
 * End-to-end: a realistic Saga-style canvas (two flows sharing participants, a Note, a Question,
 * and a structural `dependsOn` edge) through the whole Canvas -> SequenceModel -> {Mermaid,
 * PlantUML} pipeline — the same shape of diagram the product brief itself uses as its worked
 * example, run for real rather than hand-built.
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

describe('Canvas -> SequenceModel -> Mermaid/PlantUML — Saga (Happy Path + Compensation)', () => {
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

  it('renders valid Mermaid with both flows grouped and notes preserved', () => {
    const out = toMermaid(buildSequenceModel(buildSagaDocument()));

    expect(out).toContain('sequenceDiagram');
    expect(out).toContain('actor Customer as "Customer"');
    expect(out.match(/rect rgb\(240, 240, 240\)/g)).toHaveLength(2);
    expect(out).toContain('Place Order');
    expect(out).toContain('Charge Card');
    expect(out).toContain('Retries up to 3 times on timeout');
    expect(out).toContain('Question: Should this retry on failure?');
    expect(out).toContain('Release Payment');
  });

  it('renders valid PlantUML with both flows grouped and notes preserved', () => {
    const out = toPlantUml(buildSequenceModel(buildSagaDocument()));

    expect(out).toContain('@startuml');
    expect(out).toContain('@enduml');
    expect(out).toContain('actor "Customer" as Customer');
    expect(out).toContain('group Happy Path');
    expect(out).toContain('group Compensation');
    expect(out).toContain('Retries up to 3 times on timeout');
    expect(out).toContain('Question: Should this retry on failure?');
  });

  it('produces byte-identical output across two builds of the same document', () => {
    const docA = buildSagaDocument();
    const docB = buildSagaDocument();
    expect(toMermaid(buildSequenceModel(docA))).toBe(toMermaid(buildSequenceModel(docB)));
    expect(toPlantUml(buildSequenceModel(docA))).toBe(toPlantUml(buildSequenceModel(docB)));
  });
});
