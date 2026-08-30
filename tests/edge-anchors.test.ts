import { beforeEach, describe, expect, it } from 'vitest';
import { createDocument, createEdge, createNode } from '../src/document/factory';
import { addEdges, addNodes, reconnectEdge } from '../src/document/operations';
import { normalizeDocument } from '../src/document/validate';
import { DRAFT_FORMAT, CURRENT_VERSION } from '../src/document/types';
import { anchorPoint } from '../src/edges/routing';
import { __resetInteraction, useEditorStore } from '../src/store/editorStore';

describe('connector anchors', () => {
  const store = useEditorStore;

  beforeEach(() => {
    __resetInteraction();
    store.setState({
      document: createDocument('Anchors'),
      history: { past: [], future: [] },
      selection: { nodes: [], edges: [] },
      clipboard: null,
      revision: 0,
    });
  });

  it('captures the side the connection was dragged from', () => {
    const a = store.getState().addNode({ type: 'service', x: 0, y: 0 });
    const b = store.getState().addNode({ type: 'database', x: 300, y: 0 });
    const edge = store.getState().connect(a.id, b.id, 'bottom', 'top')!;

    expect(edge.sourceAnchor).toEqual({ side: 'bottom', offset: 0.5 });
    expect(edge.targetAnchor).toEqual({ side: 'top', offset: 0.5 });
  });

  it('leaves both anchors absent when no side was reported', () => {
    const a = store.getState().addNode({ type: 'service', x: 0, y: 0 });
    const b = store.getState().addNode({ type: 'database', x: 300, y: 0 });
    const edge = store.getState().connect(a.id, b.id)!;

    expect(edge.sourceAnchor).toBeUndefined();
    expect(edge.targetAnchor).toBeUndefined();
  });

  it('captures only the source side when the target was a body hit, not a handle', () => {
    const a = store.getState().addNode({ type: 'service', x: 0, y: 0 });
    const b = store.getState().addNode({ type: 'database', x: 300, y: 0 });
    const edge = store.getState().connect(a.id, b.id, 'right')!;

    expect(edge.sourceAnchor).toEqual({ side: 'right', offset: 0.5 });
    expect(edge.targetAnchor).toBeUndefined();
  });
});

describe('connector anchors — import validation', () => {
  function parse(nodes: unknown[], edges: unknown[]) {
    return normalizeDocument({ format: DRAFT_FORMAT, version: CURRENT_VERSION, nodes, edges });
  }

  it('round-trips a well-formed anchor pair', () => {
    const result = parse(
      [
        { id: 'a', type: 'service', x: 0, y: 0 },
        { id: 'b', type: 'database', x: 300, y: 0 },
      ],
      [
        {
          id: 'e1',
          source: 'a',
          target: 'b',
          directed: true,
          routing: 'smoothstep',
          sourceAnchor: { side: 'right', offset: 0.3 },
          targetAnchor: { side: 'left', offset: 0.8 },
        },
      ],
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.document.edges[0]!.sourceAnchor).toEqual({ side: 'right', offset: 0.3 });
    expect(result.document.edges[0]!.targetAnchor).toEqual({ side: 'left', offset: 0.8 });
  });

  it('clamps an out-of-range offset instead of dropping the anchor', () => {
    const result = parse(
      [
        { id: 'a', type: 'service', x: 0, y: 0 },
        { id: 'b', type: 'database', x: 300, y: 0 },
      ],
      [
        {
          id: 'e1',
          source: 'a',
          target: 'b',
          directed: true,
          routing: 'smoothstep',
          sourceAnchor: { side: 'top', offset: 4.5 },
          targetAnchor: { side: 'bottom', offset: -2 },
        },
      ],
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.document.edges[0]!.sourceAnchor).toEqual({ side: 'top', offset: 1 });
    expect(result.document.edges[0]!.targetAnchor).toEqual({ side: 'bottom', offset: 0 });
  });

  it('drops an anchor with an unrecognised side rather than coercing it', () => {
    const result = parse(
      [
        { id: 'a', type: 'service', x: 0, y: 0 },
        { id: 'b', type: 'database', x: 300, y: 0 },
      ],
      [
        {
          id: 'e1',
          source: 'a',
          target: 'b',
          directed: true,
          routing: 'smoothstep',
          sourceAnchor: { side: 'north', offset: 0.5 },
        },
      ],
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.document.edges[0]!.sourceAnchor).toBeUndefined();
  });

  it('leaves anchors absent when the file has none — never force-assigned', () => {
    const result = parse(
      [
        { id: 'a', type: 'service', x: 0, y: 0 },
        { id: 'b', type: 'database', x: 300, y: 0 },
      ],
      [{ id: 'e1', source: 'a', target: 'b', directed: true, routing: 'smoothstep' }],
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.document.edges[0]!.sourceAnchor).toBeUndefined();
    expect(result.document.edges[0]!.targetAnchor).toBeUndefined();
  });

  it('a missing offset defaults to the side midpoint (0.5), not zero', () => {
    const result = parse(
      [
        { id: 'a', type: 'service', x: 0, y: 0 },
        { id: 'b', type: 'database', x: 300, y: 0 },
      ],
      [
        {
          id: 'e1',
          source: 'a',
          target: 'b',
          directed: true,
          routing: 'smoothstep',
          sourceAnchor: { side: 'left' },
        },
      ],
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.document.edges[0]!.sourceAnchor).toEqual({ side: 'left', offset: 0.5 });
  });
});

