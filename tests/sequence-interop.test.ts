import { describe, expect, it } from 'vitest';
import { createDocument, createEdge, createNode } from '../src/document/factory';
import { addFlow, addStepToFlow, createFlow } from '../src/document/flow';
import { addEdges, addNodes } from '../src/document/operations';
import { messagesOf } from '../src/document/sequenceModel';
import { addOperand, createFragment, createMessage, createNote, createReply, groupParticipants, insertItem, wrapItems } from '../src/document/sequenceOps';
import type { DraftDocument, DraftNode, DraftSequence, SeqFragment, SeqItem, SeqMessage, SeqParticipant } from '../src/document/types';
import { countSequences, sequenceSourceFor } from '../src/export/sequence';
import { importMermaid, looksLikeMermaid } from '../src/import/mermaid';
import { parseMermaidSequence } from '../src/import/mermaid/sequence';
import { sequenceFromFlow } from '../src/sequence/fromFlow';
import { sequenceToMermaid } from '../src/sequence/native/mermaid';
import { sequenceToPlantUml } from '../src/sequence/native/plantuml';

const who = (id: string, name: string, extra: Partial<SeqParticipant> = {}): SeqParticipant => ({ id, name, type: 'service', serviceKind: 'generic', ...extra });
const call = (id: string, from: string, to: string, label: string): SeqMessage => createMessage({ id, from, to, label });

/** Everything a sequence can hold, once. */
function everything(): DraftSequence {
  const post = call('post', 'shopper', 'api', 'POST /orders');
  const pay = call('pay', 'api', 'bank', 'authorize; capture later');
  let sequence: DraftSequence = {
    participants: [
      who('shopper', 'Shopper', { type: 'actor', actorKind: 'human' }),
      who('api', 'Checkout API'),
      who('bank', 'Payment Provider', { serviceKind: 'external' }),
      who('db', 'Orders', { type: 'database', databaseKind: 'sql' }),
      who('bus', 'Order events', { type: 'queue', queueKind: 'topic' }),
      who('job', 'Receipt job', { serviceKind: 'worker' }),
    ],
    items: [
      post,
      pay,
      { ...createReply(pay, 'approved'), id: 'approved' },
      call('save', 'api', 'db', 'INSERT order'),
      createMessage({ id: 'publish', from: 'api', to: 'bus', kind: 'async', label: 'OrderPlaced' }),
      createMessage({ id: 'spawn', from: 'api', to: 'job', kind: 'create', label: 'start' }),
      createMessage({ id: 'done', from: 'api', to: 'job', kind: 'destroy', label: 'stop' }),
    ],
  };
  sequence = wrapItems(sequence, ['pay', 'approved'], { id: 'alt', operator: 'alt', guard: 'card accepted' });
  sequence = addOperand(sequence, 'alt', { id: 'else', guard: 'declined' });
  // Either way the shopper is answered: the same call, replied to in both branches.
  sequence = insertItem(sequence, { ...createReply(post, '402'), id: 'refuse' }, { operandId: 'else', index: 0 });
  sequence = wrapItems(sequence, ['save'], { id: 'par', operator: 'par' });
  sequence = addOperand(sequence, 'par', { id: 'second' });
  sequence = insertItem(sequence, createNote({ id: 'note', over: ['api', 'db'], text: 'One row per order.' }), { operandId: 'second', index: 0 });
  sequence = insertItem(sequence, { ...createReply(post, '201 Created'), id: 'created' }, { operandId: (sequence.items.find((item) => item.id === 'alt') as SeqFragment).operands[0]!.id, index: 2 });
  sequence = insertItem(sequence, createFragment({ id: 'ref', operator: 'ref', label: 'Fraud check', covers: ['api', 'bank'] }), { operandId: null, index: 1 });
  return groupParticipants(sequence, ['api', 'db'], { id: 'g', name: 'Our systems' });
}

const asNode = (sequence: DraftSequence, title = 'Checkout'): DraftNode => ({ ...createNode({ id: 'n_seq', type: 'sequence', x: 0, y: 0, text: title }), sequence });

