import { beforeEach, describe, expect, it } from 'vitest';
import { createDocument } from '../src/document/factory';
import { queueTubeCenterFraction } from '../src/document/queueGeometry';
import { __resetInteraction, useEditorStore } from '../src/store/editorStore';

describe('addDeadLetterQueue() / removeDeadLetterQueue() — "Add DLQ"', () => {
  const store = useEditorStore;

  beforeEach(() => {
    __resetInteraction();
    store.setState({
      document: createDocument('DLQ'),
      history: { past: [], future: [] },
      selection: { nodes: [], edges: [] },
      clipboard: null,
      revision: 0,
    });
  });

  it('creates a compact, connected DLQ node in one undo step', () => {
    const queue = store.getState().addNode({ type: 'queue', x: 0, y: 0 });
    const before = store.getState().history.past.length;

    store.getState().addDeadLetterQueue(queue.id);
    const doc = store.getState().document;

    expect(store.getState().history.past).toHaveLength(before + 1);
    expect(doc.nodes).toHaveLength(2);
    const dlq = doc.nodes.find((n) => n.id !== queue.id)!;
    expect(dlq.type).toBe('queue');
    expect(dlq.deliveryRole).toBe('dead-letter');

    expect(doc.edges).toHaveLength(1);
    const edge = doc.edges[0]!;
    expect(edge.source).toBe(queue.id);
    expect(edge.target).toBe(dlq.id);
    expect(edge.semantic).toBe('deadLetters');
    expect(edge.kind).toBe('failure');
    expect(edge.async).toBe(true);
    expect(edge.deliveryAttempts).toBe(3);
    // Derived from the matrix's own `queue>deadLetter` row, so it re-infers like any hand-drawn edge.
    expect(edge.semanticsOrigin).toBe('inferred');

    expect(store.getState().selection).toEqual({ nodes: [dlq.id], edges: [] });
  });

  it('anchors the connector on the tube glyph\'s own visual centre, not the node box centre', () => {
    // A Queue's tube glyph sits in the upper portion of its box (the kind caption sits below it —
    // see nodes/describe.ts's queue()), so the default 0.5 offset would land a connector at the
    // boundary between the tube and its caption, not the tube's own middle.
    const queue = store.getState().addNode({ type: 'queue', x: 0, y: 0 });
    store.getState().addDeadLetterQueue(queue.id);
    const doc = store.getState().document;
    const dlq = doc.nodes.find((n) => n.deliveryRole === 'dead-letter')!;
    const edge = doc.edges[0]!;
    const expectedFraction = queueTubeCenterFraction(48);
    expect(expectedFraction).toBeLessThan(0.5);
    expect(edge.sourceAnchor).toEqual({ side: 'right', offset: expectedFraction });
    expect(edge.targetAnchor).toEqual({ side: 'left', offset: expectedFraction });
    // Sanity: both endpoints share the same tube geometry (same default height), so the same
    // fraction is correct on both ends of this edge.
    expect(queue.height).toBe(dlq.height);
  });

  it('leaves anchors unset (default nearest-side) when placement fell back to a non-horizontal spot', () => {
    const queue = store.getState().addNode({ type: 'queue', x: 0, y: 0 });
    // Occupy the simple "beside" position so placeNear must fall back to a vertical candidate —
    // an explicit 'right'/'left' anchor pair would be actively wrong for that placement.
    store.getState().addNode({ type: 'service', x: queue.x + queue.width + 32, y: queue.y, width: 176, height: 68 });
    store.getState().addDeadLetterQueue(queue.id);
    const edge = store.getState().document.edges.find((e) => e.semantic === 'deadLetters')!;
    expect(edge.sourceAnchor).toBeUndefined();
    expect(edge.targetAnchor).toBeUndefined();
  });

  it('positions the DLQ without overlapping an existing node in the obvious spot', () => {
    const queue = store.getState().addNode({ type: 'queue', x: 0, y: 0 });
    // Occupy the naive "beside" position so placeNear has to pick something else.
    store.getState().addNode({ type: 'service', x: queue.x + queue.width + 32, y: queue.y, width: 176, height: 68 });

    store.getState().addDeadLetterQueue(queue.id);
    const doc = store.getState().document;
    const dlq = doc.nodes.find((n) => n.deliveryRole === 'dead-letter')!;
    const blocker = doc.nodes.find((n) => n.type === 'service')!;
    const overlaps =
      dlq.x < blocker.x + blocker.width &&
      dlq.x + dlq.width > blocker.x &&
      dlq.y < blocker.y + blocker.height &&
      dlq.y + dlq.height > blocker.y;
    expect(overlaps).toBe(false);
  });

  it('is a no-op on a Topic', () => {
    const topic = store.getState().addNode({ type: 'queue', queueKind: 'topic', x: 0, y: 0 });
    const before = store.getState().document;
    store.getState().addDeadLetterQueue(topic.id);
    expect(store.getState().document).toBe(before);
  });

  it('is a no-op on a Stream', () => {
    const stream = store.getState().addNode({ type: 'queue', queueKind: 'stream', x: 0, y: 0 });
    const before = store.getState().document;
    store.getState().addDeadLetterQueue(stream.id);
    expect(store.getState().document).toBe(before);
  });

  it('is a no-op on a node that is itself a generated DLQ', () => {
    const queue = store.getState().addNode({ type: 'queue', x: 0, y: 0 });
    store.getState().addDeadLetterQueue(queue.id);
    const dlq = store.getState().document.nodes.find((n) => n.deliveryRole === 'dead-letter')!;
    const before = store.getState().document;
    store.getState().addDeadLetterQueue(dlq.id);
    expect(store.getState().document).toBe(before);
  });

  it('is a no-op on a queue that already has a DLQ', () => {
    const queue = store.getState().addNode({ type: 'queue', x: 0, y: 0 });
    store.getState().addDeadLetterQueue(queue.id);
    const before = store.getState().document;
    store.getState().addDeadLetterQueue(queue.id);
    expect(store.getState().document).toBe(before);
  });

  it('removes both the DLQ node and its edge, reverting the queue to "no DLQ"', () => {
    const queue = store.getState().addNode({ type: 'queue', x: 0, y: 0 });
    store.getState().addDeadLetterQueue(queue.id);
    expect(store.getState().document.nodes).toHaveLength(2);

    store.getState().removeDeadLetterQueue(queue.id);
    const doc = store.getState().document;
    expect(doc.nodes).toHaveLength(1);
    expect(doc.edges).toHaveLength(0);
  });

  it('deletes only the edge, never the target node, once the edge has been manually reconnected onto an unmarked node', () => {
    const queue = store.getState().addNode({ type: 'queue', x: 0, y: 0 });
    store.getState().addDeadLetterQueue(queue.id);
    const edge = store.getState().document.edges[0]!;
    const important = store.getState().addNode({ type: 'service', x: 500, y: 500 });

    // Simulate a manual reconnect via the edge inspector's escape hatch onto an unrelated node.
    store.getState().reconnectEdge(edge.id, 'target', important.id, undefined);
    expect(store.getState().document.edges[0]!.target).toBe(important.id);

    store.getState().removeDeadLetterQueue(queue.id);
    const doc = store.getState().document;
    expect(doc.nodes.find((n) => n.id === important.id)).toBeDefined();
    expect(doc.edges.find((e) => e.semantic === 'deadLetters')).toBeUndefined();
  });

  it('is a no-op when there is no outgoing deadLetters edge', () => {
    const queue = store.getState().addNode({ type: 'queue', x: 0, y: 0 });
    const before = store.getState().document;
    store.getState().removeDeadLetterQueue(queue.id);
    expect(store.getState().document).toBe(before);
  });

  it('undo/redo restores the whole DLQ + edge pair together', () => {
    const queue = store.getState().addNode({ type: 'queue', x: 0, y: 0 });
    store.getState().addDeadLetterQueue(queue.id);
    expect(store.getState().document.nodes).toHaveLength(2);

    store.getState().undo();
    expect(store.getState().document.nodes).toHaveLength(1);

    store.getState().redo();
    expect(store.getState().document.nodes).toHaveLength(2);
    expect(store.getState().document.edges).toHaveLength(1);
  });
});

