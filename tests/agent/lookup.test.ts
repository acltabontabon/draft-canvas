import { describe, expect, it } from 'vitest';
import { capabilities } from '../../src/agent/capabilities';
import { schemaProblems, validateToolInput } from '../../src/agent/contract';
import { applyUpdate } from '../../src/agent/patch';
import { readLookup } from '../../src/agent/read';
import { FULL_TOOLS, TOOLS } from '../../src/agent/schema';
import { createDocument, createEdge, createNode } from '../../src/document/factory';

const file = () => ({
  ...createDocument(),
  nodes: [{ ...createNode({ id: 'editor', type: 'service', x: 12, y: 34, text: 'Shared editor' }), inside: {
    nodes: [createNode({ id: 'model', type: 'service', x: 56, y: 78, text: 'Document and depth', description: 'Original' })],
    edges: [], flows: [], viewport: { x: 0, y: 0, zoom: 1 },
  } }, createNode({ id: 'db', type: 'database', x: 400, y: 0, text: 'Database' })],
  edges: [createEdge({ id: 'writes', source: 'editor', target: 'db', label: 'Writes document' })],
});

describe('targeted agent lookup', () => {
  it('finds root and nested labels or ids without room content, and feeds an in-place patch', () => {
    const doc = file();
    expect(readLookup(doc, { query: 'SHARED EDITOR' }, 'r1', 'd')).toMatchObject({ matches: [{ id: 'editor', view: { inside: [] } }], total: 1, truncated: false });
    const result = readLookup(doc, { query: 'Document and depth' }, 'r1', 'd');
    expect(result).toEqual({ diagramId: 'd', revision: 'r1', format: 'lookup', matches: [{ id: 'model', label: 'Document and depth', type: 'service', view: { inside: ['editor'] } }], total: 1, truncated: false });
    const match = (result.matches as { id: string; view: { inside: string[] } }[])[0]!;
    const { file: updated } = applyUpdate(doc, match.view.inside, [{ op: 'update', id: match.id, set: { description: 'New description' } }], undefined);
    const expected = structuredClone(doc);
    expected.nodes[0]!.inside!.nodes[0]!.description = 'New description';
    expect(updated.nodes).toEqual(expected.nodes);
    expect(updated.edges).toEqual(doc.edges);
    expect(readLookup(doc, { query: 'model' }, 'r1', 'd').matches).toEqual(result.matches);
    expect(JSON.stringify(result).length).toBeLessThan(300);
    expect(schemaProblems(FULL_TOOLS.find((tool) => tool.name === 'read_diagram')!.outputSchema, result)).toEqual([]);
  });

  it('returns every ambiguous match count and bounds labels', () => {
    const doc = file();
    doc.nodes = Array.from({ length: 25 }, (_, i) => createNode({ id: `n${i}`, type: 'service', x: i * 200, y: 0, text: 'Duplicate ' + '🙂'.repeat(210) }));
    const result = readLookup(doc, { query: 'duplicate' }, 'r1', 'd');
    expect(result).toMatchObject({ total: 25, truncated: true });
    expect(result.matches).toHaveLength(20);
    expect((result.matches as { label: string; labelTruncated: boolean }[]).every((match) => [...match.label].length === 201 && match.labelTruncated)).toBe(true);
    expect(readLookup(doc, { query: 'missing' }, 'r1', 'd')).toMatchObject({ matches: [], total: 0, truncated: false });
  });

  it('finds relationship labels as well as nodes, preserving ambiguity', () => {
    expect(readLookup(file(), { query: 'document' }, 'r1', 'd')).toMatchObject({ total: 2, matches: expect.arrayContaining([
      { id: 'writes', label: 'Writes document', type: 'relationship', view: { inside: [] } },
      { id: 'model', label: 'Document and depth', type: 'service', view: { inside: ['editor'] } },
    ]) });
  });

  it('rejects invalid or conflicting lookup arguments instead of silently dropping scope', () => {
    for (const query of ['', '   ', 'x'.repeat(201), 42, null]) expect(() => readLookup(file(), { query }, 'r', 'd')).toThrow();
    for (const key of ['view', 'focus', 'include', 'cursor', 'format']) expect(() => readLookup(file(), { query: 'editor', [key]: {} }, 'r', 'd')).toThrow(/query alone/);
  });
});

describe('on-demand authoring contract', () => {
  it('returns only the requested full schema, retaining validation for advanced fields', () => {
    for (const tool of FULL_TOOLS) expect(capabilities({ tool: tool.name })).toEqual({ tool: tool.name, description: tool.description, inputSchema: tool.inputSchema });
    expect(() => capabilities({ tool: 'missing' })).toThrow(/Unknown tool/);
    expect(() => capabilities({ tool: 'update_diagram', topics: ['types'] })).toThrow(/separately/);
    expect(() => validateToolInput('update_diagram', { diagramId: 'd', requestId: 'r', expectedRevision: 'r1', ops: [{ op: 'update', id: 'editor', set: { invented: true } }] })).toThrow(/invented/);
    expect(() => validateToolInput('create_diagram', { requestId: 'r', title: 'T', nodes: [{ id: 'n', type: 'service', label: 'Name', inside: { nodes: [{ id: 'c', type: 'service', label: 'Child', invented: true }] } }] })).toThrow(/invented/);
    expect(TOOLS.every((tool) => !('outputSchema' in tool))).toBe(true);
  });
});