describe('a sequence as Mermaid', () => {
  it('says everything Mermaid has words for, and marks what it has not', () => {
    expect(sequenceToMermaid(asNode(everything()))).toBe(`%% Sequence "Checkout", from Draft Canvas
sequenceDiagram
    actor Shopper as Shopper
    box transparent Our systems
        participant CheckoutAPI as Checkout API
        participant Orders as Orders
    end
    participant PaymentProvider as Payment Provider
    participant OrderEvents as Order events

    Shopper->>+CheckoutAPI: POST /orders
    %% Mermaid has no reference to another interaction: written as a note.
    Note over CheckoutAPI,PaymentProvider: ref: Fraud check
    alt card accepted
        CheckoutAPI->>+PaymentProvider: authorize#59; capture later
        PaymentProvider-->>-CheckoutAPI: approved
        CheckoutAPI-->>-Shopper: 201 Created
    else declined
        CheckoutAPI-->>Shopper: 402
    end
    par
        CheckoutAPI->>+Orders: INSERT order
    and
        Note over CheckoutAPI,Orders: One row per order.
    end
    CheckoutAPI-)OrderEvents: OrderPlaced
    create participant ReceiptJob as Receipt job
    CheckoutAPI-->>ReceiptJob: start
    destroy ReceiptJob
    CheckoutAPI-xReceiptJob: stop
`);
  });

  it('never ends work Mermaid does not think is running — its count has no branches', () => {
    const post = call('post', 'a', 'b', 'POST');
    let sequence: DraftSequence = { participants: [who('a', 'A'), who('b', 'B')], items: [post, { ...createReply(post, 'ok'), id: 'ok' }, { ...createReply(post, 'failed'), id: 'failed' }] };
    sequence = wrapItems(sequence, ['ok'], { id: 'alt', operator: 'alt' });
    sequence = addOperand(sequence, 'alt', { id: 'else' });
    sequence = { ...sequence, items: sequence.items.filter((item) => item.id !== 'failed') };
    sequence = insertItem(sequence, { ...createReply(post, 'failed'), id: 'failed' }, { operandId: 'else', index: 0 });
    const text = sequenceToMermaid(asNode(sequence));
    expect(text).toContain('B-->>-A: ok');
    expect(text).toContain('B-->>A: failed');
  });

  it('a group named like a colour is not painted that colour', () => {
    const sequence = groupParticipants({ participants: [who('a', 'A'), who('b', 'B')], items: [] }, ['a', 'b'], { id: 'g', name: 'Blue team' });
    expect(sequenceToMermaid(asNode(sequence))).toContain('box transparent Blue team');
  });
});

describe('a sequence as PlantUML', () => {
  it('says all of it, references included', () => {
    expect(sequenceToPlantUml(asNode(everything()))).toBe(`' Sequence "Checkout", from Draft Canvas
@startuml
actor "Shopper" as Shopper
box "Our systems"
participant "Checkout API" as CheckoutAPI
database "Orders" as Orders
end box
participant "Payment Provider" as PaymentProvider
queue "Order events" as OrderEvents

Shopper -> CheckoutAPI: POST /orders
activate CheckoutAPI
ref over CheckoutAPI, PaymentProvider : Fraud check
alt card accepted
    CheckoutAPI -> PaymentProvider: authorize; capture later
    activate PaymentProvider
    PaymentProvider --> CheckoutAPI: approved
    deactivate PaymentProvider
    CheckoutAPI --> Shopper: 201 Created
    deactivate CheckoutAPI
else declined
    CheckoutAPI --> Shopper: 402
end
par
    CheckoutAPI -> Orders: INSERT order
    activate Orders
else
    note over CheckoutAPI,Orders
        One row per order.
    end note
end
CheckoutAPI ->> OrderEvents: OrderPlaced
create participant "Receipt job" as ReceiptJob
CheckoutAPI --> ReceiptJob: start
CheckoutAPI -> ReceiptJob: stop
destroy ReceiptJob
@enduml
`);
  });
});

