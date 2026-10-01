import mermaid from 'mermaid';
import { beforeAll, describe, expect, it } from 'vitest';
import { sequenceSourceFor } from '../src/export/sequence';
import { aliasFor } from '../src/sequence/alias';
import { toMermaid } from '../src/sequence/mermaid';
import type { SequenceModel } from '../src/sequence/types';
import { ARCHITECTURE_STARTERS } from '../src/starters/catalog';
import { starterDocument } from '../src/starters/document';

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
