import { beforeEach, describe, expect, it } from 'vitest';
import { createAttachment, createDocument } from '../src/document/factory';
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

describe('arrangeSelection', () => {
  beforeEach(reset);
  it('keeps unselected shapes and nearby notes fixed, and undoes once', async () => {
    const editor = useEditorStore.getState();
    const a = editor.addNode({ type: 'service', x: 100, y: 100 });
    const b = editor.addNode({ type: 'database', x: 100, y: 100 });
    const fixed = editor.addNode({ type: 'service', x: 1600, y: 100 });
    const note = editor.addNode({ type: 'note', x: 100, y: 250, text: 'Stay here' });
    editor.connect(a.id, b.id);
    editor.setSelection({ nodes: [a.id, b.id, note.id], edges: [] });
    const before = useEditorStore.getState();
    await editor.arrangeSelection();
    const after = useEditorStore.getState();
    expect(after.document.nodes.find((node) => node.id === fixed.id)).toBe(before.document.nodes.find((node) => node.id === fixed.id));
    expect(after.document.nodes.find((node) => node.id === note.id)).toBe(before.document.nodes.find((node) => node.id === note.id));
    expect(after.history.past.length).toBe(before.history.past.length + 1);
    after.undo();
    expect(useEditorStore.getState().document.nodes).toEqual(before.document.nodes);
  });
  it('rejects a selection changed while the engine loads', async () => {
    const editor = useEditorStore.getState();
    const node = editor.addNode({ type: 'service', x: 0, y: 0 });
    editor.setSelection({ nodes: [node.id], edges: [] });
    const pending = editor.arrangeSelection();
    editor.setSelection({ nodes: [], edges: [] });
    expect(await pending).toBe(false);
  });
});


it('arranges boundary members without shrinking their container or losing explanation metadata', async () => {
  reset();
  const editor = useEditorStore.getState();
  const a = editor.addNode({ type: 'service', x: 100, y: 100, text: 'API' });
  const b = editor.addNode({ type: 'queue', x: 100, y: 100, text: 'Orders' });
  const edge = editor.connect(a.id, b.id)!;
  editor.attachToNode(a.id, createAttachment({ type: 'note', text: 'Keep this context' }));
  const flow = editor.createFlow('Order')!;
  editor.addEdgeToFlow(flow, edge.id);
  editor.addOpenPoint('tentative', [{ kind: 'node', id: a.id }], 'Who owns this?');
  editor.setSelection({ nodes: [a.id, b.id], edges: [] });
  editor.groupSelection();
  const group = useEditorStore.getState().document.nodes.find(node => node.type === 'group')!;
  editor.setSelection({ nodes: [a.id, b.id], edges: [] });
  const before = useEditorStore.getState().document;
  expect(await editor.arrangeSelection()).toBe(true);
  const after = useEditorStore.getState().document;
  expect(after.flows).toEqual(before.flows);
  expect(after.openPoints).toHaveLength(1);
  expect(after.openPoints).toEqual(before.openPoints);
  expect(after.nodes.find(node => node.id === a.id)!.attachments).toEqual(before.nodes.find(node => node.id === a.id)!.attachments);
  expect(after.nodes.filter(node => node.parentId === group.id).map(node => node.id)).toEqual([a.id, b.id]);
  const grown = after.nodes.find(node => node.id === group.id)!;
  expect(grown.width).toBeGreaterThanOrEqual(group.width);
  expect(grown.height).toBeGreaterThanOrEqual(group.height);
  expect(after.edges[0]!.semantic).toBe(before.edges[0]!.semantic);
  editor.undo();
  expect(useEditorStore.getState().document.nodes).toEqual(before.nodes);
});
