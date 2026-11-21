import { beforeEach, describe, expect, it } from 'vitest';
import { tidyView } from '../src/agent/tidy';
import { measureContext } from '../src/agent/place';
import { createDocument, createEdge, createNode } from '../src/document/factory';
import { addEdges, addNodes } from '../src/document/operations';
import { __resetInteraction, useEditorStore } from '../src/store/editorStore';
import { useUiStore } from '../src/store/uiStore';
import { stubContext } from './commandStubs';
import { canvasCommands } from '../src/commands/registry';

/**
 * Tidying: the gentle cleanup. It keeps every shape where it was put and fixes only what reads as
 * untidy. Agents ask for it as a whole (`tidyView`); in the editor a drop does it for what it moved.
 */

/** Two services side by side, the second a step low: a connector drawn with a kink. (A few pixels
 *  fewer and the router draws it straight on its own: see `tidyView` below.) */
function offLevel(dy = 28) {
  const a = createNode({ id: 'a', type: 'service', x: 0, y: 0, text: 'A' });
  const b = createNode({ id: 'b', type: 'service', x: 320, y: dy, text: 'B' });
  const c = createNode({ id: 'c', type: 'service', x: 640, y: 400, text: 'C' });
  return addEdges(addNodes(createDocument('Tidy'), [a, b, c]), [createEdge({ id: 'ab', source: 'a', target: 'b' })]);
}

describe('tidyView', () => {
  it('straightens a connector that just misses level, by a nudge and nothing more', () => {
    const doc = offLevel();
    const tidied = tidyView(doc, undefined, measureContext());
    const at = (id: string) => tidied.view.nodes.find((node) => node.id === id)!;
    expect(tidied.moved).toHaveLength(1);
    // Level now, and the shape that moved went no further than the miss.
    expect(at('a').y + at('a').height / 2).toBe(at('b').y + at('b').height / 2);
    const moved = at(tidied.moved[0]!);
    const was = doc.nodes.find((node) => node.id === moved.id)!;
    expect(Math.abs(moved.y - was.y)).toBe(28);
    expect(moved.x).toBe(was.x);
    // A shape with nothing to straighten is the same object: untouched, not merely equal.
    expect(at('c')).toBe(doc.nodes.find((node) => node.id === 'c'));
    expect(tidied.view.edges).toBe(doc.edges);
  });

  it('leaves alone a connector the router already draws straight, however few pixels its shapes are out', () => {
    for (const dy of [3, 9, 16, 26]) {
      const doc = offLevel(dy);
      const tidied = tidyView(doc, undefined, measureContext());
      expect(tidied.view, `dy ${dy}`).toBe(doc);
      expect(tidied.moved, `dy ${dy}`).toEqual([]);
    }
  });

  it('straightens a kink the router draws as a step, even a little past the old 16 px', () => {
    for (const dy of [27, 30, 32]) {
      const doc = offLevel(dy);
      const tidied = tidyView(doc, undefined, measureContext());
      expect(tidied.moved, `dy ${dy}`).toHaveLength(1);
    }
    expect(tidyView(offLevel(40), undefined, measureContext()).moved).toEqual([]);
  });

  it('hands back the very same view when there is nothing to tidy', () => {
    const doc = offLevel();
    const once = tidyView(doc, undefined, measureContext()).view;
    const again = tidyView(once, undefined, measureContext());
    expect(again.view).toBe(once);
    expect(again.moved).toEqual([]);
    expect(again.reattached).toEqual([]);
  });

  it('moves only what is in scope, so tidying one neighbourhood leaves another alone', () => {
    const doc = offLevel();
    const tidied = tidyView(doc, new Set(['c']), measureContext());
    // `c` joins nothing, and `a` and `b` may not move: nothing to do.
    expect(tidied.view).toBe(doc);
    const scoped = tidyView(doc, new Set(['b']), measureContext());
    expect(scoped.moved).toEqual(['b']);
  });

  it('re-attaches a connector whose line runs through a shape, and only that one', () => {
    const a = createNode({ id: 'a', type: 'service', x: 0, y: 0, text: 'A' });
    const wall = createNode({ id: 'wall', type: 'service', x: 300, y: 0, text: 'Wall' });
    const b = createNode({ id: 'b', type: 'service', x: 600, y: 0, text: 'B' });
    const d = createNode({ id: 'd', type: 'service', x: 0, y: 300, text: 'D' });
    // Pinned side to side, straight through the shape between them.
    const through = { ...createEdge({ id: 'ab', source: 'a', target: 'b', routing: 'straight' }), sourceAnchor: { side: 'right' as const, offset: 0.5 }, targetAnchor: { side: 'left' as const, offset: 0.5 } };
    const fine = createEdge({ id: 'ad', source: 'a', target: 'd' });
    const doc = addEdges(addNodes(createDocument('Through'), [a, wall, b, d]), [through, fine]);
    const tidied = tidyView(doc, undefined, measureContext());
    expect(tidied.reattached).toEqual(['ab']);
    expect(tidied.moved).toEqual([]);
    // The connector that was fine keeps its own object, and so its place in history.
    expect(tidied.view.edges.find((edge) => edge.id === 'ad')).toBe(doc.edges.find((edge) => edge.id === 'ad'));
    expect(tidied.view.nodes).toBe(doc.nodes);
  });
});

