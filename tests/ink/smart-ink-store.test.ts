import { beforeEach, describe, expect, it, vi } from 'vitest';

const preferences = new Map<string, string>();
vi.mock('../../src/lib/preferences', () => ({
  readPreference: (key: string) => preferences.get(key) ?? null,
  writePreference: (key: string, value: string) => void preferences.set(key, value),
  removePreference: (key: string) => void preferences.delete(key),
}));

import { __resetInkSession, convertStrokes, flushSmartInk, smartStrokeKept } from '../../src/canvas/inkSession';
import { inkOf } from '../../src/document/ink';
import { createDocument, createNode } from '../../src/document/factory';
import type { DraftInk } from '../../src/document/types';
import { buildStroke } from '../../src/ink/capture';
import { __resetClipboardSync, __resetInteraction, fileOf, useEditorStore } from '../../src/store/editorStore';
import { useUiStore } from '../../src/store/uiStore';
import * as c from './corpus';

const store = useEditorStore;

function reset(nodes = [createNode({ id: 'n_api', type: 'service', x: 0, y: 0, text: 'API' }), createNode({ id: 'n_db', type: 'database', x: 400, y: 0, text: 'DB' })]) {
  __resetInteraction();
  __resetInkSession();
  preferences.clear();
  store.setState({
    document: { ...createDocument('Ink'), nodes },
    path: [],
    outer: null,
    liveViewport: null,
    history: { past: [], future: [] },
    selection: { nodes: [], edges: [] },
    revision: 0,
  });
  useUiStore.setState({ inkSelection: [], inkSuggestion: null, inkResolving: null, pencil: null, readOnly: null });
}

/** A stroke from corpus points, as the canvas would keep it. */
function strokeOf(points: { x: number; y: number }[]): DraftInk {
  return buildStroke(points.map((p) => ({ ...p, pressure: 0.5 })), { tool: 'pen', color: 'graphite', size: 3 }, { zoom: 1, pressure: false })!;
}

function draw(points: { x: number; y: number }[]): DraftInk {
  const stroke = strokeOf(points);
  expect(store.getState().drawInk(stroke)).toBe(true);
  return stroke;
}

const nodeIds = () => store.getState().document.nodes.map((n) => n.id);
const strokes = () => inkOf(store.getState().document).length;

describe('drawing and erasing', () => {
  beforeEach(() => reset());

  it('keeps each stroke as one undo step', () => {
    draw(c.line({ x: 0, y: 200 }, { x: 300, y: 200 }, c.hand(1))[0]!);
    draw(c.line({ x: 0, y: 260 }, { x: 300, y: 260 }, c.hand(2))[0]!);
    expect(strokes()).toBe(2);
    expect(store.getState().history.past.map((entry) => entry.label)).toEqual(['Sketch', 'Sketch']);
    store.getState().undo();
    expect(strokes()).toBe(1);
  });

  it('erases and moves strokes as single steps, and Delete erases chosen strokes', () => {
    const a = draw(c.line({ x: 0, y: 200 }, { x: 300, y: 200 }, c.hand(1))[0]!);
    const b = draw(c.line({ x: 0, y: 260 }, { x: 300, y: 260 }, c.hand(2))[0]!);
    store.getState().moveInk([a.id], 20, 10);
    expect(inkOf(store.getState().document)[0]).toMatchObject({ x: a.x + 20, y: a.y + 10 });
    store.getState().eraseInk([a.id]);
    expect(strokes()).toBe(1);
    useUiStore.getState().setInkSelection([b.id]);
    store.getState().deleteSelection();
    expect(strokes()).toBe(0);
    expect(useUiStore.getState().inkSelection).toEqual([]);
    expect(store.getState().history.past.at(-1)!.label).toBe('Erase stroke');
  });

  it('never touches the shapes a sketch is drawn over', () => {
    const before = store.getState().document.nodes;
    draw(c.ellipse(88, 34, 120, 60, c.hand(3))[0]!);
    expect(store.getState().document.nodes).toBe(before);
  });

  it('refuses a sketch in an empty room rather than keep one the room cannot hold', () => {
    store.setState({ path: ['n_api'], outer: store.getState().document, document: { ...store.getState().document, nodes: [], edges: [], flows: [] } });
    expect(store.getState().drawInk(strokeOf(c.line({ x: 0, y: 0 }, { x: 100, y: 0 }, c.hand(1))[0]!))).toBe(false);
  });

  it('choosing shapes puts chosen strokes down', () => {
    const a = draw(c.line({ x: 0, y: 200 }, { x: 300, y: 200 }, c.hand(1))[0]!);
    useUiStore.getState().setInkSelection([a.id]);
    store.getState().setSelection({ nodes: ['n_api'], edges: [] });
    expect(useUiStore.getState().inkSelection).toEqual([]);
  });
});

