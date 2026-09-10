import { beforeEach, describe, expect, it } from 'vitest';
import { createDocument, createEdge, createNode } from '../src/document/factory';
import { addEdges, addNodes, reconnectEdge, reverseEdge } from '../src/document/operations';
import { normalizeDocument } from '../src/document/validate';
import { DRAFT_FORMAT, CURRENT_VERSION } from '../src/document/types';
import {
  ANCHOR_OFFSETS,
  HANDLE_ANCHORS,
  anchorAt,
  anchorForDrop,
  anchorPoint,
  parseAnchorId,
  snappedAnchorForDrop,
} from '../src/edges/routing';
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

describe('anchorAt — the continuous counterpart used for a body-hit drop', () => {
  const rect = { x: 100, y: 200, width: 80, height: 40 };

  it('picks the nearest side and the midpoint offset for a point dead centre', () => {
    // Dead centre is equidistant from top and bottom (20) and closer than
    // left/right (40) — top wins the tie via `SIDES`' declared order.
    expect(anchorAt(rect, { x: 140, y: 220 })).toEqual({ side: 'top', offset: 0.5 });
  });

  it('picks a side near a corner and an offset near that corner', () => {
    const anchor = anchorAt(rect, { x: 105, y: 202 });
    expect(anchor.side).toBe('top');
    expect(anchor.offset).toBeCloseTo(0.0625, 3); // (105 - 100) / 80
  });

  it('picks the opposite corner correctly', () => {
    const anchor = anchorAt(rect, { x: 175, y: 238 });
    expect(anchor.side).toBe('bottom');
    expect(anchor.offset).toBeCloseTo(0.9375, 3); // (175 - 100) / 80
  });

  it('picks left/right sides and an offset along the vertical axis', () => {
    expect(anchorAt(rect, { x: 100, y: 210 })).toEqual({ side: 'left', offset: 0.25 });
    expect(anchorAt(rect, { x: 180, y: 230 })).toEqual({ side: 'right', offset: 0.75 });
  });

  it('clamps the offset for a point outside the rect along the side axis', () => {
    // Far to the left, above the rect's own vertical span.
    const anchor = anchorAt(rect, { x: -50, y: 100 });
    expect(anchor.side).toBe('left');
    expect(anchor.offset).toBe(0);
  });

  it('picks whichever side a point is furthest past when entirely outside the rect', () => {
    // Well above and slightly right — further past the top than any other side.
    expect(anchorAt(rect, { x: 150, y: -200 }).side).toBe('top');
    // Well to the right and roughly centred vertically.
    expect(anchorAt(rect, { x: 500, y: 220 }).side).toBe('right');
  });
});

describe('anchorForDrop — the centre-tolerant gate used for connect/reconnect drops', () => {
  const rect = { x: 100, y: 200, width: 80, height: 40 };

  it('is undefined for a drop dead centre — no real positional intent to capture', () => {
    expect(anchorForDrop(rect, { x: 140, y: 220 })).toBeUndefined();
  });

  it('is undefined for a drop only slightly off centre, within tolerance', () => {
    // 5px off centre on each axis — well inside the 35%-of-half-extent zone.
    expect(anchorForDrop(rect, { x: 145, y: 225 })).toBeUndefined();
  });

  it('captures a real anchor for a drop clearly favouring one side', () => {
    // Near the right edge, roughly centred vertically.
    expect(anchorForDrop(rect, { x: 178, y: 220 })).toEqual({ side: 'right', offset: 0.5 });
  });

  it('captures a real anchor for a drop near a corner', () => {
    const anchor = anchorForDrop(rect, { x: 105, y: 202 });
    expect(anchor).toEqual(anchorAt(rect, { x: 105, y: 202 }));
  });
});

describe('HANDLE_ANCHORS — the 12 rendered connection points', () => {
  it('offers exactly 3 anchors per side, 12 total', () => {
    expect(HANDLE_ANCHORS).toHaveLength(12);
    for (const side of ['top', 'right', 'bottom', 'left'] as const) {
      const onSide = HANDLE_ANCHORS.filter((anchor) => anchor.side === side);
      expect(onSide.map((anchor) => anchor.offset).sort()).toEqual([...ANCHOR_OFFSETS]);
    }
  });

  it('every id is unique and parses back to its own side and offset', () => {
    const ids = new Set(HANDLE_ANCHORS.map((anchor) => anchor.id));
    expect(ids.size).toBe(12);
    for (const anchor of HANDLE_ANCHORS) {
      expect(parseAnchorId(anchor.id)).toEqual({ side: anchor.side, offset: anchor.offset });
    }
  });
});

describe('parseAnchorId', () => {
  it('rejects a bare side, an unknown side, and non-string values', () => {
    expect(parseAnchorId('top')).toBeUndefined();
    expect(parseAnchorId('north@0')).toBeUndefined();
    expect(parseAnchorId(undefined)).toBeUndefined();
    expect(parseAnchorId(null)).toBeUndefined();
  });

  it('rejects an out-of-range or malformed offset index', () => {
    expect(parseAnchorId('top@3')).toBeUndefined();
    expect(parseAnchorId('top@-1')).toBeUndefined();
    expect(parseAnchorId('top@x')).toBeUndefined();
  });
});