describe('the source export', () => {
  const service = (id: string, x: number) => createNode({ id, type: 'service', x, y: 0, text: id });
  const flowDoc = (): DraftDocument => {
    const edge = createEdge({ id: 'e1', source: 'a', target: 'b', label: 'call' });
    const flow = createFlow({ title: 'Story' });
    return addStepToFlow(addFlow(addEdges(addNodes(createDocument('Doc'), [service('a', 0), service('b', 300)]), [edge]), flow), flow.id, 'e1');
  };

  it('a canvas with only Flows reads exactly as it always did', () => {
    const doc = flowDoc();
    expect(countSequences(doc)).toBe(0);
    expect(sequenceSourceFor(doc, 'mermaid')).toMatch(/^%% Generated by Draft Canvas from "Doc"\nsequenceDiagram\n/);
    expect(sequenceSourceFor(doc, 'mermaid').match(/sequenceDiagram/g)).toHaveLength(1);
  });

  it('a sequence is a diagram of its own, after the Flows', () => {
    const doc = addNodes(flowDoc(), [asNode(everything())]);
    expect(countSequences(doc)).toBe(1);
    const text = sequenceSourceFor(doc, 'mermaid');
    expect(text.match(/^sequenceDiagram$/gm)).toHaveLength(2);
    expect(text.indexOf('Generated by Draft Canvas')).toBeLessThan(text.indexOf('Sequence "Checkout"'));
    expect(sequenceSourceFor(doc, 'plantuml').match(/^@startuml$/gm)).toHaveLength(2);
  });

  it('a canvas with a sequence and no Flow exports the sequence; an empty frame is not yet a diagram', () => {
    const only = addNodes(createDocument('Doc'), [asNode(everything())]);
    expect(sequenceSourceFor(only, 'plantuml')).toBe(sequenceToPlantUml(asNode(everything())));
    const empty = addNodes(createDocument('Doc'), [asNode({ participants: [], items: [] })]);
    expect(countSequences(empty)).toBe(0);
  });
});

