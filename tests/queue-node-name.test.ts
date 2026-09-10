import { beforeEach, describe, expect, it } from 'vitest';
import { createDocument, createNode } from '../src/document/factory';
import { DEFAULTS } from '../src/document/limits';
import { describeContext, describeNode } from '../src/nodes/describe';
import { LIGHT } from '../src/render/theme/tokens';
import type { TextShape } from '../src/render/displayList';
import { __resetInteraction, useEditorStore } from '../src/store/editorStore';

const clean = describeContext(LIGHT, 'clean');

function textShapes(node: ReturnType<typeof createNode>): TextShape[] {
  return describeNode(node, clean).shapes.filter((s): s is TextShape => s.t === 'text');
}

/** The bottom edge of the lowest text line a node draws, in its own coordinates. */
function textBottom(node: ReturnType<typeof createNode>): number {
  return Math.max(...textShapes(node).map((s) => s.y + s.layout.height));
}

describe('a queue-family node may carry an optional name', () => {
  it('still starts out unnamed, at the compact caption-only box', () => {
    for (const queueKind of ['queue', 'topic', 'stream'] as const) {
      const node = createNode({ type: 'queue', queueKind, x: 0, y: 0 });
      expect(node.text).toBe('');
      expect(node.height).toBe(DEFAULTS.queueHeight);
      expect(textShapes(node)).toHaveLength(1);
    }
  });

  it('created with a name, takes the taller box and draws the name above its kind caption', () => {
    const topic = createNode({ type: 'queue', queueKind: 'topic', text: 'Domain Events', x: 0, y: 0 });
    expect(topic.height).toBe(DEFAULTS.queueNamedHeight);
    const lines = textShapes(topic).flatMap((s) => s.layout.lines.map((l) => l.text));
    expect(lines).toEqual(['Domain Events', 'TOPIC']);
    // Both lines sit inside the box — the whole point of the taller default.
    expect(textBottom(topic)).toBeLessThanOrEqual(topic.height);
    // And the compact box genuinely could not have held them.
    const cramped = createNode({ type: 'queue', queueKind: 'topic', text: 'Domain Events', x: 0, y: 0, height: DEFAULTS.queueHeight });
    expect(textBottom(cramped)).toBeGreaterThan(cramped.height);
  });

  it('a whitespace-only name is no name: compact box, caption only', () => {
    const node = createNode({ type: 'queue', text: '   ', x: 0, y: 0 });
    expect(node.height).toBe(DEFAULTS.queueHeight);
    expect(textShapes(node)).toHaveLength(1);
  });

  it('respects an explicit height over either default', () => {
    expect(createNode({ type: 'queue', text: 'Orders', x: 0, y: 0, height: 96 }).height).toBe(96);
  });

  it('a DLQ keeps its DLQ caption under whatever name it is given', () => {
    const dlq = createNode({ type: 'queue', deliveryRole: 'dead-letter', text: 'Integration DLQ', x: 0, y: 0 });
    const lines = textShapes(dlq).flatMap((s) => s.layout.lines.map((l) => l.text));
    expect(lines).toEqual(['Integration DLQ', 'DLQ']);
    expect(dlq.height).toBe(DEFAULTS.queueNamedHeight);
  });
});

describe('naming a queue on the canvas resizes it between the two defaults', () => {
  beforeEach(() => {
    __resetInteraction();
    useEditorStore.setState({
      document: createDocument('Queue names'),
      history: { past: [], future: [] },
      selection: { nodes: [], edges: [] },
    });
  });

  const state = () => useEditorStore.getState();
  const nodeById = (id: string) => state().document.nodes.find((n) => n.id === id)!;

  it('grows to the named box as a name is typed, and shrinks back when it is cleared', () => {
    const queue = state().addNode({ type: 'queue', x: 0, y: 0 });
    expect(queue.height).toBe(DEFAULTS.queueHeight);

    state().updateNodeText(queue.id, 'Orders');
    expect(nodeById(queue.id).text).toBe('Orders');
    expect(nodeById(queue.id).height).toBe(DEFAULTS.queueNamedHeight);

    state().updateNodeText(queue.id, 'Orders queue');
    expect(nodeById(queue.id).height).toBe(DEFAULTS.queueNamedHeight);

    state().updateNodeText(queue.id, '');
    expect(nodeById(queue.id).height).toBe(DEFAULTS.queueHeight);
  });

  it('never touches a box the user sized by hand', () => {
    const tall = state().addNode({ type: 'queue', x: 0, y: 0, height: 120 });
    state().updateNodeText(tall.id, 'Orders');
    expect(nodeById(tall.id).height).toBe(120);
    state().updateNodeText(tall.id, '');
    expect(nodeById(tall.id).height).toBe(120);
  });

  it('leaves every other node type alone', () => {
    const service = state().addNode({ type: 'service', x: 0, y: 0 });
    const before = nodeById(service.id).height;
    state().updateNodeText(service.id, 'Orders');
    expect(nodeById(service.id).height).toBe(before);
  });
});