describe('copying sketches', () => {
  beforeEach(() => reset());

  it('copies, pastes and duplicates chosen strokes under new ids, through the system clipboard format too', () => {
    const a = draw(c.line({ x: 0, y: 200 }, { x: 300, y: 200 }, c.hand(1))[0]!);
    useUiStore.getState().setInkSelection([a.id]);
    const text = store.getState().copySelection();
    expect(text).toContain('"ink"');
    store.getState().paste();
    expect(strokes()).toBe(2);
    const pasted = useUiStore.getState().inkSelection;
    expect(pasted).toHaveLength(1);
    expect(pasted[0]).not.toBe(a.id);
    store.getState().duplicateSelection();
    expect(strokes()).toBe(3);
    // From the text alone (another tab, another diagram): validated like a file.
    store.setState({ clipboard: null });
    __resetClipboardSync();
    expect(store.getState().applyExternalClipboardText(text!)).toBe(true);
    store.getState().paste();
    expect(strokes()).toBe(4);
  });

  it('cuts chosen strokes in one step', () => {
    const a = draw(c.line({ x: 0, y: 200 }, { x: 300, y: 200 }, c.hand(1))[0]!);
    useUiStore.getState().setInkSelection([a.id]);
    store.getState().cutSelection();
    expect(strokes()).toBe(0);
    store.getState().undo();
    expect(strokes()).toBe(1);
  });

  it('carries strokes chosen alongside shapes with them', () => {
    const a = draw(c.ellipse(88, 34, 130, 70, c.hand(2))[0]!);
    store.getState().setSelection({ nodes: ['n_api'], edges: [] });
    useUiStore.getState().setInkSelection([a.id]);
    store.getState().copySelection();
    store.getState().paste();
    expect(store.getState().document.nodes).toHaveLength(3);
    expect(strokes()).toBe(2);
  });
});

