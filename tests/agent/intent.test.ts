import { describe, expect, it } from 'vitest';
import { createDocument, createEdge, createNode } from '../../src/document/factory';
import type { DraftDocument } from '../../src/document/types';
import { validateToolInput } from '../../src/agent/contract';
import { intentPatch } from '../../src/agent/intent';
import { applyUpdate } from '../../src/agent/patch';
import { prepareProposal, preconditionConflicts } from '../../src/agent/proposal';

const node = (id: string, text: string) => createNode({ id, text, type: 'service', x: id === 'a' ? 0 : 400, y: 0 });
const file = () => ({ ...createDocument(), nodes: [node('a', 'API'), node('b', 'DB'), node('c', 'Archive')], edges: [createEdge({ id: 'r', source: 'a', target: 'b', label: 'Writes', semantic: 'calls' })] });

describe('revision-checked edit intents', () => {
  it('only admits isolated, closed intent inputs with a caller revision in both modes', () => {
    for (const tool of ['update_diagram', 'submit_proposal']) {
      const args = { diagramId: 'd', requestId: 'r', expectedRevision: 'o:1', ...(tool === 'submit_proposal' ? { summary: 'Description' } : {}), intent: { kind: 'shape', target: 'API', set: { description: 'Handles requests' } } };
      expect(() => validateToolInput(tool, args)).not.toThrow();
      const { expectedRevision: _revision, ...noRevision } = args;
      expect(() => validateToolInput(tool, noRevision)).toThrow();
      for (const extra of [{ ops: [] }, { rename: { from: 'API', to: 'Gateway' } }, { layout: {} }, { onConflict: 'rebase' }]) expect(() => validateToolInput(tool, { ...args, ...extra })).toThrow();
      for (const intent of [{}, { kind: 'shape', target: 'API', set: {} }, { kind: 'shape', target: 'API', set: { place: { x: 4 } } }, { kind: 'add', type: 'invented', label: 'X' }, { kind: 'connection', from: 'API', to: 'DB', set: { id: 'other' } }]) {
        expect(() => validateToolInput(tool, { ...args, intent })).toThrow();
      }
    }
  });

  it('resolves a nested description without touching the original file', () => {
    const inner = file();
    const doc: DraftDocument = { ...createDocument(), nodes: [{ ...node('owner', 'System'), inside: { nodes: inner.nodes, edges: inner.edges, flows: [], viewport: inner.viewport } }] };
    const before = JSON.stringify(doc);
    expect(intentPatch(doc, { kind: 'shape', target: 'API', set: { description: 'New description' } })).toEqual({ view: { inside: ['owner'] }, ops: [{ op: 'update', id: 'a', set: { description: 'New description' } }] });
    expect(JSON.stringify(doc)).toBe(before);
    doc.nodes.push(node('duplicate', 'API'));
    expect(() => intentPatch(doc, { kind: 'shape', target: 'API', set: { label: 'Gateway' } })).toThrow(/Ambiguous/);
    expect(() => intentPatch(doc, { kind: 'shape', target: 'api', set: { label: 'Gateway' } })).toThrow(/Missing/);
    expect(intentPatch(doc, { kind: 'shape', target: 'API', set: { label: 'Gateway' } }, { inside: ['owner'] }).ops[0]!.id).toBe('a');
  });

  it('refuses parallel edges unless the old caption identifies exactly one', () => {
    const doc = file();
    doc.edges.push({ ...doc.edges[0]!, id: 'parallel', label: 'Reads' });
    const intent = { kind: 'connection' as const, from: 'API', to: 'DB', set: { label: 'Persists' } };
    expect(() => intentPatch(doc, intent)).toThrow(/Ambiguous/);
    expect(intentPatch(doc, { ...intent, label: 'Writes' }).ops).toEqual([{ op: 'update', id: 'r', set: { label: 'Persists' } }]);
    expect(() => intentPatch(doc, { ...intent, from: 'Missing' })).toThrow(/Missing/);
    expect(() => intentPatch(doc, { ...intent, label: 'Writes', set: { to: 'Missing' } })).toThrow(/Missing/);
  });

  it('resolves new endpoints locally and stores concrete preconditions, never selectors', () => {
    const doc = file();
    const patch = intentPatch(doc, { kind: 'connection', from: 'API', to: 'DB', set: { to: 'Archive' } });
    expect(patch.ops).toEqual([{ op: 'update', id: 'r', set: { to: 'c' } }]);
    const proposal = prepareProposal(doc, patch.view.inside, patch.ops, undefined, undefined);
    expect(preconditionConflicts(doc, [], proposal.preconditions)).toEqual([]);
    const changed = { ...doc, nodes: doc.nodes.map(n => n.id === 'c' ? { ...n, text: 'Renamed archive' } : n) };
    expect(preconditionConflicts(changed, [], proposal.preconditions)).not.toEqual([]);
    const result = applyUpdate(doc, [], patch.ops, undefined).file;
    expect(result.edges[0]).toMatchObject({ id: 'r', source: 'a', target: 'c', label: 'Writes', semantic: doc.edges[0]!.semantic });
    expect(result.nodes).toEqual(doc.nodes);
  });

  it('adds shapes and connections with collision-free IDs and ordinary patch validation', () => {
    const doc = file();
    doc.nodes.push(node('intent_1', 'Reserved'));
    const add = intentPatch(doc, { kind: 'add', type: 'worker', label: 'Audit', description: 'Records events' });
    const added = applyUpdate(doc, [], add.ops, undefined).file;
    expect(added.nodes).toEqual(expect.arrayContaining(doc.nodes));
    expect(added.nodes.find(n => n.id === 'intent_2')).toMatchObject({ text: 'Audit', description: 'Records events' });
    const connect = intentPatch(doc, { kind: 'connect', from: 'API', to: 'Archive', label: 'Archives' });
    expect(applyUpdate(doc, [], connect.ops, undefined).file.edges).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'intent_2', source: 'a', target: 'c', label: 'Archives' })]));
  });
});
