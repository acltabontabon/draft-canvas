import { beforeEach, describe, expect, it } from 'vitest';
import { createDocument, createNode } from '../src/document/factory';
import { normalizeDocument } from '../src/document/validate';
import type { DraftNode } from '../src/document/types';
import { __resetInteraction, useEditorStore } from '../src/store/editorStore';

/**
 * Store actions whose result has to stay consistent with what the canvas shows.
 *
 * A node drawn inside a boundary is a member of it — it moves with it and goes when it's deleted —
 * and every in-app way of adding one next to an existing member has to agree with that, not just
 * Intent Continuation. Alongside: selections that never name removed elements, no-op playback
 * writes, and whole-pixel sizes on load.
 */
const store = useEditorStore;

function withBoundary(...members: Omit<Parameters<typeof createNode>[0], 'parentId'>[]) {
  const boundary = createNode({ type: 'group', x: 0, y: 0, width: 1600, height: 900, text: 'VPC' });
  const nodes: DraftNode[] = members.map((input) => createNode({ ...input, parentId: boundary.id }));
  store.setState({
    document: { ...createDocument('Boundaries'), nodes: [boundary, ...nodes] },
    path: [],
    outer: null,
    liveViewport: null,
    history: { past: [], future: [] },
    selection: { nodes: [], edges: [] },
    clipboard: null,
    revision: 0,
  });
  return { boundary, nodes };
}

function added(before: readonly DraftNode[]): DraftNode[] {
  const ids = new Set(before.map((n) => n.id));
  return store.getState().document.nodes.filter((n) => !ids.has(n.id));
}

describe('nodes added inside a boundary join it', () => {
  beforeEach(() => __resetInteraction());

  it('Add DLQ on a queue inside a boundary', () => {
    const { boundary, nodes } = withBoundary({ type: 'queue', x: 200, y: 200 });
    const before = store.getState().document.nodes;
    store.getState().addDeadLetterQueue(nodes[0]!.id);
    const [dlq] = added(before);
    expect(dlq?.parentId).toBe(boundary.id);
  });

  it('Add consumer on a queue inside a boundary', () => {
    const { boundary, nodes } = withBoundary({ type: 'queue', x: 200, y: 200 });
    const before = store.getState().document.nodes;
    store.getState().addConsumer(nodes[0]!.id);
    const [consumer] = added(before);
    expect(consumer?.parentId).toBe(boundary.id);
  });

  it('Insert worker between two members', () => {
    const { boundary, nodes } = withBoundary({ type: 'queue', x: 200, y: 200 }, { type: 'database', x: 900, y: 200 });
    const edge = store.getState().connect(nodes[0]!.id, nodes[1]!.id)!;
    const before = store.getState().document.nodes;
    store.getState().insertWorkerOnEdge(edge.id);
    const [worker] = added(before);
    expect(worker?.parentId).toBe(boundary.id);
  });

  it('Duplicate of a member that still fits inside its boundary', () => {
    const { boundary, nodes } = withBoundary({ type: 'service', x: 200, y: 200 });
    store.getState().setSelection({ nodes: [nodes[0]!.id], edges: [] });
    const before = store.getState().document.nodes;
    store.getState().duplicateSelection();
    const [copy] = added(before);
    expect(copy?.parentId).toBe(boundary.id);
  });

  it("…but a companion that doesn't fit inside stays outside, un-parented", () => {
    // Right at the boundary's edge: the only free spots are outside it.
    const { nodes } = withBoundary({ type: 'service', x: 1600 - 176, y: 900 - 64, width: 176, height: 64 });
    store.getState().setSelection({ nodes: [nodes[0]!.id], edges: [] });
    const before = store.getState().document.nodes;
    store.getState().duplicateSelection();
    const [copy] = added(before);
    expect(copy?.parentId).toBeUndefined();
  });
});

describe('ungroup', () => {
  it('never selects a nested boundary it removed in the same pass', () => {
    const outer = createNode({ type: 'group', x: 0, y: 0, width: 800, height: 600 });
    const inner = createNode({ type: 'group', x: 40, y: 40, width: 400, height: 300, parentId: outer.id });
    const leaf = createNode({ type: 'service', x: 80, y: 80, parentId: inner.id });
    store.setState({
      document: { ...createDocument('Nested'), nodes: [outer, inner, leaf] },
      history: { past: [], future: [] },
      selection: { nodes: [outer.id, inner.id], edges: [] },
      revision: 0,
    });
    store.getState().ungroupSelection();
    const { document, selection } = store.getState();
    expect(document.nodes.map((n) => n.id)).toEqual([leaf.id]);
    expect(selection.nodes).toEqual([leaf.id]);
    expect(store.getState().history.past.at(-1)!.selectionAfter.nodes).toEqual([leaf.id]);
  });
});

describe('setFlowPlayback', () => {
  it('a write that changes nothing keeps the store state as it is', () => {
    store.setState({ flowPlayback: { active: false, flowId: null, step: 0, phase: 'request' } });
    const before = store.getState();
    store.getState().setFlowPlayback({ phase: 'request' });
    expect(store.getState()).toBe(before);

    store.getState().setFlowPlayback({ step: 1 });
    expect(store.getState().flowPlayback).toEqual({ active: false, flowId: null, step: 1, phase: 'request' });
  });

  it('starting playback still exits Focus', () => {
    store.setState({
      flowPlayback: { active: true, flowId: 'f', step: 0 },
      focus: { active: true, nodeIds: ['n'], edgeIds: [] },
    });
    store.getState().setFlowPlayback({ active: true });
    expect(store.getState().focus.active).toBe(false);
  });
});

describe('normalizeDocument', () => {
  it('rounds fractional node sizes to whole pixels, like every size the editor writes', () => {
    const doc = createDocument('Fractional');
    const node = createNode({ type: 'service', x: 0, y: 0 });
    const result = normalizeDocument({ ...doc, nodes: [{ ...node, width: 176.5, height: 64.4 }] });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.document.nodes[0]).toMatchObject({ width: 177, height: 64 });
  });
});
