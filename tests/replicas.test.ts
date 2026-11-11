import { beforeEach, describe, expect, it } from 'vitest';
import { createDocument, createEdge, createNode } from '../src/document/factory';
import { addNodes } from '../src/document/operations';
import { splitReplicaCount } from '../src/document/replicas';
import { normalizeDocument } from '../src/document/validate';
import { serializeDocument } from '../src/export/project';
import { describeContext, describeNode } from '../src/nodes/describe';
import { LIGHT } from '../src/render/theme/tokens';
import { __resetInteraction, useEditorStore } from '../src/store/editorStore';
import { analyzeTraffic } from '../src/traffic/analyze';

describe('splitReplicaCount', () => {
  it.each([
    ['Fulfilment ×3', 'Fulfilment', 3],
    ['Fulfilment×3', 'Fulfilment', 3],
    ['Fulfilment x3', 'Fulfilment', 3],
    ['Fulfilment X 12', 'Fulfilment', 12],
    ['Fulfilment ×1', 'Fulfilment', 1],
  ])('%s', (text, name, count) => {
    expect(splitReplicaCount(text)).toEqual({ name, count });
  });

  it.each(['Redux3', 'Box 2', 'Fulfilment', '×3', 'Fulfilment ×0'])('leaves %s alone', (text) => {
    expect(splitReplicaCount(text)).toBeNull();
  });
});

describe('replicas on a Service', () => {
  const store = useEditorStore;

  beforeEach(() => {
    __resetInteraction();
    store.setState({
      document: createDocument('Replicas'),
      history: { past: [], future: [] },
      selection: { nodes: [], edges: [] },
      clipboard: null,
      revision: 0,
    });
  });

  it('moves a typed ×3 into the count, and ×1 takes it off', () => {
    const worker = store.getState().addNode({ type: 'service', serviceKind: 'worker', x: 0, y: 0 });
    store.getState().updateNodeText(worker.id, 'Fulfilment ×3');
    let node = store.getState().document.nodes[0]!;
    expect(node.text).toBe('Fulfilment');
    expect(node.replicas).toBe(3);
    store.getState().updateNodeText(worker.id, 'Fulfilment ×1');
    node = store.getState().document.nodes[0]!;
    expect(node.text).toBe('Fulfilment');
    expect(node.replicas).toBeUndefined();
  });

  it('is only a name on other shapes', () => {
    const queue = store.getState().addNode({ type: 'queue', x: 0, y: 0 });
    store.getState().updateNodeText(queue.id, 'Orders ×3');
    expect(store.getState().document.nodes[0]!.text).toBe('Orders ×3');
    expect(store.getState().document.nodes[0]!.replicas).toBeUndefined();
  });

  it('survives a save and load, and is dropped from anything but a Service', () => {
    const service = { ...createNode({ type: 'service', text: 'API', x: 0, y: 0 }), replicas: 4 };
    const queue = { ...createNode({ type: 'queue', x: 0, y: 200 }), replicas: 4 };
    const result = normalizeDocument(JSON.parse(serializeDocument(addNodes(createDocument('R'), [service, queue]))));
    if (!result.ok) throw new Error(result.error);
    const loaded = result.document;
    expect(loaded.nodes.find((n) => n.id === service.id)?.replicas).toBe(4);
    expect(loaded.nodes.find((n) => n.id === queue.id)?.replicas).toBeUndefined();
  });

  it('draws a card behind and a ×N mark, in the display list export shares', () => {
    const ctx = describeContext(LIGHT);
    const one = createNode({ type: 'service', text: 'API', x: 0, y: 0, width: 200, height: 90 });
    const three = { ...one, replicas: 3 };
    const texts = (list: ReturnType<typeof describeNode>) =>
      JSON.stringify(list).match(/"lines":\[[^\]]*\]/g)?.join(' ') ?? '';
    expect(texts(describeNode(three, ctx))).toContain('×3');
    expect(texts(describeNode(one, ctx))).not.toContain('×3');
    expect(JSON.stringify(describeNode(three, ctx)).length).toBeGreaterThan(JSON.stringify(describeNode(one, ctx)).length);
  });
});

describe('Traffic reads replicas', () => {
  it('several instances of one consumer compete for a queue', () => {
    const producer = createNode({ type: 'service', text: 'Orders', x: 0, y: 0 });
    const queue = createNode({ type: 'queue', text: 'orders', x: 0, y: 0 });
    const worker = { ...createNode({ type: 'service', serviceKind: 'worker', text: 'Fulfilment', x: 0, y: 0 }), replicas: 3 };
    const result = analyzeTraffic({
      nodes: [producer, queue, worker],
      edges: [
        createEdge({ source: producer.id, target: queue.id, semantic: 'publishes' }),
        createEdge({ source: queue.id, target: worker.id, semantic: 'consumes' }),
      ],
    });
    const competing = result.insights.find((insight) => insight.kind === 'competing-consumers');
    expect(competing?.text).toContain('3 instances of Fulfilment');
    expect(competing?.text).toContain('a third');
  });
});
