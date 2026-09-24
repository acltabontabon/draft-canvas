import { describe, expect, it } from 'vitest';
import { compose } from '../../src/agent/compile';
import { buildImplementationContext, NOTES_LIMIT } from '../../src/agent/context';
import { createAttachment } from '../../src/document/factory';
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

  it('reports truncation when notes exceed the cap', () => {
    const attachments = Array.from({ length: NOTES_LIMIT + 5 }, (_, i) => createAttachment({ id: `n${i}`, type: 'note', text: `note ${i}` }));
    const file = build({ nodes: [{ id: 'api', type: 'api', label: 'API' }] });
    const withMany = { ...file, nodes: [{ ...file.nodes[0]!, attachments }] };
    const out = buildImplementationContext(withMany, [], 'o:1.1', 'd_1') as { truncated?: { notes?: boolean } };
    expect(out.truncated?.notes).toBe(true);
  });
});
