import { describe, expect, it } from 'vitest';
import { createDocument, createEdge } from '../src/document/factory';
import { addEdges, moveNodes, removeElements, updateNode } from '../src/document/operations';
import { laneIndex, routeEdge } from '../src/edges/routing';
import { __resetInteraction, useEditorStore } from '../src/store/editorStore';
import type { Side } from '../src/document/types';

/**
 * A consolidated regression net over the requirement doc's named connector
 * scenarios, exercised through the store and `document/operations.ts` — not
 * `routeBetween` directly, which `tests/routing.test.ts` already covers at
 * the pure-geometry level. This file's job is the integration seam: does an
 * anchor captured by a real `connect()` drag actually survive a real drag,
 * resize, reconnect, or deletion once it's living in the store.
 */

const store = useEditorStore;

function reset() {
  __resetInteraction();
  store.setState({
    document: createDocument('Matrix'),
    history: { past: [], future: [] },
    selection: { nodes: [], edges: [] },
    clipboard: null,
    revision: 0,
  });
}

describe('routing matrix: an anchor survives a drag then a resize of both endpoints', () => {
  it.each([
    { source: 'right' as Side, target: 'left' as Side, label: 'right→left' },
    { source: 'left' as Side, target: 'right' as Side, label: 'left→right' },
    { source: 'top' as Side, target: 'bottom' as Side, label: 'top→bottom' },
    { source: 'bottom' as Side, target: 'top' as Side, label: 'bottom→top' },
    { source: 'right' as Side, target: 'right' as Side, label: 'same-side' },
  ])('$label', ({ source, target }) => {
    reset();
    const a = store.getState().addNode({ type: 'service', x: 0, y: 0 });
    const b = store.getState().addNode({ type: 'database', x: 400, y: 300 });
    const edge = store.getState().connect(a.id, b.id, source, target)!;
    expect(edge.sourceAnchor).toEqual({ side: source, offset: 0.5 });
    expect(edge.targetAnchor).toEqual({ side: target, offset: 0.5 });

    // drag-source, drag-target
    let doc = moveNodes(
      store.getState().document,
      new Map([
        [a.id, { x: 50, y: 20 }],
        [b.id, { x: 500, y: 380 }],
      ]),
    );
    // resize-source, resize-target
    doc = updateNode(doc, a.id, { width: 200, height: 90 });
    doc = updateNode(doc, b.id, { width: 60, height: 220 });
    store.setState({ document: doc });

    const stored = doc.edges[0]!;
    expect(stored.sourceAnchor).toEqual({ side: source, offset: 0.5 });
    expect(stored.targetAnchor).toEqual({ side: target, offset: 0.5 });

    // The resolved route still lands exactly on each node's moved, resized boundary.
    const nodes = new Map(doc.nodes.map((n) => [n.id, n]));
    const route = routeEdge(stored, nodes)!;
    expect(route.source.side).toBe(source);
    expect(route.target.side).toBe(target);
  });

  it('move-away-and-back: a round-trip drag resolves to exactly the original route', () => {
    reset();
    const a = store.getState().addNode({ type: 'service', x: 0, y: 0 });
    const b = store.getState().addNode({ type: 'database', x: 300, y: 0 });
    const original = store.getState().connect(a.id, b.id, 'top', 'bottom')!;
    const originalNodes = new Map(store.getState().document.nodes.map((n) => [n.id, n]));
    const originalRoute = routeEdge(original, originalNodes)!;

    let doc = moveNodes(store.getState().document, new Map([[a.id, { x: 800, y: 800 }]]));
    doc = moveNodes(doc, new Map([[a.id, { x: 0, y: 0 }]]));

    expect(doc.edges[0]!.sourceAnchor).toEqual({ side: 'top', offset: 0.5 });
    const nodes = new Map(doc.nodes.map((n) => [n.id, n]));
    expect(routeEdge(doc.edges[0]!, nodes)).toEqual(originalRoute);
  });
});

describe('routing matrix: fan-out and fan-in keep each connector\'s anchor independent', () => {
  it('fan-out: one source to three targets, none clobbering the others', () => {
    reset();
    const hub = store.getState().addNode({ type: 'service', x: 0, y: 0 });
    const targets = [
      store.getState().addNode({ type: 'database', x: 300, y: -200 }),
      store.getState().addNode({ type: 'queue', x: 300, y: 100 }),
      store.getState().addNode({ type: 'actor', x: 300, y: 400 }),
    ];
    const sides: Side[] = ['top', 'right', 'bottom'];
    targets.forEach((t, i) => store.getState().connect(hub.id, t.id, sides[i], 'left'));

    const stored = store.getState().document.edges;
    expect(stored.map((e) => e.sourceAnchor?.side)).toEqual(sides);
    expect(stored.every((e) => e.targetAnchor?.side === 'left')).toBe(true);
  });

  it('fan-in: three sources to one target, none clobbering the others', () => {
    reset();
    const hub = store.getState().addNode({ type: 'database', x: 300, y: 0 });
    const sources = [
      store.getState().addNode({ type: 'service', x: 0, y: -200 }),
      store.getState().addNode({ type: 'service', x: 0, y: 100 }),
      store.getState().addNode({ type: 'service', x: 0, y: 400 }),
    ];
    const sides: Side[] = ['top', 'right', 'bottom'];
    sources.forEach((s, i) => store.getState().connect(s.id, hub.id, sides[i], 'left'));

    const stored = store.getState().document.edges;
    expect(stored.map((e) => e.sourceAnchor?.side)).toEqual(sides);
    expect(stored.every((e) => e.targetAnchor?.side === 'left')).toBe(true);
  });
});

