import { beforeEach, describe, expect, it } from 'vitest';
import { contextMenuCommandsFor, type ContextMenuEntry } from '../src/commands/contextMenu';
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
    flowEdit: { active: false, flowId: null },
    selectedFlowId: null,
  });
  useUiStore.setState({ commandPaletteOpen: false, learnModeActive: false, contextMenu: null });
}

const ids = (entries: ContextMenuEntry[]) =>
  entries.filter((entry): entry is Extract<ContextMenuEntry, { type: 'command' }> => entry.type === 'command').map((entry) => entry.command.id);

const pane = (ctx: CommandContext, position = { x: 0, y: 0 }) => contextMenuCommandsFor(ctx, { kind: 'pane' }, position);

describe('contextMenuCommandsFor — empty canvas', () => {
  beforeEach(reset);

  it('offers every shape preset, including Boundary, in ALL_PRESETS order', () => {
    const list = ids(pane(stubContext()));
    expect(list).toEqual([
      'add-text',
      'add-note',
      'add-code',
      'add-boundary',
      'add-service',
      'add-database',
      'add-queue',
      'add-actor',
      'add-ellipse',
    ]);
  });

  it('never includes Paste when the clipboard is empty', () => {
    expect(ids(pane(stubContext()))).not.toContain('paste');
  });

  it('includes Paste, with the ⌘V shortcut hint, once something is copied', () => {
    useEditorStore.getState().addNode({ type: 'note', x: 0, y: 0, text: 'x' });
    useEditorStore.getState().setSelection({ nodes: [useEditorStore.getState().document.nodes[0]!.id], edges: [] });
    useEditorStore.getState().copySelection();
    const entries = pane(stubContext());
    expect(ids(entries)).toContain('paste');
    const paste = entries.find((e): e is Extract<ContextMenuEntry, { type: 'command' }> => e.type === 'command' && e.command.id === 'paste');
    expect(paste?.command.shortcut).toMatch(/V$/);
  });

  it('hides Select All on an empty document, shows it once a node exists', () => {
    expect(ids(pane(stubContext()))).not.toContain('select-all');
    useEditorStore.getState().addNode({ type: 'note', x: 0, y: 0, text: 'x' });
    expect(ids(pane(stubContext()))).toContain('select-all');
  });

  it('groups Add commands into one separator-delimited block, with Paste before and Select All after', () => {
    useEditorStore.getState().addNode({ type: 'note', x: 0, y: 0, text: 'x' });
    useEditorStore.getState().setSelection({ nodes: [useEditorStore.getState().document.nodes[0]!.id], edges: [] });
    useEditorStore.getState().copySelection();
    const entries = pane(stubContext());
    const types = entries.map((entry) => (entry.type === 'separator' ? 'sep' : entry.command.id));
    expect(types[0]).toBe('paste');
    expect(types[1]).toBe('sep');
    expect(types.at(-1)).toBe('select-all');
    expect(types.at(-2)).toBe('sep');
    // Exactly two separators: one after Paste, one before Select All.
    expect(types.filter((t) => t === 'sep')).toHaveLength(2);
  });

  it('an Add command creates the node centered on the exact clicked position, not the tracked pointer', () => {
    const ctx = stubContext();
    const entries = pane(ctx, { x: 300, y: 450 });
    const addService = entries.find((e): e is Extract<ContextMenuEntry, { type: 'command' }> => e.type === 'command' && e.command.id === 'add-service')!;
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
    const addBoundary = entries.find((e): e is Extract<ContextMenuEntry, { type: 'command' }> => e.type === 'command' && e.command.id === 'add-boundary')!;
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
    const paste = entries.find((e): e is Extract<ContextMenuEntry, { type: 'command' }> => e.type === 'command' && e.command.id === 'paste')!;
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
    const types = entries.map((e) => (e.type === 'separator' ? 'sep' : e.command.id));
    expect(types).toEqual([
      'edit-text',
      'sep',
      'attach-note',
      'attach-code',
      'sep',
      'duplicate',
      'copy',
      'cut',
      'sep',
      'bring-to-front',
      'bring-forward',
      'send-backward',
      'send-to-back',
      'sep',
      'spotlight',
      'sep',
      'delete',
    ]);
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
    const ids = nodeMenu(api.id).filter((e) => e.type === 'command').map((e) => e.command.id);
    expect(ids).toContain('flow-start-here');
  });

  it('hides Add Note/Add Code once the attachment cap is reached', () => {
    const state = useEditorStore.getState();
    const api = state.addNode({ type: 'service', x: 0, y: 0, text: 'API' });
    for (let i = 0; i < 12; i += 1) {
      state.attachToNode(api.id, { id: `a${i}`, type: 'note' });
    }
    const ids = nodeMenu(api.id).filter((e) => e.type === 'command').map((e) => e.command.id);
    expect(ids).not.toContain('attach-note');
    expect(ids).not.toContain('attach-code');
  });

  it('omits Edit text for a Queue (a verified no-op there today)', () => {
    const queue = useEditorStore.getState().addNode({ type: 'queue', x: 0, y: 0 });
    const ids = nodeMenu(queue.id).filter((e) => e.type === 'command').map((e) => e.command.id);
    expect(ids).not.toContain('edit-text');
  });

  it('a plain Queue gets Add Consumer and Add DLQ grouped right after Add Note/Add Code', () => {
    const queue = useEditorStore.getState().addNode({ type: 'queue', x: 0, y: 0 });
    const entries = nodeMenu(queue.id);
    const types = entries.map((e) => (e.type === 'separator' ? 'sep' : e.command.id));
    expect(types).toEqual([
      'attach-note',
      'attach-code',
      'sep',
      'add-consumer',
      'add-dead-letter-queue',
      'sep',
      'duplicate',
      'copy',
      'cut',
      'sep',
      'bring-to-front',
      'bring-forward',
      'send-backward',
      'send-to-back',
      'sep',
      'spotlight',
      'sep',
      'delete',
    ]);
  });

  it('a Topic gets neither reliability command, and no orphaned separator', () => {
    const topic = useEditorStore.getState().addNode({ type: 'queue', queueKind: 'topic', x: 0, y: 0 });
    const ids = nodeMenu(topic.id).filter((e) => e.type === 'command').map((e) => e.command.id);
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
    const types = entries.map((e) => (e.type === 'separator' ? 'sep' : e.command.id));
    expect(types).toEqual([
      'edit-text',
      'sep',
      'duplicate',
      'copy',
      'cut',
      'sep',
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
    const types = entries.map((e) => (e.type === 'separator' ? 'sep' : e.command.id));
    expect(types).toEqual([
      'edit-text',
      'sep',
      'edge-reverse',
      'edge-async',
      'edge-response',
      'sep',
      'attach-note',
      'attach-code',
      'sep',
      'spotlight',
      'sep',
      'delete',
    ]);
  });

  it('hides Add Note/Add Code once the (lower, edge-specific) attachment cap is reached', () => {
    const state = useEditorStore.getState();
    const api = state.addNode({ type: 'service', x: 0, y: 0 });
    const db = state.addNode({ type: 'database', x: 200, y: 0 });
    const edge = state.connect(api.id, db.id)!;
    for (let i = 0; i < 4; i += 1) {
      state.attachToEdge(edge.id, { id: `a${i}`, type: 'note' });
    }
    const ids = edgeMenu(edge.id).filter((e) => e.type === 'command').map((e) => e.command.id);
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
    const types = boundaryMenu(boundary.id).map((e) => (e.type === 'separator' ? 'sep' : e.command.id));
    expect(types).toEqual([
      'edit-text',
      'sep',
      'attach-note',
      'attach-code',
      'sep',
      'duplicate',
      'copy',
      'cut',
      'sep',
      'bring-to-front',
      'bring-forward',
      'send-backward',
      'send-to-back',
      'sep',
      'spotlight',
      'sep',
      'ungroup',
      'sep',
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
    const selectContents = entries.find(
      (e): e is Extract<ContextMenuEntry, { type: 'command' }> => e.type === 'command' && e.command.id === 'select-contents',
    )!;
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
    let ids = selectionMenu().filter((e) => e.type === 'command').map((e) => e.command.id);
    expect(ids).toContain('align-left');
    expect(ids).not.toContain('distribute-x');
    // Only the two z-order extremes here, never the single-step pair — see `selectionMenu`'s comment.
    expect(ids).toContain('bring-to-front');
    expect(ids).not.toContain('bring-forward');

    const c = state.addNode({ type: 'service', x: 600, y: 0 });
    state.setSelection({ nodes: [a.id, b.id, c.id], edges: [] });
    ids = selectionMenu().filter((e) => e.type === 'command').map((e) => e.command.id);
    expect(ids).toContain('align-left');
    expect(ids).toContain('distribute-x');
  });

  it('an edges-only multi-selection shows only Spotlight and Delete', () => {
    const state = useEditorStore.getState();
    const a = state.addNode({ type: 'service', x: 0, y: 0 });
    const b = state.addNode({ type: 'database', x: 300, y: 0 });
    const c = state.addNode({ type: 'queue', x: 0, y: 300 });
    const e1 = state.connect(a.id, b.id)!;
    const e2 = state.connect(a.id, c.id)!;
    state.setSelection({ nodes: [], edges: [e1.id, e2.id] });
    const types = selectionMenu().map((e) => (e.type === 'separator' ? 'sep' : e.command.id));
    expect(types).toEqual(['spotlight', 'sep', 'delete']);
  });

  it('Group → Ungroup round-trips via the menu', () => {
    const state = useEditorStore.getState();
    const a = state.addNode({ type: 'service', x: 0, y: 0 });
    const b = state.addNode({ type: 'service', x: 300, y: 0 });
    state.setSelection({ nodes: [a.id, b.id], edges: [] });
    const ctx = stubContext();
    const group = selectionMenu().find(
      (e): e is Extract<ContextMenuEntry, { type: 'command' }> => e.type === 'command' && e.command.id === 'group',
    )!;
    group.command.run(ctx);
    const boundary = useEditorStore.getState().document.nodes.find((n) => n.type === 'group')!;
    expect(boundary).toBeDefined();
    expect(useEditorStore.getState().selection.nodes).toEqual([boundary.id]);

    useEditorStore.getState().setSelection({ nodes: [boundary.id], edges: [] });
    const ungroupCtx = stubContext();
    // A single selected boundary goes through the node menu, not the multi-selection one — reuses
    // the identical `ungroup` command either way.
    const nodeEntries = contextMenuCommandsFor(ungroupCtx, { kind: 'node', id: boundary.id }, { x: 0, y: 0 });
    const ungroup = nodeEntries.find(
      (e): e is Extract<ContextMenuEntry, { type: 'command' }> => e.type === 'command' && e.command.id === 'ungroup',
    )!;
    ungroup.command.run(ungroupCtx);
    expect(useEditorStore.getState().document.nodes.some((n) => n.type === 'group')).toBe(false);
  });

  it('returns nothing once the selection drops below 2 members', () => {
    useEditorStore.getState().addNode({ type: 'service', x: 0, y: 0 });
    useEditorStore.getState().setSelection({ nodes: [useEditorStore.getState().document.nodes[0]!.id], edges: [] });
    expect(selectionMenu()).toEqual([]);
  });
});
