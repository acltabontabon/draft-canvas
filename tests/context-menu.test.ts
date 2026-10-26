import { beforeEach, describe, expect, it } from 'vitest';
import { plainShortcut } from '../src/lib/platform';
import { contextMenuCommandsFor, menuItemsOf, type ContextMenuEntry } from '../src/commands/contextMenu';
import type { CommandContext } from '../src/commands/types';
import { createDocument } from '../src/document/factory';
import { stubContext } from './commandStubs';
import { __resetInteraction, useEditorStore } from '../src/store/editorStore';
import { useUiStore } from '../src/store/uiStore';

function reset() {
  __resetInteraction();
  useEditorStore.setState({
    document: createDocument('Context menu'),
    history: { past: [], future: [] },
    selection: { nodes: [], edges: [] },
    clipboard: null,
    pasteRepeat: 0,
    revision: 0,
    mode: 'edit',
    flowPlayback: { active: false, flowId: null, step: 0 },
    focus: { active: false, nodeIds: [], edgeIds: [] },
    selectedFlowId: null,
  });
  useUiStore.setState({ commandPaletteOpen: false, contextMenu: null });
}

/** Every runnable item's id, grid cells and icon buttons included. */
const idsOf = (entries: ContextMenuEntry[]) => menuItemsOf(entries).map((item) => item.command.id);

/** The menu's shape: a row per command id, `sep`, `header`, and one token per grid or icon row. */
const layout = (entries: ContextMenuEntry[]) =>
  entries.map((entry) => (entry.type === 'command' ? entry.command.id : entry.type === 'separator' ? 'sep' : entry.type));

const itemFor = (entries: ContextMenuEntry[], id: string) => menuItemsOf(entries).find((item) => item.command.id === id)!;

const pane = (ctx: CommandContext, position = { x: 0, y: 0 }) => contextMenuCommandsFor(ctx, { kind: 'pane' }, position);

