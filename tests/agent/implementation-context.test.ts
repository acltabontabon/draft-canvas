import { describe, expect, it } from 'vitest';
import { compose } from '../../src/agent/compile';
import { buildImplementationContext, NOTES_LIMIT, withinReadLimit } from '../../src/agent/context';
import { READ_LIMITS } from '../../src/agent/read';
import { readSelectionContext } from '../../src/agent/selection';
import { createAttachment, createNode } from '../../src/document/factory';
import { LIMITS } from '../../src/document/limits';
import { deserializeDocument } from '../../src/export/project';
import type { DraftDocument } from '../../src/document/types';

function build(raw: Record<string, unknown>): DraftDocument {
  const parsed = deserializeDocument(compose({ title: 'T', ...raw }, 'd_ctxtest0001').text);
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.document;
}

describe('buildImplementationContext', () => {
  it('reports a flow\'s steps in stored array order, not by position or id', () => {
    const file = build({
      nodes: [
        { id: 'api', type: 'api', label: 'API' },
        { id: 'db', type: 'database', label: 'DB' },
        { id: 'cache', type: 'redis', label: 'Cache' },
      ],
      relationships: [
        { id: 'ac', from: 'api', to: 'cache', label: 'Reads cache' },
        { id: 'ad', from: 'api', to: 'db', label: 'Reads db' },
      ],
      // Deliberately out of "natural" order: db-read happens second in the story despite being
      // declared first among relationships, and despite 'ac' sitting later alphabetically.
      flows: [{ id: 'f1', title: 'Lookup', steps: ['ad', 'ac'] }],
    });
    const out = buildImplementationContext(file, [], 'o:1.1', 'd_1', { flow: 'f1' }) as { flows: { steps: { order: number; edgeId?: string }[] }[] };
    expect(out.flows[0]?.steps.map((s) => s.edgeId)).toEqual(['ad', 'ac']);
    expect(out.flows[0]?.steps.map((s) => s.order)).toEqual([0, 1]);
  });

  it('includes from/to/label for a step alongside its order', () => {
    const file = build({
      nodes: [
        { id: 'api', type: 'api', label: 'API' },
        { id: 'db', type: 'database', label: 'DB' },
      ],
      relationships: [{ id: 'ad', from: 'api', to: 'db', label: 'Reads db' }],
      flows: [{ id: 'f1', title: 'Lookup', steps: ['ad'] }],
    });
    const out = buildImplementationContext(file, [], 'o:1.1', 'd_1', { flow: 'f1' }) as { flows: { steps: { from?: string; to?: string; label?: string }[] }[] };
    expect(out.flows[0]?.steps[0]).toMatchObject({ from: 'api', to: 'db', label: 'Reads db' });
  });

  it('tags every note with its provenance, distinguishing attached from freestanding', () => {
    const file = build({ nodes: [{ id: 'api', type: 'api', label: 'API' }] });
    const withAttachment = { ...file, nodes: [{ ...file.nodes[0]!, attachments: [createAttachment({ id: 'n1', type: 'note', text: 'Careful' })] }] };
    const out = buildImplementationContext(withAttachment, [], 'o:1.1', 'd_1') as { notes: { id: string; provenance: string }[] };
    expect(out.notes).toEqual([expect.objectContaining({ id: 'n1', provenance: 'attached' })]);
  });

  it('reports boundary membership', () => {
    const file = build({
      groups: [{ id: 'sys', label: 'System', kind: 'system' }],
      nodes: [{ id: 'api', type: 'api', label: 'API', group: 'sys' }],
    });
    const out = buildImplementationContext(file, [], 'o:1.1', 'd_1') as { boundaries: { id: string; memberIds: string[] }[] };
    expect(out.boundaries).toEqual([expect.objectContaining({ id: 'sys', memberIds: ['api'] })]);
  });

  // What a person can author: twelve notes on a shape, each up to LIMITS.maxTextLength (pasted
  // runbooks). Two such shapes made one read 236 KB, every body whole.
  it('cuts long notes where read_diagram does and stays within its byte ceiling, saying how to read the rest', () => {
    const runbook = 'Step: restart the consumer and check the lag dashboard. '.repeat(Math.floor(LIMITS.maxTextLength / 57));
    const file = build({ nodes: [{ id: 'api', type: 'api', label: 'API' }, { id: 'db', type: 'database', label: 'DB' }], relationships: [{ id: 'w', from: 'api', to: 'db' }] });
    const long = {
      ...file,
      nodes: [
        ...file.nodes.map((node) => ({ ...node, attachments: Array.from({ length: 12 }, (_, i) => createAttachment({ id: `${node.id}${i}`, type: 'note', text: runbook })) })),
        { ...createNode({ id: 'free', type: 'note', x: file.nodes[0]!.x, y: file.nodes[0]!.y + 200, text: runbook }) },
      ],
    };
    const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length;
    for (const out of [
      buildImplementationContext(long, [], 'o:1.1', 'd_1'),
      readSelectionContext(long, [], { nodes: ['api', 'db'], edges: ['w'] }, 'o:1.1', 'd_1'),
    ] as { notes: { id: string; text: string; truncated?: true; characters?: number }[]; more?: string }[]) {
      expect(bytes(out)).toBeLessThanOrEqual(READ_LIMITS.bytes);
      expect(out.notes.length).toBeGreaterThan(12);
      for (const note of out.notes) {
        expect(note).toMatchObject({ truncated: true, characters: [...runbook].length });
        expect([...note.text].length).toBeLessThanOrEqual(READ_LIMITS.noteText + 1);
      }
      expect(out.more).toContain('read_attachment');
      expect(out.more).toContain('fullText');
    }
  });

  it('halves its longest lists to fit, naming each in truncated', () => {
    const file = build({ nodes: [{ id: 'api', type: 'api', label: 'API' }] });
    const noted = { ...file, nodes: [{ ...file.nodes[0]!, attachments: Array.from({ length: 12 }, (_, i) => createAttachment({ id: `n${i}`, type: 'note', text: '界'.repeat(LIMITS.maxTextLength) })) }] };
    // A read near its ceiling with a little room to spare: 12 notes of 400 three-byte characters fit.
    const out = withinReadLimit({ padding: 'x'.repeat(READ_LIMITS.bytes - 12_000), ...buildImplementationContext(noted, [], 'o:1.1', 'd_1') }, ['notes'], 'Focus for the rest.') as { notes: unknown[]; truncated?: { notes?: boolean }; more?: string };
    expect(new TextEncoder().encode(JSON.stringify(out)).length).toBeLessThanOrEqual(READ_LIMITS.bytes);
    expect(out.notes.length).toBeLessThan(12);
    expect(out.truncated?.notes).toBe(true);
    expect(out.more).toContain('Focus for the rest.');
  });

  it('reports truncation when notes exceed the cap', () => {
    const attachments = Array.from({ length: NOTES_LIMIT + 5 }, (_, i) => createAttachment({ id: `n${i}`, type: 'note', text: `note ${i}` }));
    const file = build({ nodes: [{ id: 'api', type: 'api', label: 'API' }] });
    const withMany = { ...file, nodes: [{ ...file.nodes[0]!, attachments }] };
    const out = buildImplementationContext(withMany, [], 'o:1.1', 'd_1') as { truncated?: { notes?: boolean } };
    expect(out.truncated?.notes).toBe(true);
  });
});