describe('anchorPoint offsets', () => {
  const rect = { x: 100, y: 200, width: 80, height: 40 };

  it('defaults to the side midpoint, matching pre-anchor behaviour', () => {
    expect(anchorPoint(rect, 'top')).toEqual({ x: 140, y: 200 });
    expect(anchorPoint(rect, 'right')).toEqual({ x: 180, y: 220 });
    expect(anchorPoint(rect, 'bottom')).toEqual({ x: 140, y: 240 });
    expect(anchorPoint(rect, 'left')).toEqual({ x: 100, y: 220 });
  });

  it('moves along the side as the offset changes, staying on the boundary', () => {
    expect(anchorPoint(rect, 'top', 0)).toEqual({ x: 100, y: 200 });
    expect(anchorPoint(rect, 'top', 1)).toEqual({ x: 180, y: 200 });
    expect(anchorPoint(rect, 'right', 0)).toEqual({ x: 180, y: 200 });
    expect(anchorPoint(rect, 'right', 1)).toEqual({ x: 180, y: 240 });
  });

  it('clamps an out-of-range offset rather than leaving the rect', () => {
    expect(anchorPoint(rect, 'top', -3)).toEqual(anchorPoint(rect, 'top', 0));
    expect(anchorPoint(rect, 'top', 9)).toEqual(anchorPoint(rect, 'top', 1));
  });
});

describe('reconnectEdge', () => {
  function fixture() {
    const a = createNode({ id: 'a', type: 'service', x: 0, y: 0 });
    const b = createNode({ id: 'b', type: 'database', x: 300, y: 0 });
    const c = createNode({ id: 'c', type: 'queue', x: 600, y: 0 });
    const edge = createEdge({
      id: 'e1',
      source: 'a',
      target: 'b',
      sourceAnchor: { side: 'right', offset: 0.5 },
      targetAnchor: { side: 'left', offset: 0.5 },
    });
    return addEdges(addNodes(createDocument(), [a, b, c]), [edge]);
  }

  it('moves the source endpoint to a new node and sets its new anchor', () => {
    const doc = reconnectEdge(fixture(), 'e1', 'source', 'c', 'bottom');
    const edge = doc.edges[0]!;
    expect(edge.source).toBe('c');
    expect(edge.sourceAnchor).toEqual({ side: 'bottom', offset: 0.5 });
  });

  it('leaves the untouched endpoint and its anchor exactly as they were', () => {
    const doc = reconnectEdge(fixture(), 'e1', 'source', 'c', 'bottom');
    const edge = doc.edges[0]!;
    expect(edge.target).toBe('b');
    expect(edge.targetAnchor).toEqual({ side: 'left', offset: 0.5 });
  });

  it('moves the target endpoint symmetrically, leaving the source untouched', () => {
    const doc = reconnectEdge(fixture(), 'e1', 'target', 'c', 'top');
    const edge = doc.edges[0]!;
    expect(edge.target).toBe('c');
    expect(edge.targetAnchor).toEqual({ side: 'top', offset: 0.5 });
    expect(edge.source).toBe('a');
    expect(edge.sourceAnchor).toEqual({ side: 'right', offset: 0.5 });
  });

  it('clears the touched endpoint\'s anchor when dropped without a specific side (a body hit)', () => {
    const doc = reconnectEdge(fixture(), 'e1', 'source', 'c', undefined);
    expect(doc.edges[0]!.sourceAnchor).toBeUndefined();
  });

  it('can reconnect to a different side of the same node', () => {
    const doc = reconnectEdge(fixture(), 'e1', 'source', 'a', 'top');
    const edge = doc.edges[0]!;
    expect(edge.source).toBe('a');
    expect(edge.sourceAnchor).toEqual({ side: 'top', offset: 0.5 });
  });

  it('keeps every other edge and node array referentially unchanged', () => {
    const other = createEdge({ id: 'e2', source: 'b', target: 'c' });
    const doc = addEdges(fixture(), [other]);
    const next = reconnectEdge(doc, 'e1', 'source', 'c', 'bottom');
    expect(next.nodes).toBe(doc.nodes);
    expect(next.edges[1]).toBe(doc.edges[1]);
  });

  it('is a no-op — same document reference — for an unknown edge id', () => {
    const doc = fixture();
    expect(reconnectEdge(doc, 'missing', 'source', 'c', 'bottom')).toBe(doc);
  });

  it('is one undo step through the store', () => {
    __resetInteraction();
    useEditorStore.setState({
      document: fixture(),
      history: { past: [], future: [] },
      selection: { nodes: [], edges: [] },
      clipboard: null,
      revision: 0,
    });
    const before = useEditorStore.getState().history.past.length;
    useEditorStore.getState().reconnectEdge('e1', 'source', 'c', 'bottom');
    expect(useEditorStore.getState().history.past).toHaveLength(before + 1);
    expect(useEditorStore.getState().document.edges[0]!.source).toBe('c');

    useEditorStore.getState().undo();
    expect(useEditorStore.getState().document.edges[0]!.source).toBe('a');
  });
});