describe('contextMenuCommandsFor — empty canvas', () => {
  beforeEach(reset);

  it('offers every shape preset, including Boundary, architecture shapes first', () => {
    const list = idsOf(pane(stubContext()));
    expect(list).toEqual([
      'paste',
      'add-service',
      'add-database',
      'add-queue',
      'add-actor',
      'add-component',
      'add-boundary',
      'add-note',
      'add-code',
      'add-text',
      'add-ellipse',
      'fit',
      // What acts on the whole diagram, now that the header has no ⋯.
      'find-replace',
      'settings',
    ]);
  });

  it('labels the shape grid by shape alone — the grid is already headed "Add here"', () => {
    const grid = pane(stubContext()).find((entry) => entry.type === 'grid')!;
    expect(grid.label).toBe('Add here');
    expect(grid.items.map((item) => item.label).slice(0, 3)).toEqual(['Service', 'Data Store', 'Queue']);
  });

  it('offers Undo and Tidy up layout once there is something to undo and arrange', () => {
    useEditorStore.getState().addNode({ type: 'service', x: 0, y: 0 });
    const entries = pane(stubContext());
    expect(idsOf(entries)).toEqual(expect.arrayContaining(['undo', 'select-all', 'fit', 'arrange']));
    expect(itemFor(entries, 'arrange').label).toBe('Tidy up layout');
  });

  it('still offers Paste when the in-app clipboard is empty, since the OS clipboard may hold something', () => {
    expect(idsOf(pane(stubContext()))).toContain('paste');
  });

  it('includes Paste, with the ⌘V shortcut hint, once something is copied', () => {
    useEditorStore.getState().addNode({ type: 'note', x: 0, y: 0, text: 'x' });
    useEditorStore.getState().setSelection({ nodes: [useEditorStore.getState().document.nodes[0]!.id], edges: [] });
    useEditorStore.getState().copySelection();
    const entries = pane(stubContext());
    expect(idsOf(entries)).toContain('paste');
    const paste = itemFor(entries, 'paste');
    expect(paste?.command.shortcut).toMatch(/V$/);
  });

  it('hides Select All on an empty document, shows it once a node exists', () => {
    expect(idsOf(pane(stubContext()))).not.toContain('select-all');
    useEditorStore.getState().addNode({ type: 'note', x: 0, y: 0, text: 'x' });
    expect(idsOf(pane(stubContext()))).toContain('select-all');
  });

  it('puts the shapes in one grid between Paste/Undo and Select all/Fit to view', () => {
    useEditorStore.getState().addNode({ type: 'note', x: 0, y: 0, text: 'x' });
    useEditorStore.getState().setSelection({ nodes: [useEditorStore.getState().document.nodes[0]!.id], edges: [] });
    useEditorStore.getState().copySelection();
    const entries = pane(stubContext());
    // Paste and Undo, the shapes, selection and view, then the whole diagram.
    expect(layout(entries)).toEqual(['paste', 'undo', 'sep', 'grid', 'sep', 'select-all', 'fit', 'sep', 'find-replace', 'settings']);
  });

  it('an Add command creates the node centered on the exact clicked position, not the tracked pointer', () => {
    const ctx = stubContext();
    const entries = pane(ctx, { x: 300, y: 450 });
    const addService = itemFor(entries, 'add-service');
    addService.command.run(ctx);
    const node = useEditorStore.getState().document.nodes[0]!;
    expect(node.type).toBe('service');
    // `-88,-34` centers a default-sized (176×68) node under the click point — the same convention
    // `createAtPointer`/double-click-to-create already use, not a new one.
    expect(node.x + node.width / 2).toBe(300);
    expect(node.y + node.height / 2).toBe(450);
  });

  it('Add Boundary creates a group-type node with the default boundary size', () => {
    const ctx = stubContext();
    const entries = pane(ctx, { x: 10, y: 10 });
    const addBoundary = itemFor(entries, 'add-boundary');
    addBoundary.command.run(ctx);
    const node = useEditorStore.getState().document.nodes[0]!;
    expect(node.type).toBe('group');
    expect(node.width).toBeGreaterThan(0);
    expect(node.height).toBeGreaterThan(0);
  });

  it('Paste lands the copied fragment exactly at the clicked point, ignoring paste-repeat stagger', async () => {
    useEditorStore.getState().addNode({ type: 'note', x: 100, y: 100, text: 'x' });
    useEditorStore.getState().setSelection({ nodes: [useEditorStore.getState().document.nodes[0]!.id], edges: [] });
    useEditorStore.getState().copySelection();
    // Simulate an unrelated prior paste elsewhere, which would normally stagger the next one.
    useEditorStore.getState().paste({ x: 500, y: 500 });
    expect(useEditorStore.getState().pasteRepeat).toBeGreaterThan(0);

    const ctx = stubContext();
    const entries = pane(ctx, { x: 900, y: 900 });
    const paste = itemFor(entries, 'paste');
    paste.command.run(ctx);
    // `run` fires an async clipboard sync before the actual paste — flush the microtask queue
    // (jsdom has no real Clipboard API, so the sync itself resolves as a fast no-op).
    await new Promise((resolve) => setTimeout(resolve, 0));
    const pastedNotes = useEditorStore.getState().document.nodes.filter((n) => n.type === 'note');
    const last = pastedNotes.at(-1)!;
    expect(last.x + last.width / 2).toBeCloseTo(900, 0);
    expect(last.y + last.height / 2).toBeCloseTo(900, 0);
  });
});

describe('contextMenuCommandsFor — targets not yet implemented', () => {
  beforeEach(reset);

  it('returns nothing for a selection target (a later phase)', () => {
    const ctx = stubContext();
    expect(contextMenuCommandsFor(ctx, { kind: 'selection' }, { x: 0, y: 0 })).toEqual([]);
  });

  it('returns nothing for a node id that no longer resolves (deleted while the menu was open)', () => {
    const ctx = stubContext();
    expect(contextMenuCommandsFor(ctx, { kind: 'node', id: 'gone' }, { x: 0, y: 0 })).toEqual([]);
  });
});