describe('Smart Ink conversion', () => {
  beforeEach(() => reset());

  it('turns strokes into a shape in one step that undo reverses to the strokes, and redo repeats', () => {
    const stroke = draw(c.rectangle(0, 300, 200, 100, c.hand(4))[0]!);
    const id = store.getState().inkToShape([stroke.id], 'component', { x: 0, y: 300, width: 200, height: 100 }, []);
    expect(id).not.toBeNull();
    expect(strokes()).toBe(0);
    expect(store.getState().document.nodes.find((n) => n.id === id)).toMatchObject({ type: 'component', width: 200, height: 100 });
    store.getState().undo();
    expect(strokes()).toBe(1);
    expect(nodeIds()).not.toContain(id);
    store.getState().redo();
    expect(nodeIds()).toContain(id);
    expect(strokes()).toBe(0);
  });

  it('a different choice revises the same step: one undo still goes back to the drawing', () => {
    const stroke = draw(c.rectangle(0, 300, 200, 100, c.hand(5))[0]!);
    const drawn = { x: 0, y: 300, width: 200, height: 100 };
    const id = store.getState().inkToShape([stroke.id], 'component', drawn, [])!;
    const depth = store.getState().history.past.length;
    store.getState().retypeInkShape(id, [stroke], 'service', drawn, []);
    store.getState().retypeInkShape(id, [stroke], 'note', drawn, []);
    expect(store.getState().history.past).toHaveLength(depth);
    expect(store.getState().document.nodes.find((n) => n.id === id)!.type).toBe('note');
    store.getState().undo();
    expect(strokes()).toBe(1);
    expect(nodeIds()).not.toContain(id);
  });

  it('a later choice, after other edits, changes the shape in place and keeps its connectors', () => {
    const stroke = draw(c.rectangle(0, 300, 200, 100, c.hand(5))[0]!);
    const drawn = { x: 0, y: 300, width: 200, height: 100 };
    const id = store.getState().inkToShape([stroke.id], 'component', drawn, [])!;
    store.getState().connect(id, 'n_db');
    store.getState().retypeInkShape(id, [stroke], 'service', drawn, []);
    const node = store.getState().document.nodes.find((n) => n.id === id)!;
    expect(node.type).toBe('service');
    expect(store.getState().document.edges.some((e) => e.source === id)).toBe(true);
    store.getState().undo();
    expect(store.getState().document.nodes.find((n) => n.id === id)!.type).toBe('component');
  });

  it('keep as sketch puts the strokes back; redo can make the shape again', () => {
    const stroke = draw(c.rectangle(0, 300, 200, 100, c.hand(6))[0]!);
    const id = store.getState().inkToShape([stroke.id], 'component', { x: 0, y: 300, width: 200, height: 100 }, [])!;
    store.getState().revertInkShape(id, [stroke]);
    expect(strokes()).toBe(1);
    expect(nodeIds()).not.toContain(id);
    store.getState().redo();
    expect(nodeIds()).toContain(id);
  });

  it('a Boundary drawn round shapes takes them in, as one undoable step', () => {
    const stroke = draw(c.rectangle(-30, -30, 640, 200, c.hand(7))[0]!);
    const id = store.getState().inkToShape([stroke.id], 'boundary', { x: -30, y: -30, width: 640, height: 200 }, ['n_api', 'n_db'])!;
    const nodes = store.getState().document.nodes;
    expect(nodes.find((n) => n.id === id)!.type).toBe('group');
    expect(nodes.filter((n) => n.parentId === id).map((n) => n.id).sort()).toEqual(['n_api', 'n_db']);
    store.getState().undo();
    expect(store.getState().document.nodes.every((n) => n.parentId === undefined)).toBe(true);
    expect(strokes()).toBe(1);
  });

  it('an arrow between two shapes becomes one directed connector, its kind inferred', () => {
    const stroke = draw(c.arrowOneStroke({ x: 180, y: 34 }, { x: 395, y: 40 }, c.hand(8))[0]!);
    const id = store.getState().inkToConnector([stroke.id], 'n_api', 'n_db', true);
    const edge = store.getState().document.edges.find((e) => e.id === id)!;
    expect(edge).toMatchObject({ source: 'n_api', target: 'n_db', directed: true, semanticsOrigin: 'inferred' });
    expect(strokes()).toBe(0);
    store.getState().undo();
    expect(store.getState().document.edges).toHaveLength(0);
    expect(strokes()).toBe(1);
  });

  it('never draws a second connector over an existing one; the line stays a sketch', () => {
    store.getState().connect('n_api', 'n_db');
    const stroke = draw(c.line({ x: 180, y: 34 }, { x: 395, y: 40 }, c.hand(9))[0]!);
    expect(store.getState().inkToConnector([stroke.id], 'n_db', 'n_api', false)).toBeNull();
    expect(strokes()).toBe(1);
  });
});

