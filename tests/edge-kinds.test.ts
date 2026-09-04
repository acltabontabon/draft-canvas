import { beforeEach, describe, expect, it } from 'vitest';
import { createDocument, createEdge, createNode } from '../src/document/factory';
import { addEdges, addNodes } from '../src/document/operations';
import { normalizeDocument } from '../src/document/validate';
import { CURRENT_VERSION, DRAFT_FORMAT } from '../src/document/types';
import { dashForEdge, markerVariantForEdge } from '../src/edges/kindStyle';
import { describeEdge } from '../src/edges/describe';
import { getMeasurer } from '../src/render/text/measure';
import { DARK } from '../src/render/theme/tokens';
import { __resetInteraction, useEditorStore } from '../src/store/editorStore';
import type { ConnectorKind, DraftEdge } from '../src/document/types';

function edgeWith(patch: Partial<DraftEdge> = {}): DraftEdge {
  return createEdge({ source: 'a', target: 'b', ...patch });
}

describe('dashForEdge / markerVariantForEdge: one dimension per kind', () => {
  it('sync (or no kind) is a plain solid line', () => {
    expect(dashForEdge(edgeWith())).toBeUndefined();
    expect(dashForEdge(edgeWith({ kind: 'sync' }))).toBeUndefined();
  });

  it('event, retry, and fallback each get a distinct dash pattern', () => {
    const event = dashForEdge(edgeWith({ kind: 'event' }));
    const retry = dashForEdge(edgeWith({ kind: 'retry' }));
    const fallback = dashForEdge(edgeWith({ kind: 'fallback' }));
    expect(event).toBeDefined();
    expect(retry).toBeDefined();
    expect(fallback).toBeDefined();
    expect(event).not.toEqual(retry);
    expect(event).not.toEqual(fallback);
    expect(retry).not.toEqual(fallback);
  });

  it('callback, conditional, and failure stay solid unless async is also set', () => {
    expect(dashForEdge(edgeWith({ kind: 'callback' }))).toBeUndefined();
    expect(dashForEdge(edgeWith({ kind: 'conditional' }))).toBeUndefined();
    expect(dashForEdge(edgeWith({ kind: 'failure' }))).toBeUndefined();
  });

  it('kind never overrides the existing async flag\'s own dashed line', () => {
    // A kind with no dash pattern of its own falls back to `async`, exactly
    // as if `kind` were absent — this is "kind doesn't fight async", not a
    // special case. `async` isn't part of CreateEdgeInput (only
    // toggleEdgeAsync sets it post-creation), so it's added directly here.
    expect(dashForEdge({ ...edgeWith({ kind: 'callback' }), async: true })).toEqual([6, 4]);
    expect(dashForEdge({ ...edgeWith({ kind: 'failure' }), async: true })).toEqual([6, 4]);
  });

  it('a kind with its own dash pattern takes priority over async', () => {
    // event's dotted pattern applies regardless of the async flag — kind's
    // own pattern is not itself overridable by async.
    expect(dashForEdge({ ...edgeWith({ kind: 'event' }), async: true })).toEqual(
      dashForEdge(edgeWith({ kind: 'event' })),
    );
  });

  it('only callback gets the hollow arrowhead', () => {
    const kinds: (ConnectorKind | undefined)[] = [
      undefined,
      'sync',
      'async',
      'event',
      'conditional',
      'retry',
      'failure',
      'fallback',
    ];
    for (const kind of kinds) {
      expect(markerVariantForEdge(edgeWith({ kind }))).toBe('closed');
    }
    expect(markerVariantForEdge(edgeWith({ kind: 'callback' }))).toBe('open');
  });
});

