import { describe, expect, it } from 'vitest';
import { createDocument, createNode } from '../../src/document/factory';
import { renamePatch } from '../../src/agent/rename';
import { validateToolInput } from '../../src/agent/contract';

const node = (id: string, text = 'API') => createNode({ id, text, type: 'service', x: 0, y: 0 });
const file = () => ({ ...createDocument(), nodes: [node('outer', 'System'), { ...node('owner', 'Container'), inside: { nodes: [node('api')], edges: [], flows: [], viewport: { x: 0, y: 0, zoom: 1 } } }] });

describe('one-call rename resolution', () => {
  it('accepts isolated proposal renames but cannot mix them with caller revisions or other changes', () => {
    const args = { requestId: 'rename', diagramId: 'd', summary: 'Rename API', rename: { from: 'API', to: 'Gateway' } };
    expect(() => validateToolInput('submit_proposal', args)).not.toThrow();
    expect(() => validateToolInput('submit_proposal', { ...args, revises: 'p_1', scope: { nodes: ['api'] } })).not.toThrow();
    for (const extra of [{ expectedRevision: 'old' }, { ops: [] }, { layout: {} }]) {
      expect(() => validateToolInput('submit_proposal', { ...args, ...extra })).toThrow();
    }
    const { rename: _rename, ...ordinary } = args;
    expect(() => validateToolInput('submit_proposal', { ...ordinary, ops: [] })).toThrow();
    expect(() => validateToolInput('submit_proposal', { ...ordinary, expectedRevision: 'current', ops: [] })).not.toThrow();
  });
  it('resolves an exact nested label into the existing patch contract', () => {
    const doc = file();
    const before = JSON.stringify(doc);
    expect(renamePatch(doc, { from: 'API', to: 'Gateway' })).toEqual({ view: { inside: ['owner'] }, ops: [{ op: 'update', id: 'api', set: { label: 'Gateway' } }] });
    expect(JSON.stringify(doc)).toBe(before);
    expect(() => renamePatch(doc, { from: 'api', to: 'Gateway' })).toThrow(/exact current label/);
    expect(() => renamePatch(doc, { from: 'AP', to: 'Gateway' })).toThrow(/exact current label/);
  });

  it('refuses duplicate labels across rooms; an explicit view can disambiguate', () => {
    const doc = file();
    doc.nodes.push(node('duplicate'));
    expect(() => renamePatch(doc, { from: 'API', to: 'Gateway' })).toThrow(/More than one/);
    expect(renamePatch(doc, { from: 'API', to: 'Gateway' }, { inside: [] }).ops[0]!.id).toBe('duplicate');
    expect(renamePatch(doc, { from: 'API', to: 'Gateway' }, { inside: ['owner'] }).ops[0]!.id).toBe('api');
    expect(() => renamePatch(doc, { from: 'API', to: 'Gateway' }, { inside: ['missing'] })).toThrow();
  });

  it('does not turn a note with a matching body into the target shape', () => {
    const doc = { ...createDocument(), nodes: [createNode({ id: 'note', text: 'API', type: 'note', x: 0, y: 0 })] };
    expect(() => renamePatch(doc, { from: 'API', to: 'Gateway' })).toThrow(/No shape/);
  });

  it('accepts only an isolated rename request, keeping ordinary edits revision-checked', () => {
    const args = { requestId: 'rename', diagramId: 'd', rename: { from: 'API', to: 'Gateway' } };
    expect(() => validateToolInput('update_diagram', args)).not.toThrow();
    for (const field of ['ops', 'expectedRevision', 'previewId', 'layout', 'onConflict']) {
      expect(() => validateToolInput('update_diagram', { ...args, [field]: field === 'ops' ? [] : {} })).toThrow();
    }
    for (const rename of [{ from: '', to: 'X' }, { from: 'API' }, { from: 'API', to: 'X', id: 'ignored' }, { from: 3, to: 'X' }]) {
      expect(() => validateToolInput('update_diagram', { ...args, rename })).toThrow();
    }
    expect(() => validateToolInput('update_diagram', { requestId: 'r', diagramId: 'd', ops: [{ op: 'update', id: 'api', set: { label: 'Gateway' } }] })).toThrow();
  });
});