describe('contextMenuCommandsFor — a regular node', () => {
  beforeEach(reset);

  const nodeMenu = (id: string) => contextMenuCommandsFor(stubContext(), { kind: 'node', id }, { x: 0, y: 0 });

  it('curates a small, grouped subset — no Connect to…, no Start flow here with 2+ outgoing edges', () => {
    const state = useEditorStore.getState();
    const api = state.addNode({ type: 'service', x: 0, y: 0, text: 'API' });
    const db = state.addNode({ type: 'database', x: 200, y: 0, text: 'DB' });
    const q = state.addNode({ type: 'queue', x: 200, y: 200, text: 'Q' });
    state.connect(api.id, db.id);
    state.connect(api.id, q.id);
    const entries = nodeMenu(api.id);
    const types = layout(entries);
    expect(types).toEqual([
      'header',
      'edit-text',
      // A Service can always be looked inside, whether or not anything is in there yet.
      'look-inside',
      'sep',
      'attach-note',
      'attach-code',
      'open-point-add',
      'sep',
      // Cut and the one-step z-order pair are left to ⌘K and their shortcuts.
      'duplicate',
      'copy',
      'bring-to-front',
      'send-to-back',
      'sep',
      'spotlight',
      'sep',
      'delete',
    ]);
    expect(entries[0]).toEqual({ type: 'header', title: 'API', caption: 'Service' });
    // Neither is offered: both would return a `CommandStage` (the stage-command rule) —
    // `connect-to` always would, `flow-start-here` would here since there are 2 outgoing edges.
    expect(types).not.toContain('connect-to');
    expect(types).not.toContain('flow-start-here');
  });

  it('includes Start flow here when there is exactly one outgoing edge (it resolves directly, no stage)', () => {
    const state = useEditorStore.getState();
    const api = state.addNode({ type: 'service', x: 0, y: 0, text: 'API' });
    const db = state.addNode({ type: 'database', x: 200, y: 0, text: 'DB' });
    state.connect(api.id, db.id);
    const ids = idsOf(nodeMenu(api.id));
    expect(ids).toContain('flow-start-here');
  });

  it('hides Add Note/Add Code once the attachment cap is reached', () => {
    const state = useEditorStore.getState();
    const api = state.addNode({ type: 'service', x: 0, y: 0, text: 'API' });
    for (let i = 0; i < 12; i += 1) {
      state.attachToNode(api.id, { id: `a${i}`, type: 'note' });
    }
    const ids = idsOf(nodeMenu(api.id));
    expect(ids).not.toContain('attach-note');
    expect(ids).not.toContain('attach-code');
  });

  it('offers Edit text for a Queue, which can be named like any other node', () => {
    const queue = useEditorStore.getState().addNode({ type: 'queue', x: 0, y: 0 });
    const ids = idsOf(nodeMenu(queue.id));
    expect(ids).toContain('edit-text');
  });

  it('a plain Queue gets Add consumer and Add DLQ right after Edit text, before the attachments', () => {
    const queue = useEditorStore.getState().addNode({ type: 'queue', x: 0, y: 0 });
    const entries = nodeMenu(queue.id);
    const types = layout(entries);
    expect(types).toEqual([
      'header',
      'edit-text',
      'sep',
      'add-consumer',
      'add-dead-letter-queue',
      'sep',
      'attach-note',
      'attach-code',
      'open-point-add',
      'sep',
      'duplicate',
      'copy',
      'bring-to-front',
      'send-to-back',
      'sep',
      'spotlight',
      'sep',
      'delete',
    ]);
    expect(itemFor(entries, 'add-consumer').label).toBe('Add consumer');
    expect(itemFor(entries, 'attach-note').label).toBe('Attach note');
    expect(itemFor(entries, 'spotlight').label).toBe('Spotlight');
  });

  it('a Topic gets neither reliability command, and no orphaned separator', () => {
    const topic = useEditorStore.getState().addNode({ type: 'queue', queueKind: 'topic', x: 0, y: 0 });
    const ids = idsOf(nodeMenu(topic.id));
    expect(ids).not.toContain('add-consumer');
    expect(ids).not.toContain('add-dead-letter-queue');
    expect(ids).not.toContain('remove-dead-letter-queue');
  });
});

describe('contextMenuCommandsFor — a junction', () => {
  beforeEach(reset);

  it('is deliberately smaller than a regular node: no Add Note/Add Code, no single-step z-order', () => {
    const junction = useEditorStore.getState().addNode({ type: 'ellipse', x: 0, y: 0 });
    const entries = contextMenuCommandsFor(stubContext(), { kind: 'node', id: junction.id }, { x: 0, y: 0 });
    const types = layout(entries);
    expect(types).toEqual([
      'header',
      'edit-text',
      'sep',
      'duplicate',
      'copy',
      'bring-to-front',
      'send-to-back',
      'sep',
      'spotlight',
      'sep',
      'delete',
    ]);
  });
});