describe('routing matrix: callback pair (A→B and B→A) fan out together without cross-talk', () => {
  it('reconnecting one direction leaves the other\'s anchor and lane group untouched', () => {
    reset();
    const a = store.getState().addNode({ type: 'service', x: 0, y: 0 });
    const b = store.getState().addNode({ type: 'database', x: 300, y: 0 });
    const c = store.getState().addNode({ type: 'queue', x: 600, y: 0 });
    const call = store.getState().connect(a.id, b.id, 'right', 'left')!;
    const reply = store.getState().connect(b.id, a.id, 'bottom', 'top')!;

    // The two never touch the same point on either node (right/left vs
    // bottom/top), so neither is nudged — they already read as two lines.
    const lanesBefore = laneIndex(store.getState().document.edges);
    expect(lanesBefore.get(call.id)).toEqual({ offset: 0, count: 1 });
    expect(lanesBefore.get(reply.id)).toEqual({ offset: 0, count: 1 });

    store.getState().reconnectEdge(call.id, 'target', c.id, 'left');

    const doc = store.getState().document;
    const stillReply = doc.edges.find((e) => e.id === reply.id)!;
    expect(stillReply.sourceAnchor).toEqual({ side: 'bottom', offset: 0.5 });
    expect(stillReply.targetAnchor).toEqual({ side: 'top', offset: 0.5 });

    // The reconnected edge left the a↔b pair, so the reply is now alone in its group.
    expect(laneIndex(doc.edges).get(reply.id)).toEqual({ offset: 0, count: 1 });
  });
});

describe('routing matrix: delete-and-recreate does not leak a stale anchor onto the new edge', () => {
  it('a freshly created edge between the same pair starts with only its own drag\'s anchor', () => {
    reset();
    const a = store.getState().addNode({ type: 'service', x: 0, y: 0 });
    const b = store.getState().addNode({ type: 'database', x: 300, y: 0 });
    const first = store.getState().connect(a.id, b.id, 'bottom', 'top')!;
    expect(first.sourceAnchor).toEqual({ side: 'bottom', offset: 0.5 });

    store.setState({ document: removeElements(store.getState().document, [], [first.id]) });
    expect(store.getState().document.edges).toHaveLength(0);

    const second = store.getState().connect(a.id, b.id, 'right', 'left')!;
    expect(second.id).not.toBe(first.id);
    expect(second.sourceAnchor).toEqual({ side: 'right', offset: 0.5 });
    expect(second.targetAnchor).toEqual({ side: 'left', offset: 0.5 });
  });
});

describe('routing matrix: removing one edge from a three-way parallel group re-centres the rest', () => {
  it('leaves a symmetric two-way fan-out, not a stale three-way offset', () => {
    reset();
    const a = store.getState().addNode({ type: 'service', x: 0, y: 0 });
    const b = store.getState().addNode({ type: 'database', x: 300, y: 0 });
    // Three identical-direction A→B edges — not reachable through the store's
    // `connect()` gesture, which refuses an exact duplicate pair, but a real
    // shape (paste, import) the lane layer still has to handle correctly.
    const e1 = createEdge({ id: 'e1', source: a.id, target: b.id });
    const e2 = createEdge({ id: 'e2', source: a.id, target: b.id });
    const e3 = createEdge({ id: 'e3', source: a.id, target: b.id });
    store.setState({ document: addEdges(store.getState().document, [e1, e2, e3]) });
    expect(laneIndex(store.getState().document.edges).get(e2.id)!.count).toBe(3);

    store.setState({ document: removeElements(store.getState().document, [], [e2.id]) });

    const lanes = laneIndex(store.getState().document.edges);
    expect(lanes.get(e1.id)).toEqual({ offset: -0.5, count: 2 });
    expect(lanes.get(e3.id)).toEqual({ offset: 0.5, count: 2 });
  });
});

describe('routing matrix: a node deleted mid-flow leaves its surviving sibling untouched', () => {
  it('drops only the step referencing the removed connector, keeping the other\'s anchor and step intact', () => {
    reset();
    const a = store.getState().addNode({ type: 'service', x: 0, y: 0 });
    const b = store.getState().addNode({ type: 'database', x: 300, y: 0 });
    const c = store.getState().addNode({ type: 'queue', x: 600, y: 0 });
    const e1 = store.getState().connect(a.id, b.id, 'right', 'left')!;
    const e2 = store.getState().connect(b.id, c.id, 'right', 'left')!;
    const flowId = store.getState().createFlow('Happy path')!;
    store.getState().addEdgeToFlow(flowId, e1.id);
    store.getState().addEdgeToFlow(flowId, e2.id);

    store.getState().setSelection({ nodes: [c.id], edges: [] });
    store.getState().deleteSelection();

    const doc = store.getState().document;
    expect(doc.flows[0]!.steps.map((s) => s.edgeId)).toEqual([e1.id]);
    expect(doc.edges.find((e) => e.id === e1.id)!.sourceAnchor).toEqual({ side: 'right', offset: 0.5 });
    expect(doc.edges.find((e) => e.id === e1.id)!.targetAnchor).toEqual({ side: 'left', offset: 0.5 });
  });
});
