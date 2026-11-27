import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import mermaid from 'mermaid';
import { beforeAll, describe, expect, it } from 'vitest';
import { createNode } from '../src/document/factory';
import { deserializeDocument } from '../src/export/project';
import { messagesOf } from '../src/document/sequenceModel';
import { createMessage, createNote, createReply } from '../src/document/sequenceOps';
import type { DraftSequence, SeqParticipant } from '../src/document/types';
import { sequenceSourceFor } from '../src/export/sequence';
import { parseMermaidSequence } from '../src/import/mermaid/sequence';
import { aliasFor } from '../src/sequence/alias';
import { toMermaid } from '../src/sequence/mermaid';
import { sequenceToMermaid } from '../src/sequence/native/mermaid';
import { sequenceToPlantUml } from '../src/sequence/native/plantuml';
import type { SequenceModel } from '../src/sequence/types';
import { ARCHITECTURE_STARTERS } from './fixtures/starters-v1/catalog';
import { starterDocument } from './fixtures/starters-v1/document';

/**
 * The Mermaid export is checked against Mermaid itself, not against what we think its grammar is.
 * Every starter's flows have to parse, and so does a corpus of the text that has broken sequence
 * diagrams before: statement terminators and comment markers inside labels, a directive planted in
 * a title, participants named after keywords, and colons — which earlier exports rewrote as dashes
 * rather than trust the grammar. A label reaching the diagram unchanged is the point; a directive
 * reaching the renderer would be an injection.
 */
function model(overrides: Partial<SequenceModel> = {}): SequenceModel {
  return { title: '', participants: [], elements: [], ...overrides };
}

const participant = (id: string, label: string, alias = id) => ({
  id,
  alias,
  label,
  category: 'service' as const,
  kind: 'participant' as const,
  sourceNodeId: id,
});

const message = (from: string, to: string, label: string) => ({
  kind: 'message' as const,
  order: 0,
  from,
  to,
  label,
  interaction: 'sync' as const,
  sourceFlowId: 'f1',
  sourceEdgeIds: [],
  sourceStepIds: [],
});

async function parses(text: string): Promise<boolean> {
  const result = await mermaid.parse(text, { suppressErrors: true });
  return result !== false;
}

describe('the Mermaid export parses with Mermaid', () => {
  beforeAll(() => {
    mermaid.initialize({ startOnLoad: false });
  });

  it('is a real check: broken text is refused', async () => {
    expect(await parses('sequenceDiagram\n    A->>\n')).toBe(false);
  });

  it.each(ARCHITECTURE_STARTERS.map((starter) => [starter.name, starter] as const))('%s', async (_name, starter) => {
    const text = sequenceSourceFor(starterDocument(starter), 'mermaid');
    expect(text).toContain('sequenceDiagram');
    expect(await parses(text)).toBe(true);
  });

  it.each([
    ['a directive in a title', model({ title: 'Checkout %%{init: {"theme": "forest"}}%%', participants: [participant('a', 'A')] })],
    [
      'statement breakers and tags in labels',
      model({
        participants: [participant('a', 'Map<String, Order>'), participant('b', 'retry(); # then')],
        elements: [message('a', 'b', 'POST /orders; charge # 100% <b>now</b>')],
      }),
    ],
    [
      'colons kept in labels and notes',
      model({
        participants: [participant('a', 'A'), participant('b', 'B')],
        elements: [
          message('a', 'b', 'HTTP 200: OK'),
          { kind: 'note' as const, order: 1, participantIds: ['a'], text: 'Rule: retry twice: then give up', sourceFlowId: 'f1' },
        ],
      }),
    ],
    [
      'participants named after keywords, aliased the way the builder aliases them',
      model({
        participants: [
          participant('P1', 'option', aliasFor('option', 'P1', new Set())),
          participant('P2', 'sequenceDiagram', aliasFor('sequenceDiagram', 'P2', new Set())),
          participant('P3', 'links', aliasFor('links', 'P3', new Set())),
        ],
        elements: [message('P1', 'P2', 'end'), message('P2', 'P3', 'Note over')],
      }),
    ],
    [
      'a percent sign that is only a percent sign',
      model({ participants: [participant('a', 'A'), participant('b', 'B')], elements: [message('a', 'b', '99.9% uptime')] }),
    ],
  ])('%s', async (_name, m) => {
    const text = toMermaid(m);
    expect(text).not.toMatch(/%%\{/);
    expect(await parses(text)).toBe(true);
  });
});

describe('a source with several diagrams', () => {
  const root = join(__dirname, 'fixtures', 'starters', 'starters');
  const files = (dir: string): string[] =>
    readdirSync(dir).flatMap((name) => (statSync(join(dir, name)).isDirectory() ? files(join(dir, name)) : name.endsWith('.draftcanvas') ? [join(dir, name)] : []));
  const starters = files(root).map((path) => {
    const read = deserializeDocument(readFileSync(path, 'utf8'));
    if (!read.ok) throw new Error(`${path} does not open`);
    return [relative(root, path).replaceAll('\\', '/'), read.document] as const;
  });
  /** What a reader renders: the text itself, or each Mermaid block of a Markdown one. */
  const diagrams = (text: string): string[] => (text.startsWith('```mermaid\n') ? [...text.matchAll(/^```mermaid\n([\s\S]*?)^```$/gm)].map((block) => block[1]!) : [text]);

  beforeAll(() => {
    mermaid.initialize({ startOnLoad: false });
  });

  // Flows in several rooms, or a sequence beside them, made one text with a `sequenceDiagram`
  // header each, which Mermaid refuses: fifteen of these eighteen exported that way.
  it.each(starters)('%s parses diagram by diagram', async (_name, document) => {
    const text = sequenceSourceFor(document, 'mermaid');
    const each = diagrams(text);
    expect(each.length).toBe((text.match(/^sequenceDiagram$/gm) ?? []).length);
    for (const diagram of each) expect(await parses(diagram)).toBe(true);
  });
});

/** What Mermaid's own database holds for a text: what a reader of the rendered diagram gets. */
async function mermaidDb(text: string) {
  const diagram = await mermaid.mermaidAPI.getDiagramFromText(text);
  return diagram.db as unknown as {
    getMessages(): { type: number; message: string; wrap: boolean }[];
    getActors(): Map<string, { description: string; wrap: boolean }>;
  };
}

describe('a sequence drawn on the canvas, as Mermaid reads it', () => {
  const who = (id: string, name: string): SeqParticipant => ({ id, name, type: 'service', serviceKind: 'generic' });
  const asNode = (sequence: DraftSequence) => ({ ...createNode({ id: 'n', type: 'sequence', x: 0, y: 0, text: 'T' }), sequence });

  beforeAll(() => {
    mermaid.initialize({ startOnLoad: false });
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

    const plantUml = sequenceToPlantUml(asNode(sequence));
    expect(plantUml).not.toContain('Message');
    expect(plantUml).toContain('\nAPI --> Web\n');
    expect(plantUml).toContain('\nAPI -> API\n');
    expect(plantUml).not.toMatch(/^\s*Note$/m);
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
      expect(sequenceToPlantUml(asNode({ ...early, items }))).not.toContain('create participant');
    }
    // Named first by its create message, it is created there.
    const fresh = sequenceToMermaid(asNode({ ...early, items: [start, ping] }));
    expect(fresh).toContain('\n    create participant Job as Job\n    API-->>Job: start\n');
    expect(await parses(fresh)).toBe(true);
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
