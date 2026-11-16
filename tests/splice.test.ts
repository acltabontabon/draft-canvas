import { beforeEach, describe, expect, it } from 'vitest';
import { createDocument, createEdge, createNode, type CreateNodeInput } from '../src/document/factory';
import { createFlow } from '../src/document/flow';
import { addEdges, addNodes } from '../src/document/operations';
import { bridgeProblems, canSpliceInto, removeAndBridge, spliceNodeIntoEdge } from '../src/document/splice';
import type { DraftDocument, DraftEdge, DraftNode } from '../src/document/types';
import { __resetInteraction, useEditorStore } from '../src/store/editorStore';

function node(input: CreateNodeInput): DraftNode {
  return createNode(input);
}

function graph(nodes: DraftNode[], edges: DraftEdge[]): DraftDocument {
  return addEdges(addNodes(createDocument('Splice'), nodes), edges);
}

function edgeBetween(doc: DraftDocument, source: string, target: string) {
  return doc.edges.find((e) => e.source === source && e.target === target);
}

describe('spliceNodeIntoEdge', () => {
  const api = node({ type: 'service', serviceKind: 'api', text: 'Orders API', x: 0, y: 0 });
  const billing = node({ type: 'service', text: 'Billing', x: 600, y: 0 });
  const queue = node({ type: 'queue', text: 'orders', x: 300, y: 0 });

  it('puts a Queue between two services, asynchronous on both legs', () => {
    const edge = createEdge({ source: api.id, target: billing.id, label: 'places order' });
    const doc = graph([api, billing, queue], [edge]);
    const { doc: next, legs } = spliceNodeIntoEdge(doc, edge.id, queue.id);

    expect(legs).not.toBeNull();
    expect(next.edges.some((e) => e.id === edge.id)).toBe(false);
    const into = edgeBetween(next, api.id, queue.id)!;
    const out = edgeBetween(next, queue.id, billing.id)!;
    expect(into.label).toBe('places order');
    expect(out.label).toBeUndefined();
    expect(into.semantic).toBe('command');
    expect(into.async).toBe(true);
    expect(out.semantic).toBe('consumes');
    expect(out.async).toBe(true);
    expect(into.semanticsOrigin).toBe('inferred');
  });

  it('keeps the flow beat by telling both legs', () => {
    const edge = createEdge({ source: api.id, target: billing.id });
    const flow = createFlow({ title: 'Checkout' });
    flow.steps = [{ id: 'fs1', edgeId: edge.id, caption: 'pay' }];
    const doc = { ...graph([api, billing, queue], [edge]), flows: [flow] };
    const { doc: next, legs } = spliceNodeIntoEdge(doc, edge.id, queue.id);

    expect(next.flows[0]!.steps.map((s) => s.edgeId)).toEqual(legs);
    expect(next.flows[0]!.steps[0]!.caption).toBe('pay');
  });

  it('refuses shapes that never stand in a line, and either end of the connector', () => {
    const actor = node({ type: 'actor', x: 300, y: 0 });
    const edge = createEdge({ source: api.id, target: billing.id });
    const doc = graph([api, billing, actor], [edge]);
    expect(canSpliceInto(doc, edge.id, actor.id)).toBe(false);
    expect(canSpliceInto(doc, edge.id, api.id)).toBe(false);
    expect(spliceNodeIntoEdge(doc, edge.id, actor.id).doc).toBe(doc);
  });

  it('refuses a shape already wired to one end', () => {
    const edge = createEdge({ source: api.id, target: billing.id });
    const existing = createEdge({ source: api.id, target: queue.id });
    const doc = graph([api, billing, queue], [edge, existing]);
    expect(canSpliceInto(doc, edge.id, queue.id)).toBe(false);
  });

  it('infers each leg through a Junction', () => {
    const junction = node({ type: 'ellipse', x: 300, y: 0 });
    const store = node({ type: 'database', x: 600, y: 0 });
    const edge = createEdge({ source: api.id, target: store.id });
    const { doc: next } = spliceNodeIntoEdge(graph([api, store, junction], [edge]), edge.id, junction.id);
    const into = edgeBetween(next, api.id, junction.id)!;
    expect(into.semantic).toBeDefined();
  });
});