describe('the Smart Ink session', () => {
  beforeEach(() => reset());

  it('reads a drawing once the pen rests and offers the alternatives beside it', async () => {
    const stroke = draw(c.rectangle(0, 300, 220, 110, c.hand(10))[0]!);
    smartStrokeKept(stroke, 1);
    flushSmartInk();
    await vi.waitFor(() => expect(useUiStore.getState().inkSuggestion?.mode).toBe('converted'));
    const suggestion = useUiStore.getState().inkSuggestion!;
    expect(suggestion.choices[0]).toBe('component');
    expect(store.getState().document.nodes.find((n) => n.id === suggestion.nodeId)!.type).toBe('component');
    expect(strokes()).toBe(0);
  });

  it('joins strokes drawn together into one drawing: four sides make one box', async () => {
    for (const [index, side] of c.rectangleFourStrokes(0, 300, 220, 120, c.hand(11)).entries()) {
      const stroke = draw(side);
      smartStrokeKept(stroke, 1);
      expect(useUiStore.getState().inkSuggestion, `after side ${index + 1}`).toBeNull();
    }
    flushSmartInk();
    await vi.waitFor(() => expect(useUiStore.getState().inkSuggestion?.mode).toBe('converted'));
    expect(strokes()).toBe(0);
    expect(store.getState().document.nodes).toHaveLength(3);
  });

  it('leaves a scribble exactly as drawn', async () => {
    const stroke = draw(c.scribble(0, 300, 200, 120, c.hand(12))[0]!);
    smartStrokeKept(stroke, 1);
    flushSmartInk();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(strokes()).toBe(1);
    expect(store.getState().document.nodes).toHaveLength(2);
    expect(useUiStore.getState().inkSuggestion).toBeNull();
  });

  it('leaves a circle round a shape as ink — circling is pointing, not drawing', async () => {
    const stroke = draw(c.ellipse(88, 34, 130, 70, c.hand(13))[0]!);
    smartStrokeKept(stroke, 1);
    flushSmartInk();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(strokes()).toBe(1);
  });

  it('turns an arrow drawn from one shape to another into a connector', async () => {
    const stroke = draw(c.arrowOneStroke({ x: 170, y: 34 }, { x: 405, y: 50 }, c.hand(14))[0]!);
    smartStrokeKept(stroke, 1);
    flushSmartInk();
    await vi.waitFor(() => expect(store.getState().document.edges).toHaveLength(1));
    expect(store.getState().document.edges[0]).toMatchObject({ source: 'n_api', target: 'n_db', directed: true });
  });

  it('leaves an underline under a shape alone', async () => {
    const stroke = draw(c.line({ x: 10, y: 60 }, { x: 160, y: 62 }, c.hand(15))[0]!);
    smartStrokeKept(stroke, 1);
    flushSmartInk();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(store.getState().document.edges).toHaveLength(0);
    expect(strokes()).toBe(1);
  });

  it('converts chosen sketch strokes on request', async () => {
    const parts = c.cylinder(0, 300, 120, 150, c.hand(17)).map((points) => draw(points));
    await convertStrokes(parts.map((s) => s.id), 1);
    await vi.waitFor(() => expect(useUiStore.getState().inkSuggestion?.choices[0]).toBe('database'));
    expect(fileOf(store.getState()).nodes.some((n) => n.type === 'database' && n.id !== 'n_db')).toBe(true);
    expect(strokes()).toBe(0);
  });

  it('says so, and changes nothing, when asked to convert something unreadable', async () => {
    const scribble = draw(c.scribble(0, 300, 200, 120, c.hand(18))[0]!);
    const original = useUiStore.getState().notify;
    const notify = vi.fn();
    useUiStore.setState({ notify });
    try {
      await convertStrokes([scribble.id], 1);
      expect(notify).toHaveBeenCalledWith(expect.stringContaining('stays as drawn'));
      expect(strokes()).toBe(1);
    } finally {
      useUiStore.setState({ notify: original });
    }
  });
});