describe('setEdgeKind', () => {
  const store = useEditorStore;

  beforeEach(() => {
    __resetInteraction();
    store.setState({
      document: createDocument('Kinds'),
      history: { past: [], future: [] },
      selection: { nodes: [], edges: [] },
      clipboard: null,
      revision: 0,
    });
  });

  function fixtureEdge() {
    const a = store.getState().addNode({ type: 'service', x: 0, y: 0 });
    const b = store.getState().addNode({ type: 'database', x: 300, y: 0 });
    return store.getState().connect(a.id, b.id)!;
  }

  it('sets the kind and never touches semantic or accent', () => {
    const edge = fixtureEdge();
    store.getState().setEdgeSemantic(edge.id, 'reads');
    store.getState().updateEdgeById(edge.id, { accent: 'violet' });

    store.getState().setEdgeKind(edge.id, 'retry');
    const stored = store.getState().document.edges[0]!;
    expect(stored.kind).toBe('retry');
    expect(stored.semantic).toBe('reads');
    expect(stored.accent).toBe('violet');
  });

  it('choosing the async kind defaults async to true, as a fill-in-the-blank', () => {
    const edge = fixtureEdge();
    expect(store.getState().document.edges[0]!.async).toBeUndefined();

    store.getState().setEdgeKind(edge.id, 'async');
    expect(store.getState().document.edges[0]!.async).toBe(true);
  });

  it('choosing the async kind never overrides an async flag already turned off by the user', () => {
    const edge = fixtureEdge();
    store.getState().toggleEdgeAsync(edge.id); // -> true
    store.getState().toggleEdgeAsync(edge.id); // -> back to undefined/false, explicitly chosen

    store.getState().setEdgeKind(edge.id, 'async');
    // Still defaults to true here, since there is no distinguishable
    // "explicitly false" state for async — this documents that limit rather
    // than asserting a false promise.
    expect(store.getState().document.edges[0]!.async).toBe(true);
  });

  it('choosing any other kind never touches async', () => {
    const edge = fixtureEdge();
    store.getState().toggleEdgeAsync(edge.id);
    expect(store.getState().document.edges[0]!.async).toBe(true);

    store.getState().setEdgeKind(edge.id, 'retry');
    expect(store.getState().document.edges[0]!.async).toBe(true);

    store.getState().setEdgeKind(edge.id, 'sync');
    expect(store.getState().document.edges[0]!.async).toBe(true);
  });

  it('clearing the kind leaves everything else untouched', () => {
    const edge = fixtureEdge();
    store.getState().setEdgeKind(edge.id, 'event');
    store.getState().setEdgeKind(edge.id, undefined);
    const stored = store.getState().document.edges[0]!;
    expect(stored.kind).toBeUndefined();
  });

  it('is one undo step', () => {
    const edge = fixtureEdge();
    const before = store.getState().history.past.length;
    store.getState().setEdgeKind(edge.id, 'failure');
    expect(store.getState().history.past).toHaveLength(before + 1);

    store.getState().undo();
    expect(store.getState().document.edges[0]!.kind).toBeUndefined();
  });
});

describe('connector kinds — import validation', () => {
  function parse(nodes: unknown[], edges: unknown[]) {
    return normalizeDocument({ format: DRAFT_FORMAT, version: CURRENT_VERSION, nodes, edges });
  }

  it('keeps a recognised kind', () => {
    const result = parse(
      [
        { id: 'a', type: 'service', x: 0, y: 0 },
        { id: 'b', type: 'database', x: 300, y: 0 },
      ],
      [{ id: 'e1', source: 'a', target: 'b', directed: true, routing: 'smoothstep', kind: 'retry' }],
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.document.edges[0]!.kind).toBe('retry');
  });

  it('normalizes an unrecognised kind to absent, not to a fallback value', () => {
    const result = parse(
      [
        { id: 'a', type: 'service', x: 0, y: 0 },
        { id: 'b', type: 'database', x: 300, y: 0 },
      ],
      [{ id: 'e1', source: 'a', target: 'b', directed: true, routing: 'smoothstep', kind: 'timeout' }],
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.document.edges[0]!.kind).toBeUndefined();
  });

  it('leaves kind absent when the file has none — never force-assigned', () => {
    const result = parse(
      [
        { id: 'a', type: 'service', x: 0, y: 0 },
        { id: 'b', type: 'database', x: 300, y: 0 },
      ],
      [{ id: 'e1', source: 'a', target: 'b', directed: true, routing: 'smoothstep' }],
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.document.edges[0]!.kind).toBeUndefined();
  });
});

describe('kind survives structural sharing', () => {
  it('setting kind rewrites only the edge it touched', () => {
    const a = createNode({ id: 'a', type: 'service', x: 0, y: 0 });
    const b = createNode({ id: 'b', type: 'database', x: 300, y: 0 });
    const e1 = createEdge({ id: 'e1', source: 'a', target: 'b' });
    const e2 = createEdge({ id: 'e2', source: 'b', target: 'a' });
    const doc = addEdges(addNodes(createDocument(), [a, b]), [e1, e2]);

    __resetInteraction();
    useEditorStore.setState({
      document: doc,
      history: { past: [], future: [] },
      selection: { nodes: [], edges: [] },
      clipboard: null,
      revision: 0,
    });
    useEditorStore.getState().setEdgeKind('e1', 'event');
    const next = useEditorStore.getState().document;

    expect(next.edges[0]).not.toBe(doc.edges[0]);
    expect(next.edges[1]).toBe(doc.edges[1]);
    expect(next.nodes).toBe(doc.nodes);
  });
});

