import { beforeEach, describe, expect, it } from 'vitest';
import { createAttachment, createDocument } from '../src/document/factory';
import { __resetInteraction, useEditorStore } from '../src/store/editorStore';
import { startArrange, startTidy } from '../src/commands/arrange';
import { useUiStore, type ArrangePreview } from '../src/store/uiStore';

/**
 * "Arrange diagram": the room laid out again by the agent's engine, shown as a preview and applied
 * only by `commitArrange` as one undo step that keeps every id, connector, flow and the selection —
 * only positions change.
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

/** What Arrange does end to end: the preview, then Apply. False when there was nothing to apply. */
async function arrange(options: { selection?: boolean } = {}): Promise<boolean> {
  const plan = await useEditorStore.getState().planArrange(options.selection ?? false);
  if (plan === null || typeof plan === 'string') return false;
  return useEditorStore.getState().commitArrange(plan);
}

const positionsOf = () => Object.fromEntries(useEditorStore.getState().document.nodes.map((node) => [node.id, { x: node.x, y: node.y }]));

describe('Arrange diagram', () => {
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

    const plan = (await useEditorStore.getState().planArrange()) as ArrangePreview;
    // A preview first: working it out changes nothing.
    expect(typeof plan).toBe('object');
    expect(positionsOf()).toEqual(before);
    expect(useEditorStore.getState().history.past.length).toBe(stepsBefore);
    expect(useEditorStore.getState().commitArrange(plan)).toBe(true);

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
    expect(await arrange()).toBe(false);
    expect(useEditorStore.getState().history.past.length).toBe(steps);
  });
});

