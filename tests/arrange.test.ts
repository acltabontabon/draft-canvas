import { beforeEach, describe, expect, it } from 'vitest';
import { createDocument } from '../src/document/factory';
import { __resetInteraction, useEditorStore } from '../src/store/editorStore';

/**
 * "Arrange diagram": the room laid out again by the agent's engine, as one undo step that keeps
 * every id, connector, flow and the selection — only positions change.
 */

function reset() {
  __resetInteraction();
  useEditorStore.setState({
    document: createDocument('Arrange'),
    history: { past: [], future: [] },
    selection: { nodes: [], edges: [] },
    clipboard: null,
    revision: 0,
    mode: 'edit',
    selectedFlowId: null,
    path: [],
    outer: null,
  });
}

const positionsOf = () => Object.fromEntries(useEditorStore.getState().document.nodes.map((node) => [node.id, { x: node.x, y: node.y }]));

describe('arrangeRoom', () => {
  beforeEach(reset);

  it('moves overlapping shapes apart, keeps ids, connectors, flows and the selection, and undoes in one step', async () => {
    const state = useEditorStore.getState();
    // Three shapes stacked on the same spot: nothing can be read until they are laid out.
    const api = state.addNode({ type: 'service', x: 100, y: 100, text: 'Orders API' });
    const db = state.addNode({ type: 'database', x: 100, y: 100, text: 'Orders DB' });
    const queue = state.addNode({ type: 'queue', x: 100, y: 100, text: 'Orders' });
    const first = state.connect(api.id, db.id)!;
    const second = state.connect(api.id, queue.id)!;
    useEditorStore.getState().createFlow('Place order');
    useEditorStore.getState().setSelection({ nodes: [api.id], edges: [] });
    const before = positionsOf();
    const stepsBefore = useEditorStore.getState().history.past.length;

    const moved = await useEditorStore.getState().arrangeRoom();
    expect(moved).toBe(true);

    const after = useEditorStore.getState();
    const nodes = after.document.nodes;
    expect(nodes.map((node) => node.id).sort()).toEqual([api.id, db.id, queue.id].sort());
    expect(after.document.edges.map((edge) => edge.id).sort()).toEqual([first.id, second.id].sort());
    expect(after.document.flows.map((flow) => flow.title)).toEqual(['Place order']);
    expect(after.selection).toEqual({ nodes: [api.id], edges: [] });
    // No two shapes share a spot any more.
    const spots = new Set(nodes.map((node) => `${node.x},${node.y}`));
    expect(spots.size).toBe(3);
    expect(positionsOf()).not.toEqual(before);

    // Exactly one entry, labelled, and undoing it puts every position back.
    expect(after.history.past.length).toBe(stepsBefore + 1);
    expect(after.history.past.at(-1)!.label).toBe('Arrange');
    after.undo();
    expect(positionsOf()).toEqual(before);
  });

  it('does nothing — and records nothing — for a room with nothing to lay out', async () => {
    const state = useEditorStore.getState();
    state.addNode({ type: 'note', x: 0, y: 0, text: 'Just a note' });
    const steps = useEditorStore.getState().history.past.length;
    expect(await useEditorStore.getState().arrangeRoom()).toBe(false);
    expect(useEditorStore.getState().history.past.length).toBe(steps);
  });
});
