import { beforeEach, describe, expect, it, vi } from 'vitest';
import { tidyView } from '../src/agent/tidy';
import { measureContext } from '../src/agent/place';
import { createDocument, createEdge, createNode } from '../src/document/factory';
import { addEdges, addNodes } from '../src/document/operations';
import { __resetInteraction, useEditorStore } from '../src/store/editorStore';
import { useUiStore } from '../src/store/uiStore';
import { tidySummary } from '../src/ui/Editor/tidySummary';
import { stubContext } from './commandStubs';
import { canvasCommands } from '../src/commands/registry';

/**
 * Tidy up: the gentle cleanup. It keeps every shape where it was put, fixes only what reads as
 * untidy, and changes nothing until its preview is applied.
 */

/** Two services side by side, the second a few pixels low: a connector that just misses level. */
function offLevel() {
  const a = createNode({ id: 'a', type: 'service', x: 0, y: 0, text: 'A' });
  const b = createNode({ id: 'b', type: 'service', x: 320, y: 9, text: 'B' });
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
    expect(Math.abs(moved.y - was.y)).toBe(9);
    expect(moved.x).toBe(was.x);
    // A shape with nothing to straighten is the same object: untouched, not merely equal.
    expect(at('c')).toBe(doc.nodes.find((node) => node.id === 'c'));
    expect(tidied.view.edges).toBe(doc.edges);
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

describe('Tidy up in the editor', () => {
  beforeEach(() => {
    __resetInteraction();
    useEditorStore.setState({
      document: offLevel(),
      history: { past: [], future: [] },
      selection: { nodes: [], edges: [] },
      clipboard: null,
      revision: 0,
      mode: 'edit',
      selectedFlowId: null,
      path: [],
      outer: null,
    });
    useUiStore.setState({ tidyPreview: null, readOnly: null, flowTrace: null });
  });

  it('plans without changing anything, then applies as one undo step', async () => {
    const before = useEditorStore.getState().document;
    const preview = (await useEditorStore.getState().planTidy())!;
    expect(preview).toMatchObject({ moved: 1, reattached: 0, scoped: false });
    expect(preview.base).toBe(before);
    // A plan is only a plan: the document and its history are exactly as they were.
    expect(useEditorStore.getState().document).toBe(before);
    expect(useEditorStore.getState().history.past).toHaveLength(0);

    expect(useEditorStore.getState().commitTidy(preview)).toBe(true);
    const after = useEditorStore.getState();
    expect(after.document.nodes).toEqual(preview.view.nodes);
    expect(after.history.past).toHaveLength(1);
    expect(after.history.past.at(-1)!.label).toBe('Tidy up');
    after.undo();
    expect(useEditorStore.getState().document.nodes).toEqual(before.nodes);
  });

  it('has nothing to offer a room that is already tidy', async () => {
    const preview = (await useEditorStore.getState().planTidy())!;
    useEditorStore.getState().commitTidy(preview);
    expect(await useEditorStore.getState().planTidy()).toBeNull();
  });

  it('refuses a preview of a room that has changed since', async () => {
    const preview = (await useEditorStore.getState().planTidy())!;
    useEditorStore.getState().addNode({ type: 'service', x: 900, y: 0, text: 'Late' });
    const steps = useEditorStore.getState().history.past.length;
    expect(useEditorStore.getState().commitTidy(preview)).toBe(false);
    expect(useEditorStore.getState().history.past).toHaveLength(steps);
    expect(useEditorStore.getState().document.nodes.some((node) => node.text === 'Late')).toBe(true);
  });

  it('tidies only the selection when there is one, and offers nothing to a shared diagram', async () => {
    useEditorStore.getState().setSelection({ nodes: ['b'], edges: [] });
    const preview = (await useEditorStore.getState().planTidy())!;
    expect(preview.scoped).toBe(true);
    expect(preview.view.nodes.find((node) => node.id === 'a')).toBe(preview.base.nodes.find((node) => node.id === 'a'));
    useUiStore.setState({ readOnly: { sharedTitle: 'Shared' } });
    expect(await useEditorStore.getState().planTidy()).toBeNull();
  });

  it('is one command, named for what it will tidy, and absent where nothing can be edited', () => {
    const idsOf = (ctx = stubContext()) => canvasCommands(ctx);
    const whole = idsOf().find((command) => command.id === 'tidy')!;
    expect(whole.title).toBe('Tidy up');
    useEditorStore.getState().setSelection({ nodes: ['b'], edges: [] });
    expect(idsOf().find((command) => command.id === 'tidy')!.title).toBe('Tidy up selection');
    const shared = idsOf(stubContext({ ui: { ...useUiStore.getState(), readOnly: { sharedTitle: 'Shared' } } }));
    expect(shared.some((command) => command.id === 'tidy')).toBe(false);
  });

  it('says a tidy diagram is tidy, and names what laying it out again would fix', async () => {
    const run = async () => {
      const notify = vi.fn();
      const ctx = stubContext({ ui: { ...useUiStore.getState(), notify } });
      canvasCommands(ctx).find((command) => command.id === 'tidy')!.run(ctx);
      await vi.waitFor(() => expect(notify).toHaveBeenCalled());
      return notify.mock.calls[0] as [string, string, { label: string; run: () => void }];
    };
    // Level and apart: nothing to tidy, and nothing that reads badly.
    const a = createNode({ id: 'a', type: 'service', x: 0, y: 0, text: 'A' });
    const b = createNode({ id: 'b', type: 'service', x: 420, y: 0, text: 'B' });
    const edge = createEdge({ id: 'ab', source: 'a', target: 'b' });
    useEditorStore.getState().setDocument(addEdges(addNodes(createDocument('Tidy'), [a, b]), [edge]));
    const [plain, , rearrange] = await run();
    expect(plain).toBe('Already tidy.');
    expect(rearrange.label).toBe('Rearrange');

    // The same, with a long name stacked into a narrow column: still tidy, but worth laying out.
    const stacked = { ...a, text: 'Customer-Facing Public API Gateway and Edge Routing Layer for Web and Mobile', width: 150, height: 190, y: -61 };
    useEditorStore.getState().setDocument(addEdges(addNodes(createDocument('Tidy'), [stacked, b]), [edge]));
    const [message, , fix] = await run();
    expect(message).toBe('Already tidy. Rearranging would fix 1 stacked name.');
    expect(fix.label).toBe('Show fix');
    fix.run();
    expect(useUiStore.getState().arrangePreview?.fixes?.[useUiStore.getState().arrangePreview!.direction]).toContainEqual({ kind: 'stacked-name', id: 'a' });
    useUiStore.getState().setArrangePreview(null);
  });

  it('says what a preview changes in plain words', () => {
    expect(tidySummary({ moved: 3, reattached: 0 })).toBe('3 shapes nudged');
    expect(tidySummary({ moved: 1, reattached: 2 })).toBe('1 shape nudged, 2 connectors re-attached');
    expect(tidySummary({ moved: 0, reattached: 1 })).toBe('1 connector re-attached');
  });
});
