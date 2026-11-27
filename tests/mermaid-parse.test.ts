import mermaid from 'mermaid';
import { beforeAll, describe, expect, it } from 'vitest';
import { createNode } from '../src/document/factory';
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