describe('removeAndBridge', () => {
  const client = node({ type: 'actor', text: 'Client', x: 0, y: 0 });
  const gateway = node({ type: 'service', serviceKind: 'gateway', text: 'Gateway', x: 300, y: 0 });
  const api = node({ type: 'service', serviceKind: 'api', text: 'API', x: 600, y: 0 });
  const other = node({ type: 'service', text: 'Other', x: 600, y: 200 });

  it('joins Client → Gateway → API into Client → API, keeping the flow', () => {
    const a = createEdge({ source: client.id, target: gateway.id, label: 'requests' });
    const b = createEdge({ source: gateway.id, target: api.id, label: 'routes' });
    const flow = createFlow({ title: 'Request' });
    flow.steps = [
      { id: 's1', edgeId: a.id, caption: 'Client asks.' },
      { id: 's2', edgeId: b.id, caption: 'Gateway routes.' },
    ];
    const doc = { ...graph([client, gateway, api], [a, b]), flows: [flow] };
    const result = removeAndBridge(doc, [gateway.id])!;

    expect(result.joined).toBe(1);
    expect(result.doc.nodes.some((n) => n.id === gateway.id)).toBe(false);
    const joined = edgeBetween(result.doc, client.id, api.id)!;
    expect(joined.label).toBe('requests');
    expect(result.doc.edges).toHaveLength(1);
    const steps = result.doc.flows[0]!.steps;
    expect(steps).toHaveLength(1);
    expect(steps[0]!.edgeId).toBe(joined.id);
    expect(steps[0]!.caption).toBe('Client asks. Gateway routes.');
  });

  it('joins one way in to every way out', () => {
    const a = createEdge({ source: client.id, target: gateway.id });
    const b = createEdge({ source: gateway.id, target: api.id });
    const c = createEdge({ source: gateway.id, target: other.id });
    const result = removeAndBridge(graph([client, gateway, api, other], [a, b, c]), [gateway.id])!;
    expect(result.joined).toBe(2);
    expect(edgeBetween(result.doc, client.id, api.id)).toBeDefined();
    expect(edgeBetween(result.doc, client.id, other.id)).toBeDefined();
  });

  it('refuses a shape with several ways in and several out', () => {
    const second = node({ type: 'actor', x: 0, y: 200 });
    const edges = [
      createEdge({ source: client.id, target: gateway.id }),
      createEdge({ source: second.id, target: gateway.id }),
      createEdge({ source: gateway.id, target: api.id }),
      createEdge({ source: gateway.id, target: other.id }),
    ];
    const doc = graph([client, second, gateway, api, other], edges);
    expect(bridgeProblems(doc, [gateway.id])).toEqual([gateway.id]);
    expect(removeAndBridge(doc, [gateway.id])).toBeNull();
  });

  it('joins through a chain of selected shapes', () => {
    const second = node({ type: 'service', text: 'Auth', x: 450, y: 0 });
    const edges = [
      createEdge({ source: client.id, target: gateway.id }),
      createEdge({ source: gateway.id, target: second.id }),
      createEdge({ source: second.id, target: api.id }),
    ];
    const result = removeAndBridge(graph([client, gateway, second, api], edges), [gateway.id, second.id])!;
    expect(result.doc.edges).toHaveLength(1);
    expect(edgeBetween(result.doc, client.id, api.id)).toBeDefined();
  });

  it('does not connect a pair twice', () => {
    const edges = [
      createEdge({ source: client.id, target: gateway.id }),
      createEdge({ source: gateway.id, target: api.id }),
      createEdge({ source: client.id, target: api.id }),
    ];
    const result = removeAndBridge(graph([client, gateway, api], edges), [gateway.id])!;
    expect(result.joined).toBe(0);
    expect(result.doc.edges).toHaveLength(1);
  });

  it('simply deletes a shape with nothing to join', () => {
    const edges = [createEdge({ source: client.id, target: gateway.id })];
    const result = removeAndBridge(graph([client, gateway], edges), [gateway.id])!;
    expect(result.joined).toBe(0);
    expect(result.doc.edges).toHaveLength(0);
  });
});

describe('store: splice and delete-keeping-lines', () => {
  const store = useEditorStore;

  beforeEach(() => {
    __resetInteraction();
    store.setState({
      document: createDocument('Store'),
      history: { past: [], future: [] },
      selection: { nodes: [], edges: [] },
      clipboard: null,
      revision: 0,
    });
  });

  it('splices in one undo step', () => {
    const a = store.getState().addNode({ type: 'service', x: 0, y: 0 });
    const b = store.getState().addNode({ type: 'service', x: 600, y: 0 });
    const q = store.getState().addNode({ type: 'queue', x: 300, y: 0 });
    const edge = store.getState().connect(a.id, b.id)!;
    const before = store.getState().history.past.length;
    expect(store.getState().spliceIntoEdge(q.id, edge.id)).toBe(true);
    expect(store.getState().history.past.length).toBe(before + 1);
    expect(store.getState().document.edges).toHaveLength(2);
    store.getState().undo();
    expect(store.getState().document.edges.map((e) => e.id)).toEqual([edge.id]);
  });

  it('⌥⌫ joins the line, and refuses a many-to-many shape without deleting it', () => {
    const a = store.getState().addNode({ type: 'service', x: 0, y: 0 });
    const g = store.getState().addNode({ type: 'service', serviceKind: 'gateway', x: 300, y: 0 });
    const b = store.getState().addNode({ type: 'service', x: 600, y: 0 });
    store.getState().connect(a.id, g.id);
    store.getState().connect(g.id, b.id);
    store.getState().setSelection({ nodes: [g.id], edges: [] });
    store.getState().deleteSelectionKeepingLines();
    const doc = store.getState().document;
    expect(doc.nodes.some((n) => n.id === g.id)).toBe(false);
    expect(edgeBetween(doc, a.id, b.id)).toBeDefined();
  });
});

describe('store: connectMany (fan-in)', () => {
  const store = useEditorStore;

  beforeEach(() => {
    __resetInteraction();
    store.setState({
      document: createDocument('Fan-in'),
      history: { past: [], future: [] },
      selection: { nodes: [], edges: [] },
      clipboard: null,
      revision: 0,
    });
  });

  it('connects every source to the target in one step, skipping pairs already joined', () => {
    const a = store.getState().addNode({ type: 'service', x: 0, y: 0 });
    const b = store.getState().addNode({ type: 'service', x: 0, y: 200 });
    const c = store.getState().addNode({ type: 'service', x: 0, y: 400 });
    const db = store.getState().addNode({ type: 'database', x: 400, y: 200 });
    store.getState().connect(c.id, db.id);
    const before = store.getState().history.past.length;
    const edges = store.getState().connectMany([a.id, b.id, c.id, db.id], db.id);
    expect(edges.map((e) => e.source)).toEqual([a.id, b.id]);
    expect(edges.every((e) => e.semantic !== undefined && e.semanticsOrigin === 'inferred')).toBe(true);
    expect(store.getState().history.past.length).toBe(before + 1);
    expect(store.getState().selection.edges).toEqual(edges.map((e) => e.id));
    expect(store.getState().document.edges).toHaveLength(3);
  });
});
