import { describe, expect, it } from 'vitest';
import { createDocument, createEdge, createNode } from '../src/document/factory';
import { addFlow, addStepToFlow, createFlow } from '../src/document/flow';
import { addEdges, addNodes } from '../src/document/operations';
import { messagesOf } from '../src/document/sequenceModel';
import { addOperand, createFragment, createMessage, createNote, createReply, groupParticipants, insertItem, wrapItems } from '../src/document/sequenceOps';
import type { DraftDocument, DraftNode, DraftSequence, SeqFragment, SeqItem, SeqMessage, SeqParticipant } from '../src/document/types';
import { countSequences, sequenceSourceFor } from '../src/export/sequence';
import { sourceFileNameFor } from '../src/export/source';
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

  it('a sequence is a diagram of its own, after the Flows: one Mermaid block each', () => {
    // A Mermaid text holds one diagram, and a second `sequenceDiagram` header made all of it
    // unreadable: several are Markdown, a block each. PlantUML takes several in one file.
    const doc = addNodes(flowDoc(), [asNode(everything())]);
    expect(countSequences(doc)).toBe(1);
    const text = sequenceSourceFor(doc, 'mermaid');
    expect(text).toMatch(/^```mermaid\n%% Generated by Draft Canvas from "Doc"\nsequenceDiagram\n[\s\S]*?\n```\n\n```mermaid\n%% Sequence "Checkout", from Draft Canvas\nsequenceDiagram\n[\s\S]*\n```\n$/);
    expect(text.match(/^```mermaid$/gm)).toHaveLength(2);
    expect(sourceFileNameFor(doc, 'mermaid')).toBe('doc.md');
    expect(sourceFileNameFor(flowDoc(), 'mermaid')).toBe('doc.mmd');
    expect(sequenceSourceFor(doc, 'plantuml').match(/^@startuml$/gm)).toHaveLength(2);
    expect(sourceFileNameFor(doc, 'plantuml')).toBe('doc.puml');

    // Read back, it is the first diagram, and the notice names the other.
    const read = parseMermaidSequence(text);
    expect(read.ok && messagesOf(read.sequence).map((message) => message.label)).toEqual(['call']);
    expect(read.ok && read.unsupported).toContain('another Mermaid block in the file (not imported)');
  });

  it('a label with three backticks stays inside its block', () => {
    const two = addNodes(createDocument('Doc'), [asNode({ participants: [who('a', 'A'), who('b', 'B')], items: [call('m', 'a', 'b', 'returns ```json')] }), { ...asNode(everything()), id: 'n_two' }]);
    const read = parseMermaidSequence(sequenceSourceFor(two, 'mermaid'));
    expect(read.ok && messagesOf(read.sequence).map((message) => message.label)).toEqual(['returns ```json']);
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

  it('preserves literal Mermaid entity codes alongside the characters they name', () => {
    const name = 'Parser #lt; <';
    const label = 'Encode & as #amp; and < as #lt;';
    const sequence = { participants: [who('a', name), who('b', 'API')], items: [call('send', 'a', 'b', label)] };
    const read = parseMermaidSequence(sequenceToMermaid(asNode(sequence)));
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.sequence.participants[0]?.name).toBe(name);
    expect(messagesOf(read.sequence)[0]?.label).toBe(label);
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
      %% a comment
      Web->>+Auth: check password %% not one
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
      // Only a line that starts `%%` is a comment: Mermaid keeps the rest of this one as the message.
      ['sync', 'check password %% not one', true, false, false],
      ['reply', 'token', false, true, true],
      ['loop', ['every minute', [['async', 'refresh', false, false, false]]]],
      ['note', 'Tokens last an hour\nthen expire', 1, 'right'],
      ['reply', 'Signed in', false, true, true],
    ]);
    expect(read.unsupported).toEqual(['message numbering (autonumber)', 'a tinted background (rect): what was inside it is kept']);
  });

  it('reads what Mermaid reads: a title in the body, a %% inside text, a par_over', () => {
    // `title:` was a line it couldn't read, `100%% done` came back as "100", and `par_over`'s `end`
    // closed the loop around it, so "store results" fell out of the loop.
    const read = parseMermaidSequence(`sequenceDiagram
  title: Checkout flow
  A->>B: 100%% done
  loop every minute
    par_over Poll both
      A->>B: poll B
    and
      A->>C: poll C
    end
    A->>A: store results
  end
`);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.title).toBe('Checkout flow');
    expect(shape(read.sequence.items)).toEqual([
      ['sync', '100%% done', false, false, false],
      ['loop', ['every minute', [['par', ['Poll both', [['sync', 'poll B', false, false, false]]], ['', [['sync', 'poll C', false, false, false]]]], ['sync', 'store results', false, false, false]]]],
    ]);
    expect(read.unsupported).toEqual([]);
  });

  it('reads a critical section’s options as its branches, each with its condition', () => {
    // They were merged into one straight line with their conditions gone, and nothing said so.
    const read = parseMermaidSequence('sequenceDiagram\n  A->>B: connect\n  critical Establish a connection\n    A->>DB: open\n  option Network timeout\n    A->>A: log error\n  option Bad credentials\n    A->>A: alert\n  end\n');
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(shape(read.sequence.items)).toEqual([
      ['sync', 'connect', false, false, false],
      ['critical', ['Establish a connection', [['sync', 'open', false, false, false]]], ['Network timeout', [['sync', 'log error', false, false, false]]], ['Bad credentials', [['sync', 'alert', false, false, false]]]],
    ]);
    expect(read.unsupported).toEqual([]);
    expect(sequenceToMermaid(asNode(read.sequence))).toContain('    critical Establish a connection\n        A->>DB: open\n    option Network timeout\n');
    expect(sequenceToPlantUml(asNode(read.sequence))).toContain('critical Establish a connection\n    A -> DB: open\nelse Network timeout\n');
  });

  it('reads the first of two diagrams written in one text, and says the other is left out', () => {
    // What a canvas with two sequences exported before: the second was read into the first.
    const read = parseMermaidSequence('sequenceDiagram\n  Web->>API: POST /orders\n\nsequenceDiagram\n  Support->>Payments: refund\n');
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.sequence.participants.map((participant) => participant.name)).toEqual(['Web', 'API']);
    expect(read.unsupported).toEqual(['another sequence diagram in the text (not imported)']);
  });

  it('refuses what is not a sequence diagram, and one with nobody in it', () => {
    expect(parseMermaidSequence('flowchart LR\n A-->B')).toEqual({ ok: false, error: 'That text does not start with "sequenceDiagram".' });
    expect(parseMermaidSequence('sequenceDiagram\n')).toEqual({ ok: false, error: 'There is nobody in that sequence diagram.' });
  });

  it('reads a dashed arrow with a single arrowhead as a reply', () => {
    const read = parseMermaidSequence('sequenceDiagram\n  Client->>API: GET /orders\n  API-->Client: 200');
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(shape(read.sequence.items)).toEqual([
      ['sync', 'GET /orders', false, false, false],
      ['reply', '200', false, false, true],
    ]);
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

describe('reading hostile Mermaid', () => {
  const spaces = ' '.repeat(60_000);
  const timed = (text: string) => {
    const started = performance.now();
    const result = parseMermaidSequence(text);
    return { result, ms: performance.now() - started };
  };

  // Each took seconds at 40 KB and minutes near the 512 KB cap: a lazy group beside `\s*` backtracked
  // over every split of a run of spaces that no arrow, colon or `as` ended.
  it.each([
    ['a line with no arrow', `a${spaces}b`],
    ['a message with nothing after its receiver', `a->>b${spaces}c`],
    ['a note with no colon', `Note over a${spaces}b`],
    ['a declaration with no alias', `participant a${spaces}b`],
    ['a configured declaration', `participant a${spaces}b @{ x`],
    ['a box whose colour never closes', `box rgb(1${spaces}2${spaces}`],
    ['a box with a long colour', `box rgb(1${spaces}2${spaces}) a${spaces}b`],
  ])('reads %s in one pass', (_name, line) => {
    expect(timed(`sequenceDiagram\n${line}\n`).ms).toBeLessThan(500);
  });

  it('reads a front-matter title in one pass', () => {
    const { result, ms } = timed(`---\ntitle: a${spaces}b\n---\nsequenceDiagram\nA->>B: hi\n`);
    expect(ms).toBeLessThan(500);
    expect(result.ok && result.title.startsWith('a')).toBe(true);
  });

  it('does not walk everything opened or said above each line', () => {
    // 20,000 nested loops took 4 s, and 30,000 calls then as many replies that answer none of them
    // 14 s: every new participant and every reply walked the whole stack or every waiting call.
    const pairs = Array.from({ length: 2_000 }, (_, i) => `p${i}->>q${i}: c\nq${i}-->>p${i}: r\n`).join('');
    const deep = timed(`sequenceDiagram\n${'loop x\n'.repeat(20_000)}${pairs}`);
    expect(deep.ms).toBeLessThan(2000);
    const calls = 'a->>b\n'.repeat(30_000);
    expect(timed(`sequenceDiagram\n${calls}${'c-->>d\n'.repeat(30_000)}`).ms).toBeLessThan(2000);
    expect(timed(`sequenceDiagram\n${calls}${'opt\nend\n'.repeat(30_000)}`).ms).toBeLessThan(2000);
  });

  it('keeps what one sequence holds of a text past it, and counts the rest', () => {
    const nested = `sequenceDiagram\n${'loop x\n'.repeat(20)}A->>B: deep\n${'end\n'.repeat(20)}A->>B: after\n`;
    const read = parseMermaidSequence(nested);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    // Eight frames deep, as a file keeps; the rest are opened out and their message stays inside.
    let depth = 0;
    let items = read.sequence.items;
    while (items[0]?.t === 'fragment') {
      depth += 1;
      items = items[0].operands[0]!.items;
    }
    expect(depth).toBe(8);
    expect(messagesOf(read.sequence).map((message) => message.label)).toEqual(['deep', 'after']);
    expect(read.unsupported).toContain('12 parts beyond what one sequence holds');

    const many = parseMermaidSequence(`sequenceDiagram\n${Array.from({ length: 45 }, (_, i) => `A->>P${i}: m${i}\n`).join('')}`);
    expect(many.ok).toBe(true);
    if (!many.ok) return;
    expect(many.sequence.participants).toHaveLength(40);
    expect(messagesOf(many.sequence)).toHaveLength(39);
    // Six participants past the 40th, and the six messages to them.
    expect(many.unsupported).toContain('12 parts beyond what one sequence holds');

    const long = parseMermaidSequence(`sequenceDiagram\n${'A->>B: x\nB-->>A: y\n'.repeat(400)}`);
    expect(long.ok && messagesOf(long.sequence)).toHaveLength(600);
    expect(long.ok && long.unsupported).toContain('200 parts beyond what one sequence holds');
  });
});

it('reports a sender-destroy directive without ending the receiver’s lifeline', () => {
  const result = parseMermaidSequence('sequenceDiagram\nparticipant A\nparticipant B\ndestroy A\nA->>B: Goodbye\nB->>B: Continue');
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.unsupported.join(' ')).toContain('destroys its sender');
  expect(messagesOf(result.sequence).map((message) => message.kind)).toEqual(['sync', 'sync']);
});

it('keeps a configured Mermaid participant under the same ID as its messages', () => {
  const result = parseMermaidSequence('sequenceDiagram\nparticipant A@{ "type": "database" }\nA->>B: Hello');
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.sequence.participants.map((participant) => participant.name)).toEqual(['A', 'B']);
  expect(result.unsupported.join(' ')).toContain('participant configuration');
  expect(messagesOf(result.sequence)[0]?.from).toBe(result.sequence.participants[0]?.id);
});
