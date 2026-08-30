import { beforeEach, describe, expect, it } from 'vitest';
import { createDocument, createEdge } from '../src/document/factory';
import { explainEdgeTier, explainNodeTier, orderedEdges, sequenceSteps } from '../src/document/sequence';
import { __resetInteraction, useEditorStore } from '../src/store/editorStore';

const store = useEditorStore;

function chain(length: number) {
  __resetInteraction();
  store.setState({
    document: createDocument('Sequence'),
    history: { past: [], future: [] },
    selection: { nodes: [], edges: [] },
    revision: 0,
  });

  const nodes = Array.from({ length: length + 1 }, (_, index) =>
    store.getState().addNode({ type: 'service', x: index * 240, y: 0, text: `N${index}` }),
  );
  const edges = nodes.slice(0, -1).map((node, index) =>
    store.getState().connect(node.id, nodes[index + 1]!.id)!,
  );
  return { nodes, edges };
}

describe('ordered interactions', () => {
  beforeEach(() => chain(0));

  it('numbers connections in the order they are added to the walkthrough', () => {
    const { edges } = chain(3);
    for (const edge of edges) store.getState().toggleEdgeSequence(edge.id);

    expect(orderedEdges(store.getState().document).map((e) => e.sequence)).toEqual([1, 2, 3]);
  });

  it('leaves no gaps when a numbered connection is deleted', () => {
    const { edges } = chain(4);
    for (const edge of edges) store.getState().toggleEdgeSequence(edge.id);

    store.getState().setSelection({ nodes: [], edges: [edges[1]!.id] });
    store.getState().deleteSelection();

    const steps = sequenceSteps(store.getState().document);
    expect(steps.map((step) => step.sequence)).toEqual([1, 2, 3]);
    // The connections that remain keep their relative order.
    expect(steps.map((step) => step.edge.id)).toEqual([edges[0]!.id, edges[2]!.id, edges[3]!.id]);
  });

  it('renumbers when a node at the end of a step is deleted', () => {
    const { nodes, edges } = chain(3);
    for (const edge of edges) store.getState().toggleEdgeSequence(edge.id);

    store.getState().setSelection({ nodes: [nodes[1]!.id], edges: [] });
    store.getState().deleteSelection();

    const steps = sequenceSteps(store.getState().document);
    expect(steps.map((step) => step.sequence)).toEqual([1]);
  });

  it('reorders steps by moving one earlier or later', () => {
    const { edges } = chain(3);
    for (const edge of edges) store.getState().toggleEdgeSequence(edge.id);

    store.getState().moveEdgeInSequence(edges[2]!.id, -1);
    expect(sequenceSteps(store.getState().document).map((s) => s.edge.id)).toEqual([
      edges[0]!.id,
      edges[2]!.id,
      edges[1]!.id,
    ]);

    store.getState().moveEdgeInSequence(edges[2]!.id, 1);
    expect(sequenceSteps(store.getState().document).map((s) => s.edge.id)).toEqual([
      edges[0]!.id,
      edges[1]!.id,
      edges[2]!.id,
    ]);
  });

  it('will not move a step past either end', () => {
    const { edges } = chain(2);
    for (const edge of edges) store.getState().toggleEdgeSequence(edge.id);
    const before = store.getState().document;

    store.getState().moveEdgeInSequence(edges[0]!.id, -1);
    store.getState().moveEdgeInSequence(edges[1]!.id, 1);
    expect(store.getState().document.edges).toEqual(before.edges);
  });

  it('toggles a connection out of the walkthrough and renumbers the rest', () => {
    const { edges } = chain(3);
    for (const edge of edges) store.getState().toggleEdgeSequence(edge.id);

    store.getState().toggleEdgeSequence(edges[0]!.id);
    const doc = store.getState().document;
    expect(doc.edges.find((e) => e.id === edges[0]!.id)!.sequence).toBeUndefined();
    expect(orderedEdges(doc).map((e) => e.sequence)).toEqual([1, 2]);
  });

  it('numbers every connection at once, and clears them all', () => {
    const { edges } = chain(4);
    store.getState().numberAllEdges();
    expect(orderedEdges(store.getState().document)).toHaveLength(edges.length);

    store.getState().clearAllSequence();
    expect(orderedEdges(store.getState().document)).toHaveLength(0);
  });

  it('supports undoing a sequence change', () => {
    const { edges } = chain(2);
    store.getState().toggleEdgeSequence(edges[0]!.id);
    expect(orderedEdges(store.getState().document)).toHaveLength(1);

    store.getState().undo();
    expect(orderedEdges(store.getState().document)).toHaveLength(0);
  });
});

describe('explain mode tri-state dimming', () => {
  it('classifies an edge as active, shown, or hidden relative to the current step', () => {
    expect(explainEdgeTier(3, 3)).toBe('active');
    expect(explainEdgeTier(1, 3)).toBe('shown');
    expect(explainEdgeTier(5, 3)).toBe('hidden');
    // Not part of the walkthrough at all.
    expect(explainEdgeTier(undefined, 3)).toBe('hidden');
  });

  it('gives a node the most-lit tier among the edges touching it', () => {
    const a = createEdge({ source: 'x', target: 'shared', sequence: 1 });
    const b = createEdge({ source: 'shared', target: 'y', sequence: 4 });
    const edges = [a, b];

    // At step 3 of 5: step 1 is already shown, step 4 is not reached yet.
    expect(explainNodeTier(edges, 'shared', 3)).toBe('shown');
    expect(explainNodeTier(edges, 'x', 3)).toBe('shown');
    expect(explainNodeTier(edges, 'y', 3)).toBe('hidden');

    // At the active step itself, the endpoint tier is active even though the
    // same node also touches an already-shown step.
    expect(explainNodeTier(edges, 'shared', 4)).toBe('active');

    // A node touching nothing in the walkthrough is hidden.
    expect(explainNodeTier(edges, 'unrelated', 3)).toBe('hidden');
  });
});