describe('reading Mermaid', () => {
  const shape = (items: readonly SeqItem[]): unknown[] =>
    items.map((item) =>
      item.t === 'message'
        ? [item.kind, item.label, Boolean(item.activate), Boolean(item.deactivate), Boolean(item.replyTo)]
        : item.t === 'note'
          ? ['note', item.text, item.over.length, item.side ?? 'over']
          : [item.operator, ...(item as SeqFragment).operands.map((branch) => [branch.guard ?? '', shape(branch.items)])],
    );

  it('what was written out reads back as the same sequence', () => {
    const original = everything();
    const read = parseMermaidSequence(sequenceToMermaid(asNode(original)));
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.sequence.participants.map((participant) => [participant.name, participant.type])).toEqual([
      ['Shopper', 'actor'],
      ['Checkout API', 'service'],
      ['Orders', 'service'],
      ['Payment Provider', 'service'],
      ['Order events', 'service'],
      ['Receipt job', 'service'],
    ]);
    expect(read.sequence.groups?.map((group) => [group.name, group.participantIds.length])).toEqual([['Our systems', 2]]);
    // The reference came out as a note, and comes back as one; everything else is what it was.
    const expected = shape(original.items);
    expected[1] = ['note', 'ref: Fraud check', 2, 'over'];
    expect(shape(read.sequence.items)).toEqual(expected);
    expect(messagesOf(read.sequence).find((message) => message.label === 'authorize; capture later')).toBeDefined();
  });

  it('reads a diagram somebody wrote by hand, and says what it left out', () => {
    const read = parseMermaidSequence(`---
title: Sign in
---
sequenceDiagram
    autonumber
    actor U as User
    participant Web
    U->>+Web: Sign in
    rect rgb(240, 240, 240)
      Web->>+Auth: check password %% a comment
      Auth-->>-Web: token
    end
    loop every minute
      Web-)Auth: refresh
    end
    Note right of Auth: Tokens last an hour<br/>then expire
    Web-->>-U: Signed in
`);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.title).toBe('Sign in');
    expect(read.sequence.participants.map((participant) => participant.name)).toEqual(['User', 'Web', 'Auth']);
    expect(shape(read.sequence.items)).toEqual([
      ['sync', 'Sign in', true, false, false],
      ['sync', 'check password', true, false, false],
      ['reply', 'token', false, true, true],
      ['loop', ['every minute', [['async', 'refresh', false, false, false]]]],
      ['note', 'Tokens last an hour\nthen expire', 1, 'right'],
      ['reply', 'Signed in', false, true, true],
    ]);
    expect(read.unsupported).toEqual(['message numbering (autonumber)', 'a tinted background (rect): what was inside it is kept']);
  });

  it('refuses what is not a sequence diagram, and one with nobody in it', () => {
    expect(parseMermaidSequence('flowchart LR\n A-->B')).toEqual({ ok: false, error: 'That text does not start with "sequenceDiagram".' });
    expect(parseMermaidSequence('sequenceDiagram\n')).toEqual({ ok: false, error: 'There is nobody in that sequence diagram.' });
  });

  it('is recognised on paste, and arrives as one sequence the size of what it holds', async () => {
    const text = '```mermaid\nsequenceDiagram\n  Client->>API: GET /orders\n  API-->>Client: 200\n```';
    expect(looksLikeMermaid(text)).toBe(true);
    expect(looksLikeMermaid('sequenceDiagramish text')).toBe(false);
    const imported = await importMermaid(text, 'From a README');
    expect(imported.ok).toBe(true);
    if (!imported.ok) return;
    const [node] = imported.document.nodes;
    expect(imported.document.nodes).toHaveLength(1);
    expect(node).toMatchObject({ type: 'sequence', text: 'From a README' });
    expect(messagesOf(node!.sequence!).map((message) => [message.kind, message.label])).toEqual([['sync', 'GET /orders'], ['reply', '200']]);
    expect(node!.width).toBeGreaterThan(200);
    expect(node!.height).toBeGreaterThan(100);
  });
});

describe('a Flow drawn as a sequence', () => {
  it('keeps the Flow’s order, its replies, and the shapes its participants stand for', () => {
    const client = createNode({ id: 'client', type: 'actor', x: 0, y: 0, text: 'Client' });
    const api = createNode({ id: 'api', type: 'service', x: 300, y: 0, text: 'API', technology: 'Spring Boot' });
    const db = createNode({ id: 'db', type: 'database', x: 600, y: 0, text: 'Orders' });
    const request = { ...createEdge({ id: 'e1', source: 'client', target: 'api', label: 'GET /orders' }), hasResponse: true, response: '200 OK' };
    const query = createEdge({ id: 'e2', source: 'api', target: 'db', label: 'SELECT orders' });
    const flow = createFlow({ title: 'List orders' });
    let doc = addFlow(addEdges(addNodes(createDocument('Doc'), [client, api, db]), [request, query]), flow);
    doc = addStepToFlow(addStepToFlow(doc, flow.id, 'e1'), flow.id, 'e2');

    const made = sequenceFromFlow(doc, flow.id)!;
    expect(made.title).toBe('List orders');
    expect(made.sequence.participants.map((participant) => [participant.name, participant.type, participant.ref, participant.technology])).toEqual([
      ['Client', 'actor', 'client', undefined],
      ['API', 'service', 'api', 'Spring Boot'],
      ['Orders', 'database', 'db', undefined],
    ]);
    const labels = messagesOf(made.sequence).map((message) => [message.kind, message.label]);
    expect(labels[0]).toEqual(['sync', 'GET /orders']);
    expect(labels).toContainEqual(['sync', 'SELECT orders']);
    expect(labels).toContainEqual(['reply', '200 OK']);
    expect(messagesOf(made.sequence).find((message) => message.kind === 'reply')!.replyTo).toBe(messagesOf(made.sequence)[0]!.id);
    expect(sequenceFromFlow(doc, 'nothing')).toBeNull();
  });
});
