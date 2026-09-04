import { beforeEach, describe, expect, it } from 'vitest';
import { commandsFor } from '../src/commands/registry';
import type { CommandContext } from '../src/commands/types';
import { createDocument } from '../src/document/factory';
import { stubContext, stubPlayback } from './commandStubs';
import { __resetInteraction, useEditorStore } from '../src/store/editorStore';
import { useUiStore } from '../src/store/uiStore';


function reset() {
  __resetInteraction();
  useEditorStore.setState({
    document: createDocument('Commands'),
    history: { past: [], future: [] },
    selection: { nodes: [], edges: [] },
    clipboard: null,
    revision: 0,
    mode: 'edit',
    flowPlayback: { active: false, flowId: null, step: 0 },
    focus: { active: false, nodeIds: [], edgeIds: [] },
    flowEdit: { active: false, flowId: null },
    selectedFlowId: null,
  });
  useUiStore.setState({ commandPaletteOpen: false, learnModeActive: false });
}

const ids = (ctx: CommandContext) => commandsFor(ctx).map((command) => command.id);

describe('commandsFor — edit mode', () => {
  beforeEach(reset);

  it('offers every shape preset as an Add command', () => {
    const list = ids(stubContext());
    for (const id of ['add-text', 'add-note', 'add-code', 'add-service', 'add-database', 'add-queue', 'add-actor', 'add-ellipse']) {
      expect(list).toContain(id);
    }
  });

  it('an Add command creates the node and selects it, so the next command can act on it', () => {
    const ctx = stubContext();
    const add = commandsFor(ctx).find((command) => command.id === 'add-service')!;
    add.run(ctx);
    const state = useEditorStore.getState();
    expect(state.document.nodes).toHaveLength(1);
    expect(state.document.nodes[0]!.type).toBe('service');
    expect(state.selection.nodes).toEqual([state.document.nodes[0]!.id]);
  });

  it('hides Undo/Redo until there is something to undo or redo', () => {
    expect(ids(stubContext())).not.toContain('undo');
    useEditorStore.getState().addNode({ type: 'note', x: 0, y: 0, text: 'x' });
    expect(ids(stubContext())).toContain('undo');
    expect(ids(stubContext())).not.toContain('redo');
    useEditorStore.getState().undo();
    expect(ids(stubContext())).toContain('redo');
  });

  it('only offers "Exit spotlight" while Focus Mode is on', () => {
    expect(ids(stubContext())).not.toContain('focus-exit');
    useEditorStore.getState().enterFocus([], []);
    expect(ids(stubContext())).toContain('focus-exit');
  });

  it('"Switch to flow…" is a two-step command listing Diagram and each flow', () => {
    const state = useEditorStore.getState();
    const checkout = state.createFlow('Checkout');
    const ctx = stubContext();
    const stage = commandsFor(ctx).find((command) => command.id === 'switch-flow')!.run(ctx);
    expect(stage && 'options' in stage ? stage.options.map((o) => o.title) : []).toEqual(['Diagram', 'Checkout']);
    if (stage && 'options' in stage) stage.options[1]!.run(ctx);
    expect(useEditorStore.getState().selectedFlowId).toBe(checkout);
  });

  it('Start presentation enters present mode and starts playback when a flow exists', () => {
    useEditorStore.getState().createFlow('Checkout');
    const playback = stubPlayback({ canStart: true });
    const ctx = stubContext({ playback });
    commandsFor(ctx).find((command) => command.id === 'present')!.run(ctx);
    expect(useEditorStore.getState().mode).toBe('present');
    expect(playback.start).toHaveBeenCalledOnce();
  });
});

describe('commandsFor — present mode is navigation only', () => {
  beforeEach(reset);

  const MUTATING = /^(add-|delete|duplicate|group|ungroup|align|distribute|connect|reverse|reconnect|edge-|flow-new|undo|redo|select-all|export)/;

  it('never lists a command that could change the document', () => {
    useEditorStore.getState().setMode('present');
    const list = ids(stubContext({ playback: stubPlayback({ canStart: true }) }));
    expect(list.some((id) => MUTATING.test(id))).toBe(false);
    expect(list).toContain('present-exit');
    expect(list).toContain('fit');
    expect(list).toContain('present-flow');
  });

  it('lists step navigation while a flow is playing', () => {
    const state = useEditorStore.getState();
    state.createFlow('Checkout');
    state.setMode('present');
    const playback = stubPlayback({
      active: true,
      canStart: true,
      flow: useEditorStore.getState().document.flows[0]!,
      step: 1,
      steps: [],
    });
    const ctx = stubContext({ playback });
    const list = ids(ctx);
    expect(list).toEqual(expect.arrayContaining(['step-next', 'step-previous', 'step-go-to', 'fit', 'present-exit']));
    commandsFor(ctx).find((command) => command.id === 'step-next')!.run(ctx);
    expect(playback.next).toHaveBeenCalledOnce();
  });
});

