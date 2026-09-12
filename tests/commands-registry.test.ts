import { beforeEach, describe, expect, it } from 'vitest';
import { commandsFor, primaryCommandsFor } from '../src/commands/registry';
import { rank } from '../src/commands/fuzzy';
import { STARTER_IDS } from '../src/starters';
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
    const checkout = state.createFlow('Checkout')!;
    const ctx = stubContext();
    const stage = commandsFor(ctx).find((command) => command.id === 'switch-flow')!.run(ctx);
    expect(stage && 'options' in stage ? stage.options.map((o) => o.title) : []).toEqual(['Diagram', 'Checkout']);
    if (stage && 'options' in stage) stage.options[1]!.run(ctx);
    expect(useEditorStore.getState().selectedFlowId).toBe(checkout);
  });

  it('"Add to flow…" does not offer a flow the connector is already an extra member of', () => {
    const state = useEditorStore.getState();
    const a = state.addNode({ type: 'service', x: 0, y: 0, text: 'A' });
    const b = state.addNode({ type: 'service', x: 300, y: 0, text: 'B' });
    const c = state.addNode({ type: 'service', x: 600, y: 0, text: 'C' });
    const primary = state.connect(a.id, b.id)!;
    const extra = state.connect(b.id, c.id)!;
    const checkout = state.createFlow('Checkout')!;
    state.createFlow('Refund');
    state.addEdgeToFlow(checkout, primary.id);
    const stepId = useEditorStore.getState().document.flows[0]!.steps[0]!.id;
    state.addFlowStepExtraEdge(checkout, stepId, extra.id);
    state.setSelection({ nodes: [], edges: [extra.id] });

    const ctx = stubContext();
    const command = commandsFor(ctx).find((c) => c.id === 'edge-add-to-flow')!;
    expect(command.hint).toBe('In Checkout');
    const stage = command.run(ctx);
    expect(stage && 'options' in stage ? stage.options.map((o) => o.title) : []).toEqual(['Refund', 'New flow']);
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

  it('one node: connect, edit, attach, clipboard, z-order, spotlight, delete — and creation stays available', () => {
    const node = useEditorStore.getState().addNode({ type: 'service', x: 0, y: 0, text: 'API' });
    useEditorStore.getState().setSelection({ nodes: [node.id], edges: [] });
    const list = ids(stubContext());
    expect(list.slice(0, 14)).toEqual([
      'connect-to',
      'edit-text',
      'attach-note',
      'attach-code',
      'add-data-store',
      'spotlight',
      'duplicate',
      'copy',
      'cut',
      'bring-to-front',
      'bring-forward',
      'send-backward',
      'send-to-back',
      'delete',
    ]);
    expect(list).toContain('add-service');
    expect(list).not.toContain('flow-start-here');
    expect(list).not.toContain('group');
  });

  it('a selected Text node gets a staged "Text role…" command and Bold/Italic toggles', () => {
    const node = useEditorStore.getState().addNode({ type: 'text', x: 0, y: 0, text: 'order-service' });
    useEditorStore.getState().setSelection({ nodes: [node.id], edges: [] });
    const list = ids(stubContext());
    expect(list).toEqual(expect.arrayContaining(['text-role', 'text-toggle-bold', 'text-toggle-italic']));

    const ctx = stubContext();
    const stage = stageOf(ctx, 'text-role');
    expect(stage.prompt).toBe('Text role');
    expect(stage.options.map((o) => o.title)).toEqual(['Body', 'Label', 'Heading', 'Title', 'Technical']);
    expect(stage.options.find((o) => o.title === 'Body')!.hint).toBe('Current');
    expect(stage.options.find((o) => o.title === 'Heading')!.hint).toBeUndefined();

    stage.options.find((o) => o.title === 'Heading')!.run(ctx);
    expect(useEditorStore.getState().document.nodes[0]!.textRole).toBe('heading');

    const bold = commandsFor(ctx).find((c) => c.id === 'text-toggle-bold')!;
    expect(bold.title).toBe('Bold');
    bold.run(ctx);
    expect(useEditorStore.getState().document.nodes[0]!.textBold).toBe(true);
    const boldAgain = commandsFor(stubContext()).find((c) => c.id === 'text-toggle-bold')!;
    expect(boldAgain.title).toBe('Remove bold');
    boldAgain.run(stubContext());
    expect(useEditorStore.getState().document.nodes[0]!.textBold).toBe(false);

    const italic = commandsFor(stubContext()).find((c) => c.id === 'text-toggle-italic')!;
    italic.run(stubContext());
    expect(useEditorStore.getState().document.nodes[0]!.textItalic).toBe(true);
  });

  it('a non-Text node never gets the text-only commands', () => {
    const node = useEditorStore.getState().addNode({ type: 'service', x: 0, y: 0, text: 'API' });
    useEditorStore.getState().setSelection({ nodes: [node.id], edges: [] });
    const list = ids(stubContext());
    expect(list).not.toEqual(expect.arrayContaining(['text-role', 'text-toggle-bold', 'text-toggle-italic']));
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
    expect(stage.options.map((o) => o.title)).toEqual([
      'Ledger',
      'New Service',
      'New Data Store',
      'New Queue',
      'New Actor',
      'New Component',
    ]);

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
    expect(ids(ctx).slice(0, 12)).toEqual([
      'edge-semantic', 'edge-kind', 'edge-async', 'edge-response', 'edge-route-direct', 'edge-reverse',
      'edge-reconnect-source', 'edge-reconnect-target', 'edge-add-to-flow', 'spotlight', 'edit-text', 'delete',
    ]);
    // A lone connector is not part of any fan, so there is nothing to convert.
    expect(ids(ctx)).not.toContain('edge-convert-to-junction');

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
    const checkout = state.createFlow('Checkout')!;
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
    expect(list).toEqual(
      expect.arrayContaining([
        'group',
        'align-left',
        'align-center-y',
        'spotlight',
        'duplicate',
        'copy',
        'cut',
        'bring-to-front',
        'send-to-back',
        'export-selection',
        'delete',
      ]),
    );
    expect(list).not.toContain('distribute-x');
    expect(list).not.toContain('ungroup');
    // No single-step Bring Forward/Send Backward for a multi-selection — only the two extremes.
    expect(list).not.toContain('bring-forward');
    expect(list).not.toContain('send-backward');

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

  it('an edges-only multi-selection has nothing node-shaped to duplicate/copy/cut/reorder/export', () => {
    const state = useEditorStore.getState();
    const a = state.addNode({ type: 'service', x: 0, y: 0 });
    const b = state.addNode({ type: 'database', x: 300, y: 0 });
    const c = state.addNode({ type: 'queue', x: 0, y: 300 });
    const e1 = state.connect(a.id, b.id)!;
    const e2 = state.connect(a.id, c.id)!;
    state.setSelection({ nodes: [], edges: [e1.id, e2.id] });
    const list = ids(stubContext());
    expect(list).toContain('spotlight');
    expect(list).toContain('delete');
    for (const id of ['duplicate', 'copy', 'cut', 'bring-to-front', 'send-to-back', 'export-selection', 'group']) {
      expect(list).not.toContain(id);
    }
  });
});

describe('commandsFor — Queue reliability commands (Add Consumer / Add DLQ)', () => {
  beforeEach(reset);

  function select(id: string) {
    useEditorStore.getState().setSelection({ nodes: [id], edges: [] });
  }

  it('a plain Queue offers both Add Consumer and Add DLQ', () => {
    const q = useEditorStore.getState().addNode({ type: 'queue', x: 0, y: 0 });
    select(q.id);
    const list = ids(stubContext());
    expect(list).toContain('add-consumer');
    expect(list).toContain('add-dead-letter-queue');
    expect(list).not.toContain('remove-dead-letter-queue');
  });

  it('a Topic offers neither — failure handling belongs to a subscription path Draft Canvas does not model yet', () => {
    const topic = useEditorStore.getState().addNode({ type: 'queue', queueKind: 'topic', x: 0, y: 0 });
    select(topic.id);
    const list = ids(stubContext());
    expect(list).not.toContain('add-consumer');
    expect(list).not.toContain('add-dead-letter-queue');
    expect(list).not.toContain('remove-dead-letter-queue');
  });

  it('a Stream offers Add Consumer but not Add DLQ — its dead-letter destination is typically a separate topic', () => {
    const stream = useEditorStore.getState().addNode({ type: 'queue', queueKind: 'stream', x: 0, y: 0 });
    select(stream.id);
    const list = ids(stubContext());
    expect(list).toContain('add-consumer');
    expect(list).not.toContain('add-dead-letter-queue');
  });

  it('a generated DLQ node offers Add Consumer but never a DLQ of its own', () => {
    const state = useEditorStore.getState();
    const q = state.addNode({ type: 'queue', x: 0, y: 0 });
    state.addDeadLetterQueue(q.id);
    const dlq = useEditorStore.getState().document.nodes.find((n) => n.deliveryRole === 'dead-letter')!;
    select(dlq.id);
    const list = ids(stubContext());
    expect(list).toContain('add-consumer');
    expect(list).not.toContain('add-dead-letter-queue');
    expect(list).not.toContain('remove-dead-letter-queue');
  });

  it('a Queue that already has a DLQ offers Remove DLQ instead of Add DLQ', () => {
    const state = useEditorStore.getState();
    const q = state.addNode({ type: 'queue', x: 0, y: 0 });
    state.addDeadLetterQueue(q.id);
    select(q.id);
    const list = ids(stubContext());
    expect(list).toContain('remove-dead-letter-queue');
    expect(list).not.toContain('add-dead-letter-queue');
  });

  it('running "Add DLQ" from the command list actually creates the companion', () => {
    const q = useEditorStore.getState().addNode({ type: 'queue', x: 0, y: 0 });
    select(q.id);
    const ctx = stubContext();
    commandsFor(ctx).find((command) => command.id === 'add-dead-letter-queue')!.run(ctx);
    expect(useEditorStore.getState().document.nodes).toHaveLength(2);
  });

  it('a Topic offers Add Subscriber, a plain Queue and a Stream do not', () => {
    const topic = useEditorStore.getState().addNode({ type: 'queue', queueKind: 'topic', x: 0, y: 0 });
    select(topic.id);
    expect(ids(stubContext())).toContain('add-subscriber');

    const q = useEditorStore.getState().addNode({ type: 'queue', x: 0, y: 0 });
    select(q.id);
    expect(ids(stubContext())).not.toContain('add-subscriber');

    const stream = useEditorStore.getState().addNode({ type: 'queue', queueKind: 'stream', x: 0, y: 0 });
    select(stream.id);
    expect(ids(stubContext())).not.toContain('add-subscriber');
  });

  it('running "Add Subscriber" creates a fanned-out Queue in one undo step', () => {
    const topic = useEditorStore.getState().addNode({ type: 'queue', queueKind: 'topic', x: 0, y: 0 });
    select(topic.id);
    const ctx = stubContext();
    commandsFor(ctx).find((command) => command.id === 'add-subscriber')!.run(ctx);
    const state = useEditorStore.getState();
    expect(state.document.nodes).toHaveLength(2);
    const subscriber = state.document.nodes.find((n) => n.id !== topic.id)!;
    expect(subscriber.type).toBe('queue');
    expect(state.document.edges).toMatchObject([{ source: topic.id, target: subscriber.id, semantic: 'fansOut' }]);
    expect(state.selection.nodes).toEqual([subscriber.id]);
    state.undo();
    expect(useEditorStore.getState().document.nodes).toHaveLength(1);
    expect(useEditorStore.getState().document.edges).toHaveLength(0);
  });

  it('Add Subscriber is repeatable — a topic can fan out to several queues', () => {
    const topic = useEditorStore.getState().addNode({ type: 'queue', queueKind: 'topic', x: 0, y: 0 });
    select(topic.id);
    const ctx = stubContext();
    commandsFor(ctx).find((command) => command.id === 'add-subscriber')!.run(ctx);
    select(topic.id);
    commandsFor(ctx).find((command) => command.id === 'add-subscriber')!.run(ctx);
    const state = useEditorStore.getState();
    expect(state.document.nodes).toHaveLength(3);
    expect(state.document.edges).toHaveLength(2);
  });
});

/**
 * The primary popover's quick-actions row (`ElementInspectorPopover`) sources its 0-3 shape-native
 * buttons from `primaryCommandsFor` — the same commands (same ids/`run`) `nodeCommands` would
 * include, computed directly rather than filtered from the full palette/context-menu list. These
 * tests pin exactly which kinds get a primary row today and that it stays declarative (no shape
 * gets more than the handful of actions the audit called out).
 */
describe('primaryCommandsFor — primary popover quick actions', () => {
  beforeEach(reset);

  const primaryIds = (node: { id: string }) =>
    primaryCommandsFor(stubContext(), useEditorStore.getState().document.nodes.find((n) => n.id === node.id)!).map(
      (command) => command.id,
    );

  it('a plain Queue with no DLQ offers Add Consumer + Add DLQ', () => {
    const q = useEditorStore.getState().addNode({ type: 'queue', x: 0, y: 0 });
    expect(primaryIds(q)).toEqual(['add-consumer', 'add-dead-letter-queue']);
  });

  it('a Queue that already has a DLQ offers Add Consumer + Remove DLQ', () => {
    const state = useEditorStore.getState();
    const q = state.addNode({ type: 'queue', x: 0, y: 0 });
    state.addDeadLetterQueue(q.id);
    expect(primaryIds(q)).toEqual(['add-consumer', 'remove-dead-letter-queue']);
  });

  it('a Topic offers only Add Subscriber', () => {
    const topic = useEditorStore.getState().addNode({ type: 'queue', queueKind: 'topic', x: 0, y: 0 });
    expect(primaryIds(topic)).toEqual(['add-subscriber']);
  });

  it('a Stream offers only Add Consumer', () => {
    const stream = useEditorStore.getState().addNode({ type: 'queue', queueKind: 'stream', x: 0, y: 0 });
    expect(primaryIds(stream)).toEqual(['add-consumer']);
  });

  it('a Group offers only Ungroup', () => {
    const group = useEditorStore.getState().addNode({ type: 'group', x: 0, y: 0, width: 400, height: 300 });
    expect(primaryIds(group)).toEqual(['ungroup']);
  });

  it('a Service that owns data offers Add Data Store; a Gateway offers Add Service; the rest offer nothing', () => {
    const state = useEditorStore.getState();
    for (const serviceKind of ['generic', 'api', 'worker'] as const) {
      const service = state.addNode({ type: 'service', serviceKind, x: 0, y: 0 });
      expect(primaryIds(service)).toEqual(['add-data-store']);
    }
    const gateway = state.addNode({ type: 'service', serviceKind: 'gateway', x: 0, y: 0 });
    expect(primaryIds(gateway)).toEqual(['add-routed-service']);
    // An external system's storage isn't ours to draw; a scheduler fires jobs, it doesn't persist.
    for (const serviceKind of ['external', 'scheduler'] as const) {
      const service = state.addNode({ type: 'service', serviceKind, x: 0, y: 0 });
      expect(primaryIds(service)).toEqual([]);
    }
  });

  it('kinds with no dedicated shape-native command offer nothing — a graceful empty row', () => {
    const state = useEditorStore.getState();
    const database = state.addNode({ type: 'database', x: 0, y: 0 });
    const junction = state.addNode({ type: 'ellipse', x: 0, y: 0 });
    const actor = state.addNode({ type: 'actor', x: 0, y: 0 });
    const note = state.addNode({ type: 'note', x: 0, y: 0 });
    for (const node of [database, junction, actor, note]) {
      expect(primaryIds(node)).toEqual([]);
    }
  });
});

/**
 * Architecture Starters reach the palette as ordinary commands. What is worth pinning is the
 * search behaviour: a starter has to answer to how people actually say its name, without ever
 * taking a word that already belongs to a shape.
 */
describe('architecture starters', () => {
  beforeEach(reset);

  const top = (query: string) => rank(query, commandsFor(stubContext()))[0]!.entry.id;

  it('offers one row per starter, under Architectures then Patterns, each with a one-line description', () => {
    const starters = commandsFor(stubContext()).filter(
      (command) => command.group === 'starter' || command.group === 'pattern',
    );
    expect(starters.map((command) => command.id)).toEqual(STARTER_IDS.map((id) => `starter-${id}`));
    for (const command of starters) {
      expect(command.hint).toBeTruthy();
      expect(command.title).not.toMatch(/template/i);
    }
    // The two headers stay contiguous: every architecture precedes every pattern.
    const groups = starters.map((command) => command.group);
    expect(groups.lastIndexOf('starter')).toBeLessThan(groups.indexOf('pattern'));
    expect(starters.filter((command) => command.group === 'pattern').map((command) => command.id)).toEqual([
      'starter-saga-orchestration',
      'starter-saga-choreography',
      'starter-transactional-outbox',
    ]);
  });

  it.each([
    ['monolith', 'monolith'],
    ['monolithic', 'monolith'],
    ['modular monolith', 'modular-monolith'],
    ['modular architecture', 'modular-monolith'],
    ['modules', 'modular-monolith'],
    ['microservices', 'microservices'],
    ['microservice', 'microservices'],
    ['distributed services', 'microservices'],
    ['event driven', 'event-driven'],
    ['event-driven', 'event-driven'],
    ['events', 'event-driven'],
    ['event architecture', 'event-driven'],
    ['pub sub', 'event-driven'],
    ['messaging', 'event-driven'],
    ['hexagonal', 'hexagonal'],
    ['ports and adapters', 'hexagonal'],
    ['ports adapters', 'hexagonal'],
    ['hex architecture', 'hexagonal'],
    ['clean-ish architecture', 'hexagonal'],
    ['bff', 'bff'],
    ['backend for frontend', 'bff'],
    ['cqrs', 'cqrs'],
    ['command query', 'cqrs'],
    ['read model', 'cqrs'],
    ['saga orchestration', 'saga-orchestration'],
    ['orchestrator', 'saga-orchestration'],
    ['compensation', 'saga-orchestration'],
    ['distributed transaction', 'saga-orchestration'],
    ['saga choreography', 'saga-choreography'],
    ['choreography', 'saga-choreography'],
    ['no orchestrator', 'saga-choreography'],
    ['outbox', 'transactional-outbox'],
    ['dual write', 'transactional-outbox'],
  ])('"%s" leads with the %s starter', (query, id) => {
    expect(top(query)).toBe(`starter-${id}`);
  });

  it('"saga" leads with the two saga starters, side by side', () => {
    const ids = rank('saga', commandsFor(stubContext()))
      .slice(0, 2)
      .map((entry) => entry.entry.id)
      .sort();
    expect(ids).toEqual(['starter-saga-choreography', 'starter-saga-orchestration']);
  });

  it.each([
    ['serv', 'add-service'],
    ['service', 'add-service'],
    ['db', 'add-database'],
    ['data store', 'add-database'],
    ['queue', 'add-queue'],
    ['topic', 'add-queue'],
    ['note', 'add-note'],
    ['code', 'add-code'],
    ['actor', 'add-actor'],
    ['boundary', 'add-boundary'],
  ])('never takes "%s" away from %s', (query, id) => {
    expect(top(query)).toBe(id);
  });

  it('a selected service\'s own continuations never take "data store" or "service" away from creation', () => {
    const state = useEditorStore.getState();
    const gateway = state.addNode({ type: 'service', serviceKind: 'gateway', x: 0, y: 0 });
    state.setSelection({ nodes: [gateway.id], edges: [] });
    expect(top('service')).toBe('add-service');
    const api = state.addNode({ type: 'service', serviceKind: 'api', x: 0, y: 300 });
    state.setSelection({ nodes: [api.id], edges: [] });
    expect(top('data store')).toBe('add-database');
    expect(top('connect data store')).toBe('add-data-store');
  });

  it('inserts the architecture and moves the camera onto it', () => {
    const ctx = stubContext();
    commandsFor(ctx).find((command) => command.id === 'starter-microservices')!.run(ctx);
    expect(useEditorStore.getState().document.nodes).toHaveLength(12);
    expect(useEditorStore.getState().selection.nodes).toHaveLength(12);
    // The command context's `document` predates its own insert, so the camera move has to come
    // from what the store handed back — see `focusBounds`.
    expect(ctx.camera.setViewport).toHaveBeenCalledTimes(1);
  });

  it('is not on offer while presenting', () => {
    useEditorStore.getState().setMode('present');
    expect(ids(stubContext()).some((id) => id.startsWith('starter-'))).toBe(false);
  });
});
