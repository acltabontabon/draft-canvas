import { beforeEach, describe, expect, it } from 'vitest';
import { createDocument } from '../src/document/factory';
import { isEdgeFocused, __resetInteraction, useEditorStore } from '../src/store/editorStore';

const store = useEditorStore;

function reset() {
  __resetInteraction();
  store.setState({
    document: createDocument('Focus'),
    history: { past: [], future: [] },
    selection: { nodes: [], edges: [] },
    clipboard: null,
    revision: 0,
    flowPlayback: { active: false, flowId: null, step: 0 },
    focus: { active: false, nodeIds: [], edgeIds: [] },
    selectedFlowId: null,
  });
}

describe('focus mode', () => {
  beforeEach(reset);

  it('enters and exits, and never touches history', () => {
    const before = store.getState().history.past.length;
    store.getState().enterFocus(['a', 'b'], []);
    expect(store.getState().focus).toEqual({ active: true, nodeIds: ['a', 'b'], edgeIds: [] });

    store.getState().exitFocus();
    expect(store.getState().focus.active).toBe(false);
    expect(store.getState().history.past).toHaveLength(before);
  });

  it('toggles a member in and out of the focus set', () => {
    store.getState().enterFocus(['a'], []);
    store.getState().toggleFocusMember('b', 'node');
    expect(store.getState().focus.nodeIds).toEqual(['a', 'b']);

    store.getState().toggleFocusMember('a', 'node');
    expect(store.getState().focus.nodeIds).toEqual(['b']);
  });

  it('drops deleted elements from focus, and leaves Focus when nothing focused is left', () => {
    const a = store.getState().addNode({ type: 'service', x: 0, y: 0 });
    const b = store.getState().addNode({ type: 'service', x: 300, y: 0 });
    store.getState().enterFocus([a.id, b.id], []);

    store.getState().setSelection({ nodes: [a.id], edges: [] });
    store.getState().deleteSelection();
    expect(store.getState().focus).toEqual({ active: true, nodeIds: [b.id], edgeIds: [] });

    store.getState().setSelection({ nodes: [b.id], edges: [] });
    store.getState().deleteSelection();
    expect(store.getState().focus.active).toBe(false);
  });

  it('ignores undo and redo while a drag or resize is still held', () => {
    const a = store.getState().addNode({ type: 'service', x: 0, y: 0 });
    store.getState().beginInteraction('Move');
    store.getState().updateNodeById(a.id, { x: 50 });
    const past = store.getState().history.past.length;
    store.getState().undo();
    expect(store.getState().document.nodes[0]!.x).toBe(50);
    store.getState().endInteraction();
    expect(store.getState().history.past).toHaveLength(past + 1);
    store.getState().undo();
    expect(store.getState().document.nodes[0]!.x).toBe(0);
  });

  it('does nothing when toggling while focus is not active', () => {
    store.getState().toggleFocusMember('a', 'node');
    expect(store.getState().focus).toEqual({ active: false, nodeIds: [], edgeIds: [] });
  });

  it('is mutually exclusive with flow playback', () => {
    store.getState().setFlowPlayback({ active: true, step: 1 });
    expect(store.getState().flowPlayback.active).toBe(true);

    store.getState().enterFocus(['a'], []);
    expect(store.getState().focus.active).toBe(true);
    expect(store.getState().flowPlayback.active).toBe(false);

    store.getState().setFlowPlayback({ active: true, step: 1 });
    expect(store.getState().flowPlayback.active).toBe(true);
    expect(store.getState().focus.active).toBe(false);
  });
});

describe('isEdgeFocused', () => {
  const edge = { id: 'e1', source: 'a', target: 'b' };

  it('is false when focus is inactive', () => {
    expect(isEdgeFocused({ active: false, nodeIds: [], edgeIds: [] }, edge)).toBe(false);
  });

  it('is true when the edge was explicitly focused', () => {
    expect(isEdgeFocused({ active: true, nodeIds: [], edgeIds: ['e1'] }, edge)).toBe(true);
  });

  it('is inferred true when both endpoints are focused nodes', () => {
    expect(isEdgeFocused({ active: true, nodeIds: ['a', 'b'], edgeIds: [] }, edge)).toBe(true);
  });

  it('stays false when only one endpoint is a focused node', () => {
    expect(isEdgeFocused({ active: true, nodeIds: ['a'], edgeIds: [] }, edge)).toBe(false);
  });
});