describe('contextMenuCommandsFor — an edge', () => {
  beforeEach(reset);

  const edgeMenu = (id: string) => contextMenuCommandsFor(stubContext(), { kind: 'edge', id }, { x: 0, y: 0 });

  it('curates a small, grouped subset — no Change relationship…/Change kind…/Reconnect…/Add to flow…, no Duplicate/Copy/Cut', () => {
    const state = useEditorStore.getState();
    const api = state.addNode({ type: 'service', x: 0, y: 0 });
    const db = state.addNode({ type: 'database', x: 200, y: 0 });
    const edge = state.connect(api.id, db.id)!;
    const entries = edgeMenu(edge.id);
    const types = layout(entries);
    expect(types).toEqual([
      'header',
      'edit-text',
      'sep',
      'edge-reverse',
      'edge-async',
      'edge-response',
      'edge-route-direct',
      'edge-pin-ends',
      'sep',
      'attach-note',
      'attach-code',
      'open-point-add',
      'sep',
      'spotlight',
      'sep',
      'delete',
    ]);
    // This connector is on its own, so "Convert to junction" has no shared
    // trunk to convert and must not be offered — the more valuable half of
    // this assertion, since the entry is conditional.
    expect(types).not.toContain('edge-convert-to-junction');
  });

  it('offers Convert to junction only for a connector drawn through a shared trunk', () => {
    const state = useEditorStore.getState();
    const hub = state.addNode({ type: 'service', x: 0, y: 400, text: 'Hub' });
    const edges = [0, 1, 2].map((i) => {
      const target = state.addNode({ type: 'service', x: 700, y: i * 220, text: `T${i}` });
      return state.connect(hub.id, target.id)!;
    });
    const types = layout(edgeMenu(edges[0]!.id));
    expect(types).toContain('edge-convert-to-junction');
  });

  it('hides Add Note/Add Code once the (lower, edge-specific) attachment cap is reached', () => {
    const state = useEditorStore.getState();
    const api = state.addNode({ type: 'service', x: 0, y: 0 });
    const db = state.addNode({ type: 'database', x: 200, y: 0 });
    const edge = state.connect(api.id, db.id)!;
    for (let i = 0; i < 4; i += 1) {
      state.attachToEdge(edge.id, { id: `a${i}`, type: 'note' });
    }
    const ids = idsOf(edgeMenu(edge.id));
    expect(ids).not.toContain('attach-note');
    expect(ids).not.toContain('attach-code');
  });

  it('returns nothing for an edge id that no longer resolves', () => {
    expect(edgeMenu('gone')).toEqual([]);
  });
});

describe('contextMenuCommandsFor — a boundary', () => {
  beforeEach(reset);

  const boundaryMenu = (id: string) => contextMenuCommandsFor(stubContext(), { kind: 'node', id }, { x: 0, y: 0 });

  it('hides Select Contents on an empty boundary', () => {
    const boundary = useEditorStore.getState().addNode({ type: 'group', x: 0, y: 0, width: 400, height: 300 });
    const types = layout(boundaryMenu(boundary.id));
    expect(types).toEqual([
      'header',
      'edit-text',
      'sep',
      'attach-note',
      'attach-code',
      'open-point-add',
      'sep',
      'duplicate',
      'copy',
      'bring-to-front',
      'send-to-back',
      'sep',
      'spotlight',
      'sep',
      'ungroup',
      'delete',
    ]);
  });

  it('shows Select Contents, with a count hint, once the boundary has descendants — including a nested boundary\'s own contents', () => {
    const state = useEditorStore.getState();
    const outer = state.addNode({ type: 'group', x: 0, y: 0, width: 800, height: 600 });
    const inner = state.addNode({ type: 'group', x: 50, y: 50, width: 300, height: 200, parentId: outer.id });
    const service = state.addNode({ type: 'service', x: 100, y: 100, parentId: inner.id });
    const db = state.addNode({ type: 'database', x: 500, y: 100, parentId: outer.id });
    const internalEdge = state.connect(service.id, db.id)!;

    const entries = boundaryMenu(outer.id);
    const selectContents = itemFor(entries, 'select-contents');
    expect(selectContents.command.hint).toBe('3 elements');

    const ctx = stubContext();
    selectContents.command.run(ctx);
    const selection = useEditorStore.getState().selection;
    expect(new Set(selection.nodes)).toEqual(new Set([inner.id, service.id, db.id]));
    expect(selection.edges).toEqual([internalEdge.id]);
  });

  it('returns nothing for a boundary id that no longer resolves', () => {
    expect(boundaryMenu('gone')).toEqual([]);
  });
});