describe('Arrange selection', () => {
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
    await arrange({ selection: true });
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
    const pending = editor.planArrange(true);
    editor.setSelection({ nodes: [], edges: [] });
    expect(await pending).toBeNull();
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
  expect(await arrange({ selection: true })).toBe(true);
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

describe('starting Arrange', () => {
  beforeEach(() => {
    reset();
    useUiStore.setState({ arrangePreview: null, tidyPreview: null, layoutBusy: null, readOnly: null, flowTrace: null });
  });

  function stacked() {
    const state = useEditorStore.getState();
    const a = state.addNode({ type: 'service', x: 100, y: 100, text: 'Orders API' });
    const b = state.addNode({ type: 'database', x: 100, y: 100, text: 'Orders DB' });
    state.connect(a.id, b.id);
  }

  it('says it is arranging while it works, opens a preview, and changes nothing until Apply', async () => {
    stacked();
    const before = positionsOf();
    const started = startArrange();
    // Busy at once, with a Cancel: the person is told before any work is done.
    expect(useUiStore.getState().layoutBusy).toMatchObject({ kind: 'arrange', scoped: false });
    // A second start while one is running is ignored rather than doubled.
    expect(await startArrange()).toBe('nothing');
    expect(await started).toBe('preview');
    expect(useUiStore.getState().layoutBusy).toBeNull();
    expect(useUiStore.getState().arrangePreview).not.toBeNull();
    expect(positionsOf()).toEqual(before);
  });

  it('Cancel stops it: no preview, nothing changed, and Arrange can be started again', async () => {
    stacked();
    const before = positionsOf();
    const started = startArrange();
    useUiStore.getState().layoutBusy!.cancel();
    expect(await started).toBe('nothing');
    expect(useUiStore.getState().layoutBusy).toBeNull();
    expect(useUiStore.getState().arrangePreview).toBeNull();
    expect(positionsOf()).toEqual(before);
    expect(await startArrange()).toBe('preview');
  });

  it('a layout skill\'s ask is a preview too, set up to play its motion on Apply', async () => {
    stacked();
    expect(await startArrange({ preset: { direction: 'down' } })).toBe('preview');
    const preview = useUiStore.getState().arrangePreview!;
    // Asked for "down": that is the one direction offered, and nothing has moved.
    expect(Object.keys(preview.options)).toEqual(['down']);
    expect(preview.motion).toBe(true);
  });

  it('does not offer a preview of a room that changed while it was worked out', async () => {
    stacked();
    const started = startArrange();
    useEditorStore.getState().addNode({ type: 'service', x: 900, y: 0, text: 'Late' });
    expect(await started).toBe('nothing');
    expect(useUiStore.getState().arrangePreview).toBeNull();
  });

  it('Tidy up is told the same way, and Cancel leaves nothing behind', async () => {
    stacked();
    const started = startTidy(false);
    expect(useUiStore.getState().layoutBusy).toMatchObject({ kind: 'tidy' });
    useUiStore.getState().layoutBusy!.cancel();
    await started;
    expect(useUiStore.getState().layoutBusy).toBeNull();
    expect(useUiStore.getState().tidyPreview).toBeNull();
  });
});

describe('arrange under a work budget', () => {
  beforeEach(reset);

  /** A tangled 100-shape room: unbounded, arranging it held the page for tens of seconds. */
  function tangle() {
    const ids: string[] = [];
    let seed = 7;
    const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    for (let i = 0; i < 100; i++) ids.push(useEditorStore.getState().addNode({ type: i % 3 ? 'service' : 'database', x: (i % 10) * 200, y: Math.floor(i / 10) * 150, text: `N${i}` }).id);
    let edges = 0;
    for (let i = 1; i < 100; i++) if (useEditorStore.getState().connect(ids[Math.floor(rnd() * i)]!, ids[i]!)) edges++;
    while (edges < 148) {
      const a = ids[Math.floor(rnd() * 100)]!;
      const b = ids[Math.floor(rnd() * 100)]!;
      if (a !== b && useEditorStore.getState().connect(a, b)) edges++;
    }
  }

  const overlapping = () => {
    const nodes = useEditorStore.getState().document.nodes;
    let count = 0;
    for (let i = 0; i < nodes.length; i++) for (let j = i + 1; j < nodes.length; j++) {
      const [a, b] = [nodes[i]!, nodes[j]!];
      if (a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height) count++;
    }
    return count;
  };

  const signature = (nodes: readonly { id: string; x: number; y: number }[]) => nodes.map((n) => `${n.id}:${n.x},${n.y}`).join('|');

  async function arrangeWith(work: number) {
    const [{ arrangeView, readingDirectionOf }, { measureContext }, { Problems }, { withBudget }] = await Promise.all([
      import('../src/agent/arrange'), import('../src/agent/place'), import('../src/agent/errors'), import('../src/agent/route'),
    ]);
    const doc = useEditorStore.getState().document;
    return withBudget({ work }, () => arrangeView(doc, {
      connectors: 'tidy', move: true,
      layout: { direction: readingDirectionOf(doc), spacing: 'comfortable', allowDegraded: false, normalizePeerSizes: false },
    }, measureContext(), new Problems(), '/arrange'));
  }

  it('a spent budget still leaves a valid layout: every shape placed, none overlapping', async () => {
    tangle();
    const { value: arranged, partial } = await arrangeWith(0);
    expect(arranged).toBeDefined();
    // Said: the repairs it skipped are why the result may not be the best there is.
    expect(partial).toBe(true);
    useEditorStore.setState({ document: arranged!.view });
    expect(useEditorStore.getState().document.nodes).toHaveLength(100);
    expect(useEditorStore.getState().document.edges).toHaveLength(148);
    expect(overlapping()).toBe(0);
  }, 30_000);

  it('gives the same layout however long it takes: the budget counts work, not time', async () => {
    tangle();
    const slow = async () => {
      const first = await arrangeWith(6_000);
      // Another job's worth of the clock passes between the two runs; nothing may depend on it.
      await new Promise((resolve) => setTimeout(resolve, 120));
      const second = await arrangeWith(6_000);
      return [first, second] as const;
    };
    const [a, b] = await slow();
    expect(a.partial).toBe(true);
    expect(a.used).toBe(b.used);
    expect(signature(a.value!.view.nodes)).toBe(signature(b.value!.view.nodes));
    expect(JSON.stringify(a.value!.view.edges.map((e) => [e.id, e.sourceAnchor, e.targetAnchor]))).toBe(JSON.stringify(b.value!.view.edges.map((e) => [e.id, e.sourceAnchor, e.targetAnchor])));
  }, 60_000);

  it('arranges a large tangled room within its budget, as a preview that says it stopped early', async () => {
    tangle();
    const started = performance.now();
    const plan = (await useEditorStore.getState().planArrange()) as ArrangePreview;
    expect(plan.partial).toBe(true);
    // A diagram this size spends its budget on the first direction; the bar says why there is one.
    expect(Object.keys(plan.options)).toHaveLength(1);
    expect(plan.alternativeSkipped).toBe(true);
    expect(useEditorStore.getState().commitArrange(plan)).toBe(true);
    // Unbounded, this took over ten times as long.
    expect(performance.now() - started).toBeLessThan(20_000);
    expect(overlapping()).toBe(0);
  }, 60_000);
});
