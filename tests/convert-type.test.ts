import { beforeEach, describe, expect, it } from 'vitest';
import { convertedNode, convertNodeType } from '../src/document/convert';
import { createDocument, createEdge, createNode } from '../src/document/factory';
import { DEFAULTS } from '../src/document/limits';
import { addEdges, addNodes } from '../src/document/operations';
import { __resetInteraction, useEditorStore } from '../src/store/editorStore';

describe('convertedNode', () => {
  it('keeps the id, a typed name, details and room; resets kind and size around the centre', () => {
    const service = {
      ...createNode({ type: 'service', serviceKind: 'worker', text: 'Order events', x: 100, y: 100, technology: 'Node.js 22' }),
      attachments: [{ id: 'a1', type: 'note' as const, text: 'why' }],
    };
    const queue = convertedNode(service, 'queue');
    expect(queue.id).toBe(service.id);
    expect(queue.type).toBe('queue');
    expect(queue.text).toBe('Order events');
    expect(queue.serviceKind).toBeUndefined();
    expect(queue.queueKind).toBe('queue');
    expect(queue.technology).toBe('Node.js 22');
    expect(queue.attachments).toEqual(service.attachments);
    expect(queue.height).toBe(DEFAULTS.queueNamedHeight);
    expect(queue.x + queue.width / 2).toBeCloseTo(service.x + service.width / 2, 0);
    expect(queue.y + queue.height / 2).toBeCloseTo(service.y + service.height / 2, 0);
  });

  it('gives an automatic name the new shape\'s own', () => {
    const service = createNode({ type: 'service', x: 0, y: 0 });
    expect(service.textOrigin).toBe('auto');
    const actor = convertedNode(service, 'actor');
    expect(actor.text).toBe('User');
    expect(actor.actorKind).toBe('human');
    expect(actor.textOrigin).toBe('auto');
  });

  it('drops a dead-letter role on leaving Queue', () => {
    const dlq = createNode({ type: 'queue', deliveryRole: 'dead-letter', text: 'DLQ', x: 0, y: 0 });
    expect(convertedNode(dlq, 'service').deliveryRole).toBeUndefined();
  });

  it('leaves a document alone for a non-architecture shape or the same type', () => {
    const note = createNode({ type: 'note', x: 0, y: 0 });
    const service = createNode({ type: 'service', x: 0, y: 0 });
    const doc = addNodes(createDocument('C'), [note, service]);
    expect(convertNodeType(doc, note.id, 'queue')).toBe(doc);
    expect(convertNodeType(doc, service.id, 'service')).toBe(doc);
  });
});

describe('store: convertSelection', () => {
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

  it('turns a Service into a Queue in one step, re-inferring only inferred connectors', () => {
    const api = createNode({ type: 'service', serviceKind: 'api', x: 0, y: 0 });
    const middle = createNode({ type: 'service', text: 'Order events', x: 300, y: 0 });
    const billing = createNode({ type: 'service', x: 600, y: 0 });
    const inferred = createEdge({ source: api.id, target: middle.id, semantic: 'calls', semanticsOrigin: 'inferred' });
    const chosen = createEdge({ source: middle.id, target: billing.id, semantic: 'calls', semanticsOrigin: 'explicit' });
    store.setState({ document: addEdges(addNodes(createDocument('S'), [api, middle, billing]), [inferred, chosen]) });
    store.getState().setSelection({ nodes: [middle.id], edges: [] });
    store.getState().convertSelection('queue');

    const doc = store.getState().document;
    expect(doc.nodes.find((n) => n.id === middle.id)?.type).toBe('queue');
    expect(doc.edges.find((e) => e.id === inferred.id)?.semantic).toBe('command');
    expect(doc.edges.find((e) => e.id === chosen.id)?.semantic).toBe('calls');
    expect(store.getState().history.past.at(-1)?.label).toBe('Turn into Queue');
  });
});