describe('contextMenuCommandsFor — a multi-selection', () => {
  beforeEach(reset);

  const selectionMenu = () => contextMenuCommandsFor(stubContext(), { kind: 'selection' }, { x: 0, y: 0 });

  it('shows Align but not Distribute at exactly 2 nodes; both at 3+', () => {
    const state = useEditorStore.getState();
    const a = state.addNode({ type: 'service', x: 0, y: 0 });
    const b = state.addNode({ type: 'service', x: 300, y: 0 });
    state.setSelection({ nodes: [a.id, b.id], edges: [] });
    let ids = idsOf(selectionMenu());
    expect(ids).toContain('align-left');
    expect(ids).not.toContain('distribute-x');
    // Only the two z-order extremes here, never the single-step pair — see `selectionMenu`'s comment.
    expect(ids).toContain('bring-to-front');
    expect(ids).not.toContain('bring-forward');

    const c = state.addNode({ type: 'service', x: 600, y: 0 });
    state.setSelection({ nodes: [a.id, b.id, c.id], edges: [] });
    ids = idsOf(selectionMenu());
    // Align and distribute share one row of icons under a header that counts the selection.
    expect(selectionMenu()[0]).toEqual({ type: 'header', title: '3 elements' });
    expect(selectionMenu().find((entry) => entry.type === 'icons')?.items).toHaveLength(8);
    expect(ids).toContain('align-left');
    expect(ids).toContain('distribute-x');
  });

  it('an edges-only multi-selection shows only Spotlight, Delete and a shared open point', () => {
    const state = useEditorStore.getState();
    const a = state.addNode({ type: 'service', x: 0, y: 0 });
    const b = state.addNode({ type: 'database', x: 300, y: 0 });
    const c = state.addNode({ type: 'queue', x: 0, y: 300 });
    const e1 = state.connect(a.id, b.id)!;
    const e2 = state.connect(a.id, c.id)!;
    state.setSelection({ nodes: [], edges: [e1.id, e2.id] });
    const types = layout(selectionMenu());
    // …plus one shared open point about both connectors, which any selection may raise.
    expect(types).toEqual(['header', 'open-point-add', 'sep', 'spotlight', 'sep', 'delete']);
  });

  it('Group → Ungroup round-trips via the menu', () => {
    const state = useEditorStore.getState();
    const a = state.addNode({ type: 'service', x: 0, y: 0 });
    const b = state.addNode({ type: 'service', x: 300, y: 0 });
    state.setSelection({ nodes: [a.id, b.id], edges: [] });
    const ctx = stubContext();
    const group = itemFor(selectionMenu(), 'group');
    group.command.run(ctx);
    const boundary = useEditorStore.getState().document.nodes.find((n) => n.type === 'group')!;
    expect(boundary).toBeDefined();
    expect(useEditorStore.getState().selection.nodes).toEqual([boundary.id]);

    useEditorStore.getState().setSelection({ nodes: [boundary.id], edges: [] });
    const ungroupCtx = stubContext();
    // A single selected boundary goes through the node menu, not the multi-selection one — reuses
    // the identical `ungroup` command either way.
    const nodeEntries = contextMenuCommandsFor(ungroupCtx, { kind: 'node', id: boundary.id }, { x: 0, y: 0 });
    const ungroup = itemFor(nodeEntries, 'ungroup');
    ungroup.command.run(ungroupCtx);
    expect(useEditorStore.getState().document.nodes.some((n) => n.type === 'group')).toBe(false);
  });

  it('returns nothing once the selection drops below 2 members', () => {
    useEditorStore.getState().addNode({ type: 'service', x: 0, y: 0 });
    useEditorStore.getState().setSelection({ nodes: [useEditorStore.getState().document.nodes[0]!.id], edges: [] });
    expect(selectionMenu()).toEqual([]);
  });
});

describe('plainShortcut', () => {
  it('runs Mac symbols together', () => {
    expect(plainShortcut('⌘ D', true)).toBe('⌘D');
    expect(plainShortcut('Shift 1', true)).toBe('⇧1');
    expect(plainShortcut('Backspace', true)).toBe('⌫');
  });

  it('spells keys out with + elsewhere', () => {
    expect(plainShortcut('Ctrl Shift Z', false)).toBe('Ctrl+Shift+Z');
    expect(plainShortcut('Backspace', false)).toBe('Backspace');
  });
});
