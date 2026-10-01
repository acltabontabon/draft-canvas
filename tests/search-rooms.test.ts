import { beforeEach, describe, expect, it, vi } from 'vitest';
import { rank } from '../src/commands/fuzzy';
import { JUMP_LIMIT, jumpCommands } from '../src/commands/search';
import { createDocument, createNode } from '../src/document/factory';
import type { DraftDocument } from '../src/document/types';
import { addNodes } from '../src/document/operations';
import { __resetInteraction, fileOf, useEditorStore } from '../src/store/editorStore';
import { useUiStore } from '../src/store/uiStore';
import { stubContext } from './commandStubs';

/** "Orders API" at the root, with "Orders worker" and the flow "Place order" inside it. */
function twoRooms(): DraftDocument {
  const owner = createNode({ type: 'service', x: 0, y: 0, text: 'Orders API' });
  const worker = createNode({ type: 'service', x: 0, y: 0, text: 'Orders worker' });
  owner.inside = { nodes: [worker], edges: [], flows: [{ id: 'flow_inner', title: 'Place order', steps: [] }], viewport: { x: 0, y: 0, zoom: 1 } };
  return addNodes(createDocument('Rooms'), [owner, createNode({ type: 'database', x: 300, y: 0, text: 'Ledger' })]);
}

const scope = () => {
  const state = useEditorStore.getState();
  return { file: fileOf(state), path: state.path };
};

describe('jumpCommands across rooms', () => {
  beforeEach(() => {
    __resetInteraction();
    useEditorStore.setState({
      document: twoRooms(),
      history: { past: [], future: [] },
      selection: { nodes: [], edges: [] },
      clipboard: null,
      revision: 0,
      mode: 'edit',
      selectedFlowId: null,
      path: [],
      outer: null,
    });
    useUiStore.setState({ jumpFlashId: null });
  });

  it('lists every room, subtitling rows from elsewhere with where they live', () => {
    const rows = jumpCommands(useEditorStore.getState().document, scope());
    const titles = rows.map((row) => row.title);
    expect(titles).toEqual(['Orders API', 'Ledger', 'Orders worker', 'Place order']);
    const worker = rows.find((row) => row.title === 'Orders worker')!;
    expect(worker.hint).toBe('Service · inside Orders API');
    expect(worker.keywords).toContain('Orders API');
    expect(rows.find((row) => row.title === 'Place order')!.hint).toBe('Flow · 0 steps · inside Orders API');
    // The room on screen reads as it always did.
    expect(rows.find((row) => row.title === 'Ledger')!.hint).toBe('Data store');
    // Without a scope, only the room on screen — the old contract.
    expect(jumpCommands(useEditorStore.getState().document).map((row) => row.title)).toEqual(['Orders API', 'Ledger']);
  });

  it('keeps the cap and the ranking: a query is still answered by the best few, local rows first on a tie', () => {
    const rows = rank('orders', jumpCommands(useEditorStore.getState().document, scope())).slice(0, JUMP_LIMIT);
    expect(rows.length).toBeLessThanOrEqual(JUMP_LIMIT);
    expect(rows.map((row) => row.entry.title)).toContain('Orders worker');
  });

  it('picking a row from another room goes there first, then selects, frames and flashes it', async () => {
    const ctx = stubContext();
    const ownerId = useEditorStore.getState().document.nodes[0]!.id;
    const rows = jumpCommands(useEditorStore.getState().document, scope());
    const worker = rows.find((row) => row.title === 'Orders worker')!;
    const workerId = worker.id.replace('jump-node:', '');
    worker.run(ctx);
    await vi.waitFor(() => expect(useEditorStore.getState().path).toEqual([ownerId]));
    await vi.waitFor(() => expect(useEditorStore.getState().selection).toEqual({ nodes: [workerId], edges: [] }));
    expect(ctx.camera.setViewport).toHaveBeenCalled();
    expect(useUiStore.getState().jumpFlashId).toBe(workerId);

    // And back out again from inside: the root row climbs up.
    const fromInside = jumpCommands(useEditorStore.getState().document, scope());
    expect(fromInside.find((row) => row.title === 'Ledger')!.hint).toBe('Data store · at the top level');
    fromInside.find((row) => row.title === 'Ledger')!.run(stubContext());
    await vi.waitFor(() => expect(useEditorStore.getState().path).toEqual([]));
  });
});
