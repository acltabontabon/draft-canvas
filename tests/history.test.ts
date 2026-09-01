import { beforeEach, describe, expect, it } from 'vitest';
import { createDocument } from '../src/document/factory';
import { __resetClipboardSync, __resetInteraction, useEditorStore } from '../src/store/editorStore';

const store = useEditorStore;

function reset() {
  __resetInteraction();
  __resetClipboardSync();
  store.setState({
    document: createDocument('History'),
    history: { past: [], future: [] },
    selection: { nodes: [], edges: [] },
    clipboard: null,
    pasteRepeat: 0,
    revision: 0,
  });
}

describe('undo and redo', () => {
  beforeEach(reset);

  it('records one entry per discrete command', () => {
    const state = store.getState();
    state.addNode({ type: 'note', x: 0, y: 0, text: 'A' });
    state.addNode({ type: 'note', x: 200, y: 0, text: 'B' });
    expect(store.getState().history.past).toHaveLength(2);

    store.getState().undo();
    expect(store.getState().document.nodes).toHaveLength(1);
    store.getState().undo();
    expect(store.getState().document.nodes).toHaveLength(0);

    store.getState().redo();
    store.getState().redo();
    expect(store.getState().document.nodes).toHaveLength(2);
    expect(store.getState().document.nodes[1]!.text).toBe('B');
  });

  it('collapses a whole drag into a single undo step', () => {
    const node = store.getState().addNode({ type: 'note', x: 0, y: 0 });
    const historyBefore = store.getState().history.past.length;

    store.getState().beginInteraction('Move');
    // Simulates the per-frame position stream React Flow emits during a drag.
    for (let frame = 1; frame <= 30; frame += 1) {
      store.getState().commitPositions(new Map([[node.id, { x: frame * 4, y: frame * 2 }]]));
    }
    store.getState().endInteraction();

    expect(store.getState().history.past).toHaveLength(historyBefore + 1);
    expect(store.getState().document.nodes[0]!.x).toBe(120);

    store.getState().undo();
    expect(store.getState().document.nodes[0]!.x).toBe(0);
    expect(store.getState().document.nodes[0]!.y).toBe(0);
  });

  it('creates no entry for a click that moved nothing', () => {
    const node = store.getState().addNode({ type: 'note', x: 10, y: 10 });
    const before = store.getState().history.past.length;

    store.getState().beginInteraction('Move');
    store.getState().commitPositions(new Map([[node.id, { x: 10, y: 10 }]]));
    store.getState().endInteraction();

    expect(store.getState().history.past).toHaveLength(before);
  });

  it('coalesces consecutive text edits on the same node', () => {
    const node = store.getState().addNode({ type: 'note', x: 0, y: 0, text: '' });
    const before = store.getState().history.past.length;

    for (const text of ['O', 'Or', 'Ord', 'Orde', 'Order']) {
      store.getState().updateNodeText(node.id, text);
    }

    expect(store.getState().document.nodes[0]!.text).toBe('Order');
    expect(store.getState().history.past).toHaveLength(before + 1);

    store.getState().undo();
    expect(store.getState().document.nodes[0]!.text).toBe('');
  });

  it('does not coalesce edits to different nodes', () => {
    const a = store.getState().addNode({ type: 'note', x: 0, y: 0 });
    const b = store.getState().addNode({ type: 'note', x: 100, y: 0 });
    const before = store.getState().history.past.length;

    store.getState().updateNodeText(a.id, 'A');
    store.getState().updateNodeText(b.id, 'B');

    expect(store.getState().history.past).toHaveLength(before + 2);
  });

  it('restores the selection an action was performed with', () => {
    const node = store.getState().addNode({ type: 'note', x: 0, y: 0 });
    store.getState().setSelection({ nodes: [node.id], edges: [] });
    store.getState().deleteSelection();

    expect(store.getState().document.nodes).toHaveLength(0);
    store.getState().undo();
    expect(store.getState().selection.nodes).toEqual([node.id]);
  });

  it('discards the redo branch once a new action is taken', () => {
    store.getState().addNode({ type: 'note', x: 0, y: 0 });
    store.getState().undo();
    expect(store.getState().history.future).toHaveLength(1);

    store.getState().addNode({ type: 'note', x: 50, y: 50 });
    expect(store.getState().history.future).toHaveLength(0);
  });

  it('keeps the viewport out of the undo stack', () => {
    const before = store.getState().history.past.length;
    store.getState().persistViewport({ x: 100, y: 200, zoom: 1.5 });
    expect(store.getState().document.viewport.zoom).toBe(1.5);
    expect(store.getState().history.past).toHaveLength(before);
  });

  it('undoes and redoes connection creation and deletion', () => {
    const a = store.getState().addNode({ type: 'service', x: 0, y: 0 });
    const b = store.getState().addNode({ type: 'database', x: 300, y: 0 });
    const edge = store.getState().connect(a.id, b.id)!;
    expect(store.getState().document.edges).toHaveLength(1);

    store.getState().setSelection({ nodes: [], edges: [edge.id] });
    store.getState().deleteSelection();
    expect(store.getState().document.edges).toHaveLength(0);

    store.getState().undo();
    expect(store.getState().document.edges).toHaveLength(1);
    store.getState().undo();
    expect(store.getState().document.edges).toHaveLength(0);
    store.getState().redo();
    expect(store.getState().document.edges).toHaveLength(1);
  });

  it('refuses to connect a node to itself, or to duplicate a connection', () => {
    const a = store.getState().addNode({ type: 'note', x: 0, y: 0 });
    const b = store.getState().addNode({ type: 'note', x: 200, y: 0 });
    expect(store.getState().connect(a.id, a.id)).toBeNull();
    expect(store.getState().connect(a.id, b.id)).not.toBeNull();
    expect(store.getState().connect(a.id, b.id)).toBeNull();
    expect(store.getState().document.edges).toHaveLength(1);
  });

  it('duplicates a selection without touching the original', () => {
    const node = store.getState().addNode({ type: 'note', x: 10, y: 10, text: 'Idea' });
    store.getState().setSelection({ nodes: [node.id], edges: [] });
    store.getState().duplicateSelection();

    const doc = store.getState().document;
    expect(doc.nodes).toHaveLength(2);
    expect(doc.nodes[1]!.text).toBe('Idea');
    expect(doc.nodes[1]!.id).not.toBe(node.id);
    expect(doc.nodes[0]!.x).toBe(10);

    store.getState().undo();
    expect(store.getState().document.nodes).toHaveLength(1);
  });

  it('copies and pastes across the clipboard, placed around a given target center', () => {
    // Default note size is 200x108, so a note at (0,0) has fragment center
    // (100,54); a target of (160,114) reproduces a (60,60) top-left, same as
    // the old fixed-offset behavior, but now because it's viewport-aware.
    const node = store.getState().addNode({ type: 'note', x: 0, y: 0, text: 'Copy me' });
    store.getState().setSelection({ nodes: [node.id], edges: [] });
    store.getState().copySelection();
    store.getState().paste({ x: 160, y: 114 });

    const doc = store.getState().document;
    expect(doc.nodes).toHaveLength(2);
    expect(doc.nodes[1]!.x).toBe(60);
    expect(doc.nodes[1]!.y).toBe(60);
    expect(doc.nodes[1]!.text).toBe('Copy me');
  });

  it('pastes near the original position when no target center is given', () => {
    const node = store.getState().addNode({ type: 'note', x: 0, y: 0, text: 'Copy me' });
    store.getState().setSelection({ nodes: [node.id], edges: [] });
    store.getState().copySelection();
    store.getState().paste();

    const doc = store.getState().document;
    expect(doc.nodes[1]!.x).toBe(32);
    expect(doc.nodes[1]!.y).toBe(32);
  });

  it('offsets repeated pastes diagonally, and resets the stagger on a fresh copy', () => {
    const node = store.getState().addNode({ type: 'note', x: 0, y: 0, text: 'Copy me' });
    store.getState().setSelection({ nodes: [node.id], edges: [] });
    store.getState().copySelection();

    store.getState().paste({ x: 160, y: 114 });
    store.getState().paste({ x: 160, y: 114 });
    store.getState().paste({ x: 160, y: 114 });

    const [, first, second, third] = store.getState().document.nodes;
    expect(first!.x).toBe(60);
    expect(second!.x).toBe(76);
    expect(third!.x).toBe(92);

    store.getState().copySelection();
    store.getState().paste({ x: 160, y: 114 });
    expect(store.getState().document.nodes.at(-1)!.x).toBe(60);
  });

  it('cuts a selection into the clipboard, removing it in one undo step', () => {
    const node = store.getState().addNode({ type: 'note', x: 0, y: 0, text: 'Cut me' });
    store.getState().setSelection({ nodes: [node.id], edges: [] });
    const before = store.getState().history.past.length;

    store.getState().cutSelection();
    expect(store.getState().document.nodes).toHaveLength(0);
    expect(store.getState().history.past.length).toBe(before + 1);
    expect(store.getState().clipboard?.nodes).toHaveLength(1);

    store.getState().paste({ x: 0, y: 0 });
    expect(store.getState().document.nodes).toHaveLength(1);
    expect(store.getState().document.nodes[0]!.text).toBe('Cut me');

    store.getState().undo(); // undoes the paste
    store.getState().undo(); // undoes the cut's delete
    expect(store.getState().document.nodes).toHaveLength(1);
    // The clipboard isn't part of document history — undo doesn't clear it.
    expect(store.getState().clipboard?.nodes).toHaveLength(1);
  });

  it('cutting an edge-only selection deletes without touching the clipboard', () => {
    const a = store.getState().addNode({ type: 'note', x: 0, y: 0 });
    const b = store.getState().addNode({ type: 'note', x: 200, y: 0 });
    const edge = store.getState().connect(a.id, b.id)!;
    store.getState().setSelection({ nodes: [], edges: [edge.id] });

    // Mirrors `copySelection`'s own gate: an edge-only selection has no
    // self-contained fragment, so cutting one just deletes, clipboard untouched.
    store.getState().cutSelection();
    expect(store.getState().document.edges).toHaveLength(0);
    expect(store.getState().clipboard).toBeNull();
  });

  it('cutting an empty selection is a no-op', () => {
    const before = store.getState().history.past.length;
    store.getState().cutSelection();
    expect(store.getState().history.past.length).toBe(before);
  });
});