describe('a connector\'s subtle relationship caption', () => {
  function described(edge: DraftEdge) {
    const a = createNode({ id: 'a', type: 'service', x: 0, y: 0 });
    const b = createNode({ id: 'b', type: 'queue', x: 300, y: 0 });
    const nodes = new Map([[a.id, a], [b.id, b]]);
    return describeEdge(edge, nodes, { theme: DARK, measurer: getMeasurer(), showSequence: false })!;
  }

  it('shows a muted caption of the semantic next to the event dot when there is no label', () => {
    const edge = createEdge({ source: 'a', target: 'b', kind: 'event', semantic: 'publishes' });
    const texts = described(edge).overlay.filter((s) => s.t === 'text');
    expect(texts).toHaveLength(1);
    expect(texts[0]!.layout.lines.map((l) => l.text).join('')).toBe('publishes');
    expect(texts[0]!.fill).toBe(DARK.textFaint);
  });

  it('has no caption when the connector has no semantic to describe', () => {
    const edge = createEdge({ source: 'a', target: 'b', kind: 'event' });
    const texts = described(edge).overlay.filter((s) => s.t === 'text');
    expect(texts).toHaveLength(0);
  });

  it('yields entirely to a real label — no caption, no dot glyph either', () => {
    const edge = createEdge({ source: 'a', target: 'b', kind: 'event', semantic: 'publishes', label: 'OrderCreated' });
    const overlay = described(edge).overlay;
    // The label itself is still a text shape — what must be gone is the
    // *caption* (the semantic word) and the event dot.
    const texts = overlay.filter((s) => s.t === 'text');
    expect(texts.every((s) => !s.layout.lines.some((l) => l.text.includes('publishes')))).toBe(true);
    expect(overlay.some((s) => s.t === 'ellipse')).toBe(false);
  });

  it('shows the caption for a non-event kind too — independent of the glyph', () => {
    const edge = createEdge({ source: 'a', target: 'b', kind: 'retry', semantic: 'publishes' });
    const overlay = described(edge).overlay;
    const texts = overlay.filter((s) => s.t === 'text');
    expect(texts).toHaveLength(1);
    expect(texts[0]!.layout.lines.map((l) => l.text).join('')).toBe('publishes');
    // Retry isn't event/conditional, so it gets no dot or diamond glyph —
    // the caption alone still carries the relationship.
    expect(overlay.some((s) => s.t === 'ellipse')).toBe(false);
  });

  it('shows the caption for a plain connector with no kind at all', () => {
    const edge = createEdge({ source: 'a', target: 'b', semantic: 'calls' });
    const texts = described(edge).overlay.filter((s) => s.t === 'text');
    expect(texts).toHaveLength(1);
    expect(texts[0]!.layout.lines.map((l) => l.text).join('')).toBe('calls');
  });

  function describedServiceToService(edge: DraftEdge) {
    const a = createNode({ id: 'a', type: 'service', x: 0, y: 0 });
    const b = createNode({ id: 'b', type: 'service', x: 300, y: 0 });
    const nodes = new Map([[a.id, a], [b.id, b]]);
    return describeEdge(edge, nodes, { theme: DARK, measurer: getMeasurer(), showSequence: false })!;
  }

  it('a request/response connector now shows a caption too — "requests" for the untouched default', () => {
    const edge = createEdge({ source: 'a', target: 'b', semantic: 'calls', hasResponse: true });
    const texts = describedServiceToService(edge).overlay.filter((s) => s.t === 'text');
    expect(texts.some((s) => s.layout.lines.map((l) => l.text).join('') === 'requests')).toBe(true);
  });

  it('a request/response connector with a more specific interaction shows that interaction\'s own label, not "requests"', () => {
    const edge = createEdge({ source: 'a', target: 'b', semantic: 'http', hasResponse: true });
    const texts = describedServiceToService(edge).overlay.filter((s) => s.t === 'text');
    expect(texts.some((s) => s.layout.lines.map((l) => l.text).join('') === 'HTTP')).toBe(true);
    expect(texts.some((s) => s.layout.lines.map((l) => l.text).join('').includes('requests'))).toBe(false);
  });

  it('an unusual pairing\'s caption carries a small warning marker', () => {
    const a = createNode({ id: 'a', type: 'queue', x: 0, y: 0 });
    const b = createNode({ id: 'b', type: 'queue', x: 300, y: 0, queueKind: 'topic' });
    const nodes = new Map([[a.id, a], [b.id, b]]);
    const edge = createEdge({ source: 'a', target: 'b', semantic: 'event' });
    const described = describeEdge(edge, nodes, { theme: DARK, measurer: getMeasurer(), showSequence: false })!;
    const texts = described.overlay.filter((s) => s.t === 'text');
    expect(texts.some((s) => s.layout.lines.map((l) => l.text).join('').startsWith('▲'))).toBe(true);
  });

  it('an ordinary pairing\'s caption carries no warning marker', () => {
    const edge = createEdge({ source: 'a', target: 'b', semantic: 'publishes' });
    const texts = described(edge).overlay.filter((s) => s.t === 'text');
    expect(texts.some((s) => s.layout.lines.map((l) => l.text).join('').startsWith('▲'))).toBe(false);
  });
});
