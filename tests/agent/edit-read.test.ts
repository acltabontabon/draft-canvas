import { describe, expect, it } from 'vitest';
import { readEdit } from '../../src/agent/read';
import { createDocument, createEdge, createNode } from '../../src/document/factory';
import { validateToolInput } from '../../src/agent/contract';

const node = (id: string, text = 'API') => createNode({ id, text, type: 'service', x: 0, y: 0 });
const file = () => ({ ...createDocument(), nodes: [node('outer'), { ...node('owner', 'Container'), inside: { nodes: [node('inner')], edges: [], flows: [], viewport: { x: 0, y: 0, zoom: 1 } } }], edges: [createEdge({ id: 'r', source: 'outer', target: 'owner', label: 'Calls' })] });

describe('compact editing reads', () => {
  it('keeps ambiguous targets and their concrete paths, without modifying the file', () => {
    const doc = file();
    const before = JSON.stringify(doc);
    const read = readEdit(doc, { query: 'API' }, 'r1', 'd');
    expect(read).toMatchObject({ revision: 'r1', total: 3, truncated: false, matches: [
      { id: 'outer', label: 'API', view: { inside: [] } },
      { id: 'r', type: 'relationship', from: { id: 'outer', label: 'API' }, to: { id: 'owner', label: 'Container' } },
      { id: 'inner', label: 'API', view: { inside: ['owner'] } },
    ] });
    expect(JSON.stringify(doc)).toBe(before);
    expect(readEdit(doc, { view: { inside: ['owner'] } }, 'r1', 'd')).toMatchObject({ total: 1, matches: [{ id: 'inner' }] });
    for (const query of ['API Container', 'API to Container']) {
      expect(readEdit(doc, { query }, 'r1', 'd')).toMatchObject({ total: 1, matches: [{ id: 'r', from: { id: 'outer' }, to: { id: 'owner' } }] });
    }
    expect(readEdit(doc, { query: ['inner', 'Container'] }, 'r1', 'd')).toMatchObject({ total: 3, matches: [
      { id: 'owner' }, { id: 'r' }, { id: 'inner', view: { inside: ['owner'] } },
    ] });
    expect(() => readEdit(doc, { view: { inside: ['absent'] } }, 'r1', 'd')).toThrow();
  });

  it('pages duplicate matches with revision, diagram, query and view bound cursors', () => {
    const doc = { ...createDocument(), nodes: Array.from({ length: 45 }, (_, i) => node(`n${i}`)) };
    const first = readEdit(doc, { query: 'API' }, 'r1', 'd');
    expect(first).toMatchObject({ total: 45, truncated: true, cursor: expect.any(String) });
    expect(first.matches).toHaveLength(20);
    const second = readEdit(doc, { query: 'API', cursor: first.cursor }, 'r1', 'd');
    expect(second.matches).toHaveLength(20);
    const last = readEdit(doc, { query: 'API', cursor: second.cursor }, 'r1', 'd');
    expect(last).toMatchObject({ total: 45, truncated: false });
    expect(last.matches).toHaveLength(5);
    expect(last).not.toHaveProperty('cursor');
    for (const [args, revision, id] of [
      [{ query: 'API', cursor: first.cursor }, 'r2', 'd'],
      [{ query: 'API', cursor: first.cursor }, 'r1', 'other'],
      [{ query: 'n', cursor: first.cursor }, 'r1', 'd'],
      [{ view: { inside: [] }, cursor: first.cursor }, 'r1', 'd'],
    ] as const) expect(() => readEdit(doc, args, revision, id)).toThrow(/changed since/);
  });

  it('bounds hostile text and marks truncation instead of presenting a shortened label as exact', () => {
    const doc = file();
    doc.nodes[0]!.text = '😀'.repeat(1000);
    const read = readEdit(doc, {}, 'r1', 'd');
    expect(read).toMatchObject({ matches: expect.arrayContaining([
      expect.objectContaining({ id: 'outer', labelTruncated: true }),
      expect.objectContaining({ id: 'r', from: expect.objectContaining({ labelTruncated: true }) }),
    ]) });
    expect(JSON.stringify(read)).not.toContain('😀'.repeat(201));
    for (const args of [{ query: [] }, { query: ['API', 3] }, { query: Array(9).fill('API') }, { query: '' }, { query: 5 }, { query: 'a'.repeat(201) }, { focus: {} }, { include: [] }, { query: 'API', view: {} }, { cursor: 'broken' }]) {
      expect(() => readEdit(doc, args, 'r1', 'd')).toThrow();
    }
  });

  it('exposes the index through the validated read contract without relaxing write revisions', () => {
    expect(() => validateToolInput('read_diagram', { diagramId: 'd', format: 'edit', query: 'API' })).not.toThrow();
    const ops = [{ op: 'update', id: 'outer', set: { description: 'New description' } }];
    for (const tool of ['update_diagram', 'submit_proposal']) {
      const args = { diagramId: 'd', requestId: 'r', ops, ...(tool === 'submit_proposal' ? { summary: 'Edit' } : {}) };
      expect(() => validateToolInput(tool, args)).toThrow();
      expect(() => validateToolInput(tool, { ...args, expectedRevision: 'r1' })).not.toThrow();
    }
  });
});
