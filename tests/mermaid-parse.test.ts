import mermaid from 'mermaid';
import { beforeAll, describe, expect, it } from 'vitest';
import { createNode } from '../src/document/factory';
import { messagesOf } from '../src/document/sequenceModel';
import { createMessage, createNote, createReply } from '../src/document/sequenceOps';
import type { DraftSequence, SeqParticipant } from '../src/document/types';
import { parseMermaidSequence } from '../src/import/mermaid/sequence';
import { sequenceToMermaid } from '../src/sequence/native/mermaid';

/**
 * The Mermaid text a sequence is written as (what an agent reads and edits) is checked against
 * Mermaid itself, not against what we think its grammar is: so is the reader that takes such text
 * back. The corpus is the text that has broken sequence diagrams before: statement terminators and
 * comment markers inside labels, a directive planted in a title, participants named after keywords,
 * and colons. A label reaching the diagram unchanged is the point; a directive reaching the renderer
 * would be an injection.
 */
async function parses(text: string): Promise<boolean> {
  const result = await mermaid.parse(text, { suppressErrors: true });
  return result !== false;
}

/** What Mermaid's own database holds for a text: what a reader of the rendered diagram gets. */
async function mermaidDb(text: string) {
  const diagram = await mermaid.mermaidAPI.getDiagramFromText(text);
  return diagram.db as unknown as {
    getMessages(): { type: number; message: string; wrap: boolean; from?: unknown; to?: unknown }[];
    getActors(): Map<string, { description: string; wrap: boolean }>;
    getBoxes(): { name?: string }[];
    getAccTitle(): string;
    getAccDescription(): string;
  };
}