describe('duplicate/copy/paste carry the DLQ relationship with zero DLQ-specific code', () => {
  const store = useEditorStore;

  beforeEach(() => {
    __resetInteraction();
    store.setState({
      document: createDocument('DLQ duplicate'),
      history: { past: [], future: [] },
      selection: { nodes: [], edges: [] },
      clipboard: null,
      revision: 0,
    });
  });

  it('duplicating the primary + its DLQ together produces a second, independently-correct pair', () => {
    const queue = store.getState().addNode({ type: 'queue', x: 0, y: 0 });
    store.getState().addDeadLetterQueue(queue.id);
    const dlq = store.getState().document.nodes.find((n) => n.deliveryRole === 'dead-letter')!;

    store.getState().setSelection({ nodes: [queue.id, dlq.id], edges: [] });
    store.getState().duplicateSelection();

    const doc = store.getState().document;
    expect(doc.nodes).toHaveLength(4);
    const dlEdges = doc.edges.filter((e) => e.semantic === 'deadLetters');
    expect(dlEdges).toHaveLength(2);
    const dlqNodeIds = new Set(doc.nodes.filter((n) => n.deliveryRole === 'dead-letter').map((n) => n.id));
    for (const edge of dlEdges) {
      expect(dlqNodeIds.has(edge.target)).toBe(true);
      expect(edge.deliveryAttempts).toBe(3);
    }
    // The duplicate's own edge/node ids are fresh, not shared with the original pair.
    const newEdge = dlEdges.find((e) => e.source !== queue.id)!;
    expect(newEdge.target).not.toBe(dlq.id);
  });

  it('duplicating only the primary (DLQ not selected) produces a plain queue with no DLQ', () => {
    const queue = store.getState().addNode({ type: 'queue', x: 0, y: 0 });
    store.getState().addDeadLetterQueue(queue.id);

    store.getState().setSelection({ nodes: [queue.id], edges: [] });
    store.getState().duplicateSelection();

    const doc = store.getState().document;
    expect(doc.nodes).toHaveLength(3);
    const duplicate = doc.nodes.find((n) => n.id !== queue.id && n.deliveryRole !== 'dead-letter' && n.type === 'queue')!;
    expect(doc.edges.some((e) => e.source === duplicate.id)).toBe(false);
  });

  it('copy then paste preserves the pair the same way duplicate does', () => {
    const queue = store.getState().addNode({ type: 'queue', x: 0, y: 0 });
    store.getState().addDeadLetterQueue(queue.id);
    const dlq = store.getState().document.nodes.find((n) => n.deliveryRole === 'dead-letter')!;

    store.getState().setSelection({ nodes: [queue.id, dlq.id], edges: [] });
    store.getState().copySelection();
    store.getState().paste({ x: 800, y: 800 });

    const doc = store.getState().document;
    expect(doc.nodes).toHaveLength(4);
    const dlEdges = doc.edges.filter((e) => e.semantic === 'deadLetters');
    expect(dlEdges).toHaveLength(2);
  });
});