describe('snappedAnchorForDrop — what an interactive drag actually captures', () => {
  const rect = { x: 100, y: 200, width: 80, height: 40 };

  it('snaps a near-corner drop to the nearest of the 3 fixed offsets', () => {
    // Continuous anchorAt would give ~0.0625 here (see the anchorAt tests
    // above) — the nearest fixed point is 0.25.
    expect(snappedAnchorForDrop(rect, { x: 105, y: 202 })).toEqual({ side: 'top', offset: 0.25 });
  });

  it('snaps a drop past the far corner to the nearest fixed offset, not the raw extreme', () => {
    // Continuous offset ~0.9375 — nearest fixed point is 0.75.
    expect(snappedAnchorForDrop(rect, { x: 175, y: 238 })).toEqual({ side: 'bottom', offset: 0.75 });
  });

  it('stays undefined for a dead-centre drop, exactly like the unsnapped version', () => {
    expect(snappedAnchorForDrop(rect, { x: 140, y: 220 })).toBeUndefined();
  });

  it('every possible offset in 0..1 snaps to one of the 3 fixed points', () => {
    for (let x = rect.x; x <= rect.x + rect.width; x += 1) {
      const anchor = snappedAnchorForDrop(rect, { x, y: rect.y });
      if (anchor) expect(ANCHOR_OFFSETS).toContain(anchor.offset);
    }
  });
});

describe('connect() with an explicit non-centre offset — the actual bug a real handle-drawn connection used to hit', () => {
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

  it('honours a non-0.5 offset for both endpoints, the way a real 25%/75% handle now supplies', () => {
    const a = store.getState().addNode({ type: 'service', x: 0, y: 0 });
    const b = store.getState().addNode({ type: 'database', x: 300, y: 0 });
    const edge = store.getState().connect(a.id, b.id, 'right', 'left', 0.25, 0.75)!;

    expect(edge.sourceAnchor).toEqual({ side: 'right', offset: 0.25 });
    expect(edge.targetAnchor).toEqual({ side: 'left', offset: 0.75 });
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

  it('is a no-op rather than creating a dangling reference for an unknown target node id', () => {
    // Guards the same invariant `addEdges` already enforces for new edges: a reconnect must never
    // leave an edge pointing at a node that doesn't exist, e.g. one deleted by a concurrent action
    // in the moment between the drop and this call committing.
    const doc = fixture();
    const next = reconnectEdge(doc, 'e1', 'source', 'does-not-exist', 'bottom');
    expect(next).toBe(doc);
    expect(next.edges[0]!.source).toBe('a');
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

describe('reverseEdge', () => {
  const store = useEditorStore;

  beforeEach(() => {
    __resetInteraction();
    store.setState({
      document: createDocument('Reverse'),
      history: { past: [], future: [] },
      selection: { nodes: [], edges: [] },
      clipboard: null,
      revision: 0,
    });
  });

  it('swaps the endpoints and their anchors, and nothing else — for an edge whose semantics a user has explicitly set', () => {
    const a = store.getState().addNode({ type: 'service', x: 0, y: 0 });
    const b = store.getState().addNode({ type: 'database', x: 300, y: 0 });
    const edge = store.getState().connect(a.id, b.id, 'right', 'left')!;
    // `setEdgeKind` marks the whole edge `semanticsOrigin: 'explicit'` — what makes `reverseEdge`'s
    // own re-inference step (see `reinferIfEligible`) correctly leave it alone. An edge still
    // eligible for re-inference (the far more common, freshly-inferred case) is exactly the one
    // `tests/connector-semantics.test.ts`'s `reverseEdge` block covers instead.
    store.getState().setEdgeKind(edge.id, 'retry');
    store.getState().updateEdgeById(edge.id, { label: 'reads', condition: 'cached', hasResponse: true });
    const before = store.getState().document.edges.find((e) => e.id === edge.id)!;

    store.getState().reverseEdge(edge.id);
    const after = store.getState().document.edges.find((e) => e.id === edge.id)!;

    expect(after.source).toBe(b.id);
    expect(after.target).toBe(a.id);
    expect(after.sourceAnchor).toEqual({ side: 'left', offset: 0.5 });
    expect(after.targetAnchor).toEqual({ side: 'right', offset: 0.5 });
    const { source: _s, target: _t, sourceAnchor: _sa, targetAnchor: _ta, ...restBefore } = before;
    const { source: _s2, target: _t2, sourceAnchor: _sa2, targetAnchor: _ta2, ...restAfter } = after;
    expect(restAfter).toEqual(restBefore);
  });

  it('keeps an absent anchor absent rather than writing undefined', () => {
    const doc0 = addNodes(createDocument('Reverse'), [
      createNode({ type: 'service', x: 0, y: 0, id: 'a' }),
      createNode({ type: 'service', x: 300, y: 0, id: 'b' }),
    ]);
    const doc1 = addEdges(doc0, [
      createEdge({ source: 'a', target: 'b', id: 'e', sourceAnchor: { side: 'right', offset: 0.5 } }),
    ]);
    const reversed = reverseEdge(doc1, 'e');
    const edge = reversed.edges[0]!;
    expect(edge.source).toBe('b');
    expect(edge.targetAnchor).toEqual({ side: 'right', offset: 0.5 });
    expect('sourceAnchor' in edge).toBe(false);
    expect(reverseEdge(doc1, 'missing')).toBe(doc1);
  });

  it('is one undo step and keeps flow steps pointing at the same connector', () => {
    const a = store.getState().addNode({ type: 'service', x: 0, y: 0 });
    const b = store.getState().addNode({ type: 'service', x: 300, y: 0 });
    const edge = store.getState().connect(a.id, b.id)!;
    const flowId = store.getState().createFlow('Checkout')!;
    store.getState().addEdgeToFlow(flowId, edge.id);
    const past = store.getState().history.past.length;

    store.getState().reverseEdge(edge.id);
    expect(store.getState().history.past.length).toBe(past + 1);
    expect(store.getState().document.flows[0]!.steps[0]!.edgeId).toBe(edge.id);
    store.getState().undo();
    expect(store.getState().document.edges[0]!.source).toBe(a.id);
  });
});
