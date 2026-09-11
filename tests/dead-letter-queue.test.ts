import { beforeEach, describe, expect, it } from 'vitest';
import { createDocument } from '../src/document/factory';
import { queueTubeSpan } from '../src/document/queueGeometry';
import { routeEdge } from '../src/edges/routing';
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

  it('pins the sides only — routing itself lands the level connector on the tube glyph', () => {
    // A Queue's tube glyph sits in the upper portion of its box (the kind caption sits below it —
    // see nodes/describe.ts's queue()). The edge carries the plain midpoint offset; it is
    // `edges/routing.ts` that distributes left/right anchors over the tube band, so the same edge
    // stays correct if the node is later renamed (and grows) or resized.
    const queue = store.getState().addNode({ type: 'queue', x: 0, y: 0 });
    store.getState().addDeadLetterQueue(queue.id);
    const doc = store.getState().document;
    const dlq = doc.nodes.find((n) => n.deliveryRole === 'dead-letter')!;
    const edge = doc.edges[0]!;
    expect(edge.sourceAnchor).toEqual({ side: 'right', offset: 0.5 });
    expect(edge.targetAnchor).toEqual({ side: 'left', offset: 0.5 });
    const route = routeEdge(edge, new Map(doc.nodes.map((n) => [n.id, n])))!;
    const span = queueTubeSpan(queue.height);
    expect(route.source.y).toBeCloseTo(queue.y + (span.top + span.bottom) / 2, 5);
    expect(route.target.y).toBeCloseTo(dlq.y + (span.top + span.bottom) / 2, 5);
    expect(route.source.y).toBeLessThan(queue.y + queue.height / 2);
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

  it('pins the Queue side (routing lands it on the tube), and leaves the Worker side untouched', () => {
    const queue = store.getState().addNode({ type: 'queue', x: 0, y: 0 });
    store.getState().addConsumer(queue.id);
    const edge = store.getState().document.edges[0]!;
    expect(edge.sourceAnchor).toEqual({ side: 'right', offset: 0.5 });
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

describe('addDataStore() / addRoutedService() — the Service quick actions', () => {
  const store = useEditorStore;

  beforeEach(() => {
    __resetInteraction();
    store.setState({
      document: createDocument('Companions'),
      history: { past: [], future: [] },
      selection: { nodes: [], edges: [] },
      clipboard: null,
      revision: 0,
    });
  });

  it('connects a Service to a new Data Store with "writes", inferred, in one undo step', () => {
    const service = store.getState().addNode({ type: 'service', serviceKind: 'api', x: 0, y: 0 });
    const before = store.getState().history.past.length;
    store.getState().addDataStore(service.id);
    const doc = store.getState().document;
    const database = doc.nodes.find((n) => n.type === 'database')!;
    expect(database).toBeDefined();
    const edge = doc.edges[0]!;
    expect(edge.source).toBe(service.id);
    expect(edge.target).toBe(database.id);
    expect(edge.semantic).toBe('writes');
    expect(edge.semanticsOrigin).toBe('inferred');
    expect(store.getState().selection).toEqual({ nodes: [database.id], edges: [] });
    expect(store.getState().history.past.length).toBe(before + 1);
  });

  it('is a no-op for a kind that does not own data', () => {
    for (const serviceKind of ['external', 'scheduler', 'gateway'] as const) {
      const service = store.getState().addNode({ type: 'service', serviceKind, x: 0, y: 0 });
      store.getState().addDataStore(service.id);
    }
    expect(store.getState().document.nodes.filter((n) => n.type === 'database')).toHaveLength(0);
  });

  it('connects a Gateway to a new API service with "routes", and refuses for a non-gateway', () => {
    const gateway = store.getState().addNode({ type: 'service', serviceKind: 'gateway', x: 0, y: 0 });
    store.getState().addRoutedService(gateway.id);
    const doc = store.getState().document;
    const target = doc.nodes.find((n) => n.id !== gateway.id)!;
    expect(target.serviceKind).toBe('api');
    expect(doc.edges[0]!.semantic).toBe('routes');

    const plain = store.getState().addNode({ type: 'service', x: 0, y: 400 });
    const count = store.getState().document.nodes.length;
    store.getState().addRoutedService(plain.id);
    expect(store.getState().document.nodes.length).toBe(count);
  });
});
