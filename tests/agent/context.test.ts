import { describe, expect, it } from 'vitest';
import { collectNotes, NOTES_LIMIT } from '../../src/agent/context';
import { createAttachment, createDocument, createNode } from '../../src/document/factory';
import type { DraftDocument } from '../../src/document/types';

function withNodes(...nodes: DraftDocument['nodes']): DraftDocument {
  return { ...createDocument(), nodes, edges: [] };
}

describe('collectNotes', () => {
  it('includes a folded attachment as "attached", about its host', () => {
    const host = createNode({ id: 'svc', type: 'service', x: 0, y: 0 });
    host.attachments = [createAttachment({ id: 'n1', type: 'note', text: 'Careful here' })];
    const { notes } = collectNotes(withNodes(host));
    expect(notes).toEqual([expect.objectContaining({ id: 'n1', provenance: 'attached', about: 'svc', text: 'Careful here' })]);
  });

  it('includes a freestanding note near an element as "nearest"', () => {
    const host = createNode({ id: 'svc', type: 'service', x: 0, y: 0, width: 148, height: 88 });
    const note = createNode({ id: 'note1', type: 'note', x: 160, y: 0, text: 'An assumption' });
    const { notes } = collectNotes(withNodes(host, note));
    expect(notes).toEqual([expect.objectContaining({ id: 'note1', provenance: 'nearest', about: 'svc', text: 'An assumption' })]);
  });

  it('a freestanding note far from anything in scope is excluded when aboutIds is given', () => {
    const host = createNode({ id: 'svc', type: 'service', x: 0, y: 0, width: 148, height: 88 });
    const far = createNode({ id: 'far', type: 'service', x: 5000, y: 0, width: 148, height: 88 });
    const note = createNode({ id: 'note1', type: 'note', x: 5160, y: 0, text: 'About far, not svc' });
    const { notes } = collectNotes(withNodes(host, far, note), { aboutIds: new Set(['svc']) });
    expect(notes).toEqual([]);
  });

  it('a freestanding note near something in scope is included when aboutIds is given', () => {
    const host = createNode({ id: 'svc', type: 'service', x: 0, y: 0, width: 148, height: 88 });
    const note = createNode({ id: 'note1', type: 'note', x: 160, y: 0, text: 'About svc' });
    const { notes } = collectNotes(withNodes(host, note), { aboutIds: new Set(['svc']) });
    expect(notes).toEqual([expect.objectContaining({ id: 'note1', about: 'svc' })]);
  });

  it('caps at NOTES_LIMIT and reports truncation', () => {
    const host = createNode({ id: 'svc', type: 'service', x: 0, y: 0 });
    host.attachments = Array.from({ length: NOTES_LIMIT + 5 }, (_, i) => createAttachment({ id: `n${i}`, type: 'note', text: `note ${i}` }));
    const { notes, truncated } = collectNotes(withNodes(host));
    expect(notes).toHaveLength(NOTES_LIMIT);
    expect(truncated).toBe(true);
  });
});