describe('a sequence drawn on the canvas, as Mermaid reads it', () => {
  const who = (id: string, name: string): SeqParticipant => ({ id, name, type: 'service', serviceKind: 'generic' });
  const asNode = (sequence: DraftSequence) => ({ ...createNode({ id: 'n', type: 'sequence', x: 0, y: 0, text: 'T' }), sequence });

  beforeAll(() => {
    mermaid.initialize({ startOnLoad: false });
  });

  it('is a real check: broken text is refused', async () => {
    expect(await parses('sequenceDiagram\n    A->>\n')).toBe(false);
  });

  it.each<[string, string, DraftSequence]>([
    ['a directive in a title', 'Checkout %%{init: {"theme": "forest"}}%%', { participants: [who('a', 'A')], items: [] }],
    [
      'statement breakers and tags in labels',
      'T',
      {
        participants: [who('a', 'Map<String, Order>'), who('b', 'retry(); # then')],
        items: [createMessage({ id: 'm', from: 'a', to: 'b', label: 'POST /orders; charge # 100% <b>now</b>' })],
      },
    ],
    [
      'a directive in a name, a message and a note',
      'T',
      {
        participants: [who('a', 'A %%{init: {"theme": "forest"}}%%'), who('b', 'B')],
        items: [
          createMessage({ id: 'm', from: 'a', to: 'b', label: '%%{init: {"theme": "forest"}}%%' }),
          createNote({ id: 'n', over: ['a'], text: '%%{init: {"theme": "forest"}}%%' }),
        ],
      },
    ],
    [
      'colons kept in labels and notes',
      'T',
      {
        participants: [who('a', 'A'), who('b', 'B')],
        items: [createMessage({ id: 'm', from: 'a', to: 'b', label: 'HTTP 200: OK' }), createNote({ id: 'n', over: ['a'], text: 'Rule: retry twice: then give up' })],
      },
    ],
    [
      'participants named after keywords',
      'T',
      {
        participants: [who('a', 'option'), who('b', 'sequenceDiagram'), who('c', 'links')],
        items: [createMessage({ id: 'm', from: 'a', to: 'b', label: 'end' }), createMessage({ id: 'm2', from: 'b', to: 'c', label: 'Note over' })],
      },
    ],
    [
      'a percent sign that is only a percent sign',
      'T',
      { participants: [who('a', 'A'), who('b', 'B')], items: [createMessage({ id: 'm', from: 'a', to: 'b', label: '99.9% uptime' })] },
    ],
  ])('parses with %s', async (_name, title, sequence) => {
    const text = sequenceToMermaid({ ...asNode(sequence), text: title });
    expect(text).not.toMatch(/%%\{/);
    expect(await parses(text)).toBe(true);
  });

  it('writes a blank label as nothing, and it comes back blank', async () => {
    // Replies, self-messages and notes start blank; they were exported as "Message" and "Note".
    const call = createMessage({ id: 'c', from: 'a', to: 'b', label: 'GET /orders' });
    const sequence: DraftSequence = {
      participants: [who('a', 'Web'), who('b', 'API')],
      items: [call, { ...createReply(call), id: 'r' }, createMessage({ id: 's', from: 'b', to: 'b' }), createNote({ id: 'n', over: ['a'] })],
    };
    const text = sequenceToMermaid(asNode(sequence));
    expect(text).not.toMatch(/Message|Note over Web: Note/);
    expect(await parses(text)).toBe(true);
    expect((await mermaidDb(text)).getMessages().filter((entry) => entry.type === 0 || entry.type === 1 || entry.type === 2).map((entry) => entry.message)).toEqual(['GET /orders', '', '', '']);
    const back = parseMermaidSequence(text);
    expect(back.ok).toBe(true);
    if (!back.ok) return;
    expect(messagesOf(back.sequence).map((message) => message.label)).toEqual(['GET /orders', '', '']);
    expect(back.sequence.items.at(-1)).toMatchObject({ t: 'note', text: '' });
  });

  it('keeps words that start "wrap:" or "nowrap:", which Mermaid reads as a switch and drops', async () => {
    const sequence: DraftSequence = {
      participants: [who('a', 'wrap: Checkout'), who('b', 'B')],
      groups: [{ id: 'g', name: 'nowrap: Team', participantIds: ['b'] }],
      items: [
        createMessage({ id: 'm', from: 'a', to: 'b', label: 'wrap: the order in an envelope' }),
        createMessage({ id: 'm2', from: 'a', to: 'b', label: ':nowrap:raw' }),
        createNote({ id: 'n', over: ['a'], text: 'wrap: note' }),
      ],
    };
    const text = sequenceToMermaid(asNode(sequence));
    expect(await parses(text)).toBe(true);
    const db = await mermaidDb(text);
    // Read as a switch, the flag is set and the words lose their prefix; written as text, neither.
    expect(db.getMessages().filter((entry) => entry.type === 0 || entry.type === 2).map((entry) => [entry.wrap, entry.message.endsWith('rap: the order in an envelope') || entry.message.endsWith('owrap:raw') || entry.message.endsWith('rap: note')])).toEqual([
      [false, true],
      [false, true],
      [false, true],
    ]);
    expect([...db.getActors().values()].map((actor) => [actor.wrap, actor.description.endsWith('rap: Checkout')])[0]).toEqual([false, true]);
    expect((db as unknown as { getBoxes(): { name: string; wrap: boolean }[] }).getBoxes().map((box) => [box.wrap, box.name.endsWith('owrap: Team')])).toEqual([[false, true]]);
    const back = parseMermaidSequence(text);
    expect(back.ok && [back.sequence.participants[0]!.name, ...messagesOf(back.sequence).map((message) => message.label)]).toEqual(['wrap: Checkout', 'wrap: the order in an envelope', ':nowrap:raw']);
  });

  it('creates a participant only where the text first names it', async () => {
    // Job took part above its create message (`check.ts` flags it, and allows it), and Mermaid
    // refuses a `create participant` for one already there: the whole text failed to parse.
    const ping = createMessage({ id: 'm1', from: 'a', to: 'b', label: 'ping' });
    const start = createMessage({ id: 'm2', from: 'a', to: 'b', kind: 'create', label: 'start' });
    const early: DraftSequence = { participants: [who('a', 'API'), who('b', 'Job')], items: [ping, start] };
    for (const items of [early.items, [createNote({ id: 'n', over: ['a', 'b'], text: 'warm up' }), start]]) {
      const text = sequenceToMermaid(asNode({ ...early, items }));
      expect(text).toContain('\n    participant Job as Job\n');
      expect(text).not.toContain('create participant');
      expect(await parses(text)).toBe(true);
    }
    // Named first by its create message, it is created there.
    const fresh = sequenceToMermaid(asNode({ ...early, items: [start, ping] }));
    expect(fresh).toContain('\n    create participant Job as Job\n    API-->>Job: start\n');
    expect(await parses(fresh)).toBe(true);
  });

  it('ends work on its own line before a receiver whose name starts with x, which Mermaid reads as "-x"', async () => {
    // Mermaid reads arrows case-blind, so `BillingAPI-->>-Xero` held the lost-message arrow `-X` and
    // the whole text failed to parse ("got 'SOLID_CROSS'").
    const call = createMessage({ id: 'c', from: 'xero', to: 'api', label: 'GET /invoices' });
    const reply = { ...createReply(call, '200 OK'), id: 'r' };
    const gone = { ...createMessage({ id: 'd', from: 'api', to: 'xero', kind: 'destroy', label: 'close' }), deactivate: true as const };
    for (const items of [[call, reply], [call, gone]]) {
      const sequence: DraftSequence = { participants: [who('xero', 'Xero'), who('api', 'Billing API')], items };
      const text = sequenceToMermaid(asNode(sequence));
      expect(text).not.toMatch(/-X/);
      expect(await parses(text)).toBe(true);
      const back = parseMermaidSequence(text);
      expect(back.ok && messagesOf(back.sequence).map((message) => [message.kind, Boolean(message.deactivate)])).toEqual([['sync', false], [items[1]!.kind, true]]);
    }
  });

  it('writes a critical section’s branches as the options Mermaid reads', async () => {
    const read = parseMermaidSequence('sequenceDiagram\n  critical Connect\n    A->>B: open\n  option Timeout\n    A->>A: log\n  end\n');
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    const text = sequenceToMermaid(asNode(read.sequence));
    expect(await parses(text)).toBe(true);
    // CRITICAL_START, a message, OPTION, a message, CRITICAL_END.
    expect((await mermaidDb(text)).getMessages().map((entry) => [entry.type, entry.message])).toEqual([[27, 'Connect'], [0, 'open'], [28, 'Timeout'], [0, 'log'], [29, '']]);
  });
});

/** Each text as Mermaid reads it and as the import does: the two must say the same. */
describe('a sequence written by hand, read as Mermaid reads it', () => {
  beforeAll(() => {
    mermaid.initialize({ startOnLoad: false });
  });

  it('takes a box’s first word for its colour only where Mermaid does', async () => {
    // `box Aqua Payments` made a group called "Aqua Payments"; Mermaid draws an aqua box called "Payments".
    const named: [string, string][] = [
      ['Aqua Payments', 'Payments'],
      ['AQUA Payments', 'Payments'],
      ['Aqua', ''],
      ['Background jobs', 'jobs'],
      ['Initial checks', 'checks'],
      ['Red-Team Payments', '-Team Payments'],
      ['transparent Blue team', 'Blue team'],
      ['Bluebird Team', 'Bluebird Team'],
      ['None Team', 'None Team'],
      ['Payments', 'Payments'],
      ['rgb(1,2,3) Payments', 'Payments'],
      ['rgba(1, 2, 3, 0.5) Payments', 'Payments'],
      ['hsl(120 50% 50% / .5) Payments', 'Payments'],
      ['rgb(1, 2%, 3) Payments', 'rgb(1, 2%, 3) Payments'],
      ['rgb(1,2,3) Payments (EU)', 'rgb(1,2,3) Payments (EU)'],
    ];
    for (const [head, name] of named) {
      const text = `sequenceDiagram\n  box ${head}\n    participant A\n  end\n  A->>A: hi\n`;
      expect([head, (await mermaidDb(text)).getBoxes()[0]?.name ?? '']).toEqual([head, name]);
      const read = parseMermaidSequence(text);
      expect([head, read.ok && read.sequence.groups?.[0]?.name]).toEqual([head, name]);
    }
  });

  it('ends a statement at every `;`, as Mermaid does, between quotes too', async () => {
    // `participant Alice;` made a participant called "Alice;" beside the Alice who spoke, and each of
    // these lines was one message.
    const text = [
      'sequenceDiagram',
      '  participant Alice; participant Bob;',
      '  Alice->>Bob: hello; Bob-->>Alice: hi;',
      '  Alice->>Bob: "quoted; Bob->>Alice: words"',
      '  loop every minute; Alice-)Bob: ping; end',
      '  Alice->>Bob: 100%% done; %% the rest of the line; Bob->>Alice: is a comment',
    ].join('\n');
    const said = ['hello', 'hi', '"quoted', 'words"', 'ping', '100%% done'];
    const db = await mermaidDb(text);
    expect([...db.getActors().keys()]).toEqual(['Alice', 'Bob']);
    // Without the loop's start and end.
    expect(db.getMessages().filter((entry) => entry.type !== 10 && entry.type !== 11).map((entry) => entry.message)).toEqual(said);
    const read = parseMermaidSequence(text);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.sequence.participants.map((participant) => participant.name)).toEqual(['Alice', 'Bob']);
    expect(messagesOf(read.sequence).map((message) => message.label)).toEqual(said);
    expect(read.sequence.items.map((item) => (item.t === 'fragment' ? item.operator : item.t))).toEqual(['message', 'message', 'message', 'message', 'loop', 'message']);
    expect(read.unsupported).toEqual([]);
  });

  it('reads a `()` beside an arrow as the circle Mermaid draws on that lifeline, not as a name', async () => {
    // `Alice->>()Bob` was a call to a third participant, called "()Bob".
    const text = 'sequenceDiagram\n  Alice->>()Bob: hi\n  Alice()->>Bob: how are you?\n  Bob()-->>()Alice: fine\n';
    const said = [
      ['Alice', 'Bob', 'hi'],
      ['Alice', 'Bob', 'how are you?'],
      ['Bob', 'Alice', 'fine'],
    ];
    const db = await mermaidDb(text);
    expect([...db.getActors().keys()]).toEqual(['Alice', 'Bob']);
    // The messages, without the circles Mermaid notes beside them.
    expect(db.getMessages().filter((entry) => entry.type === 0 || entry.type === 1).map((entry) => [entry.from, entry.to, entry.message])).toEqual(said);
    const read = parseMermaidSequence(text);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    const name = new Map(read.sequence.participants.map((participant) => [participant.id, participant.name]));
    expect([...name.values()]).toEqual(['Alice', 'Bob']);
    expect(messagesOf(read.sequence).map((message) => [name.get(message.from), name.get(message.to), message.label])).toEqual(said);
    expect(messagesOf(read.sequence).map((message) => [message.kind, Boolean(message.activate), Boolean(message.replyTo)])).toEqual([['sync', false, false], ['sync', false, false], ['reply', false, true]]);
    expect(read.unsupported).toEqual(['a circle where a message meets a lifeline ("()"): the message is kept']);

    // Beside a `+` or `-`, Mermaid refuses the line, and so does the import: nobody called "()Bob".
    for (const line of ['Alice->>+()Bob: hi', 'Alice->>()+Bob: hi', 'Alice()->>+Bob: hi']) {
      const refused = `sequenceDiagram\n  participant Alice\n  participant Bob\n  ${line}\n`;
      expect([line, await parses(refused)]).toEqual([line, false]);
      const back = parseMermaidSequence(refused);
      expect(back.ok && back.sequence.participants.map((participant) => participant.name)).toEqual(['Alice', 'Bob']);
      expect(back.ok && back.unsupported).toEqual([`a line it couldn’t read: “${line}”`]);
    }
  });

  it('leaves the accessible title and description out of what is said, as Mermaid does', async () => {
    // Their words were read as statements: `accDescr: Alice->>Bob …` as a message from "accDescr: Alice",
    // and the `end` in `accDescr { … }` closed the loop around it.
    const text = [
      'sequenceDiagram',
      '  accTitle: Signing in; for screen readers',
      '  loop every minute',
      '    accDescr: Alice->>Bob asks; Bob-->>Alice answers',
      '    accDescr {',
      '      %% a comment line is gone before Mermaid reads: }',
      '      Alice->>Bob: shown as words',
      '      end',
      '    } Alice->>Bob: ping',
      '    Bob-->>Alice: pong',
      '  end',
      '  Alice->>Bob: done',
    ].join('\n');
    const db = await mermaidDb(text);
    expect(db.getAccTitle()).toBe('Signing in; for screen readers');
    expect(db.getAccDescription()).toBe('Alice->>Bob: shown as words\nend');
    expect([...db.getActors().keys()]).toEqual(['Alice', 'Bob']);
    expect(db.getMessages().map((entry) => [entry.type, entry.message])).toEqual([[10, 'every minute'], [0, 'ping'], [1, 'pong'], [11, ''], [0, 'done']]);
    const read = parseMermaidSequence(text);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.sequence.participants.map((participant) => participant.name)).toEqual(['Alice', 'Bob']);
    expect(read.sequence.items.map((item) => (item.t === 'fragment' ? [item.operator, item.operands.flatMap((branch) => branch.items.map((inner) => (inner.t === 'message' ? inner.label : inner.t)))] : item.t === 'message' ? item.label : item.t))).toEqual([['loop', ['ping', 'pong']], 'done']);
    expect(read.unsupported).toEqual(['an accessible title or description (accTitle, accDescr)']);
  });
});