describe('addConsumer() — "Add Consumer"', () => {
  const store = useEditorStore;

  beforeEach(() => {
    __resetInteraction();
    store.setState({
      document: createDocument('Consumer'),
      history: { past: [], future: [] },
      selection: { nodes: [], edges: [] },
      clipboard: null,
      revision: 0,
    });
  });

  it('connects a plain Queue to a new Worker with "consumes"', () => {
    const queue = store.getState().addNode({ type: 'queue', x: 0, y: 0 });
    store.getState().addConsumer(queue.id);
    const doc = store.getState().document;
    const worker = doc.nodes.find((n) => n.type === 'service')!;
    expect(worker.serviceKind).toBe('worker');
    const edge = doc.edges[0]!;
    expect(edge.source).toBe(queue.id);
    expect(edge.target).toBe(worker.id);
    expect(edge.semantic).toBe('consumes');
  });

  it('connects a Stream to a new Worker with "consumes" too (folds into the queue category)', () => {
    const stream = store.getState().addNode({ type: 'queue', queueKind: 'stream', x: 0, y: 0 });
    store.getState().addConsumer(stream.id);
    const edge = store.getState().document.edges[0]!;
    expect(edge.semantic).toBe('consumes');
  });

  it('anchors the Queue side on its tube centre, and leaves the Worker side untouched (not tube-shaped)', () => {
    const queue = store.getState().addNode({ type: 'queue', x: 0, y: 0 });
    store.getState().addConsumer(queue.id);
    const edge = store.getState().document.edges[0]!;
    expect(edge.sourceAnchor).toEqual({ side: 'right', offset: queueTubeCenterFraction(48) });
    expect(edge.targetAnchor).toBeUndefined();
  });

  it('connects a Topic to a new Worker with "deliversTo" (fan-out framing)', () => {
    const topic = store.getState().addNode({ type: 'queue', queueKind: 'topic', x: 0, y: 0 });
    store.getState().addConsumer(topic.id);
    const edge = store.getState().document.edges[0]!;
    expect(edge.semantic).toBe('deliversTo');
  });

  it('is one undo step', () => {
    const queue = store.getState().addNode({ type: 'queue', x: 0, y: 0 });
    const before = store.getState().history.past.length;
    store.getState().addConsumer(queue.id);
    expect(store.getState().history.past).toHaveLength(before + 1);
  });
});

describe('setEdgeDeliveryAttempts()', () => {
  const store = useEditorStore;

  beforeEach(() => {
    __resetInteraction();
    store.setState({
      document: createDocument('DLQ attempts'),
      history: { past: [], future: [] },
      selection: { nodes: [], edges: [] },
      clipboard: null,
      revision: 0,
    });
  });

  it('clamps to 1–50', () => {
    const queue = store.getState().addNode({ type: 'queue', x: 0, y: 0 });
    store.getState().addDeadLetterQueue(queue.id);
    const edge = store.getState().document.edges[0]!;

    store.getState().setEdgeDeliveryAttempts(edge.id, 0);
    expect(store.getState().document.edges[0]!.deliveryAttempts).toBe(1);

    store.getState().setEdgeDeliveryAttempts(edge.id, 999);
    expect(store.getState().document.edges[0]!.deliveryAttempts).toBe(50);

    store.getState().setEdgeDeliveryAttempts(edge.id, 5);
    expect(store.getState().document.edges[0]!.deliveryAttempts).toBe(5);
  });
});