describe('commandsFor — contextual (8.2)', () => {
  beforeEach(reset);

  const stageOf = (ctx: CommandContext, id: string) => {
    const result = commandsFor(ctx).find((command) => command.id === id)!.run(ctx);
    if (!result || !('options' in result)) throw new Error(`${id} did not return a stage`);
    return result;
  };

  it('one node: connect, edit, spotlight, duplicate, z-order, delete — and creation stays available', () => {
    const node = useEditorStore.getState().addNode({ type: 'service', x: 0, y: 0, text: 'API' });
    useEditorStore.getState().setSelection({ nodes: [node.id], edges: [] });
    const list = ids(stubContext());
    expect(list.slice(0, 7)).toEqual(['connect-to', 'edit-text', 'spotlight', 'duplicate', 'bring-to-front', 'send-to-back', 'delete']);
    expect(list).toContain('add-service');
    expect(list).not.toContain('flow-start-here');
    expect(list).not.toContain('group');
  });

  it('Connect to… lists every other node, never the source or a boundary, then create-and-connect options', () => {
    const state = useEditorStore.getState();
    const api = state.addNode({ type: 'service', x: 0, y: 0, text: 'API' });
    const ledger = state.addNode({ type: 'database', x: 300, y: 0, text: 'Ledger' });
    state.addNode({ type: 'group', x: -50, y: -50, width: 800, height: 400, text: 'Payments' });
    state.setSelection({ nodes: [api.id], edges: [] });
    const ctx = stubContext();
    const stage = stageOf(ctx, 'connect-to');
    expect(stage.prompt).toBe('Connect to');
    expect(stage.options.map((o) => o.title)).toEqual(['Ledger', 'New Service', 'New Data Store', 'New Queue', 'New Actor']);

    stage.options[0]!.run(ctx);
    const edges = useEditorStore.getState().document.edges;
    expect(edges).toHaveLength(1);
    expect(edges[0]).toMatchObject({ source: api.id, target: ledger.id });
    expect(useEditorStore.getState().selection.edges).toEqual([edges[0]!.id]);
  });

  it('Connect to… → New Queue creates the node to the right of the source, connects, and selects it', () => {
    const state = useEditorStore.getState();
    const api = state.addNode({ type: 'service', x: 100, y: 100, text: 'API' });
    state.setSelection({ nodes: [api.id], edges: [] });
    const ctx = stubContext();
    const stage = stageOf(ctx, 'connect-to');
    stage.options.find((o) => o.title === 'New Queue')!.run(ctx);
    const after = useEditorStore.getState();
    const queue = after.document.nodes.find((n) => n.type === 'queue')!;
    expect(queue.x).toBeGreaterThan(api.x + api.width);
    expect(after.document.edges[0]).toMatchObject({ source: api.id, target: queue.id });
    expect(after.selection.nodes).toEqual([queue.id]);
  });

  it('Start flow here appears only with an outgoing connector; one connector starts immediately', () => {
    const state = useEditorStore.getState();
    const api = state.addNode({ type: 'service', x: 0, y: 0, text: 'API' });
    const db = state.addNode({ type: 'database', x: 300, y: 0, text: 'DB' });
    const edge = state.connect(api.id, db.id)!;
    state.setSelection({ nodes: [db.id], edges: [] });
    expect(ids(stubContext())).not.toContain('flow-start-here');
    state.setSelection({ nodes: [api.id], edges: [] });
    const ctx = stubContext();
    expect(commandsFor(ctx).find((c) => c.id === 'flow-start-here')!.run(ctx)).toBeUndefined();
    const after = useEditorStore.getState();
    expect(after.document.flows).toHaveLength(1);
    expect(after.document.flows[0]!.steps[0]!.edgeId).toBe(edge.id);
    expect(after.selectedFlowId).toBe(after.document.flows[0]!.id);
  });

  it('Start flow here with several outgoing connectors asks which one', () => {
    const state = useEditorStore.getState();
    const api = state.addNode({ type: 'service', x: 0, y: 0, text: 'API' });
    const db = state.addNode({ type: 'database', x: 300, y: 0, text: 'DB' });
    const q = state.addNode({ type: 'queue', x: 300, y: 200, text: 'Events' });
    state.connect(api.id, db.id);
    state.connect(api.id, q.id);
    state.setSelection({ nodes: [api.id], edges: [] });
    const stage = stageOf(stubContext(), 'flow-start-here');
    expect(stage.options.map((o) => o.title)).toEqual(['API → DB', 'API → Events']);
  });

  it('one connector: relationship, kind, async, response, reverse, reconnect, add to flow, spotlight, edit, delete', () => {
    const state = useEditorStore.getState();
    const api = state.addNode({ type: 'service', x: 0, y: 0, text: 'API' });
    const db = state.addNode({ type: 'database', x: 300, y: 0, text: 'DB' });
    const other = state.addNode({ type: 'queue', x: 300, y: 300, text: 'Q' });
    const edge = state.connect(api.id, db.id)!;
    state.setSelection({ nodes: [], edges: [edge.id] });
    const ctx = stubContext();
    expect(ids(ctx).slice(0, 11)).toEqual([
      'edge-semantic', 'edge-kind', 'edge-async', 'edge-response', 'edge-reverse',
      'edge-reconnect-source', 'edge-reconnect-target', 'edge-add-to-flow', 'spotlight', 'edit-text', 'delete',
    ]);

    const semantics = stageOf(ctx, 'edge-semantic');
    expect(semantics.options.at(-1)!.title).toBe('None');
    semantics.options.find((o) => o.title === 'publishes')!.run(ctx);
    expect(useEditorStore.getState().document.edges[0]!.semantic).toBe('publishes');

    const kinds = stageOf(ctx, 'edge-kind');
    kinds.options.find((o) => o.title === 'Retry')!.run(ctx);
    expect(useEditorStore.getState().document.edges[0]!.kind).toBe('retry');

    // Reconnect never offers the endpoint the connector is already on.
    const targets = stageOf(ctx, 'edge-reconnect-target');
    expect(targets.options.map((o) => o.title)).toEqual(['API', 'Q']);
    targets.options[1]!.run(ctx);
    expect(useEditorStore.getState().document.edges[0]!.target).toBe(other.id);

    commandsFor(ctx).find((c) => c.id === 'edge-reverse')!.run(ctx);
    expect(useEditorStore.getState().document.edges[0]).toMatchObject({ source: other.id, target: api.id });
  });

  it('Add to flow… lists flows it is not in yet, plus New flow', () => {
    const state = useEditorStore.getState();
    const api = state.addNode({ type: 'service', x: 0, y: 0, text: 'API' });
    const db = state.addNode({ type: 'database', x: 300, y: 0, text: 'DB' });
    const edge = state.connect(api.id, db.id)!;
    const checkout = state.createFlow('Checkout');
    state.createFlow('Refund');
    state.addEdgeToFlow(checkout, edge.id);
    state.setSelection({ nodes: [], edges: [edge.id] });
    const ctx = stubContext();
    const stage = stageOf(ctx, 'edge-add-to-flow');
    expect(stage.options.map((o) => o.title)).toEqual(['Refund', 'New flow']);
    stage.options[1]!.run(ctx);
    expect(useEditorStore.getState().document.flows).toHaveLength(3);
  });

  it('multi-selection: group, align, distribute (≥3), spotlight, duplicate, export selection, delete', () => {
    const state = useEditorStore.getState();
    const a = state.addNode({ type: 'service', x: 0, y: 0 });
    const b = state.addNode({ type: 'service', x: 300, y: 40 });
    state.setSelection({ nodes: [a.id, b.id], edges: [] });
    let list = ids(stubContext());
    expect(list).toEqual(expect.arrayContaining(['group', 'align-left', 'align-center-y', 'spotlight', 'duplicate', 'export-selection', 'delete']));
    expect(list).not.toContain('distribute-x');
    expect(list).not.toContain('ungroup');

    const c = state.addNode({ type: 'service', x: 600, y: 0 });
    state.setSelection({ nodes: [a.id, b.id, c.id], edges: [] });
    list = ids(stubContext());
    expect(list).toContain('distribute-x');

    const ctx = stubContext();
    commandsFor(ctx).find((command) => command.id === 'align-top')!.run(ctx);
    expect(new Set(useEditorStore.getState().document.nodes.map((n) => n.y)).size).toBe(1);

    commandsFor(ctx).find((command) => command.id === 'export-selection')!.run(ctx);
    expect(useUiStore.getState().exportOpen).toBe(true);
    expect(useUiStore.getState().exportSelectionRequested).toBe(true);
  });
});
