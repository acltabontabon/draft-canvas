import { describe, expect, it } from 'vitest';
import { createDocument, createEdge, createNode } from '../src/document/factory';
import { createOpenPoint } from '../src/document/openPoints';
import { readerAttachments, readerContext } from '../src/share/context';

describe('shared reader context', () => {
  it('collects existing notes, decisions, pending and resolved points across levels without changing the file', () => {
    const file = createDocument('Architecture');
    const inner = createNode({ type: 'note', x: 0, y: 0, text: 'Use idempotent writes.', noteKind: 'decision' });
    const api = createNode({ type: 'service', x: 0, y: 0, text: 'API' });
    api.inside = { nodes: [inner], edges: [], flows: [], viewport: file.viewport };
    api.attachments = [{ id: 'at-note', type: 'note', noteKind: 'question', text: 'How do retries work?' }, { id: 'at-code', type: 'code', code: 'example()' }];
    const db = createNode({ type: 'database', x: 300, y: 0, text: 'Orders' });
    const edge = createEdge({ source: api.id, target: db.id });
    edge.attachments = [{ id: 'at-decision', type: 'note', noteKind: 'decision', text: 'Use transactions.' }];
    file.nodes = [api, db];
    file.edges = [edge];
    const pending = createOpenPoint('awaiting', [{ kind: 'node', id: inner.id }, { kind: 'edge', id: edge.id }], 'Confirm retention.')!;
    const resolved = { ...createOpenPoint('tentative', [{ kind: 'node', id: db.id }], 'Storage choice.')!, resolved: true as const, resolution: 'Keep PostgreSQL.' };
    file.openPoints = [pending, resolved];
    const before = JSON.stringify(file);
    const result = readerContext(file);
    expect(result.notes.map((item) => item.text)).toEqual(['How do retries work?']);
    expect(result.decisions.map((item) => item.text)).toEqual(['Use idempotent writes.', 'Use transactions.']);
    expect(result.decisions[0]!.targets[0]!.path).toEqual([api.id]);
    expect(result.pending[0]!.targets.map((target) => target.path)).toEqual([[api.id], []]);
    expect(result.pending[0]!.point?.kind).toBe('awaiting');
    expect(result.resolved[0]!.point?.resolution).toBe('Keep PostgreSQL.');
    expect(JSON.stringify(file)).toBe(before);
  });

  it('does not invent context when none was recorded', () => {
    expect(readerContext(createDocument())).toEqual({ notes: [], decisions: [], pending: [], resolved: [] });
  });

  it('keeps code, connector details and cross-level references in the attachment browser', () => {
    const file = createDocument();
    const api = createNode({ type: 'service', x: 0, y: 0, text: 'API' });
    api.attachments = [{ id: 'at-code', type: 'code', code: 'accept(order);', language: 'javascript' }];
    const inner = createNode({ type: 'note', x: 0, y: 0, text: 'Contract note' });
    api.inside = { nodes: [inner], edges: [], flows: [], viewport: file.viewport };
    const db = createNode({ type: 'database', x: 300, y: 0, text: 'Orders' });
    const edge = createEdge({ source: api.id, target: db.id });
    edge.details = { code: 'commit(order);', language: 'javascript' };
    file.nodes = [api, db];
    file.edges = [edge];
    file.openPoints = [createOpenPoint('awaiting', [{ kind: 'node', id: inner.id }, { kind: 'edge', id: edge.id }], 'Review the contract.')!];
    const before = JSON.stringify(file);
    const items = readerAttachments(file);
    expect(items.find((item) => item.code)?.code).toEqual({ code: 'accept(order);', language: 'javascript' });
    expect(items.find((item) => item.text === 'Contract note')?.targets[0]?.path).toEqual([api.id]);
    expect(items.find((item) => item.point)?.targets.map((target) => target.path)).toEqual([[api.id], []]);
    expect(items.find((item) => item.code?.code === 'commit(order);')?.targets[0]?.id).toBe(edge.id);
    expect(JSON.stringify(file)).toBe(before);
  });
});