describe('a drop settles what it moved', () => {
  beforeEach(() => {
    __resetInteraction();
    useEditorStore.setState({
      document: offLevel(0),
      history: { past: [], future: [] },
      selection: { nodes: [], edges: [] },
      clipboard: null,
      revision: 0,
      mode: 'edit',
      selectedFlowId: null,
      path: [],
      outer: null,
    });
    useUiStore.setState({ readOnly: null, flowTrace: null });
  });

  const at = (id: string) => useEditorStore.getState().document.nodes.find((node) => node.id === id)!;
  /** `b` dropped a step low, as a drag would leave it. */
  const drop = (settle?: readonly ('x' | 'y')[]) =>
    useEditorStore.getState().commitMove(new Map([['b', { x: 320, y: 28 }]]), ['b'], settle ? { settle } : undefined);

  it('straightens the connector the drop left with a kink, in the same undo step as the move', () => {
    drop(['y']);
    // Level with `a` again: the dropped shape went the last few pixels, and `a` never moved.
    expect(at('b').y).toBe(0);
    expect(at('a')).toMatchObject({ x: 0, y: 0 });
    expect(useEditorStore.getState().history.past).toHaveLength(1);
    expect(useEditorStore.getState().history.past[0]!.label).toBe('Move');
  });

  it('leaves the shape where it was dropped on an axis the drag did not arm, and with none armed', () => {
    drop(['x']);
    expect(at('b').y).toBe(28);
    useEditorStore.getState().undo();
    drop([]);
    expect(at('b').y).toBe(28);
    useEditorStore.getState().undo();
    drop();
    expect(at('b').y).toBe(28);
  });

  it('never moves a shape that was not dragged', () => {
    // `a` is the lighter end and would be the one a whole-view Straighten nudges; a drop of `b` may not.
    useEditorStore.getState().commitMove(new Map([['b', { x: 320, y: 28 }]]), ['b'], { settle: ['x', 'y'] });
    expect(at('a')).toMatchObject({ x: 0, y: 0 });
    expect(at('c')).toMatchObject({ x: 640, y: 400 });
  });

  it('leaves a held shape exactly where it was dropped', () => {
    const doc = useEditorStore.getState().document;
    useEditorStore.setState({ document: { ...doc, nodes: doc.nodes.map((node) => (node.id === 'b' ? { ...node, held: true } : node)) } });
    drop(['y']);
    expect(at('b').y).toBe(28);
  });

  it('keeps what a dragged boundary carries as it was laid out', () => {
    const frame = createNode({ id: 'frame', type: 'group', x: 300, y: -40, width: 240, height: 200 });
    const doc = addNodes(offLevel(28), [frame]);
    useEditorStore.setState({ document: { ...doc, nodes: doc.nodes.map((node) => (node.id === 'b' ? { ...node, parentId: 'frame' } : node)) } });
    useEditorStore.getState().commitMove(new Map([['frame', { x: 300, y: -30 }], ['b', { x: 320, y: 38 }]]), ['frame', 'b'], { settle: ['x', 'y'] });
    expect(at('b').y).toBe(38);
  });

  it('is not a command: the cleanup happens as the diagram is drawn', () => {
    const commands = canvasCommands(stubContext());
    expect(commands.some((command) => command.id === 'tidy')).toBe(false);
    // The whole-view tools it was built from stay for someone who wants exactly one of them.
    expect(commands.some((command) => command.id === 'straighten')).toBe(true);
  });
});
