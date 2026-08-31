import { beforeEach, describe, expect, it } from 'vitest';
import { createDocument } from '../src/document/factory';
import { normalizeDocument } from '../src/document/validate';
import { DRAFT_FORMAT, CURRENT_VERSION } from '../src/document/types';
import { __resetInteraction, useEditorStore } from '../src/store/editorStore';

describe('semantic connections', () => {
  const store = useEditorStore;

  beforeEach(() => {
    __resetInteraction();
    store.setState({
      document: createDocument('Semantics'),
      history: { past: [], future: [] },
      selection: { nodes: [], edges: [] },
      clipboard: null,
      revision: 0,
    });
  });

  it('fills in a default label for a labelless edge, and never sets an accent', () => {
    const a = store.getState().addNode({ type: 'service', x: 0, y: 0 });
    const b = store.getState().addNode({ type: 'database', x: 300, y: 0 });
    const edge = store.getState().connect(a.id, b.id)!;
    expect(edge.label).toBeUndefined();
    expect(edge.accent).toBeUndefined();

    store.getState().setEdgeSemantic(edge.id, 'reads');
    const stored = store.getState().document.edges[0]!;
    expect(stored.semantic).toBe('reads');
    expect(stored.label).toBe('reads');
    expect(stored.accent).toBeUndefined();
  });

  it('leaves an existing label untouched when a semantic is applied', () => {
    const a = store.getState().addNode({ type: 'service', x: 0, y: 0 });
    const b = store.getState().addNode({ type: 'queue', x: 300, y: 0 });
    const edge = store.getState().connect(a.id, b.id)!;
    store.getState().updateEdgeLabel(edge.id, 'ACCOUNT_CANCELLED');

    store.getState().setEdgeSemantic(edge.id, 'publishes');
    const stored = store.getState().document.edges[0]!;
    expect(stored.semantic).toBe('publishes');
    expect(stored.label).toBe('ACCOUNT_CANCELLED');
  });

  it('leaves an existing accent untouched, whichever semantic is applied', () => {
    const a = store.getState().addNode({ type: 'service', x: 0, y: 0 });
    const b = store.getState().addNode({ type: 'database', x: 300, y: 0 });
    const edge = store.getState().connect(a.id, b.id)!;
    store.getState().updateEdgeById(edge.id, { accent: 'rose' });

    store.getState().setEdgeSemantic(edge.id, 'http');
    expect(store.getState().document.edges[0]!.accent).toBe('rose');
  });

  it('clears the semantic without reverting an already-set label', () => {
    const a = store.getState().addNode({ type: 'service', x: 0, y: 0 });
    const b = store.getState().addNode({ type: 'database', x: 300, y: 0 });
    const edge = store.getState().connect(a.id, b.id)!;
    store.getState().setEdgeSemantic(edge.id, 'calls');
    expect(store.getState().document.edges[0]!.label).toBe('calls');

    store.getState().setEdgeSemantic(edge.id, undefined);
    const stored = store.getState().document.edges[0]!;
    expect(stored.semantic).toBeUndefined();
    expect(stored.label).toBe('calls');
  });

  it('is one undo step', () => {
    // Plain cards, not service/database — that pair now infers `writes` on
    // connect (see `connectorSemantics.ts`), which would muddy what this
    // test actually checks: that a manual `setEdgeSemantic` undoes cleanly.
    const a = store.getState().addNode({ type: 'note', x: 0, y: 0 });
    const b = store.getState().addNode({ type: 'note', x: 300, y: 0 });
    const edge = store.getState().connect(a.id, b.id)!;
    const before = store.getState().history.past.length;

    store.getState().setEdgeSemantic(edge.id, 'writes');
    expect(store.getState().history.past).toHaveLength(before + 1);

    store.getState().undo();
    expect(store.getState().document.edges[0]!.semantic).toBeUndefined();
    expect(store.getState().document.edges[0]!.label).toBeUndefined();
  });
});

describe('semantic connections — import validation', () => {
  function parse(nodes: unknown[], edges: unknown[]) {
    return normalizeDocument({ format: DRAFT_FORMAT, version: CURRENT_VERSION, nodes, edges });
  }

  it('keeps a recognised semantic', () => {
    const result = parse(
      [
        { id: 'a', type: 'service', x: 0, y: 0 },
        { id: 'b', type: 'database', x: 300, y: 0 },
      ],
      [{ id: 'e1', source: 'a', target: 'b', directed: true, routing: 'smoothstep', semantic: 'reads' }],
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.document.edges[0]!.semantic).toBe('reads');
  });

  it('normalizes an unknown semantic to absent, not to a fallback value', () => {
    const result = parse(
      [
        { id: 'a', type: 'service', x: 0, y: 0 },
        { id: 'b', type: 'database', x: 300, y: 0 },
      ],
      [{ id: 'e1', source: 'a', target: 'b', directed: true, routing: 'smoothstep', semantic: 'ftp' }],
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.document.edges[0]!.semantic).toBeUndefined();
  });

  it('leaves a semantic absent when the file has none — never force-assigned', () => {
    const result = parse(
      [
        { id: 'a', type: 'service', x: 0, y: 0 },
        { id: 'b', type: 'database', x: 300, y: 0 },
      ],
      [{ id: 'e1', source: 'a', target: 'b', directed: true, routing: 'smoothstep' }],
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.document.edges[0]!.semantic).toBeUndefined();
  });
});
